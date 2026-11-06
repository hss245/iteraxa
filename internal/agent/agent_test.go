package agent

import (
	"context"
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestClaudeArgs(t *testing.T) {
	t.Setenv("ANTHROPIC_API_KEY", "")
	if _, args, _ := command(Config{Agent: "claude", Prompt: "hi", Lean: true}); contains(args, "--bare") {
		t.Fatalf("--bare without an API key logs a claude.ai sign-in out: %v", args)
	}
	t.Setenv("ANTHROPIC_API_KEY", "sk-test")
	bin, args, err := command(Config{Agent: "claude", Prompt: "hi", Lean: true, MaxUSD: 1.234, Model: "sonnet"})
	if err != nil {
		t.Fatal(err)
	}
	if bin != "claude" || !contains(args, "--bare") || !contains(args, "acceptEdits") || !contains(args, "1.23") || !contains(args, "sonnet") || args[len(args)-1] != "hi" {
		t.Fatalf("bin=%s args=%v", bin, args)
	}
	_, args, _ = command(Config{Agent: "claude", Prompt: "hi"})
	if contains(args, "--bare") || contains(args, "--max-budget-usd") || contains(args, "--model") {
		t.Fatalf("defaults should add no optional flags: %v", args)
	}
	_, args, _ = command(Config{Agent: "codex", Prompt: "hi", Model: "gpt-5-codex"})
	if !contains(args, "-m") || args[len(args)-1] != "hi" || contains(args, "sandbox_workspace_write.network_access=true") {
		t.Fatalf("codex args=%v", args)
	}
	_, args, _ = command(Config{Agent: "claude", Prompt: "hi", ReadOnly: true})
	if contains(args, "acceptEdits") || !contains(args, "Edit,Write,NotebookEdit,Bash,WebFetch,WebSearch") || contains(args, "--settings") {
		t.Fatalf("read-only claude must not edit or run commands: %v", args)
	}
}

func TestClaudeNetworkOffSandboxesBash(t *testing.T) {
	_, args, _ := command(Config{Agent: "claude", Prompt: "hi"})
	i := indexOf(args, "--settings")
	if i < 0 || !contains(args, "WebFetch,WebSearch") {
		t.Fatalf("network off must sandbox Bash and drop the web tools: %v", args)
	}
	var s struct {
		Sandbox struct {
			Enabled           bool `json:"enabled"`
			FailIfUnavailable bool `json:"failIfUnavailable"`
			AllowUnsandboxed  bool `json:"allowUnsandboxedCommands"`
			Network           struct {
				StrictAllowlist bool     `json:"strictAllowlist"`
				AllowedDomains  []string `json:"allowedDomains"`
			} `json:"network"`
		} `json:"sandbox"`
	}
	if err := json.Unmarshal([]byte(args[i+1]), &s); err != nil {
		t.Fatal(err)
	}
	sb := s.Sandbox
	if !sb.Enabled || !sb.FailIfUnavailable || sb.AllowUnsandboxed || !sb.Network.StrictAllowlist || len(sb.Network.AllowedDomains) != 0 {
		t.Fatalf("the sandbox must fail closed with no host allowed: %+v", sb)
	}
	if _, args, _ = command(Config{Agent: "claude", Prompt: "hi", Network: true}); contains(args, "--settings") || contains(args, "WebFetch,WebSearch") {
		t.Fatalf("network on keeps Bash and the web tools unrestricted: %v", args)
	}
}

func TestParseClaudeUsage(t *testing.T) {
	out := `{"type":"result","total_cost_usd":0.12,"result":"done","usage":{"input_tokens":10,"cache_creation_input_tokens":200,"cache_read_input_tokens":3000,"output_tokens":40}}`
	p := ParseOutput("claude", []byte(out), "")
	if p.Tokens != 3250 || p.USD != 0.12 || !p.HasUSD || p.Text != "done" {
		t.Fatalf("%+v", p)
	}
}

func indexOf(args []string, want string) int {
	for i, a := range args {
		if a == want {
			return i
		}
	}
	return -1
}

func TestNetworkAndReadOnlyFlags(t *testing.T) {
	_, args, _ := command(Config{Agent: "codex", Prompt: "hi", Network: true})
	if !contains(args, "sandbox_workspace_write.network_access=true") || !contains(args, "workspace-write") {
		t.Fatalf("codex network args=%v", args)
	}
	_, args, _ = command(Config{Agent: "codex", Prompt: "hi", ReadOnly: true, Network: true})
	if !contains(args, "read-only") || contains(args, "sandbox_workspace_write.network_access=true") {
		t.Fatalf("codex read-only args=%v", args)
	}
	for effort, want := range map[string]string{"low": `model_reasoning_effort="low"`, "xhigh": `model_reasoning_effort="high"`} {
		if _, args, _ = command(Config{Agent: "codex", Prompt: "hi", Effort: effort}); !contains(args, want) {
			t.Fatalf("codex effort %s args=%v", effort, args)
		}
	}
	if _, args, _ = command(Config{Agent: "codex", Prompt: "hi"}); strings.Contains(strings.Join(args, " "), "reasoning") {
		t.Fatalf("codex keeps its own effort when none is set: %v", args)
	}
	_, args, _ = command(Config{Agent: "cursor", Prompt: "hi", Workspace: "/w", Model: "grok-4.6-high"})
	if !contains(args, "--force") || !contains(args, "enabled") || !contains(args, "grok-4.6-high") || args[len(args)-1] != "hi" {
		t.Fatalf("cursor args=%v", args)
	}
	_, args, _ = command(Config{Agent: "cursor", Prompt: "hi", Workspace: "/w", Network: true})
	if !contains(args, "disabled") {
		t.Fatalf("cursor network args=%v", args)
	}
	_, args, _ = command(Config{Agent: "cursor", Prompt: "hi", Workspace: "/w", ReadOnly: true, Network: true})
	if contains(args, "--force") || !contains(args, "ask") || !contains(args, "enabled") {
		t.Fatalf("cursor read-only args=%v", args)
	}
}

func TestPickCursorModel(t *testing.T) {
	list := "Available models\n  auto - Auto\n  grok-4.7 - Grok 4.7\n  grok-4.7-xhigh - Grok 4.7 Extra High\n  grok-4.7-xhigh-fast - Grok 4.7 Extra High Fast\n" +
		"  grok-4.6 - Grok 4.6\n  grok-4.6-high - Grok 4.6 High\n  claude-opus-5-5 - Opus\n"
	cases := map[string]string{"high": "grok-4.6-high", "xhigh": "grok-4.7-xhigh", "": "grok-4.6-high"}
	for effort, want := range cases {
		if got := PickCursorModel(list, effort); got != want {
			t.Fatalf("effort %q: got %q want %q", effort, got, want)
		}
	}
	if got := PickCursorModel("grok-4.7 - Grok 4.7\n", "high"); got != "grok-4.7" {
		t.Fatalf("plan with fixed effort: got %q", got)
	}
	prefixed := "grok-4.7-high - Grok 4.7  High\ngrok-4.7-xhigh - Grok 4.7  Extra High\ncursor-grok-4.6-high - Grok 4.6\ncursor-grok-4.6-high-fast - Grok 4.6 Fast\n"
	if got := PickCursorModel(prefixed, "high"); got != "cursor-grok-4.6-high" {
		t.Fatalf("prefixed slug: got %q", got)
	}
	if got := PickCursorModel("not logged in", "high"); got != "" {
		t.Fatalf("no list: got %q", got)
	}
}

func TestClipEnds(t *testing.T) {
	msg := "Cannot use this model: grok-4.6-high. Available models: " + strings.Repeat("gpt-5.6-sol-high, ", 80) + "kimi-k3-max"
	got := clipEnds(msg, 500)
	if len(got) > 500 || !strings.HasPrefix(got, "Cannot use this model: grok-4.6-high") || !strings.HasSuffix(got, "kimi-k3-max") {
		t.Fatalf("clipEnds lost an end (%d bytes): %q", len(got), got)
	}
}

func TestLongReplyKeepsItsStart(t *testing.T) {
	reply := `{"checks": [{"id": "a", "cmd": "` + strings.Repeat("x", 5000) + `"}]}`
	raw := `{"type":"result","result":"` + strings.ReplaceAll(reply, `"`, `\"`) + `"}`
	if p := ParseOutput("cursor", []byte(raw), ""); p.Text != reply {
		t.Fatalf("a 5 KB reply was cut to %d bytes", len(p.Text))
	}
}

func TestParseCursorEstimate(t *testing.T) {
	prompt := strings.Repeat("p", 4000)
	file := strings.Repeat("f", 8000)
	raw := `{"type":"system","subtype":"init","model":"Grok 4.6"}
{"type":"user","message":{"content":[{"type":"text","text":"` + prompt + `"}]}}
{"type":"tool_call","subtype":"started","tool_call":{"readToolCall":{"args":{"path":"a"}}}}
{"type":"tool_call","subtype":"completed","tool_call":{"readToolCall":{"result":"` + file + `"}}}
{"type":"assistant","message":{"content":[{"type":"text","text":"done"}]}}
{"type":"result","subtype":"success","result":"done {\"cause\":\"x\"}"}
`
	p := ParseOutput("cursor", []byte(raw), "")
	if !p.HasUSD || !p.Estimated || p.Model != "Grok 4.6" || !strings.Contains(p.Text, "cause") {
		t.Fatalf("%+v", p)
	}
	// Two model calls: the first reads the prompt fresh; the second reads the file fresh and the prompt from cache.
	low := (4000.0+8000)*2/4/1e6 + 4000*0.5/4/1e6
	if p.USD < low || p.USD > low*1.1 || p.Tokens < 4000 {
		t.Fatalf("usd=%v want about %v, tokens=%d", p.USD, low, p.Tokens)
	}
	if in, _, out := cursorPrice("grok-4.7-xhigh-fast"); in != 4 || out != 12 {
		t.Fatalf("fast price in=%v out=%v", in, out)
	}
}

func TestRunFakeCursor(t *testing.T) {
	dir := t.TempDir()
	bin := filepath.Join(dir, "cursor-agent")
	script := "#!/bin/sh\n" +
		"if [ \"$1\" = --list-models ]; then echo 'grok-4.6-high - Grok 4.6 High'; echo 'grok-4.7-xhigh - Grok 4.7'; exit 0; fi\n" +
		"echo \"$@\" > args\n" +
		"printf '%s\\n' '{\"type\":\"result\",\"subtype\":\"success\",\"result\":\"fixed\"}'\n"
	if err := os.WriteFile(bin, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	res, err := Run(context.Background(), Config{Agent: "cursor", Bin: bin, Workspace: dir, Prompt: "fix it", Effort: "xhigh", Timeout: 5 * time.Second})
	if err != nil {
		t.Fatal(err)
	}
	args, _ := os.ReadFile(filepath.Join(dir, "args"))
	if !res.OK || res.Model != "grok-4.7-xhigh" || res.Output != "fixed" || !strings.Contains(string(args), "--model grok-4.7-xhigh") {
		t.Fatalf("%+v args=%s", res, args)
	}
}

func TestParseCodexUsage(t *testing.T) {
	raw := []byte("{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"hi\"}}\n" +
		"{\"type\":\"turn.completed\",\"usage\":{\"input_tokens\":1000000,\"cached_input_tokens\":400000,\"output_tokens\":90000,\"reasoning_output_tokens\":10000}}\n")
	// Luna: 600k fresh input at $0.10, 400k cached at $0.01, 100k output at $0.50 per million.
	p := ParseOutput("codex", raw, "gpt-6-luna")
	if !p.HasUSD || !p.Estimated || math.Abs(p.USD-0.114) > 1e-9 || p.Tokens != 1100000 || p.Text != "hi" {
		t.Fatalf("%+v", p)
	}
	if p = ParseOutput("codex", []byte("crashed"), ""); p.HasUSD || p.USD != 0 {
		t.Fatalf("no usage means no cost: %+v", p)
	}
}

func TestRunFakeClaude(t *testing.T) {
	dir := t.TempDir()
	bin := filepath.Join(dir, "fake")
	script := "#!/bin/sh\nprintf '%s\\n' '{\"total_cost_usd\":0.25,\"result\":\"hello\"}'\n"
	if err := os.WriteFile(bin, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	res, err := Run(context.Background(), Config{
		Agent:     "claude",
		Bin:       bin,
		Workspace: dir,
		Prompt:    "fix it",
		Timeout:   5 * time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !res.OK || !res.HasUSD || res.CostUSD != 0.25 || res.Output != "hello" {
		t.Fatalf("%+v", res)
	}

	limited := "#!/bin/sh\nprintf '%s\\n' '{\"is_error\":true,\"total_cost_usd\":0,\"result\":\"You have hit your weekly limit · resets 7:30am\"}'\nexit 1\n"
	if err := os.WriteFile(bin, []byte(limited), 0o755); err != nil {
		t.Fatal(err)
	}
	res, _ = Run(context.Background(), Config{Agent: "claude", Bin: bin, Workspace: dir, Prompt: "fix it", Timeout: 5 * time.Second})
	if res.OK || !strings.Contains(res.Error, "weekly limit") {
		t.Fatalf("the CLI's own message should be the error: %+v", res)
	}
}

func TestRunTimeoutKillsGroup(t *testing.T) {
	dir := t.TempDir()
	bin := filepath.Join(dir, "sleep")
	childPid := filepath.Join(dir, "child.pid")
	// The CLI starts a child of its own, as agent CLIs do for tools; the timeout must kill it too.
	script := "#!/bin/sh\nsleep 30 &\necho $! > " + childPid + "\nwait\n"
	if err := os.WriteFile(bin, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if b, err := os.ReadFile(childPid); err == nil {
			if pid, err := strconv.Atoi(strings.TrimSpace(string(b))); err == nil {
				_ = syscall.Kill(pid, syscall.SIGKILL)
			}
		}
	})
	start := time.Now()
	res, err := Run(context.Background(), Config{
		Agent:     "claude",
		Bin:       bin,
		Workspace: dir,
		Prompt:    "fix it",
		Timeout:   2 * time.Second, // macOS scans a new executable on its first run; let the script reach its child
	})
	if err == nil || res.Error != "timeout" {
		t.Fatalf("err=%v res=%+v", err, res)
	}
	if time.Since(start) > 8*time.Second {
		t.Fatalf("timeout took %s", time.Since(start))
	}
	b, err := os.ReadFile(childPid)
	if err != nil {
		t.Fatal(err)
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(b)))
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; syscall.Kill(pid, 0) == nil; i++ { // the group was SIGKILLed; give the kernel a moment to reap
		if i == 50 {
			t.Fatalf("the CLI's child %d outlived the timeout", pid)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func contains(args []string, want string) bool {
	for _, a := range args {
		if a == want {
			return true
		}
	}
	return false
}
