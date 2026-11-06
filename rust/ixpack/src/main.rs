use serde::Deserialize;
use serde_json::Value;
use std::io::{self, Read, Write};
use std::process::ExitCode;
use toon_format::{decode, encode, DecodeOptions, Delimiter, EncodeOptions};

const FAIL_LINES: usize = 40;
const FAIL_BYTES: usize = 2000;

/// The loop writes the instructions; ixpack turns the ledger into TOON and trims the failure.
#[derive(Debug, Deserialize)]
struct PackIn {
    brief: String,
    #[serde(default)]
    ledger: Value,
    #[serde(default)]
    failure: String,
}

fn main() -> ExitCode {
    let mut args = std::env::args().skip(1);
    let cmd = args.next().unwrap_or_default();
    let mut raw = String::new();
    if io::stdin().read_to_string(&mut raw).is_err() {
        eprintln!("ixpack: failed to read stdin");
        return ExitCode::from(1);
    }
    let result = match cmd.as_str() {
        "encode" => encode_stdin(&raw),
        "decode" => decode_stdin(&raw),
        "pack" => pack_prompt(&raw),
        _ => {
            eprintln!("usage: ixpack encode|decode|pack");
            return ExitCode::from(2);
        }
    };
    match result {
        Ok(out) => {
            let mut stdout = io::stdout().lock();
            if stdout.write_all(out.as_bytes()).is_err() {
                return ExitCode::from(1);
            }
            ExitCode::SUCCESS
        }
        Err(err) => {
            eprintln!("ixpack: {err}");
            ExitCode::from(1)
        }
    }
}

fn pipe_opts() -> EncodeOptions {
    EncodeOptions::new().with_delimiter(Delimiter::Pipe)
}

fn encode_stdin(raw: &str) -> Result<String, String> {
    let value: Value = serde_json::from_str(raw).map_err(|e| e.to_string())?;
    let mut out = encode(&value, &pipe_opts()).map_err(|e| e.to_string())?;
    if !out.ends_with('\n') {
        out.push('\n');
    }
    Ok(out)
}

fn decode_stdin(raw: &str) -> Result<String, String> {
    let value: Value = decode(raw, &DecodeOptions::default()).map_err(|e| e.to_string())?;
    let mut out = serde_json::to_string(&value).map_err(|e| e.to_string())?;
    out.push('\n');
    Ok(out)
}

fn encode_ledger(ledger: &Value) -> Result<String, String> {
    encode(ledger, &EncodeOptions::default()).map_err(|e| e.to_string())
}

fn pack_prompt(raw: &str) -> Result<String, String> {
    let input: PackIn = serde_json::from_str(raw).map_err(|e| e.to_string())?;
    let mut out = input.brief.trim().to_string();
    out.push('\n');
    let empty = match &input.ledger {
        Value::Null => true,
        Value::Object(m) => m.is_empty(),
        _ => false,
    };
    if !empty {
        out.push('\n');
        out.push_str(encode_ledger(&input.ledger)?.trim_end());
        out.push('\n');
    }
    let failure = trim_failure(&input.failure);
    if !failure.is_empty() {
        out.push_str("\nLatest failing output:\n");
        out.push_str(&failure);
        if !failure.ends_with('\n') {
            out.push('\n');
        }
    }
    Ok(out)
}

/// The failure is one section per failing check, each starting with a `check <id> exit <code>:` line. Every
/// section keeps its header and the tail of its own output within an equal share of the budget, so one noisy
/// check cannot push the others (or a reviewer's objections) out of the prompt.
fn trim_failure(s: &str) -> String {
    let mut sections: Vec<Vec<&str>> = Vec::new();
    for line in s.lines() {
        if is_header(line) || sections.is_empty() {
            sections.push(Vec::new());
        }
        sections.last_mut().unwrap().push(line);
    }
    let n = sections.len().max(1);
    let (lines, bytes) = (
        (FAIL_LINES / n).max(MIN_LINES),
        (FAIL_BYTES / n).max(MIN_BYTES),
    );
    sections
        .iter()
        .map(|s| trim_section(s, lines, bytes))
        .collect::<Vec<_>>()
        .join("\n")
}

const MIN_LINES: usize = 4;
const MIN_BYTES: usize = 240;

fn is_header(line: &str) -> bool {
    line.starts_with("check ") && line.ends_with(':') && line.contains(" exit ")
}

fn trim_section(lines: &[&str], max_lines: usize, max_bytes: usize) -> String {
    let (head, body) = match lines.first() {
        Some(h) if is_header(h) => (Some(*h), &lines[1..]),
        _ => (None, lines),
    };
    let keep = max_lines - usize::from(head.is_some());
    let tail = body[body.len().saturating_sub(keep)..].join("\n");
    let tail = tail_str(
        &tail,
        max_bytes.saturating_sub(head.map_or(0, |h| h.len() + 1)),
    );
    match head {
        Some(h) if tail.is_empty() => h.to_string(),
        Some(h) => format!("{h}\n{tail}"),
        None => tail.to_string(),
    }
}

fn tail_str(s: &str, max_bytes: usize) -> &str {
    if s.len() <= max_bytes {
        return s;
    }
    let mut i = s.len() - max_bytes;
    while i < s.len() && !s.is_char_boundary(i) {
        i += 1;
    }
    &s[i..]
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn tabular_smaller_than_json() {
        let turns: Vec<Value> = (0..8)
            .map(|i| json!({"n": i + 1, "check": "tests", "cause": "wrong config path", "fix": "fixed the path"}))
            .collect();
        let ledger = json!({"turns": turns, "ruled_out": ["API_KEY unset", "server down"]});
        let toon = encode_ledger(&ledger).unwrap();
        let js = serde_json::to_string(&ledger).unwrap();
        assert!(toon.contains("turns[8]{n,check,cause,fix}:"), "{toon}");
        assert!(toon.contains("ruled_out[2]:"), "{toon}");
        assert!(
            toon.len() < js.len(),
            "toon {} bytes, json {} bytes\n{toon}",
            toon.len(),
            js.len()
        );
    }

    #[test]
    fn goal_roundtrip_keeps_comma() {
        let value = json!({
            "intent": "Make the check pass",
            "agent": "claude",
            "budget_usd": 2,
            "max_turns": 8,
            "checks": [{"id": "done", "cmd": "python3 check.py --flag a,b"}]
        });
        let toon = encode(&value, &pipe_opts()).unwrap();
        let back: Value = decode(&toon, &DecodeOptions::default()).unwrap();
        assert_eq!(back["checks"][0]["cmd"], "python3 check.py --flag a,b");
        assert_eq!(back["intent"], "Make the check pass");
    }

    #[test]
    fn trims_failure_tail() {
        let lines: Vec<String> = (0..100).map(|i| format!("line-{i}")).collect();
        let trimmed = trim_failure(&lines.join("\n"));
        assert!(trimmed.contains("line-99"));
        assert!(!trimmed.contains("line-50"));
        assert!(trimmed.lines().count() <= FAIL_LINES);
    }

    #[test]
    fn every_failing_check_keeps_its_header_and_tail() {
        let noisy: Vec<String> = (0..200).map(|i| format!("build log line {i}")).collect();
        let failure = format!(
            "check build exit 1:\n{}\ncheck tests exit 2:\nFAIL test_resize\ncheck review exit 1:\nReviewer (Codex Sol) rejected the change:\n- the test was deleted",
            noisy.join("\n")
        );
        let trimmed = trim_failure(&failure);
        for want in [
            "check build exit 1:",
            "build log line 199",
            "check tests exit 2:",
            "FAIL test_resize",
            "check review exit 1:",
            "- the test was deleted",
        ] {
            assert!(trimmed.contains(want), "missing {want:?} in\n{trimmed}");
        }
        assert!(!trimmed.contains("build log line 150"), "{trimmed}");
        assert!(trimmed.len() <= FAIL_BYTES + 3, "{} bytes", trimmed.len());
    }

    #[test]
    fn pack_includes_brief_ledger_and_failure() {
        let raw = r#"{"brief":"Goal: Ship it","ledger":{"turns":[{"n":1,"check":"tests","cause":"typo"}]},"failure":"boom"}"#;
        let prompt = pack_prompt(raw).unwrap();
        assert!(prompt.starts_with("Goal: Ship it\n"));
        assert!(prompt.contains("turns[1]{n,check,cause}:"));
        assert!(prompt.ends_with("Latest failing output:\nboom\n"));
        let bare = pack_prompt(r#"{"brief":"Propose checks","ledger":{}}"#).unwrap();
        assert_eq!(bare, "Propose checks\n");
    }
}
