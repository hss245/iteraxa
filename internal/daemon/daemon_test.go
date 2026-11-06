package daemon

import (
	"bufio"
	"encoding/json"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

// A stand-in for `python -m iteraxa run`: quick goals pass in one turn, "slow" goals block until stopped.
const fakeLoop = `#!/bin/sh
while [ $# -gt 0 ]; do case "$1" in --state) state="$2"; shift;; esac; shift; done
echo '{"type":"start"}'
if grep -q broke "$state/goal.toon"; then
  if grep -q '"budget_usd":3' "$state/goal.toon"; then
    echo '{"type":"turn","n":2,"agent":"claude","check":"t","cost_usd":0.5,"spent_usd":1.5,"tokens_total":0}'
    echo '{"type":"finished","ok":true,"reason":"checks_passed","spent_usd":1.5,"tokens":0}'
    exit 0
  fi
  echo '{"type":"turn","n":1,"agent":"claude","check":"t","cost_usd":1,"spent_usd":1,"tokens_total":0}'
  echo '{"type":"finished","ok":false,"reason":"budget","spent_usd":1,"tokens":0}'
  exit 2
fi
if grep -q needs-approval "$state/goal.toon"; then
  if grep -q '"approved"' "$state/goal.toon"; then
    sleep 1
    echo '{"type":"finished","ok":true,"reason":"checks_passed","spent_usd":0.2,"tokens":0}'
    exit 0
  fi
  echo '{"type":"ask","kind":"checks","question":"Approve?","checks":[{"id":"approved","cmd":"true"}],"spent_usd":0.1}'
  sleep 0.5
  exit 3
fi
if grep -q slow "$state/goal.toon"; then
  sleep 30 &
  echo $! > "$state/child.pid"
  echo '{"type":"running","n":1,"agent":"claude"}'
  wait
  exit 0
fi
echo '{"type":"checks","results":[{"id":"t","code":1,"ok":false}]}'
echo '{"type":"turn","n":1,"agent":"claude","check":"t","cost_usd":0.1,"spent_usd":0.1,"tokens_total":0}'
echo '{"type":"finished","ok":true,"reason":"checks_passed","spent_usd":0.1,"tokens":0}'
`

func setup(t *testing.T) (data string) {
	t.Helper()
	data, err := os.MkdirTemp("/tmp", "ixd") // short: unix socket paths are limited to ~104 bytes
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(data) })
	loop := filepath.Join(data, "loop.sh")
	must(t, os.WriteFile(loop, []byte(fakeLoop), 0o755))
	must(t, os.WriteFile(filepath.Join(data, "ixpack"), []byte("#!/bin/sh\ncat\n"), 0o755))
	must(t, writeJSON(filepath.Join(data, "settings.json"), map[string]any{"bins": map[string]string{"python": loop}}))
	return data
}

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}

func goal(ws, intent string) map[string]any {
	return map[string]any{"intent": intent, "workspace": ws, "agent": "claude", "budget_usd": 1, "max_turns": 3, "checks": []Check{{ID: "t", Cmd: "true"}}}
}

func call(t *testing.T, sock string, req map[string]any) reply {
	t.Helper()
	c, err := net.Dial("unix", sock)
	must(t, err)
	defer c.Close()
	must(t, json.NewEncoder(c).Encode(req))
	var r reply
	line, _ := bufio.NewReader(c).ReadBytes('\n')
	must(t, json.Unmarshal(line, &r))
	return r
}

func waitFor(t *testing.T, events <-chan Meta, id, status string) {
	t.Helper()
	deadline := time.After(10 * time.Second)
	for {
		select {
		case m := <-events:
			if m.ID == id && m.Status == status {
				return
			}
			if m.ID == id && m.Status == "failed" {
				t.Fatalf("run %s failed while waiting for %s: %s", id, status, m.Error)
			}
		case <-deadline:
			t.Fatalf("run %s never reached %s", id, status)
		}
	}
}

func alive(pid int) bool { return syscall.Kill(pid, 0) == nil }

func TestDaemon(t *testing.T) {
	data := setup(t)
	m, err := NewManager(data, filepath.Join(data, "ixpack"), "", "/usr/bin/true")
	must(t, err)
	m.Quiet = true
	sock := filepath.Join(data, "ixd.sock")
	go Serve(m, sock)
	for i := 0; i < 100 && !fileExists(sock); i++ {
		time.Sleep(10 * time.Millisecond)
	}
	if st, err := os.Stat(sock); err != nil || st.Mode().Perm() != 0o600 {
		t.Fatalf("socket must be private: %v %v", st, err)
	}

	// Events are persisted and broadcast.
	sub, err := net.Dial("unix", sock)
	must(t, err)
	defer sub.Close()
	must(t, json.NewEncoder(sub).Encode(map[string]string{"op": "subscribe"}))
	events := make(chan Meta, 64)
	go func() {
		sc := bufio.NewScanner(sub)
		sc.Scan() // ok reply
		for sc.Scan() {
			var msg struct{ Run Meta }
			if json.Unmarshal(sc.Bytes(), &msg) == nil {
				events <- msg.Run
			}
		}
	}()
	ws1, ws2 := t.TempDir(), t.TempDir()
	r := call(t, sock, map[string]any{"op": "start", "goal": goal(ws1, "quick")})
	if !r.OK {
		t.Fatalf("start: %s", r.Error)
	}
	id := r.Data.(map[string]any)["id"].(string)
	waitFor(t, events, id, "passed")
	got, _ := m.Get(id)
	if turns := got["turns"].([]json.RawMessage); len(turns) != 1 {
		t.Fatalf("want 1 turn, got %d", len(turns))
	}
	if b, _ := os.ReadFile(filepath.Join(data, "runs", id, "events.jsonl")); strings.Count(string(b), "\n") != 4 {
		t.Fatalf("events.jsonl:\n%s", b)
	}

	// No checks: the run asks for approval, holds its folder while waiting, and resumes once checks are approved.
	ws3 := t.TempDir()
	g := goal(ws3, "needs-approval")
	g["checks"], g["agent"] = []Check{}, "cursor"
	r = call(t, sock, map[string]any{"op": "start", "goal": g})
	if !r.OK {
		t.Fatalf("start without checks: %s", r.Error)
	}
	ask := r.Data.(map[string]any)["id"].(string)
	waitFor(t, events, ask, "waiting")
	got, _ = m.Get(ask)
	if meta := got["meta"].(*Meta); meta.Ask == nil || meta.Ask.Kind != "checks" || meta.Ask.Checks[0].ID != "approved" || meta.SpentUSD != 0.1 {
		t.Fatalf("waiting meta: %+v", meta)
	}
	if r = call(t, sock, map[string]any{"op": "start", "goal": goal(ws3, "again")}); r.OK {
		t.Fatal("a waiting run must keep its workspace")
	}
	if r = call(t, sock, map[string]any{"op": "reply", "id": ask, "hint": "go"}); r.OK || !strings.Contains(r.Error, "approve") {
		t.Fatalf("a check proposal needs checks, not a hint: %+v", r)
	}
	if r = call(t, sock, map[string]any{"op": "reply", "id": ask, "checks": []Check{{ID: "approved", Cmd: "true"}}}); !r.OK {
		t.Fatalf("reply: %s", r.Error)
	}
	waitFor(t, events, ask, "passed")
	got, _ = m.Get(ask)
	if tl := got["turns"].([]json.RawMessage); len(tl) != 2 || !strings.Contains(string(tl[0]), `"ask"`) || !strings.Contains(string(tl[1]), `"replied"`) {
		t.Fatalf("timeline should show the ask and the reply: %s", tl)
	}
	if r = call(t, sock, map[string]any{"op": "reply", "id": ask, "hint": "more"}); r.OK {
		t.Fatal("only waiting runs take replies")
	}
	// Stopped by its budget: raising the limit continues the same run with its turns and spend.
	ws4 := t.TempDir()
	r = call(t, sock, map[string]any{"op": "start", "goal": goal(ws4, "broke")})
	if !r.OK {
		t.Fatalf("start broke: %s", r.Error)
	}
	broke := r.Data.(map[string]any)["id"].(string)
	waitFor(t, events, broke, "failed")
	for settled := false; !settled; { // drain until the loop has exited, so no stale "failed" is queued
		select {
		case m := <-events:
			settled = m.ID == broke && m.LoopPID == 0
		case <-time.After(5 * time.Second):
			t.Fatal("the stopped loop never exited")
		}
	}
	for _, bad := range []map[string]any{
		{"op": "extend", "id": broke, "budget_usd": 1, "max_turns": 3},   // nothing raised
		{"op": "extend", "id": broke, "budget_usd": 0.5, "max_turns": 9}, // lowered
		{"op": "extend", "id": ask, "budget_usd": 3, "max_turns": 9},     // passed, not stopped
	} {
		if r = call(t, sock, bad); r.OK {
			t.Fatalf("extend should be refused: %v", bad)
		}
	}
	if r = call(t, sock, map[string]any{"op": "extend", "id": broke, "budget_usd": 3, "max_turns": 3}); !r.OK {
		t.Fatalf("extend: %s", r.Error)
	}
	waitFor(t, events, broke, "passed")
	got, _ = m.Get(broke)
	if meta := got["meta"].(*Meta); meta.BudgetUSD != 3 || meta.SpentUSD != 1.5 || meta.TurnsUsed != 2 {
		t.Fatalf("extended meta: %+v", meta)
	}
	if tl := got["turns"].([]json.RawMessage); len(tl) != 3 || !strings.Contains(string(tl[1]), `"extended"`) {
		t.Fatalf("timeline should show turn, extended, turn: %s", tl)
	}

	bad := goal(ws3, "h")
	bad["kind"] = "hypothesis"
	if r = call(t, sock, map[string]any{"op": "start", "goal": bad}); r.OK || !strings.Contains(r.Error, "hypothesis") {
		t.Fatalf("a hypothesis goal needs the hypothesis: %+v", r)
	}

	// One active run per workspace.
	r = call(t, sock, map[string]any{"op": "start", "goal": goal(ws2, "slow")})
	if !r.OK {
		t.Fatalf("start slow: %s", r.Error)
	}
	slow := r.Data.(map[string]any)["id"].(string)
	if r = call(t, sock, map[string]any{"op": "start", "goal": goal(ws2, "again")}); r.OK || !strings.Contains(r.Error, "already") {
		t.Fatalf("second run on the same workspace should be rejected: %+v", r)
	}

	// Stop kills the whole process group, including the loop's children.
	pidFile := filepath.Join(data, "runs", slow, "child.pid")
	for i := 0; i < 200 && !fileExists(pidFile); i++ {
		time.Sleep(10 * time.Millisecond)
	}
	b, _ := os.ReadFile(pidFile)
	child, _ := strconv.Atoi(strings.TrimSpace(string(b)))
	if child == 0 || !alive(child) {
		t.Fatalf("slow loop child not running: %q", b)
	}
	if r = call(t, sock, map[string]any{"op": "stop", "id": slow}); !r.OK {
		t.Fatalf("stop: %s", r.Error)
	}
	waitFor(t, events, slow, "stopped")
	for i := 0; i < 200 && alive(child); i++ {
		time.Sleep(10 * time.Millisecond)
	}
	if alive(child) {
		t.Fatal("stop left the loop's child running")
	}

	// After a crash: history reloads, and a run left "running" is marked interrupted with its processes killed.
	orphan := exec.Command("sleep", "30")
	orphan.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	must(t, orphan.Start())
	reaped := make(chan error, 1)
	go func() { reaped <- orphan.Wait() }()
	dir := filepath.Join(data, "runs", "crashed")
	must(t, os.MkdirAll(dir, 0o700))
	must(t, saveMeta(&Meta{Goal: Goal{Intent: "x", Workspace: ws1}, ID: "crashed", Status: "running", LoopPID: orphan.Process.Pid, Dir: dir}))
	m2, err := NewManager(data, filepath.Join(data, "ixpack"), "", "/usr/bin/true")
	must(t, err)
	byID := map[string]string{}
	for _, meta := range m2.List() {
		byID[meta.ID] = meta.Status
	}
	if byID[id] != "passed" || byID[slow] != "stopped" || byID["crashed"] != "interrupted" {
		t.Fatalf("history after restart: %v", byID)
	}
	select {
	case <-reaped:
	case <-time.After(3 * time.Second):
		t.Fatal("orphaned loop was not killed on restart")
	}
}

func fileExists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

func TestStampAt(t *testing.T) {
	var m map[string]any
	if err := json.Unmarshal(stampAt([]byte(`{"type":"ask","phase":"x"}`), 123), &m); err != nil {
		t.Fatal(err)
	}
	if m["at"] != float64(123) || m["type"] != "ask" || m["phase"] != "x" {
		t.Fatalf("stamped event wrong: %v", m)
	}
	// An event that already has a clock keeps it.
	if err := json.Unmarshal(stampAt([]byte(`{"type":"replied","at":99}`), 123), &m); err != nil {
		t.Fatal(err)
	}
	if m["at"] != float64(99) {
		t.Fatalf("overwrote existing at: %v", m["at"])
	}
}

// A second daemon on the same data folder must back off before it touches any run: NewManager kills every
// "running" run it finds, which would end the first daemon's live runs.
func TestLockKeepsASecondDaemonOut(t *testing.T) {
	data := setup(t)
	first, err := Lock(data)
	must(t, err)
	if _, err := Lock(data); err != ErrRunning {
		t.Fatalf("a second lock on the same folder: got %v, want ErrRunning", err)
	}
	first.Close() // the kernel drops the lock when its daemon exits
	again, err := Lock(data)
	must(t, err)
	again.Close()
}

func TestFoldLimitedPausesAndRunningResumes(t *testing.T) {
	meta := &Meta{Status: "running", Phase: "work", Members: []string{"Claude Sonnet"}}
	fold(meta, event{Type: "limited", Agent: "claude", ResumeAt: 1_900_000_000_000, Error: "weekly limit · resets 7:30am"})
	if meta.Phase != "limit" || meta.ResumeAt != 1_900_000_000_000 || meta.Members != nil || meta.Error == "" || meta.Status != "running" {
		t.Fatalf("a usage-limit pause keeps the run running in phase limit: %+v", meta)
	}
	fold(meta, event{Type: "running", Agent: "claude", Phase: "work"})
	if meta.Phase != "work" || meta.ResumeAt != 0 || meta.Error != "" {
		t.Fatalf("the next turn clears the pause: %+v", meta)
	}
}

func TestCleanForksKeepsLinkedFolders(t *testing.T) {
	ws := t.TempDir()
	must(t, os.WriteFile(filepath.Join(ws, "keep.txt"), []byte("mine"), 0o600))
	fork, err := os.MkdirTemp("", "iteraxa-team-20261104-101500-abc123-")
	must(t, err)
	must(t, os.Symlink(ws, filepath.Join(fork, "node_modules")))
	other, err := os.MkdirTemp("", "iteraxa-team-20261104-999999-ffffff-")
	must(t, err)
	defer os.RemoveAll(other)
	cleanForks("20261104-101500-abc123")
	if fileExists(fork) || !fileExists(filepath.Join(ws, "keep.txt")) || !fileExists(other) {
		t.Fatalf("only this run's copies go, and never what they link to: fork=%v ws=%v other=%v",
			fileExists(fork), fileExists(filepath.Join(ws, "keep.txt")), fileExists(other))
	}
}
