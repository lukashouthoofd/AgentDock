use crate::host;
use serde_json::Value;
use std::{
    io::{BufRead, BufReader, Read, Write},
    process::{Child, ExitStatus, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

const INPUT_LIMIT: usize = 24 * 1024;
const ANSWER_LIMIT: usize = 64 * 1024;
const STREAM_LIMIT: u64 = 768 * 1024;
const DEADLINE: Duration = Duration::from_secs(100);
const STOP_GRACE: Duration = Duration::from_secs(5);
const STOPPED: &str = "Draft generation stopped.";
const TIMED_OUT: &str = "Claude Code did not finish within the time limit.";
const FAILED: &str =
    "Claude Code could not finish this draft. Check your Claude subscription and selected model.";

// The parent reads one length-framed UTF-8 prompt, then watches the same pipe
// for EOF. Closing the pipe stops the bounded Linux process group even when
// the desktop process exits. The CLI itself receives only the prompt on stdin.
const SUPERVISOR: &str = r#"
export LC_ALL=C
umask 077
IFS= read -r count || exit 130
[[ $count =~ ^[1-9][0-9]{0,4}$ ]] && (( count <= 24576 )) || exit 65
IFS= read -r -N "$count" draft || exit 130
dir=$(/usr/bin/mktemp -d /tmp/agentdock-studio.XXXXXXXXXX) || exit 70
job= watcher=
cleanup() {
  if [[ -n $watcher ]]; then kill "$watcher" 2>/dev/null; wait "$watcher" 2>/dev/null; fi
  if [[ -n $job ]]; then kill -TERM "$job" 2>/dev/null; wait "$job" 2>/dev/null; fi
  cd /
  /usr/bin/rmdir -- "$dir" 2>/dev/null
}
trap cleanup EXIT
trap 'exit 130' TERM HUP INT
cd -- "$dir" || exit 70
exec 3<&0
/usr/bin/timeout --kill-after=3s 85s /bin/bash --noprofile --norc -c "$1" agentdock-studio-cli "$2" \
  < <(printf '%s' "$draft") 3<&- &
job=$!
unset draft
owner=$BASHPID
( IFS= read -r -n 1 _ <&3; kill -TERM "$owner" 2>/dev/null ) 3<&3 &
watcher=$!
wait "$job"
status=$?
job=
exit "$status"
"#;

const CLAUDE: &str = r#"
set -o pipefail
export PATH="$HOME/.local/bin:$HOME/bin:/usr/local/bin:/usr/bin:/bin${PATH:+:$PATH}"
cli=$(type -P claude) || exit 127
clean=(/usr/bin/env -i "HOME=$HOME" "PATH=$PATH" LANG=C.UTF-8
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 DISABLE_AUTOUPDATER=1 CLAUDE_CODE_MAX_OUTPUT_TOKENS=2048)
auth=$(/usr/bin/timeout --foreground --kill-after=1s 10s "${clean[@]}" "$cli" \
  --safe-mode --restricted auth status --json </dev/null | /usr/bin/head -c 16385) || exit 66
logged='"loggedIn"[[:space:]]*:[[:space:]]*true([[:space:]]*[,}])'
provider='"authMethod"[[:space:]]*:[[:space:]]*"claude[.]ai"([[:space:]]*[,}])'
[[ ${#auth} -le 16384 && $auth =~ $logged && $auth =~ $provider ]] || exit 66
unset auth
exec "${clean[@]}" "$cli" -p --model "$1" --safe-mode --restricted --tools '' \
  --strict-mcp-config --mcp-config '{"mcpServers":{}}' --disable-slash-commands --no-session-persistence \
  --no-chrome --permission-mode dontAsk --permission-prompts none --output-format stream-json --verbose \
  --include-partial-messages --system-prompt 'Help draft or refine an engineering prompt. Return the requested draft directly, without an introduction. Preserve requirements, avoid inventing facts, and use concise actionable language.'
"#;

#[derive(Default)]
pub struct PromptStudio {
    state: Mutex<State>,
}

#[derive(Default)]
struct State {
    running: Option<(String, Arc<AtomicBool>)>,
    cancelled_before_start: Option<String>,
}

struct Lease<'a>(&'a PromptStudio);

impl Drop for Lease<'_> {
    fn drop(&mut self) {
        if let Ok(mut state) = self.0.state.lock() {
            state.running = None;
        }
    }
}

impl PromptStudio {
    pub fn generate(
        &self,
        distro: &str,
        request_id: &str,
        model: &str,
        prompt: &str,
        mut on_delta: impl FnMut(String) -> bool,
    ) -> host::Result<String> {
        host::valid_distro(distro)?;
        if !valid_request_id(request_id) {
            return Err("Invalid Prompt Studio request.".into());
        }
        if !valid_model(model) {
            return Err("Choose a Claude model or enter its exact model ID.".into());
        }
        if prompt.trim().is_empty() || prompt.len() > INPUT_LIMIT || prompt.as_bytes().contains(&0)
        {
            return Err("Enter a prompt of up to 24 KiB.".into());
        }
        let cancelled = Arc::new(AtomicBool::new(false));
        {
            let mut state = self.state.lock().map_err(|_| FAILED)?;
            if state.running.is_some() {
                return Err("Prompt Studio is already generating a draft.".into());
            }
            if state.cancelled_before_start.take().as_deref() == Some(request_id) {
                return Err(STOPPED.into());
            }
            state.running = Some((request_id.into(), cancelled.clone()));
        }
        let _lease = Lease(self);
        let mut command = host::wsl(distro);
        let child = host::quiet(&mut command)
            .args([
                "/usr/bin/env",
                "-u",
                "BASH_ENV",
                "-u",
                "ENV",
                "/bin/bash",
                "--noprofile",
                "--norc",
                "-c",
                SUPERVISOR,
                "agentdock-studio",
                CLAUDE,
                model,
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|_| "Could not start Claude Code in the selected Ubuntu distribution.")?;
        monitor(child, prompt, &cancelled, &mut on_delta)
    }

    pub fn cancel(&self, request_id: &str) -> host::Result<()> {
        if !valid_request_id(request_id) {
            return Err("Invalid Prompt Studio request.".into());
        }
        let mut state = self.state.lock().map_err(|_| FAILED)?;
        match &state.running {
            Some((id, cancelled)) if id == request_id => cancelled.store(true, Ordering::Relaxed),
            None => state.cancelled_before_start = Some(request_id.into()),
            _ => (),
        }
        Ok(())
    }
}

fn valid_request_id(value: &str) -> bool {
    (16..=64).contains(&value.len())
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

fn valid_model(value: &str) -> bool {
    matches!(value, "haiku" | "sonnet" | "opus" | "fable")
        || ((8..=100).contains(&value.len())
            && value.starts_with("claude-")
            && value
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"-._".contains(&b)))
}

enum Output {
    Delta(String),
    Result(Option<String>),
    Limit,
}

fn read_output(source: impl Read, tx: mpsc::SyncSender<Output>) {
    let mut reader = BufReader::new(source.take(STREAM_LIMIT + 1));
    let mut line = Vec::new();
    let mut bytes = 0;
    let mut answer_bytes = 0;
    loop {
        line.clear();
        let Ok(count) = reader.read_until(b'\n', &mut line) else {
            break;
        };
        if count == 0 {
            break;
        }
        bytes += count as u64;
        if bytes > STREAM_LIMIT {
            let _ = tx.send(Output::Limit);
            break;
        }
        let Ok(record) = serde_json::from_slice::<Value>(&line) else {
            continue;
        };
        match record["type"].as_str() {
            Some("stream_event") if record["parent_tool_use_id"].is_null() => {
                let event = &record["event"];
                if event["type"] != "content_block_delta" || event["delta"]["type"] != "text_delta"
                {
                    continue;
                }
                let Some(text) = event["delta"]["text"].as_str() else {
                    continue;
                };
                answer_bytes += text.len();
                if answer_bytes > ANSWER_LIMIT {
                    let _ = tx.send(Output::Limit);
                    break;
                }
                if !text.is_empty() && tx.send(Output::Delta(text.into())).is_err() {
                    break;
                }
            }
            Some("result") => {
                let answer = (record["subtype"] == "success" && record["is_error"] == false)
                    .then(|| record["result"].as_str())
                    .flatten();
                if answer.is_some_and(|text| text.len() > ANSWER_LIMIT) {
                    let _ = tx.send(Output::Limit);
                    break;
                }
                if tx.send(Output::Result(answer.map(str::to_owned))).is_err() {
                    break;
                }
            }
            _ => (),
        }
    }
}

fn exit_error(status: ExitStatus) -> &'static str {
    match status.code() {
        Some(127) => "Claude Code was not found in this Ubuntu profile.",
        Some(66) => {
            "Sign in to Claude Code with your Claude subscription in Ubuntu, then try again."
        }
        Some(124 | 137) => TIMED_OUT,
        Some(130) => STOPPED,
        _ => FAILED,
    }
}

fn monitor(
    mut child: Child,
    prompt: &str,
    cancelled: &AtomicBool,
    on_delta: &mut impl FnMut(String) -> bool,
) -> host::Result<String> {
    let mut input = child.stdin.take().expect("connected studio input pipe");
    let output = child.stdout.take().expect("connected studio output pipe");
    let (input_tx, input_rx) = mpsc::sync_channel(1);
    let frame = format!("{}\n{prompt}", prompt.len());
    thread::spawn(move || {
        let written = input.write_all(frame.as_bytes()).is_ok();
        let _ = input_tx.send(written.then_some(input));
    });
    let (output_tx, output_rx) = mpsc::sync_channel(8);
    thread::spawn(move || read_output(output, output_tx));

    let mut stdin = None;
    let mut stop = None;
    let mut answer = None;
    let mut exited = None;
    let mut output_closed = false;
    let deadline = Instant::now() + DEADLINE;
    loop {
        let now = Instant::now();
        if stdin.is_none() && stop.is_none() {
            if let Ok(Some(pipe)) = input_rx.try_recv() {
                stdin = Some(pipe);
            }
        }
        let problem = if cancelled.load(Ordering::Relaxed) {
            Some(STOPPED)
        } else if now >= deadline {
            Some(TIMED_OUT)
        } else {
            None
        };
        if let Some(error) = problem {
            stop.get_or_insert((now, error));
        }
        if stop.is_some() {
            drop(stdin.take());
            // A writer may finish after cancellation. Discard its pipe too.
            drop(input_rx.try_recv());
        }
        if exited.is_none() {
            match child.try_wait() {
                Ok(status) => exited = status,
                Err(_) => {
                    stop.get_or_insert((now, FAILED));
                }
            }
        }
        if let Some((since, error)) = stop {
            if exited.is_some() || now.duration_since(since) >= STOP_GRACE {
                if exited.is_none() {
                    let _ = child.kill();
                    let _ = child.wait();
                }
                return Err(error.into());
            }
        }
        if let Some(status) = exited.filter(|_| output_closed) {
            if !status.success() {
                return Err(exit_error(status).into());
            }
            return answer
                .filter(|value: &String| !value.trim().is_empty())
                .ok_or_else(|| FAILED.into());
        }
        match output_rx.recv_timeout(Duration::from_millis(38)) {
            Ok(Output::Delta(value)) if stop.is_none() => {
                if !on_delta(value) {
                    stop.get_or_insert((now, STOPPED));
                }
            }
            Ok(Output::Result(value)) => answer = value,
            Ok(Output::Limit) => {
                stop.get_or_insert((now, "The draft exceeded Prompt Studio's output limit."));
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                output_closed = true;
                thread::sleep(Duration::from_millis(12));
            }
            _ => (),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_only_cli_model_names_and_distinct_request_ids() {
        for model in ["haiku", "sonnet", "opus", "fable", "claude-sonnet-4-6"] {
            assert!(valid_model(model));
        }
        for model in ["", "--help", "claude-4 --tools", "claude-$(whoami)"] {
            assert!(!valid_model(model));
        }
        assert!(valid_request_id("studio-0123456789abcdef"));
        assert!(!valid_request_id("studio-../../example"));
    }

    #[test]
    fn forwards_only_assistant_text_and_authoritative_final_answer() {
        let fixture = concat!(
            "{\"type\":\"system\",\"text\":\"ignored\"}\n",
            "{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_delta\",\"delta\":{\"type\":\"thinking_delta\",\"thinking\":\"ignored\"}}}\n",
            "{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"A draft\"}}}\n",
            "{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"result\":\"A draft.\"}\n",
        );
        let (tx, rx) = mpsc::sync_channel(4);
        read_output(fixture.as_bytes(), tx);
        assert!(matches!(rx.recv().unwrap(), Output::Delta(text) if text == "A draft"));
        assert!(matches!(rx.recv().unwrap(), Output::Result(Some(text)) if text == "A draft."));
        assert!(rx.recv().is_err());
    }

    #[cfg(unix)]
    #[test]
    fn closing_input_stops_the_supervised_linux_job() {
        use std::process::Command;
        // The fixture reports the PID that is about to become the sleeping job.
        let tool = r#"printf '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"%s"}}}\n' "$BASHPID"; exec /usr/bin/sleep 60"#;
        let child = Command::new("/bin/bash")
            .args([
                "--noprofile",
                "--norc",
                "-c",
                SUPERVISOR,
                "fixture",
                tool,
                "haiku",
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let cancelled = AtomicBool::new(false);
        let mut pid = None;
        let begin = Instant::now();
        let result = monitor(child, "Fixture é\n", &cancelled, &mut |value| {
            pid = value.parse::<u32>().ok();
            cancelled.store(true, Ordering::Relaxed);
            true
        });
        assert_eq!(result.unwrap_err(), STOPPED);
        assert!(begin.elapsed() < STOP_GRACE);
        assert!(!std::path::Path::new(&format!("/proc/{}", pid.unwrap())).exists());
    }
}
