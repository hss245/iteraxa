package daemon

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
)

// Version must match the app's Cargo package version; the app restarts an idle daemon on mismatch.
var Version = "0.4.0"

// DataDir must match data_dir() in app/src/system.rs.
func DataDir() string {
	if d := os.Getenv("ITERAXA_DATA"); d != "" {
		return d
	}
	home, _ := os.UserHomeDir()
	if runtime.GOOS == "darwin" {
		return filepath.Join(home, "Library", "Application Support", "Iteraxa")
	}
	if x := os.Getenv("XDG_DATA_HOME"); x != "" {
		return filepath.Join(x, "iteraxa")
	}
	return filepath.Join(home, ".local", "share", "iteraxa")
}

type Check struct {
	ID  string `json:"id"`
	Cmd string `json:"cmd"`
	Why string `json:"why,omitempty"`
}

type CheckState struct {
	ID      string `json:"id"`
	Code    int    `json:"code"`
	OK      bool   `json:"ok"`
	Skipped bool   `json:"skipped,omitempty"`
	Tail    string `json:"tail,omitempty"`
}

type Goal struct {
	Intent       string   `json:"intent"`
	Workspace    string   `json:"workspace"`
	Kind         string   `json:"kind"` // code, research or hypothesis
	Hypothesis   string   `json:"hypothesis,omitempty"`
	Agent        string   `json:"agent"`
	BudgetUSD    float64  `json:"budget_usd"`
	MaxTurns     int      `json:"max_turns"`
	SwitchAgent  bool     `json:"switch_agent"`
	Team         bool     `json:"team"`        // a lead staffs each round from every installed model
	AutoLimits   bool     `json:"auto_limits"` // the lead's first estimate replaces the budget and max turns
	Autonomous   bool     `json:"autonomous"`  // no checks given: the run scopes the goal and judges when to stop, no approval gate
	AllowNetwork bool     `json:"allow_network"`
	Checks       []Check  `json:"checks"`
	Hints        []string `json:"hints,omitempty"` // the user's answers when the run asked
}

// Ask is what a waiting run needs: approval of proposed checks, or a hint.
type Ask struct {
	Kind     string  `json:"kind"`
	Question string  `json:"question"`
	Checks   []Check `json:"checks"`
}

type Meta struct {
	Goal
	ID            string          `json:"id"`
	Status        string          `json:"status"` // queued, running, waiting, passed, failed, stopped, interrupted
	Ask           *Ask            `json:"ask,omitempty"`
	Verdict       json.RawMessage `json:"verdict,omitempty"`
	Report        json.RawMessage `json:"report,omitempty"`
	ReportPath    string          `json:"report_path,omitempty"`
	Success       string          `json:"success,omitempty"`     // what the autonomous scope decided "done" looks like
	StopReason    string          `json:"stop_reason,omitempty"` // why the judge stopped a good-enough run
	Reason        string          `json:"reason"`
	Error         string          `json:"error"`
	SpentUSD      float64         `json:"spent_usd"`
	Tokens        int64           `json:"tokens"`
	TurnsUsed     int             `json:"turns_used"`
	CurrentAgent  string          `json:"current_agent"`
	Phase         string          `json:"phase,omitempty"`     // what the run is doing now: propose, work, staff, investigate, attempts, review, limit
	ResumeAt      int64           `json:"resume_at,omitempty"` // phase "limit": when the usage limit lifts and the run carries on (ms)
	Members       []string        `json:"members,omitempty"`   // who is on it right now, for a team
	CheckState    []CheckState    `json:"check_state"`
	CreatedAt     int64           `json:"created_at"`
	StartedAt     int64           `json:"started_at"`
	FinishedAt    int64           `json:"finished_at"`
	TurnStartedAt int64           `json:"turn_started_at"`
	LoopPID       int             `json:"loop_pid"`
	Dir           string          `json:"dir"`
}

func (m *Meta) active() bool { return m.Status == "queued" || m.Status == "running" }

// holdsWorkspace: a waiting run is mid-task, so no other run may start editing its folder.
func (m *Meta) holdsWorkspace() bool { return m.active() || m.Status == "waiting" }

var checkID = regexp.MustCompile(`^[A-Za-z0-9_.-]{1,40}$`)

// The hypothesis loop adds these rows itself.
var reservedChecks = map[string]bool{"verdict": true, "reproduce": true, "review": true}

// Validate guards the socket boundary: the goal ends up in argv, files and prompts.
// No checks is allowed: the first turn proposes them and the user approves.
func (g *Goal) Validate() error {
	if g.Kind == "" {
		g.Kind = "code"
	}
	switch {
	case len(g.Intent) == 0 || len(g.Intent) > 4000:
		return errors.New("describe the goal (up to 4000 characters)")
	case !filepath.IsAbs(g.Workspace):
		return errors.New("workspace must be an absolute path")
	case g.Kind != "code" && g.Kind != "research" && g.Kind != "hypothesis":
		return fmt.Errorf("unknown goal type %q", g.Kind)
	case g.Kind == "hypothesis" && (len(g.Hypothesis) == 0 || len(g.Hypothesis) > 2000):
		return errors.New("state the hypothesis (up to 2000 characters)")
	case g.Agent != "claude" && g.Agent != "codex" && g.Agent != "cursor":
		return fmt.Errorf("unknown agent %q", g.Agent)
	case !(g.BudgetUSD > 0) || math.IsInf(g.BudgetUSD, 0):
		return errors.New("budget must be above $0")
	case g.MaxTurns < 1:
		return errors.New("max turns must be at least 1")
	case len(g.Checks) > 20:
		return errors.New("use at most 20 checks")
	case len(g.Hints) > 20:
		return errors.New("too many replies on one run")
	}
	if st, err := os.Stat(g.Workspace); err != nil || !st.IsDir() {
		return fmt.Errorf("workspace %s is not a folder", g.Workspace)
	}
	for _, h := range g.Hints {
		if len(h) == 0 || len(h) > 2000 {
			return errors.New("a reply must be 1 to 2000 characters")
		}
	}
	seen := map[string]bool{}
	for _, c := range g.Checks {
		if !checkID.MatchString(c.ID) || seen[c.ID] {
			return fmt.Errorf("check name %q must be unique and use letters, digits, '.', '_' or '-'", c.ID)
		}
		if g.Kind == "hypothesis" && reservedChecks[c.ID] {
			return fmt.Errorf("check name %q is used by the hypothesis test; pick another", c.ID)
		}
		if c.Cmd == "" || len(c.Cmd) > 2000 || len(c.Why) > 300 {
			return fmt.Errorf("check %s needs a command", c.ID)
		}
		seen[c.ID] = true
	}
	return nil
}

func writeJSON(path string, v any) error {
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func saveMeta(m *Meta) error { return writeJSON(filepath.Join(m.Dir, "meta.json"), m) }

func loadMetas(runsDir string) []*Meta {
	entries, _ := os.ReadDir(runsDir)
	var out []*Meta
	for _, e := range entries {
		b, err := os.ReadFile(filepath.Join(runsDir, e.Name(), "meta.json"))
		if err != nil {
			continue
		}
		m := &Meta{}
		if json.Unmarshal(b, m) == nil && m.ID == e.Name() {
			m.Dir = filepath.Join(runsDir, e.Name())
			out = append(out, m)
		}
	}
	return out
}

// The events a run's timeline shows: agent turns, check proposals, reviews, questions, the user's replies and
// raised limits, a team's plans, findings and competing attempts, the lead's sizing and usage-limit pauses.
// contract_test.go keeps this in step with what the loop emits and what run.js draws.
var timelineEvents = map[string]bool{"turn": true, "proposed": true, "review": true, "ask": true, "replied": true,
	"extended": true, "plan": true, "findings": true, "attempts": true, "sized": true, "failed": true,
	"scoped": true, "judged": true, "limited": true}

// readTurns returns a run's timeline events, oldest first.
func readTurns(dir string) []json.RawMessage {
	f, err := os.Open(filepath.Join(dir, "events.jsonl"))
	if err != nil {
		return []json.RawMessage{}
	}
	defer f.Close()
	out := []json.RawMessage{}
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 64*1024), 4<<20)
	for sc.Scan() {
		var ev struct {
			Type string `json:"type"`
		}
		if json.Unmarshal(sc.Bytes(), &ev) == nil && timelineEvents[ev.Type] {
			out = append(out, append(json.RawMessage(nil), sc.Bytes()...))
		}
	}
	return out
}

type Settings struct {
	MaxParallel  int               `json:"max_parallel"`
	CheckTimeout int               `json:"check_timeout_sec"`
	Lean         *bool             `json:"lean"`
	Models       map[string]string `json:"models"`
	Bins         map[string]string `json:"bins"`
}

// loadSettings reads settings.json, written by the app, with defaults for anything missing.
func loadSettings(data string) Settings {
	s := Settings{}
	if b, err := os.ReadFile(filepath.Join(data, "settings.json")); err == nil {
		_ = json.Unmarshal(b, &s)
	}
	if s.MaxParallel < 1 {
		s.MaxParallel = 2
	}
	if s.CheckTimeout < 1 {
		s.CheckTimeout = 120
	}
	if s.Lean == nil {
		t := true
		s.Lean = &t
	}
	return s
}
