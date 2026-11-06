package agent

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"time"
)

type Config struct {
	Agent     string
	Bin       string
	Workspace string
	Prompt    string
	Timeout   time.Duration
	PidFile   string
	MaxUSD    float64 // Claude only: hard cap for this one call.
	Model     string
	Lean      bool   // Claude --bare: skip hooks, plugins, MCP and CLAUDE.md discovery.
	ReadOnly  bool   // reviewers and check proposals: read files, change nothing
	Network   bool   // let commands reach databases, services and the internet
	Effort    string // Cursor: "high" or "xhigh" picks the model when Model is empty. Codex: reasoning effort.
}

type Result struct {
	Agent     string  `json:"agent"`
	OK        bool    `json:"ok"`
	CostUSD   float64 `json:"cost_usd"`
	Tokens    int     `json:"tokens"`
	HasUSD    bool    `json:"has_usd"`
	Estimated bool    `json:"estimated,omitempty"`
	Model     string  `json:"model,omitempty"`
	Output    string  `json:"output"`
	Error     string  `json:"error,omitempty"`
}

// Bin resolves an agent's CLI: the ITERAXA_<AGENT>_BIN override, then PATH.
func Bin(name string) string {
	if b := os.Getenv("ITERAXA_" + strings.ToUpper(name) + "_BIN"); b != "" {
		return b
	}
	if name == "cursor" {
		// The Cursor installer adds both names; `agent` alone is too generic to try first.
		for _, b := range []string{"cursor-agent", "agent"} {
			if p, err := exec.LookPath(b); err == nil {
				return p
			}
		}
		return "cursor-agent"
	}
	return name
}

func Run(ctx context.Context, cfg Config) (Result, error) {
	res := Result{Agent: cfg.Agent}
	if cfg.Bin == "" {
		cfg.Bin = Bin(cfg.Agent)
	}
	if cfg.Agent == "cursor" && cfg.Model == "" {
		cfg.Model = PickCursorModel(listModels(ctx, cfg.Bin), cfg.Effort)
	}
	res.Model = cfg.Model
	bin, args, err := command(cfg)
	if err != nil {
		res.Error = err.Error()
		return res, err
	}
	if cfg.Workspace == "" {
		res.Error = "workspace is required"
		return res, fmt.Errorf("%s", res.Error)
	}
	if cfg.Timeout <= 0 {
		cfg.Timeout = 10 * time.Minute
	}

	cctx, cancel := context.WithTimeout(ctx, cfg.Timeout)
	defer cancel()

	cmd := exec.CommandContext(cctx, bin, args...)
	cmd.Dir = cfg.Workspace
	// Prompt is an argv. Empty stdin so a piped parent prompt is not fed to the CLI twice.
	cmd.Stdin = strings.NewReader("")
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.WaitDelay = 2 * time.Second
	cmd.Cancel = func() error {
		if cmd.Process == nil {
			return nil
		}
		// ponytail: SIGKILL the process group. Upgrade path is SIGTERM, then SIGKILL after a grace period.
		return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
	}

	if err := cmd.Start(); err != nil {
		res.Error = err.Error()
		return res, err
	}
	if cfg.PidFile != "" {
		_ = os.WriteFile(cfg.PidFile, []byte(strconv.Itoa(cmd.Process.Pid)), 0o644)
		defer os.Remove(cfg.PidFile)
	}

	err = cmd.Wait()
	p := ParseOutput(cfg.Agent, stdout.Bytes(), cfg.Model)
	res.CostUSD, res.Tokens, res.HasUSD, res.Estimated, res.Output = p.USD, p.Tokens, p.HasUSD, p.Estimated, p.Text
	if res.Model == "" {
		res.Model = p.Model
	}
	if cctx.Err() == context.DeadlineExceeded {
		res.OK = false
		res.Error = "timeout"
		return res, fmt.Errorf("timeout")
	}
	if err != nil {
		res.OK = false
		// Claude and Codex print why they failed (not signed in, usage limit) in their JSON, not on stderr.
		msg := strings.TrimSpace(stderr.String())
		if msg == "" {
			msg = strings.TrimSpace(p.Text)
		}
		if msg == "" {
			msg = err.Error()
		}
		res.Error = clipEnds(msg, 500)
		return res, err
	}
	res.OK = true
	return res, nil
}

func command(cfg Config) (string, []string, error) {
	switch cfg.Agent {
	case "claude":
		bin := cfg.Bin
		if bin == "" {
			bin = "claude"
		}
		var args []string
		// --bare authenticates only with ANTHROPIC_API_KEY: it never reads a claude.ai sign-in from the keychain.
		if cfg.Lean && os.Getenv("ANTHROPIC_API_KEY") != "" {
			args = append(args, "--bare")
		}
		args = append(args, "--output-format", "json")
		var deny []string
		if cfg.ReadOnly {
			args = append(args, "--allowedTools", "Read,Glob,Grep")
			deny = append(deny, "Edit", "Write", "NotebookEdit", "Bash")
		} else {
			args = append(args, "--permission-mode", "acceptEdits", "--allowedTools", "Read,Edit,Bash")
		}
		if !cfg.Network {
			deny = append(deny, "WebFetch", "WebSearch")
			if !cfg.ReadOnly { // read-only Claude has no Bash, so there is nothing to sandbox
				args = append(args, "--settings", claudeSandbox)
			}
		}
		if len(deny) > 0 {
			args = append(args, "--disallowedTools", strings.Join(deny, ","))
		}
		if cfg.MaxUSD > 0 {
			args = append(args, "--max-budget-usd", strconv.FormatFloat(cfg.MaxUSD, 'f', 2, 64))
		}
		if cfg.Model != "" {
			args = append(args, "--model", cfg.Model)
		}
		return bin, append(args, "-p", cfg.Prompt), nil
	case "codex":
		bin := cfg.Bin
		if bin == "" {
			bin = "codex"
		}
		sandbox := "workspace-write"
		if cfg.ReadOnly {
			sandbox = "read-only"
		}
		args := []string{"exec", "--json", "--sandbox", sandbox, "--ephemeral"}
		if cfg.Network && !cfg.ReadOnly {
			args = append(args, "-c", "sandbox_workspace_write.network_access=true")
		}
		switch cfg.Effort {
		case "low", "medium", "high":
			args = append(args, "-c", `model_reasoning_effort="`+cfg.Effort+`"`)
		case "xhigh": // ponytail: not every Codex model accepts xhigh, so it maps to high
			args = append(args, "-c", `model_reasoning_effort="high"`)
		}
		if cfg.Model != "" {
			args = append(args, "-m", cfg.Model)
		}
		return bin, append(args, cfg.Prompt), nil
	case "cursor":
		bin := cfg.Bin
		if bin == "" {
			bin = "cursor-agent"
		}
		args := []string{"-p", "--output-format", "stream-json", "--trust", "--workspace", cfg.Workspace}
		if cfg.ReadOnly {
			args = append(args, "--mode", "ask")
		} else {
			args = append(args, "--force")
		}
		// The sandbox keeps commands inside the workspace with no network; disabling it lifts both.
		if cfg.Network && !cfg.ReadOnly {
			args = append(args, "--sandbox", "disabled")
		} else {
			args = append(args, "--sandbox", "enabled")
		}
		if cfg.Model != "" {
			args = append(args, "--model", cfg.Model)
		}
		return bin, append(args, cfg.Prompt), nil
	default:
		return "", nil, fmt.Errorf("unknown agent %q", cfg.Agent)
	}
}

// claudeSandbox runs Claude's Bash in Claude Code's own sandbox when the network is off, like Codex's
// workspace-write: writes only in the workspace and a temp folder, and no host reachable (strictAllowlist with
// no allowed domains, Claude Code 2.1.219 or later). It fails closed: if the sandbox cannot start (Linux without
// bubblewrap and socat), the call fails instead of running unsandboxed, and no command may opt out of it.
const claudeSandbox = `{"sandbox":{"enabled":true,"failIfUnavailable":true,"allowUnsandboxedCommands":false,"network":{"strictAllowlist":true}}}`

type Parsed struct {
	USD       float64
	Tokens    int
	Text      string
	HasUSD    bool
	Estimated bool
	Model     string
}

func ParseOutput(agent string, stdout []byte, model string) Parsed {
	switch agent {
	case "codex":
		return parseCodex(stdout, model)
	case "cursor":
		return parseCursor(stdout, model)
	default:
		usd, tokens, text, has := parseClaude(stdout)
		return Parsed{USD: usd, Tokens: tokens, Text: text, HasUSD: has}
	}
}

func parseClaude(stdout []byte) (usd float64, tokens int, text string, hasUSD bool) {
	body := jsonObject(stdout)
	var raw map[string]json.RawMessage
	if json.Unmarshal(body, &raw) != nil {
		return 0, 0, clip(string(stdout), maxText), false
	}
	if v, ok := raw["total_cost_usd"]; ok {
		hasUSD = json.Unmarshal(v, &usd) == nil
	}
	if v, ok := raw["usage"]; ok {
		var u struct {
			Input      int `json:"input_tokens"`
			CacheWrite int `json:"cache_creation_input_tokens"`
			CacheRead  int `json:"cache_read_input_tokens"`
			Output     int `json:"output_tokens"`
		}
		if json.Unmarshal(v, &u) == nil {
			tokens = u.Input + u.CacheWrite + u.CacheRead + u.Output
		}
	}
	var result string
	if v, ok := raw["result"]; ok {
		_ = json.Unmarshal(v, &result)
	}
	if result == "" {
		result = clip(string(stdout), maxText)
	}
	return usd, tokens, clip(result, maxText), hasUSD
}

// parseCursor estimates tokens from the stream-json events, because Cursor reports neither tokens nor cost.
// Each model call re-reads the whole conversation: new material bills as input, the rest as cache reads.
// ponytail: ~4 characters per token, and Cursor's own system prompt and tool schemas are not visible,
// so the estimate reads low. The upgrade path is real usage numbers if the CLI ever reports them.
func parseCursor(stdout []byte, model string) Parsed {
	var p Parsed
	var fresh, cached, out, ctx, pending int
	outputSide := false
	modelOut := func(n int) {
		if !outputSide {
			fresh += pending
			cached += ctx - pending
			pending = 0
			outputSide = true
		}
		out += n
		ctx += n
	}
	modelIn := func(n int) {
		pending += n
		ctx += n
		outputSide = false
	}
	for _, line := range bytes.Split(stdout, []byte("\n")) {
		line = bytes.TrimSpace(line)
		if len(line) == 0 || line[0] != '{' {
			continue
		}
		var ev struct {
			Type     string          `json:"type"`
			Subtype  string          `json:"subtype"`
			Model    string          `json:"model"`
			Result   string          `json:"result"`
			ToolCall json.RawMessage `json:"tool_call"`
			Message  struct {
				Content []struct {
					Text string `json:"text"`
				} `json:"content"`
			} `json:"message"`
		}
		if json.Unmarshal(line, &ev) != nil {
			continue
		}
		text := 0
		for _, c := range ev.Message.Content {
			text += len(c.Text)
		}
		switch {
		case ev.Type == "system" && ev.Model != "" && model == "":
			model = ev.Model
		case ev.Type == "user":
			modelIn(text)
		case ev.Type == "assistant":
			modelOut(text)
		case ev.Type == "tool_call" && ev.Subtype == "started":
			modelOut(len(ev.ToolCall))
		case ev.Type == "tool_call" && ev.Subtype == "completed":
			modelIn(len(ev.ToolCall))
		case ev.Type == "result":
			p.Text = clip(ev.Result, maxText)
		}
	}
	if p.Text == "" {
		p.Text = clip(string(stdout), maxText)
	}
	in, cache, outPrice := cursorPrice(model)
	p.Tokens = (fresh + cached + out) / 4
	p.USD = (float64(fresh)*in + float64(cached)*cache + float64(out)*outPrice) / 4 / 1e6
	p.HasUSD, p.Estimated, p.Model = true, true, model
	return p
}

// cursorPrice is USD per million tokens (input, cache read, output) from cursor.com/docs/models.
func cursorPrice(model string) (in, cache, out float64) {
	m := strings.ToLower(model)
	in, cache, out = 2, 0.5, 6 // Grok 4.5, 4.6 and 4.7
	if strings.Contains(m, "composer") {
		in, cache, out = 0.5, 0.2, 2.5
	}
	if strings.Contains(m, "fast") || strings.Contains(m, "500k") {
		in, cache, out = in*2, cache*2, out*2
	}
	return in, cache, out
}

// Some accounts list Grok 4.6 as "cursor-grok-4.6-high"; only the full slug is accepted by --model.
var modelSlug = regexp.MustCompile(`(?:cursor-)?grok-4\.[67][a-z0-9.-]*`)

// PickCursorModel chooses from `cursor-agent --list-models`: Grok 4.6 for normal work at high effort,
// Grok 4.7 at extra-high effort when the work is hard. Fast and 500k variants cost 2x or more and are
// skipped. An empty result leaves the choice to Cursor.
func PickCursorModel(list, effort string) string {
	var slugs []string
	for _, s := range modelSlug.FindAllString(strings.ToLower(list), -1) {
		s = strings.TrimRight(s, ".-")
		if !strings.Contains(s, "fast") && !strings.Contains(s, "500k") {
			slugs = append(slugs, s)
		}
	}
	families := []string{"grok-4.6", "grok-4.7"}
	efforts := []string{"high", "medium", ""}
	if effort == "xhigh" {
		families = []string{"grok-4.7", "grok-4.6"}
		efforts = []string{"xhigh", "high", "medium", ""}
	}
	for _, f := range families {
		for _, e := range efforts {
			want := f
			if e != "" {
				want += "-" + e
			}
			for _, s := range slugs {
				if strings.TrimPrefix(s, "cursor-") == want {
					return s
				}
			}
		}
	}
	if len(slugs) > 0 {
		return slugs[0]
	}
	return ""
}

func listModels(ctx context.Context, bin string) string {
	cctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	out, _ := exec.CommandContext(cctx, bin, "--list-models").CombinedOutput()
	return string(out)
}

// codexPrices are USD per million tokens (input, cached input, output): standard short-context rates from
// developers.openai.com/api/docs/pricing. With a ChatGPT sign-in Codex is paid by subscription, so this is the API-equivalent cost.
var codexPrices = []struct {
	prefix         string
	in, cache, out float64
}{
	{"gpt-6-astra", 10, 1, 50},
	{"gpt-6.1-sol", 2, 0.10, 10},
	{"gpt-6.1-terra", 1, 0.05, 5},
	{"gpt-6-luna", 0.10, 0.01, 0.50},
	{"gpt-6-sol", 2, 0.20, 10},
	{"gpt-5.6-sol", 4, 0.40, 20},
	{"gpt-5.6-terra", 2, 0.20, 12},
	{"gpt-5.6-luna", 0.20, 0.02, 1.20},
}

func codexPrice(model string) (in, cache, out float64) {
	m := strings.ToLower(model)
	for _, p := range codexPrices {
		if strings.HasPrefix(m, p.prefix) {
			return p.in, p.cache, p.out
		}
	}
	return 2, 0.10, 10 // Codex picks its own model when none is set; priced as its recommended GPT-6.1 Sol
}

func parseCodex(stdout []byte, model string) Parsed {
	var p Parsed
	var in, cached, out int
	var notes []string
	for _, line := range bytes.Split(stdout, []byte("\n")) {
		line = bytes.TrimSpace(line)
		if len(line) == 0 || line[0] != '{' {
			continue
		}
		var ev struct {
			Type  string `json:"type"`
			Usage struct {
				Input     int `json:"input_tokens"`
				Cached    int `json:"cached_input_tokens"`
				Output    int `json:"output_tokens"`
				Reasoning int `json:"reasoning_output_tokens"`
			} `json:"usage"`
			Item struct {
				Type string `json:"type"`
				Text string `json:"text"`
			} `json:"item"`
		}
		if json.Unmarshal(line, &ev) != nil {
			continue
		}
		if ev.Type == "turn.completed" {
			// ponytail: reasoning tokens are billed as output; if a Codex version already counts them in
			// output_tokens this estimate reads high, which errs on the side of stopping early.
			in, cached, out = in+ev.Usage.Input, cached+ev.Usage.Cached, out+ev.Usage.Output+ev.Usage.Reasoning
			p.HasUSD = true
		}
		if ev.Type == "item.completed" && ev.Item.Type == "agent_message" && ev.Item.Text != "" {
			notes = append(notes, ev.Item.Text)
		}
	}
	p.Text = clip(strings.Join(notes, "\n"), maxText)
	if p.Text == "" {
		p.Text = clip(string(stdout), maxText)
	}
	pin, pcache, pout := codexPrice(model)
	p.Tokens = in + out
	p.USD = (float64(max(in-cached, 0))*pin + float64(cached)*pcache + float64(out)*pout) / 1e6
	p.Estimated, p.Model = p.HasUSD, model
	return p
}

func jsonObject(b []byte) []byte {
	i := bytes.IndexByte(b, '{')
	j := bytes.LastIndexByte(b, '}')
	if i >= 0 && j > i {
		return b[i : j+1]
	}
	return b
}

func clip(s string, n int) string {
	s = strings.TrimSpace(s)
	if len(s) <= n {
		return s
	}
	i := len(s) - n
	for i < len(s) && !utf8Start(s[i]) {
		i++
	}
	return s[i:]
}

// maxText bounds an agent's reply. It must hold a whole JSON answer (proposed checks, a lead's plan):
// clip keeps the tail, so a reply cut at the front no longer parses.
const maxText = 32 << 10

// clipEnds keeps both ends of an error: the first line usually says what failed, the last lines why.
func clipEnds(s string, n int) string {
	s = strings.TrimSpace(s)
	if len(s) <= n {
		return s
	}
	i := n / 2
	for i > 0 && !utf8Start(s[i]) {
		i--
	}
	return s[:i] + " … " + clip(s, n-i-5)
}

func utf8Start(b byte) bool {
	return b&0xC0 != 0x80
}
