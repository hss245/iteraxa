// ixd is the Iteraxa daemon. `ixd serve` owns the runs; `ixd run-agent` makes one agent call for the loop.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"time"

	"iteraxa/internal/agent"
	"iteraxa/internal/daemon"
)

func main() {
	if len(os.Args) < 2 {
		usage()
	}
	switch os.Args[1] {
	case "serve":
		serve(os.Args[2:])
	case "run-agent":
		if err := runAgent(os.Args[2:]); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
	case "version", "--version":
		fmt.Println(daemon.Version)
	default:
		usage()
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, "usage: ixd serve [--data DIR] [--ixpack PATH] [--python-path DIR] | ixd run-agent ... | ixd version")
	os.Exit(2)
}

func serve(args []string) {
	fs := flag.NewFlagSet("serve", flag.ExitOnError)
	data := fs.String("data", daemon.DataDir(), "data folder")
	ixpack := fs.String("ixpack", "ixpack", "ixpack binary")
	pythonPath := fs.String("python-path", "", "folder containing the iteraxa Python package")
	_ = fs.Parse(args)
	self, err := os.Executable()
	if err != nil {
		log.Fatal(err)
	}
	lock, err := daemon.Lock(*data)
	if errors.Is(err, daemon.ErrRunning) {
		// The app can race two starts; the loser leaves the winner's runs alone.
		log.Print(err)
		return
	}
	if err != nil {
		log.Fatal(err)
	}
	defer lock.Close()
	m, err := daemon.NewManager(*data, *ixpack, *pythonPath, self)
	if err != nil {
		log.Fatal(err)
	}
	log.Printf("ixd %s serving %s", daemon.Version, *data)
	if err := daemon.Serve(m, filepath.Join(*data, "ixd.sock")); err != nil {
		log.Fatal(err)
	}
}

func runAgent(args []string) error {
	fs := flag.NewFlagSet("run-agent", flag.ContinueOnError)
	name := fs.String("agent", "", "claude, codex or cursor")
	workspace := fs.String("workspace", "", "workspace directory")
	timeout := fs.Duration("timeout", 10*time.Minute, "agent timeout")
	resultPath := fs.String("result", "", "result JSON path")
	pidfile := fs.String("pidfile", "", "child pid file")
	promptFlag := fs.String("prompt", "", "prompt text; default is stdin")
	maxUSD := fs.Float64("max-usd", 0, "Claude: cap for this call in dollars")
	model := fs.String("model", "", "model name")
	lean := fs.Bool("lean", false, "Claude: --bare")
	readOnly := fs.Bool("readonly", false, "read files only (reviews and check proposals)")
	network := fs.Bool("network", false, "allow network and services")
	effort := fs.String("effort", "", "Cursor: high or xhigh picks the model when -model is empty; Codex: reasoning effort")
	if err := fs.Parse(args); err != nil {
		return err
	}
	prompt := *promptFlag
	if prompt == "" {
		b, err := io.ReadAll(os.Stdin)
		if err != nil {
			return err
		}
		prompt = string(b)
	}
	res, runErr := agent.Run(context.Background(), agent.Config{
		Agent: *name, Workspace: *workspace, Prompt: prompt, Timeout: *timeout,
		PidFile: *pidfile, MaxUSD: *maxUSD, Model: *model, Lean: *lean,
		ReadOnly: *readOnly, Network: *network, Effort: *effort,
	})
	if *resultPath != "" {
		b, err := json.Marshal(res)
		if err != nil {
			return err
		}
		if err := os.WriteFile(*resultPath, append(b, '\n'), 0o644); err != nil {
			return err
		}
	}
	return runErr
}
