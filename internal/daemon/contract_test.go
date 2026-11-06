package daemon

import (
	"encoding/json"
	"os"
	"regexp"
	"slices"
	"strings"
	"testing"
)

// The loop (Python), the daemon (Go) and the window (JS) share event names, the team roster and a version by
// convention rather than a schema. These tests read the other layers' sources so that drift fails here.

func source(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile("../../" + path)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// Events the run header folds live; they are not drawn in the timeline.
var liveEvents = map[string]bool{"start": true, "running": true, "checks": true, "finished": true, "report": true}

func TestEveryLoopEventIsKeptAndDrawn(t *testing.T) {
	loop, runJS := source(t, "python/iteraxa/loop.py"), source(t, "app/ui/js/views/run.js")
	emitted := regexp.MustCompile(`"type": "([a-z_]+)"`).FindAllStringSubmatch(loop, -1)
	if len(emitted) < 10 {
		t.Fatalf("found only %d emitted events; has the loop's emit format changed?", len(emitted))
	}
	for _, m := range emitted {
		if !liveEvents[m[1]] && !timelineEvents[m[1]] {
			t.Errorf("the loop emits %q, but the daemon neither folds it live nor keeps it in the timeline", m[1])
		}
	}
	for ev := range timelineEvents {
		if ev != "turn" && !strings.Contains(runJS, "case '"+ev+"'") { // turns have their own card
			t.Errorf("the timeline keeps %q events, but run.js has no case to draw them", ev)
		}
	}
}

func TestTeamRosterMatchesTheWindow(t *testing.T) {
	py, js := source(t, "python/iteraxa/team.py"), source(t, "app/ui/js/util.js")
	block := regexp.MustCompile(`(?s)export const TEAM = \[(.*?)\]\.map`).FindStringSubmatch(js)
	if block == nil {
		t.Fatal("util.js no longer declares TEAM as an array literal")
	}
	var roster, team []string
	for _, m := range regexp.MustCompile(`"agent": "(\w+)".*"tier": "(\w+)"`).FindAllStringSubmatch(py, -1) {
		roster = append(roster, m[1]+"/"+m[2])
	}
	for _, m := range regexp.MustCompile(`\['(\w+)', '[^']+', '(\w+)'\]`).FindAllStringSubmatch(block[1], -1) {
		team = append(team, m[1]+"/"+m[2])
	}
	slices.Sort(roster)
	slices.Sort(team)
	if len(roster) == 0 || !slices.Equal(roster, team) {
		t.Errorf("team.py ROSTER %v and util.js TEAM %v list different members", roster, team)
	}
	vendors := regexp.MustCompile(`VENDORS = \(([^)]*)\)`).FindStringSubmatch(py)
	agents := regexp.MustCompile(`AGENTS = \[([^\]]*)\]`).FindStringSubmatch(js)
	if vendors == nil || agents == nil || strings.ReplaceAll(vendors[1], `"`, "'") != agents[1] {
		t.Errorf("team.py VENDORS %v and util.js AGENTS %v differ in order", vendors, agents)
	}
}

// The app restarts an idle daemon whose version differs from its own, so all three must move together.
func TestVersionsMatch(t *testing.T) {
	cargo := regexp.MustCompile(`(?m)^version = "([^"]+)"`).FindStringSubmatch(source(t, "app/Cargo.toml"))
	var conf struct {
		Version string `json:"version"`
	}
	if err := json.Unmarshal([]byte(source(t, "app/tauri.conf.json")), &conf); err != nil {
		t.Fatal(err)
	}
	if cargo == nil || cargo[1] != Version || conf.Version != Version {
		t.Fatalf("app/Cargo.toml %v, app/tauri.conf.json %q and daemon.Version %q must match", cargo, conf.Version, Version)
	}
}
