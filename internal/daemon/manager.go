package daemon

import (
	"bufio"
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

type Manager struct {
	Data       string
	Ixpack     string
	PythonPath string
	Self       string // this binary; the loop calls it as `run-agent`
	Quiet      bool   // no desktop notifications

	mu     sync.Mutex
	runs   map[string]*run
	subsMu sync.Mutex
	subs   map[chan []byte]struct{}
}

type run struct {
	meta     *Meta
	stopping bool
	exited   chan struct{} // closed once the running loop has exited
}

// stopGrace is how long a stopped loop gets to kill its checks and remove its team copies before SIGKILL.
const stopGrace = 10 * time.Second

func now() int64 { return time.Now().UnixMilli() }

func NewManager(data, ixpack, pythonPath, self string) (*Manager, error) {
	m := &Manager{Data: data, Ixpack: ixpack, PythonPath: pythonPath, Self: self, runs: map[string]*run{}, subs: map[chan []byte]struct{}{}}
	if err := os.MkdirAll(m.runsDir(), 0o700); err != nil {
		return nil, err
	}
	for _, meta := range loadMetas(m.runsDir()) {
		if meta.Status == "running" {
			// The previous daemon died mid-run. Kill what it left behind so nothing keeps spending.
			killGroup(meta.LoopPID)
			killChildren(meta.Dir)
			meta.Status, meta.Reason, meta.FinishedAt = "interrupted", "interrupted", now()
			_ = saveMeta(meta)
		}
		if meta.CheckState == nil {
			meta.CheckState = []CheckState{}
		}
		m.runs[meta.ID] = &run{meta: meta}
	}
	m.mu.Lock()
	m.schedule()
	m.mu.Unlock()
	return m, nil
}

func (m *Manager) runsDir() string { return filepath.Join(m.Data, "runs") }

func snapshot(meta *Meta) *Meta {
	c := *meta
	c.CheckState = append([]CheckState{}, meta.CheckState...)
	c.Checks = append([]Check{}, meta.Checks...)
	c.Members = append([]string(nil), meta.Members...)
	return &c
}

func newID() string {
	b := make([]byte, 3)
	_, _ = rand.Read(b)
	return time.Now().Format("20060102-150405") + "-" + hex.EncodeToString(b)
}

func (m *Manager) List() []*Meta {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]*Meta, 0, len(m.runs))
	for _, r := range m.runs {
		out = append(out, snapshot(r.meta))
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt > out[j].CreatedAt })
	return out
}

func (m *Manager) Get(id string) (map[string]any, error) {
	m.mu.Lock()
	r, ok := m.runs[id]
	if !ok {
		m.mu.Unlock()
		return nil, errors.New("run not found")
	}
	meta := snapshot(r.meta)
	m.mu.Unlock()
	ledger, _ := os.ReadFile(filepath.Join(meta.Dir, "ledger.toon"))
	return map[string]any{"meta": meta, "turns": readTurns(meta.Dir), "ledger_toon": string(ledger)}, nil
}

func (m *Manager) Active() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	n := 0
	for _, r := range m.runs {
		if r.meta.active() {
			n++
		}
	}
	return n
}

func (m *Manager) Start(g Goal) (*Meta, error) {
	g.Workspace = filepath.Clean(g.Workspace)
	if err := g.Validate(); err != nil {
		return nil, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, r := range m.runs {
		if r.meta.holdsWorkspace() && r.meta.Workspace == g.Workspace {
			return nil, fmt.Errorf("another run is already working in %s", g.Workspace)
		}
	}
	id := newID()
	dir := filepath.Join(m.runsDir(), id)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	meta := &Meta{Goal: g, ID: id, Status: "queued", CheckState: []CheckState{}, CreatedAt: now(), CurrentAgent: g.Agent, Dir: dir}
	if err := m.writeGoal(meta); err != nil {
		os.RemoveAll(dir)
		return nil, fmt.Errorf("writing goal: %w", err)
	}
	if err := saveMeta(meta); err != nil {
		os.RemoveAll(dir)
		return nil, err
	}
	m.runs[id] = &run{meta: meta}
	m.broadcast(meta, map[string]any{"type": "queued"})
	m.schedule()
	return snapshot(meta), nil
}

// writeGoal stores the goal, plus the settings that shape each turn, as TOON for the loop.
func (m *Manager) writeGoal(meta *Meta) error {
	s := loadSettings(m.Data)
	checks := meta.Checks
	if checks == nil {
		checks = []Check{}
	}
	goal := map[string]any{
		"intent": meta.Intent, "kind": meta.Kind, "hypothesis": meta.Hypothesis, "agent": meta.Agent,
		"budget_usd": meta.BudgetUSD, "max_turns": meta.MaxTurns, "switch_agent": meta.SwitchAgent, "team": meta.Team,
		"auto_limits": meta.AutoLimits, "autonomous": meta.Autonomous, "allow_network": meta.AllowNetwork,
		"check_timeout": s.CheckTimeout, "lean": *s.Lean,
		"model_claude": s.Models["claude"], "model_codex": s.Models["codex"], "model_cursor": s.Models["cursor"],
		"checks": checks, "hints": append([]string{}, meta.Hints...),
	}
	b, _ := json.Marshal(goal)
	cmd := exec.Command(m.Ixpack, "encode")
	cmd.Stdin = bytes.NewReader(b)
	out, err := cmd.Output()
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(meta.Dir, "goal.toon"), out, 0o600)
}

// schedule starts queued runs, oldest first, up to the parallel limit. Caller holds m.mu.
func (m *Manager) schedule() {
	limit := loadSettings(m.Data).MaxParallel
	running := 0
	var queued []*run
	for _, r := range m.runs {
		switch r.meta.Status {
		case "running":
			running++
		case "queued":
			if r.meta.LoopPID == 0 { // a reply can arrive while the paused loop is still exiting; its pump reschedules
				queued = append(queued, r)
			}
		}
	}
	sort.Slice(queued, func(i, j int) bool { return queued[i].meta.CreatedAt < queued[j].meta.CreatedAt })
	for _, r := range queued {
		if running >= limit {
			return
		}
		if err := m.launch(r); err != nil {
			r.meta.Status, r.meta.Reason, r.meta.Error, r.meta.FinishedAt = "failed", "error", err.Error(), now()
			_ = saveMeta(r.meta)
			m.broadcast(r.meta, map[string]any{"type": "finished", "ok": false, "reason": "error"})
			continue
		}
		running++
	}
}

// launch spawns the Python loop in its own process group. Caller holds m.mu.
func (m *Manager) launch(r *run) error {
	meta := r.meta
	s := loadSettings(m.Data)
	py := s.Bins["python"]
	if py == "" {
		py = "python3"
	}
	cmd := exec.Command(py, "-m", "iteraxa", "run", "--goal", filepath.Join(meta.Dir, "goal.toon"), "--workspace", meta.Workspace, "--state", meta.Dir)
	cmd.Dir = meta.Workspace
	cmd.Env = append(os.Environ(), "PYTHONPATH="+m.PythonPath, "PYTHONUNBUFFERED=1", "IX_BIN="+m.Self, "IXPACK_BIN="+m.Ixpack)
	if b := s.Bins["claude"]; b != "" {
		cmd.Env = append(cmd.Env, "ITERAXA_CLAUDE_BIN="+b)
	}
	for _, a := range []string{"codex", "cursor"} {
		if b := s.Bins[a]; b != "" {
			cmd.Env = append(cmd.Env, "ITERAXA_"+strings.ToUpper(a)+"_BIN="+b)
		}
	}
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	logf, err := os.Create(filepath.Join(meta.Dir, "loop.log"))
	if err != nil {
		return err
	}
	cmd.Stderr = logf
	if err := cmd.Start(); err != nil {
		logf.Close()
		return err
	}
	t := now()
	if meta.StartedAt == 0 {
		meta.StartedAt = t
	}
	meta.Status, meta.TurnStartedAt, meta.LoopPID, meta.Ask, meta.ResumeAt = "running", t, cmd.Process.Pid, nil, 0
	r.exited = make(chan struct{})
	_ = saveMeta(meta)
	m.broadcast(meta, map[string]any{"type": "start"})
	go m.pump(r, cmd, stdout, logf)
	return nil
}

type event struct {
	Type        string          `json:"type"`
	N           int             `json:"n"`
	Agent       string          `json:"agent"`
	OK          bool            `json:"ok"`
	Reason      string          `json:"reason"`
	Error       string          `json:"error"`
	SpentUSD    float64         `json:"spent_usd"`
	Tokens      int64           `json:"tokens"`
	TokensTotal int64           `json:"tokens_total"`
	Results     []CheckState    `json:"results"`
	Kind        string          `json:"kind"`
	Question    string          `json:"question"`
	Checks      []Check         `json:"checks"`
	Verdict     json.RawMessage `json:"verdict"`
	Report      json.RawMessage `json:"report"`
	ReportPath  string          `json:"report_path"`
	Phase       string          `json:"phase"`
	Members     []string        `json:"members"`
	BudgetUSD   float64         `json:"budget_usd"`
	MaxTurns    int             `json:"max_turns"`
	ResumeAt    int64           `json:"resume_at"` // limited: when the usage limit lifts (ms)
	Success     string          `json:"success"`   // scoped: what "done" looks like
	Note        string          `json:"note"`      // finished: the judge's stop reason for a good-enough run
}

func fold(meta *Meta, ev event) {
	switch ev.Type {
	case "checks":
		meta.CheckState = ev.Results
	case "running":
		meta.CurrentAgent, meta.TurnStartedAt, meta.Phase, meta.Members, meta.Error = ev.Agent, now(), ev.Phase, ev.Members, ""
		meta.ResumeAt = 0
	case "limited":
		// Every installed agent is out on a usage limit: the loop sleeps until ResumeAt, then carries on.
		meta.CurrentAgent, meta.Phase, meta.Members, meta.Error, meta.ResumeAt = ev.Agent, "limit", nil, ev.Error, ev.ResumeAt
	case "turn":
		meta.TurnsUsed, meta.SpentUSD, meta.Tokens, meta.CurrentAgent = ev.N, ev.SpentUSD, ev.TokensTotal, ev.Agent
	case "sized":
		meta.BudgetUSD, meta.MaxTurns = ev.BudgetUSD, ev.MaxTurns
	case "proposed", "review", "plan", "findings", "attempts", "failed", "judged":
		meta.SpentUSD, meta.Tokens = ev.SpentUSD, ev.TokensTotal
	case "scoped":
		meta.SpentUSD, meta.Tokens, meta.Success = ev.SpentUSD, ev.TokensTotal, ev.Success
		if len(ev.Checks) > 0 { // show what the autonomous run will verify, when it inferred runnable checks
			meta.Checks = append([]Check{}, ev.Checks...)
		}
	case "report":
		meta.Report, meta.ReportPath, meta.SpentUSD, meta.Tokens = ev.Report, ev.ReportPath, ev.SpentUSD, ev.TokensTotal
	case "ask":
		meta.Status, meta.SpentUSD, meta.Phase, meta.Members = "waiting", ev.SpentUSD, "", nil
		meta.Ask = &Ask{Kind: ev.Kind, Question: ev.Question, Checks: append([]Check{}, ev.Checks...)}
	case "finished":
		meta.Status = "failed"
		if ev.OK {
			meta.Status = "passed"
		}
		meta.Reason, meta.Error, meta.SpentUSD, meta.Tokens, meta.FinishedAt = ev.Reason, ev.Error, ev.SpentUSD, ev.Tokens, now()
		meta.Verdict, meta.Phase, meta.Members, meta.StopReason, meta.ResumeAt = ev.Verdict, "", nil, ev.Note, 0
	}
}

// stampAt adds an "at" wall-clock (ms) to an event's JSON when it has none, so the UI can show how long
// each phase took. The loop's events arrive without one; the daemon's own events already set it.
func stampAt(line []byte, t int64) []byte {
	var m map[string]json.RawMessage
	if json.Unmarshal(line, &m) != nil {
		return append([]byte(nil), line...)
	}
	if _, ok := m["at"]; !ok {
		m["at"], _ = json.Marshal(t)
	}
	if b, err := json.Marshal(m); err == nil {
		return b
	}
	return append([]byte(nil), line...)
}

// pump records each loop event, folds it into meta.json and broadcasts it, then settles the run.
func (m *Manager) pump(r *run, cmd *exec.Cmd, stdout io.Reader, logf *os.File) {
	evf, _ := os.OpenFile(filepath.Join(r.meta.Dir, "events.jsonl"), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	sc := bufio.NewScanner(stdout)
	sc.Buffer(make([]byte, 64*1024), 4<<20)
	for sc.Scan() {
		var ev event
		if json.Unmarshal(sc.Bytes(), &ev) != nil || ev.Type == "" {
			continue
		}
		line := stampAt(sc.Bytes(), now()) // loop events carry no clock; stamp one so the UI can time each phase
		if evf != nil {
			evf.Write(append(line, '\n'))
		}
		m.mu.Lock()
		if !r.stopping {
			fold(r.meta, ev)
			_ = saveMeta(r.meta)
		}
		snap := snapshot(r.meta)
		m.mu.Unlock()
		m.broadcast(snap, json.RawMessage(line))
	}
	err := cmd.Wait()
	logf.Close()
	if evf != nil {
		evf.Close()
	}
	killChildren(r.meta.Dir)
	cleanForks(r.meta.ID)

	m.mu.Lock()
	close(r.exited)
	meta := r.meta
	switch {
	case r.stopping:
		meta.Status, meta.Reason, meta.Ask = "stopped", "stopped", nil
	case meta.Status == "running":
		meta.Status, meta.Reason, meta.Error = "failed", "error", loopError(meta.Dir, err)
	}
	r.stopping = false
	if meta.Status != "waiting" && meta.Status != "queued" && (meta.FinishedAt == 0 || meta.Status == "stopped") {
		meta.FinishedAt = now()
	}
	meta.LoopPID, meta.Phase, meta.ResumeAt = 0, "", 0
	_ = saveMeta(meta)
	snap := snapshot(meta)
	m.schedule()
	m.mu.Unlock()
	m.broadcast(snap, map[string]any{"type": "closed"})
	if !m.Quiet && (snap.Status == "passed" || snap.Status == "failed" || snap.Status == "waiting") {
		notify(snap)
	}
}

// Reply answers a waiting run, approving its checks or giving a hint, and queues it to carry on
// where it paused: the loop keeps its turns, spend and ruled-out causes in the run folder.
func (m *Manager) Reply(id string, checks []Check, hint string) (*Meta, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	r, ok := m.runs[id]
	if !ok {
		return nil, errors.New("run not found")
	}
	meta := r.meta
	if meta.Status != "waiting" || meta.Ask == nil {
		return nil, errors.New("this run is not waiting for you")
	}
	g := meta.Goal
	hint = strings.TrimSpace(hint)
	switch {
	case meta.Ask.Kind == "checks" && len(checks) == 0:
		return nil, errors.New("approve at least one check")
	case meta.Ask.Kind != "checks" && hint == "":
		return nil, errors.New("write a reply for the agent")
	}
	if len(checks) > 0 {
		g.Checks = checks
	}
	if hint != "" {
		g.Hints = append(append([]string{}, g.Hints...), hint)
	}
	if err := g.Validate(); err != nil {
		return nil, err
	}
	meta.Goal = g
	if err := m.writeGoal(meta); err != nil {
		return nil, fmt.Errorf("writing goal: %w", err)
	}
	meta.Status, meta.Ask, meta.FinishedAt = "queued", nil, 0
	_ = saveMeta(meta)
	m.record(meta, map[string]any{"type": "replied", "hint": hint, "checks": checks, "at": now()})
	m.schedule()
	return snapshot(meta), nil
}

// Extend raises the limit a run stopped on (budget or turns) and queues it to continue where it stopped:
// the loop keeps its turns, spend and ruled-out causes in the run folder. Limits only go up.
func (m *Manager) Extend(id string, budget float64, maxTurns int) (*Meta, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	r, ok := m.runs[id]
	if !ok {
		return nil, errors.New("run not found")
	}
	meta := r.meta
	if meta.Status != "failed" || (meta.Reason != "budget" && meta.Reason != "max_turns") {
		return nil, errors.New("only a run stopped by its budget or turn limit can continue")
	}
	for _, o := range m.runs {
		if o != r && o.meta.holdsWorkspace() && o.meta.Workspace == meta.Workspace {
			return nil, fmt.Errorf("another run is already working in %s", meta.Workspace)
		}
	}
	g := meta.Goal
	switch {
	case budget < g.BudgetUSD || maxTurns < g.MaxTurns:
		return nil, errors.New("the budget and max turns can only go up")
	case budget == g.BudgetUSD && maxTurns == g.MaxTurns:
		return nil, errors.New("raise the budget or max turns to continue")
	case budget <= meta.SpentUSD:
		return nil, fmt.Errorf("the budget must be above the $%.2f already spent", meta.SpentUSD)
	case maxTurns <= meta.TurnsUsed:
		return nil, fmt.Errorf("max turns must be above the %d turns already taken", meta.TurnsUsed)
	}
	g.BudgetUSD, g.MaxTurns = budget, maxTurns
	if err := g.Validate(); err != nil {
		return nil, err
	}
	meta.Goal = g
	if err := m.writeGoal(meta); err != nil {
		return nil, fmt.Errorf("writing goal: %w", err)
	}
	meta.Status, meta.Reason, meta.Error, meta.FinishedAt = "queued", "", "", 0
	_ = saveMeta(meta)
	m.record(meta, map[string]any{"type": "extended", "budget_usd": budget, "max_turns": maxTurns, "at": now()})
	m.schedule()
	return snapshot(meta), nil
}

// record adds an event of the daemon's own (not the loop's) to the run's timeline and broadcasts it.
func (m *Manager) record(meta *Meta, ev map[string]any) {
	if b, err := json.Marshal(ev); err == nil {
		if f, err := os.OpenFile(filepath.Join(meta.Dir, "events.jsonl"), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600); err == nil {
			_, _ = f.Write(append(b, '\n'))
			f.Close()
		}
	}
	m.broadcast(meta, ev)
}

func loopError(dir string, err error) string {
	b, _ := os.ReadFile(filepath.Join(dir, "loop.log"))
	lines := strings.Split(strings.TrimSpace(string(b)), "\n")
	if last := strings.TrimSpace(lines[len(lines)-1]); last != "" {
		return last
	}
	if err != nil {
		return "the goal loop exited: " + err.Error()
	}
	return "the goal loop exited without a result"
}

func (m *Manager) Stop(id string) error {
	m.mu.Lock()
	r, ok := m.runs[id]
	if !ok {
		m.mu.Unlock()
		return errors.New("run not found")
	}
	switch r.meta.Status {
	case "queued", "waiting":
		r.meta.Status, r.meta.Reason, r.meta.FinishedAt, r.meta.Ask = "stopped", "stopped", now(), nil
		_ = saveMeta(r.meta)
		snap := snapshot(r.meta)
		m.mu.Unlock()
		m.broadcast(snap, map[string]any{"type": "closed"})
		return nil
	case "running":
		r.stopping = true
		pid, dir, exited := r.meta.LoopPID, r.meta.Dir, r.exited
		m.mu.Unlock()
		// SIGTERM lets the loop kill its checks and remove its team copies; whatever is left after the grace
		// period, or still in the group once the loop has gone, is killed outright.
		_ = syscall.Kill(-pid, syscall.SIGTERM)
		killChildren(dir)
		go func() {
			select {
			case <-exited:
			case <-time.After(stopGrace):
			}
			killGroup(pid)
			killChildren(dir)
		}()
		return nil
	default:
		m.mu.Unlock()
		return errors.New("this run is not active")
	}
}

func (m *Manager) Delete(id string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	r, ok := m.runs[id]
	if !ok {
		return errors.New("run not found")
	}
	if r.meta.active() {
		return errors.New("stop the run before deleting it")
	}
	delete(m.runs, id)
	return os.RemoveAll(r.meta.Dir)
}

// ponytail: a pid from a dead daemon could in theory be reused by now; we only signal it if it exists.
func killGroup(pid int) {
	if pid > 0 && syscall.Kill(-pid, 0) == nil {
		_ = syscall.Kill(-pid, syscall.SIGKILL)
	}
}

// killChildren kills what a run started in process groups of their own, so killing the loop's group misses them:
// every agent CLI (agent-<tag>.pid, one or a team working in parallel) and every check command (check-<tag>.pid).
func killChildren(dir string) {
	agents, _ := filepath.Glob(filepath.Join(dir, "agent*.pid"))
	checks, _ := filepath.Glob(filepath.Join(dir, "check*.pid"))
	for _, f := range append(agents, checks...) {
		b, err := os.ReadFile(f)
		if err != nil {
			continue
		}
		if pid, err := strconv.Atoi(strings.TrimSpace(string(b))); err == nil {
			killGroup(pid)
		}
	}
}

// cleanForks removes the workspace copies a team round left in the temp folder when its loop was killed before it
// could (the loop names them iteraxa-team-<run id>-*). RemoveAll deletes symlinks without following them, so the
// dependency folders a copy links to in the user's workspace are untouched.
func cleanForks(id string) {
	dirs, _ := filepath.Glob(filepath.Join(os.TempDir(), "iteraxa-team-"+id+"-*"))
	for _, d := range dirs {
		_ = os.RemoveAll(d)
	}
}

func (m *Manager) subscribe() chan []byte {
	ch := make(chan []byte, 256)
	m.subsMu.Lock()
	m.subs[ch] = struct{}{}
	m.subsMu.Unlock()
	return ch
}

func (m *Manager) unsubscribe(ch chan []byte) {
	m.subsMu.Lock()
	delete(m.subs, ch)
	m.subsMu.Unlock()
}

func (m *Manager) broadcast(meta *Meta, ev any) {
	b, err := json.Marshal(map[string]any{"run": meta, "ev": ev})
	if err != nil {
		return
	}
	b = append(b, '\n')
	m.subsMu.Lock()
	defer m.subsMu.Unlock()
	for ch := range m.subs {
		select {
		case ch <- b:
		default: // a stuck subscriber must not block runs; it will resync from list
		}
	}
}

func notify(meta *Meta) {
	title, body := "Goal reached", meta.Intent
	switch {
	case meta.Status == "waiting" && meta.Ask != nil:
		title, body = "Needs your input", meta.Ask.Question
	case meta.Status != "passed":
		title = "Goal not reached"
	}
	var cmd *exec.Cmd
	if runtime.GOOS == "darwin" {
		q := func(s string) string { return `"` + strings.NewReplacer(`\`, `\\`, `"`, `\"`).Replace(s) + `"` }
		cmd = exec.Command("osascript", "-e", fmt.Sprintf("display notification %s with title %s", q(body), q("Iteraxa: "+title)))
	} else {
		cmd = exec.Command("notify-send", "-a", "Iteraxa", title, body)
	}
	go func() { _ = cmd.Run() }()
}
