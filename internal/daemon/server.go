package daemon

import (
	"bufio"
	"encoding/json"
	"errors"
	"net"
	"os"
	"path/filepath"
	"syscall"
	"time"
)

// Request is one line on the socket: {"op": ..., "id": run id, "goal": {...}}.
// "reply" answers a waiting run with approved "checks" or a "hint"; "extend" raises a stopped run's
// "budget_usd" and "max_turns" so it continues.
type Request struct {
	Op        string  `json:"op"`
	ID        string  `json:"id"`
	Goal      Goal    `json:"goal"`
	Checks    []Check `json:"checks"`
	Hint      string  `json:"hint"`
	BudgetUSD float64 `json:"budget_usd"`
	MaxTurns  int     `json:"max_turns"`
}

type reply struct {
	OK    bool   `json:"ok"`
	Data  any    `json:"data,omitempty"`
	Error string `json:"error,omitempty"`
}

// ErrRunning means another daemon already owns the data folder.
var ErrRunning = errors.New("ixd is already running")

// Lock claims the data folder for this daemon until it exits. It must come before NewManager, which treats
// every "running" run as left behind by a dead daemon and kills it: a second daemon started by mistake would
// otherwise kill the first one's live runs before noticing the socket is taken. The lock is an flock, so the
// kernel releases it when the daemon dies, and Go opens it close-on-exec, so loops and agents never inherit it.
func Lock(data string) (*os.File, error) {
	if err := os.MkdirAll(data, 0o700); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(filepath.Join(data, "ixd.lock"), os.O_RDWR|os.O_CREATE, 0o600)
	if err != nil {
		return nil, err
	}
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		f.Close()
		if errors.Is(err, syscall.EWOULDBLOCK) {
			return nil, ErrRunning
		}
		return nil, err
	}
	return f, nil
}

// Serve listens on a unix socket only the current user can open. It returns when shut down.
func Serve(m *Manager, sock string) error {
	if c, err := net.Dial("unix", sock); err == nil {
		c.Close()
		return ErrRunning
	}
	_ = os.Remove(sock)
	old := syscall.Umask(0o077)
	ln, err := net.Listen("unix", sock)
	syscall.Umask(old)
	if err != nil {
		return err
	}
	_ = os.Chmod(sock, 0o600)
	done := make(chan struct{})
	for {
		c, err := ln.Accept()
		if err != nil {
			select {
			case <-done:
				return nil
			default:
				return err
			}
		}
		go m.handle(c, func() {
			close(done)
			ln.Close()
			_ = os.Remove(sock)
		})
	}
}

func (m *Manager) handle(c net.Conn, shutdown func()) {
	defer c.Close()
	enc := json.NewEncoder(c)
	sc := bufio.NewScanner(c)
	sc.Buffer(make([]byte, 64*1024), 1<<20)
	for sc.Scan() {
		var req Request
		if err := json.Unmarshal(sc.Bytes(), &req); err != nil {
			_ = enc.Encode(reply{Error: "bad request: " + err.Error()})
			continue
		}
		if req.Op == "subscribe" {
			ch := m.subscribe()
			defer m.unsubscribe(ch)
			_ = enc.Encode(reply{OK: true})
			for b := range ch {
				if _, err := c.Write(b); err != nil {
					return
				}
			}
			return
		}
		data, err := m.dispatch(req)
		if err != nil {
			_ = enc.Encode(reply{Error: err.Error()})
			continue
		}
		_ = enc.Encode(reply{OK: true, Data: data})
		if req.Op == "shutdown" {
			time.AfterFunc(50*time.Millisecond, shutdown)
			return
		}
	}
}

func (m *Manager) dispatch(req Request) (any, error) {
	switch req.Op {
	case "hello":
		return map[string]any{"version": Version, "active": m.Active()}, nil
	case "list":
		return m.List(), nil
	case "get":
		return m.Get(req.ID)
	case "start":
		return m.Start(req.Goal)
	case "reply":
		return m.Reply(req.ID, req.Checks, req.Hint)
	case "extend":
		return m.Extend(req.ID, req.BudgetUSD, req.MaxTurns)
	case "stop":
		return nil, m.Stop(req.ID)
	case "delete":
		return nil, m.Delete(req.ID)
	case "shutdown":
		if m.Active() > 0 {
			return nil, errors.New("runs are active")
		}
		return nil, nil
	}
	return nil, errors.New("unknown op " + req.Op)
}
