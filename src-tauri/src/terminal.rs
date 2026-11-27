use crate::{host, workspace::valid_id};
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    io::{Read, Write},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Condvar, Mutex,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

const RING: usize = 256 * 1024;
const CHUNK: usize = 32 * 1024;
const MAX_SESSIONS: usize = 64;
const SOCKET: &str = "agentdock-v1";
type Result<T> = host::Result<T>;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Spec {
    pub id: String,
    pub path: String,
    pub distro: String,
    pub profile: Profile,
    pub launcher: Option<String>,
}

#[derive(Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Profile {
    Ubuntu,
    Powershell,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Health {
    pub id: String,
    pub attached: bool,
    pub running: bool,
    pub exit_code: Option<i64>,
    pub last_output: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Start {
    pub cursor: u64,
    pub attachment: u64,
}

fn tmux_args() -> [&'static str; 5] {
    ["/usr/bin/tmux", "-L", SOCKET, "-f", "/dev/null"]
}

fn tmux(distro: &str) -> std::process::Command {
    let mut command = host::wsl(distro);
    command
        .args(tmux_args())
        .env_remove("TMUX")
        .env_remove("TMUX_PANE");
    command
}

fn target(id: &str) -> Result<String> {
    if valid_id(id) {
        Ok(format!("=ad-{id}"))
    } else {
        Err("Invalid terminal identity.".into())
    }
}

fn execute_tmux(distro: &str, args: &[&str], failure: &str) -> Result<()> {
    host::valid_distro(distro)?;
    let out = host::output(tmux(distro).args(args))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(failure.into())
    }
}

fn quote_shell(text: &str) -> String {
    format!("'{}'", text.replace('\'', "'\"'\"'"))
}

impl Spec {
    fn verify(&self) -> Result<()> {
        target(&self.id)?;
        if self
            .launcher
            .as_ref()
            .is_some_and(|s| s.len() > 4096 || s.contains(['\0', '\r', '\n']))
        {
            return Err("Enter a single-line launcher command of at most 4096 bytes.".into());
        }
        if self.profile == Profile::Ubuntu {
            host::valid_distro(&self.distro)?;
        }
        Ok(())
    }

    fn create_tmux(&self) -> Result<()> {
        let location = host::resolve(&self.path, &self.distro, true)?;
        let path = location.linux.as_deref().ok_or(
            "Ubuntu cannot enter this network folder. Select PowerShell for native UNC paths.",
        )?;
        let name = format!("ad-{}", self.id);
        let mut args = vec![
            "new-session",
            "-d",
            "-s",
            &name,
            "-c",
            path,
            "-x",
            "100",
            "-y",
            "30",
        ];
        let command = self
            .launcher
            .as_ref()
            .filter(|s| !s.trim().is_empty())
            .map(|launcher| {
                format!(
                    "exec \"${{SHELL:-/bin/bash}}\" -ilc {}",
                    quote_shell(launcher)
                )
            });
        if let Some(command) = &command {
            args.push(command);
        }
        args.extend([
            ";",
            "set-option",
            "-g",
            "status",
            "off",
            ";",
            "set-option",
            "-g",
            "history-limit",
            "2000",
            ";",
            "set-option",
            "-g",
            "focus-events",
            "on",
            ";",
            "set-option",
            "-g",
            "mouse",
            "on",
            ";",
            "set-option",
            "-g",
            "default-terminal",
            "tmux-256color",
            ";",
            "set-option",
            "-s",
            "escape-time",
            "10",
            ";",
            "set-option",
            "-w",
            "-t",
            &name,
            "remain-on-exit",
            "on",
        ]);
        execute_tmux(&self.distro, &args,
            "Could not create the Ubuntu session. Check the distro, working directory and existing tmux installation.")
    }
}

struct Data {
    queue: VecDeque<u8>,
    base: u64,
    visible: bool,
    done: Option<i64>,
    stopped: bool,
}

struct Stream {
    state: Mutex<Data>,
    wake: Condvar,
    last: AtomicU64,
}

impl Stream {
    fn new() -> Self {
        Self {
            state: Mutex::new(Data {
                queue: VecDeque::new(),
                base: 0,
                visible: true,
                done: None,
                stopped: false,
            }),
            wake: Condvar::new(),
            last: AtomicU64::new(0),
        }
    }

    fn write(&self, bytes: &[u8]) -> bool {
        let mut state = self.state.lock().unwrap();
        while state.visible && state.queue.len() + bytes.len() > RING && !state.stopped {
            state = self.wake.wait(state).unwrap();
        }
        if state.stopped {
            return false;
        }
        let excess = (state.queue.len() + bytes.len()).saturating_sub(RING);
        state.queue.drain(..excess);
        state.base += excess as u64;
        state.queue.extend(bytes);
        self.last.store(now_ms(), Ordering::Relaxed);
        self.wake.notify_all();
        true
    }

    fn set_visible(&self, visible: bool) -> u64 {
        let mut state = self.state.lock().unwrap();
        state.visible = visible;
        self.wake.notify_all();
        state.base
    }

    fn close(&self, status: i64) {
        self.state.lock().unwrap().done = Some(status);
        self.wake.notify_all();
    }

    fn stop(&self) {
        self.state.lock().unwrap().stopped = true;
        self.wake.notify_all();
    }

    fn read(&self, cursor: u64) -> Vec<u8> {
        let mut state = self.state.lock().unwrap();
        let acknowledged = cursor
            .saturating_sub(state.base)
            .min(state.queue.len() as u64) as usize;
        state.queue.drain(..acknowledged);
        state.base += acknowledged as u64;
        self.wake.notify_all();
        if state.queue.is_empty() && state.done.is_none() && !state.stopped {
            (state, _) = self
                .wake
                .wait_timeout(state, Duration::from_millis(1250))
                .unwrap();
        }
        let available = state.queue.len().min(CHUNK);
        let next_cursor = state.base + available as u64;
        let ended = (state.done.is_some() || state.stopped) && available == state.queue.len();
        let flags = u8::from(ended) | (u8::from(cursor < state.base) << 1);
        let mut result = Vec::with_capacity(9 + available);
        result.extend_from_slice(&next_cursor.to_le_bytes());
        result.push(flags);
        result.extend(state.queue.iter().take(available));
        result
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn size(cols: u16, rows: u16) -> PtySize {
    PtySize {
        cols: cols.clamp(2, 500),
        rows: rows.clamp(2, 300),
        pixel_width: 0,
        pixel_height: 0,
    }
}

#[cfg(windows)]
struct Job(windows_sys::Win32::Foundation::HANDLE);

#[cfg(windows)]
unsafe impl Send for Job {}

#[cfg(windows)]
unsafe impl Sync for Job {}

#[cfg(windows)]
impl Job {
    fn new(child: &dyn portable_pty::Child) -> Result<Self> {
        use windows_sys::Win32::System::JobObjects::*;
        let process = child
            .as_raw_handle()
            .ok_or("Unable to own the terminal process.")?;
        // SAFETY: the handle belongs to the live child; the job owns its separate handle.
        unsafe {
            let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if handle.is_null() {
                return Err("Could not create a terminal process job.".into());
            }
            let job = Self(handle);
            let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                std::mem::size_of_val(&limits) as u32,
            ) == 0
                || AssignProcessToJobObject(handle, process as _) == 0
            {
                return Err("Could not assign the terminal process to AgentDock’s job.".into());
            }
            Ok(job)
        }
    }
}

#[cfg(windows)]
impl Drop for Job {
    fn drop(&mut self) {
        // SAFETY: this is the job handle returned by CreateJobObjectW.
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.0);
        }
    }
}

struct Pty {
    spec: Spec,
    attachment: AtomicU64,
    stream: Arc<Stream>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    writer: Mutex<Box<dyn Write + Send>>,
    #[cfg(windows)]
    job: Mutex<Option<Job>>,
    master: Mutex<Box<dyn MasterPty + Send>>,
}

impl Pty {
    fn spawn(spec: &Spec, cols: u16, rows: u16) -> Result<Arc<Self>> {
        let pair = native_pty_system()
            .openpty(size(cols, rows))
            .map_err(|_| "Could not allocate a terminal.")?;
        let mut command = if spec.profile == Profile::Ubuntu {
            #[cfg(windows)]
            let mut command = {
                let mut command = CommandBuilder::new(host::system_exe("wsl.exe").into_os_string());
                command.args(["--distribution", &spec.distro, "--exec"]);
                command
            };
            #[cfg(not(windows))]
            let mut command = CommandBuilder::new("env");
            command.args(["/usr/bin/env", "TERM=xterm-256color"]);
            command.args(tmux_args());
            command.args(["attach-session", "-t", &target(&spec.id)?]);
            command.env_remove("TMUX");
            command.env_remove("TMUX_PANE");
            command.env_remove("WSLENV");
            command.env("TERM", "xterm-256color");
            command
        } else {
            let location = host::resolve(&spec.path, &spec.distro, true)?;
            let mut command = CommandBuilder::new(
                host::system_exe("WindowsPowerShell/v1.0/powershell.exe").into_os_string(),
            );
            command.args(["-NoLogo", "-NoExit"]);
            if let Some(launcher) = &spec.launcher {
                if !launcher.trim().is_empty() {
                    command.args(["-Command", launcher]);
                }
            }
            command.cwd(location.native);
            command
        };
        command.env_remove("AGENTDOCK_E2E");
        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|_| "Could not read from the terminal.")?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|_| "Could not write to the terminal.")?;
        let mut child = pair
            .slave
            .spawn_command(command)
            .map_err(|_| "Could not launch the selected shell.")?;
        drop(pair.slave);
        #[cfg(windows)]
        let job = match Job::new(child.as_ref()) {
            Ok(job) => Some(job),
            Err(error) => {
                let _ = child.kill();
                return Err(error);
            }
        };
        let killer = child.clone_killer();
        let stream = Arc::new(Stream::new());
        let read_stream = stream.clone();
        std::thread::spawn(move || {
            let mut bytes = [0; 8192];
            loop {
                match reader.read(&mut bytes) {
                    Ok(0) => break,
                    Ok(count) if !read_stream.write(&bytes[..count]) => break,
                    Ok(_) => {}
                    Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(_) => break,
                }
            }
            drop(reader);
            let status = child
                .wait()
                .map(|status| i64::from(status.exit_code()))
                .unwrap_or(-1);
            read_stream.close(status);
        });
        Ok(Arc::new(Self {
            spec: spec.clone(),
            attachment: AtomicU64::new(0),
            stream,
            killer: Mutex::new(killer),
            writer: Mutex::new(writer),
            #[cfg(windows)]
            job: Mutex::new(job),
            master: Mutex::new(pair.master),
        }))
    }

    fn active(&self) -> bool {
        self.stream.state.lock().unwrap().done.is_none()
    }
}

impl Pty {
    fn stop(&self) {
        self.stream.stop();
        #[cfg(windows)]
        drop(self.job.lock().unwrap().take());
        if self.active() {
            let _ = self.killer.lock().unwrap().kill();
        }
    }
}

impl Drop for Pty {
    fn drop(&mut self) {
        self.stop();
    }
}

#[derive(Default)]
pub struct Terminals {
    ptys: Mutex<HashMap<String, Arc<Pty>>>,
    lifecycle: Mutex<()>,
    next_attachment: AtomicU64,
}

impl Terminals {
    pub fn create(&self, spec: Spec, cols: u16, rows: u16) -> Result<Start> {
        spec.verify()?;
        let _guard = self.lifecycle.lock().unwrap();
        let existing = self.ptys.lock().unwrap();
        if existing.contains_key(&spec.id) || existing.len() >= MAX_SESSIONS {
            return Err("This terminal already exists or the attachment limit was reached.".into());
        }
        drop(existing);
        if spec.profile == Profile::Ubuntu {
            spec.create_tmux()?;
        } else {
            let pty = Pty::spawn(&spec, cols, rows)?;
            pty.stream.set_visible(false);
            self.ptys.lock().unwrap().insert(spec.id, pty);
        }
        Ok(Start {
            cursor: 0,
            attachment: 0,
        })
    }

    pub fn attach(&self, spec: Spec, cols: u16, rows: u16) -> Result<Start> {
        spec.verify()?;
        let _guard = self.lifecycle.lock().unwrap();
        self.attach_locked(&spec, cols, rows)
    }

    fn attach_locked(&self, spec: &Spec, cols: u16, rows: u16) -> Result<Start> {
        let (existing, count) = {
            let ptys = self.ptys.lock().unwrap();
            (ptys.get(&spec.id).cloned(), ptys.len())
        };
        let attachment = self.next_attachment.fetch_add(1, Ordering::Relaxed) + 1;
        if let Some(pty) = existing {
            pty.attachment.store(attachment, Ordering::Release);
            pty.master
                .lock()
                .unwrap()
                .resize(size(cols, rows))
                .map_err(|_| "Could not resize the terminal.")?;
            return Ok(Start {
                cursor: pty.stream.set_visible(true),
                attachment,
            });
        }
        if count >= MAX_SESSIONS {
            return Err("The attachment limit was reached.".into());
        }
        if spec.profile == Profile::Powershell {
            return Err(
                "This PowerShell terminal has ended. Open a new terminal to start another shell."
                    .into(),
            );
        }
        {
            execute_tmux(
                &spec.distro,
                &["has-session", "-t", &target(&spec.id)?],
                "This Ubuntu terminal is no longer available.",
            )?;
        }
        let pty = Pty::spawn(spec, cols, rows)?;
        pty.attachment.store(attachment, Ordering::Release);
        self.ptys.lock().unwrap().insert(spec.id.clone(), pty);
        Ok(Start {
            cursor: 0,
            attachment,
        })
    }

    pub fn conceal(&self, spec: Spec) -> Result<()> {
        spec.verify()?;
        let _guard = self.lifecycle.lock().unwrap();
        if spec.profile == Profile::Ubuntu {
            let pty = self.ptys.lock().unwrap().remove(&spec.id);
            if let Some(pty) = pty {
                pty.stop();
            }
        } else if let Some(pty) = self.ptys.lock().unwrap().get(&spec.id).cloned() {
            pty.attachment.store(0, Ordering::Release);
            pty.stream.set_visible(false);
        }
        Ok(())
    }

    pub fn terminate(&self, spec: Spec) -> Result<()> {
        spec.verify()?;
        let _guard = self.lifecycle.lock().unwrap();
        if spec.profile == Profile::Ubuntu {
            let status =
                host::output(tmux(&spec.distro).args(["kill-session", "-t", &target(&spec.id)?]))?;
            let diagnostic = host::text(&status.stderr);
            let missing = diagnostic.starts_with("no server running")
                || diagnostic.starts_with("can't find session:")
                || (diagnostic.starts_with("error connecting to ")
                    && diagnostic.contains("(No such file or directory)"));
            if !status.status.success() && !missing {
                return Err("The Ubuntu session could not be terminated. Refresh its status before removing it.".into());
            }
        }
        let pty = self.ptys.lock().unwrap().remove(&spec.id);
        if let Some(pty) = pty {
            pty.stop();
        }
        Ok(())
    }

    fn pty(&self, id: &str, attachment: u64) -> Result<Arc<Pty>> {
        self.ptys
            .lock()
            .unwrap()
            .get(id)
            .filter(|pty| attachment != 0 && pty.attachment.load(Ordering::Acquire) == attachment)
            .cloned()
            .ok_or_else(|| "The terminal is detached.".into())
    }

    pub fn read(&self, id: &str, attachment: u64, cursor: u64) -> Result<Vec<u8>> {
        let stream = self.pty(id, attachment)?.stream.clone();
        Ok(stream.read(cursor))
    }

    pub fn write(&self, id: &str, attachment: u64, input: &[u8]) -> Result<()> {
        if input.len() > 65_536 {
            return Err("Terminal input chunk exceeds 64 KiB.".into());
        }
        self.pty(id, attachment)?
            .writer
            .lock()
            .unwrap()
            .write_all(input)
            .map_err(|_| "The terminal stopped accepting input.".into())
    }

    pub fn resize(&self, id: &str, attachment: u64, cols: u16, rows: u16) -> Result<()> {
        self.pty(id, attachment)?
            .master
            .lock()
            .unwrap()
            .resize(size(cols, rows))
            .map_err(|_| "Could not resize the terminal.".into())
    }

    pub fn search(&self, spec: Spec, query: &str, backward: bool) -> Result<()> {
        spec.verify()?;
        if spec.profile != Profile::Ubuntu
            || query.is_empty()
            || query.len() > 512
            || query.contains(['\r', '\n', '\0'])
        {
            return Err("Enter a single-line terminal search term.".into());
        }
        let session = target(&spec.id)?;
        execute_tmux(
            &spec.distro,
            &[
                "copy-mode",
                "-t",
                &session,
                ";",
                "send-keys",
                "-t",
                &session,
                "-X",
                if backward {
                    "search-backward"
                } else {
                    "search-forward"
                },
                "--",
                query,
            ],
            "tmux could not search the requested terminal.",
        )
    }

    pub fn health(&self, distros: Vec<String>) -> Vec<Health> {
        let mut out: HashMap<String, Health> = self
            .ptys
            .lock()
            .unwrap()
            .values()
            .map(|pty| {
                let status = pty.stream.state.lock().unwrap().done;
                let id = pty.spec.id.clone();
                (
                    id.clone(),
                    Health {
                        id,
                        attached: true,
                        running: status.is_none(),
                        exit_code: status,
                        last_output: pty.stream.last.load(Ordering::Relaxed),
                    },
                )
            })
            .collect();
        let mut seen = HashSet::new();
        for distro in distros.into_iter().take(12) {
            if host::valid_distro(&distro).is_err() {
                continue;
            }
            let snapshot = host::output(tmux(&distro).args([
                "list-panes",
                "-a",
                "-F",
                "#{session_name}\t#{pane_dead}\t#{pane_dead_status}\t#{pane_dead_signal}",
            ]));
            let Ok(snapshot) = snapshot else { continue };
            if !snapshot.status.success() {
                continue;
            }
            for line in host::text(&snapshot.stdout).lines() {
                let parts: Vec<_> = line.split('\t').collect();
                if let [name, dead, status, signal] = parts.as_slice() {
                    let Some(id) = name.strip_prefix("ad-").filter(|id| valid_id(id)) else {
                        continue;
                    };
                    let entry = out.entry(id.into()).or_insert(Health {
                        id: id.into(),
                        attached: false,
                        running: false,
                        exit_code: None,
                        last_output: 0,
                    });
                    let first = seen.insert(id.to_owned());
                    entry.running = (!first && entry.running) || *dead == "0";
                    entry.exit_code = if entry.running {
                        None
                    } else {
                        status
                            .parse()
                            .ok()
                            .or_else(|| (!signal.is_empty()).then_some(128))
                    };
                }
            }
        }
        out.into_values().collect()
    }

    pub fn active_powershell(&self) -> usize {
        self.ptys
            .lock()
            .unwrap()
            .values()
            .filter(|pty| pty.spec.profile == Profile::Powershell && pty.active())
            .count()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn buffer_bounds_hidden_output_and_acknowledges_visible_output() {
        let stream = Stream::new();
        stream.set_visible(false);
        for _ in 0..50 {
            assert!(stream.write(&[42; 8192]));
        }
        let response = stream.read(0);
        let cursor = u64::from_le_bytes(response[0..8].try_into().unwrap());
        assert_eq!(response.len(), 9 + CHUNK);
        assert!(cursor > CHUNK as u64);
        stream.read(cursor);
        assert_eq!(stream.state.lock().unwrap().queue.len(), RING - CHUNK);
    }

    #[test]
    fn launcher_paths_and_target_are_literal() {
        assert_eq!(quote_shell("a'b"), "'a'\"'\"'b'");
        assert!(target("$(uname)").is_err());
        assert!(target("1aef6808-33b2-48d7-bad1-dde21305afbf").is_ok());
    }
}
