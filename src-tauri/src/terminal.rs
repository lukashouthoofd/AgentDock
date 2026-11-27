use crate::{
    host,
    tmux_sessions::{self, Session as TmuxSession, SessionIdentity},
    workspace::valid_id,
};
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    io::{Read, Write},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Condvar, Mutex, Weak,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

const RING: usize = 256 * 1024;
const CHUNK: usize = 32 * 1024;
const MAX_SESSIONS: usize = 64;
const SOCKET: &str = "agentdock-v1";
const WSL_DEADLINE: Duration = Duration::from_secs(12);
const WSL_CLOSE_DEADLINE: Duration = Duration::from_secs(90);
const WSL_CREATE_FIRST_ATTEMPT: Duration = Duration::from_secs(20);
const WSL_CREATE_RETRY: Duration = Duration::from_secs(80);
const TMUX_ALERT_OPTIONS: &[&str] = &[
    ";",
    "set-option",
    "-g",
    "monitor-bell",
    "on",
    ";",
    "set-option",
    "-g",
    "bell-action",
    "any",
    ";",
    "set-option",
    "-g",
    "visual-bell",
    "off",
    ";",
    "set-hook",
    "-g",
    "alert-bell[0]",
    "set-option -wF @agentdock-bell '#{e|+|:#{?@agentdock-bell,#{@agentdock-bell},0},1}'",
];
type Result<T> = host::Result<T>;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Spec {
    pub id: String,
    pub path: String,
    pub distro: String,
    pub profile: Profile,
    pub backend: Option<Backend>,
    pub tmux: Option<SessionIdentity>,
    pub launcher: Option<String>,
}

#[derive(Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Profile {
    Ubuntu,
    Powershell,
}

#[derive(Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Backend {
    Tmux,
    Native,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Health {
    pub id: String,
    pub attached: bool,
    pub running: bool,
    pub exit_code: Option<i64>,
    pub last_output: u64,
    pub last_activity: u64,
    pub bell: bool,
    pub bell_count: u64,
    pub tmux_confirmed: bool,
    pub tmux_clients: Option<u32>,
    pub missing: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Inventory {
    terminals: Vec<Health>,
    tmux: Vec<TmuxSession>,
    complete_distros: Vec<String>,
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

fn matches_session(spec: &Spec, session: &TmuxSession) -> bool {
    match &spec.tmux {
        Some(identity) => &session.identity == identity,
        None => {
            session.identity.distro == spec.distro
                && session.managed
                && session.name == format!("ad-{}", spec.id)
        }
    }
}

fn run_guarded(identity: &SessionIdentity, args: &[&str], deadline: Duration) -> Result<()> {
    let mut command = host::wsl(&identity.distro);
    command
        .args(tmux_sessions::guarded_args(identity, args)?)
        .env_remove("TMUX")
        .env_remove("TMUX_PANE");
    let output = host::output_bounded(&mut command, deadline)?;
    if output.status.success() {
        Ok(())
    } else if host::text(&output.stderr).starts_with("The tmux session or pane changed") {
        Err("This tmux session changed or is no longer available. Refresh the session list.".into())
    } else {
        Err(
            "tmux could not complete that operation. Refresh the session details before retrying."
                .into(),
        )
    }
}

pub fn tmux_action(identity: SessionIdentity, args: Vec<String>) -> Result<()> {
    let args: Vec<_> = args.iter().map(String::as_str).collect();
    let deadline = match args.as_slice() {
        ["kill-session"] | ["kill-pane", _] => WSL_CLOSE_DEADLINE,
        ["rename-session", _] | ["split-window", _, _] | ["select-pane", _, _] => WSL_DEADLINE,
        _ => return Err("This tmux control is unsupported.".into()),
    };
    run_guarded(&identity, &args, deadline)
}

fn quote_shell(text: &str) -> String {
    format!("'{}'", text.replace('\'', "'\"'\"'"))
}

impl Spec {
    fn uses_tmux(&self) -> bool {
        self.tmux.is_some()
            || self.profile == Profile::Ubuntu
            || self.backend == Some(Backend::Tmux)
    }

    fn verify(&self) -> Result<()> {
        target(&self.id)?;
        if self
            .launcher
            .as_ref()
            .is_some_and(|s| s.len() > 4096 || s.contains(['\0', '\r', '\n']))
        {
            return Err("Enter a single-line launcher command of at most 4096 bytes.".into());
        }
        if self.uses_tmux() {
            host::valid_distro(&self.distro)?;
        }
        if let Some(identity) = &self.tmux {
            identity.validate()?;
            if identity.distro != self.distro {
                return Err("The tmux session belongs to a different Ubuntu distribution.".into());
            }
        }
        Ok(())
    }

    fn create_tmux(&self) -> Result<()> {
        let location = host::resolve(&self.path, &self.distro, false)?;
        let path = location.linux.as_deref().ok_or(
            "WSL cannot enter this network folder. Choose PowerShell (native compatibility) to open it.",
        )?;
        let name = format!("ad-{}", self.id);
        let mut args = vec!["-d", "-s", &name, "-x", "100", "-y", "30"];
        let launcher = self.launcher.as_deref().filter(|s| !s.trim().is_empty());
        let command = if self.profile == Profile::Powershell {
            Some(match launcher {
                Some(launcher) => format!(
                    "exec powershell.exe -NoLogo -NoExit -Command {}",
                    quote_shell(launcher)
                ),
                None => "exec powershell.exe -NoLogo".to_owned(),
            })
        } else {
            launcher.map(|launcher| {
                format!(
                    "exec \"${{SHELL:-/bin/bash}}\" -ilc {}",
                    quote_shell(launcher)
                )
            })
        };
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
            "-t",
            &name,
            "prefix",
            "C-b",
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
        args.extend_from_slice(TMUX_ALERT_OPTIONS);
        let mut command = host::wsl(&self.distro);
        command
            .args([
                "/bin/sh",
                "-c",
                r#"cd -- "$1" 2>/dev/null || exit 124
                    client=$2; socket=$3; profile=$4; shift 4
                    if [ "$profile" = windows ]; then
                        # The invoking wsl.exe can close its interop socket before the pane starts.
                        for durable in /run/WSL/1_interop /run/WSL/2_interop; do
                            if [ -S "$durable" ]; then WSL_INTEROP=$durable; break; fi
                        done
                    fi
                    if [ -n "${WSL_INTEROP:-}" ]; then set -- -e "WSL_INTEROP=$WSL_INTEROP" "$@"; fi
                    exec "$client" -L "$socket" -f /dev/null new-session "$@""#,
                "agentdock",
                path,
                "/usr/bin/tmux",
                SOCKET,
                if self.profile == Profile::Powershell {
                    "windows"
                } else {
                    "linux"
                },
            ])
            .args(args)
            .env_remove("TMUX")
            .env_remove("TMUX_PANE");
        // The name is fixed for both attempts. The first WSL client may have reached tmux
        // before Windows stopped returning from wsl.exe, so a duplicate is a successful retry.
        let output = match host::output_bounded(&mut command, WSL_CREATE_FIRST_ATTEMPT) {
            Err(error) if error == host::HELPER_TIMEOUT => {
                host::output_bounded(&mut command, WSL_CREATE_RETRY)
            }
            outcome => outcome,
        }?;
        match output.status.code() {
            Some(0) => Ok(()),
            Some(124) => Err("The Ubuntu working directory is missing or unavailable.".into()),
            _ if host::text(&output.stderr).trim_end() == format!("duplicate session: {name}") => {
                Ok(())
            }
            _ => Err("Could not create the Ubuntu session. Check the distro and existing tmux installation.".into()),
        }
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
        let mut command = if spec.uses_tmux() {
            #[cfg(windows)]
            let mut command = {
                let mut command = CommandBuilder::new(host::system_exe("wsl.exe").into_os_string());
                command.args([
                    "--distribution",
                    &spec.distro,
                    "--cd",
                    "/",
                    "--exec",
                    "/usr/bin/env",
                    "TERM=xterm-256color",
                ]);
                command
            };
            #[cfg(not(windows))]
            let mut command = CommandBuilder::new("env");
            command.args(["/usr/bin/env", "TERM=xterm-256color"]);
            if let Some(identity) = &spec.tmux {
                command.args(tmux_sessions::guarded_args(identity, &["attach-session"])?);
            } else {
                command.args(tmux_sessions::managed_attach_args(&spec.id)?);
            }
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
    lifecycle: Mutex<HashMap<String, Weak<Mutex<()>>>>,
    next_attachment: AtomicU64,
}

impl Terminals {
    fn lifecycle_lock(&self, id: &str) -> Arc<Mutex<()>> {
        let mut locks = self.lifecycle.lock().unwrap();
        if let Some(lock) = locks.get(id).and_then(Weak::upgrade) {
            return lock;
        }
        locks.retain(|_, lock| lock.strong_count() != 0);
        let lock = Arc::new(Mutex::new(()));
        locks.insert(id.to_owned(), Arc::downgrade(&lock));
        lock
    }

    fn distro_control(&self, distro: &str) -> Arc<Mutex<()>> {
        self.lifecycle_lock(&format!("tmux-distro:{distro}"))
    }

    fn register(&self, id: String, pty: Arc<Pty>) -> Result<()> {
        let mut ptys = self.ptys.lock().unwrap();
        if ptys.len() >= MAX_SESSIONS {
            return Err("The attachment limit was reached.".into());
        }
        ptys.insert(id, pty);
        Ok(())
    }

    pub fn create(&self, spec: Spec, cols: u16, rows: u16) -> Result<Start> {
        spec.verify()?;
        if spec.tmux.is_some() {
            return Err("Attach to the existing tmux session to reconnect.".into());
        }
        let lifecycle = self.lifecycle_lock(&spec.id);
        let _guard = lifecycle.lock().unwrap();
        let existing = self.ptys.lock().unwrap();
        if existing.contains_key(&spec.id) || existing.len() >= MAX_SESSIONS {
            return Err("This terminal already exists or the attachment limit was reached.".into());
        }
        drop(existing);
        if spec.uses_tmux() {
            let distro_control = self.distro_control(&spec.distro);
            let _guard = distro_control.lock().unwrap();
            spec.create_tmux()?;
        } else {
            let pty = Pty::spawn(&spec, cols, rows)?;
            pty.stream.set_visible(false);
            self.register(spec.id, pty)?;
        }
        Ok(Start {
            cursor: 0,
            attachment: 0,
        })
    }

    pub fn attach(&self, spec: Spec, cols: u16, rows: u16) -> Result<Start> {
        spec.verify()?;
        let lifecycle = self.lifecycle_lock(&spec.id);
        let _guard = lifecycle.lock().unwrap();
        self.attach_locked(&spec, cols, rows)
    }

    fn attach_locked(&self, spec: &Spec, cols: u16, rows: u16) -> Result<Start> {
        let (existing, count) = {
            let ptys = self.ptys.lock().unwrap();
            (ptys.get(&spec.id).cloned(), ptys.len())
        };
        let attachment = self.next_attachment.fetch_add(1, Ordering::Relaxed) + 1;
        if let Some(pty) = existing {
            if pty.spec.distro != spec.distro
                || pty.spec.uses_tmux() != spec.uses_tmux()
                || pty
                    .spec
                    .tmux
                    .as_ref()
                    .is_some_and(|identity| Some(identity) != spec.tmux.as_ref())
            {
                return Err("The terminal reference changed. Detach before reconnecting.".into());
            }
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
        if !spec.uses_tmux() {
            return Err(
                "This PowerShell terminal has ended. Open a new terminal to start another shell."
                    .into(),
            );
        }
        // tmux reports a missing session through the PTY. A separate WSL
        // invocation here would block independent pane attachments.
        let pty = Pty::spawn(spec, cols, rows)?;
        pty.attachment.store(attachment, Ordering::Release);
        self.register(spec.id.clone(), pty)?;
        Ok(Start {
            cursor: 0,
            attachment,
        })
    }

    pub fn conceal(&self, spec: Spec) -> Result<()> {
        spec.verify()?;
        let lifecycle = self.lifecycle_lock(&spec.id);
        let _guard = lifecycle.lock().unwrap();
        if spec.uses_tmux() {
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
        let lifecycle = self.lifecycle_lock(&spec.id);
        let _guard = lifecycle.lock().unwrap();
        if let Some(identity) = &spec.tmux {
            run_guarded(identity, &["kill-session"], WSL_CLOSE_DEADLINE)?;
        } else if spec.uses_tmux() {
            let status = host::output_bounded(
                tmux(&spec.distro).args(["kill-session", "-t", &target(&spec.id)?]),
                WSL_CLOSE_DEADLINE,
            )?;
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
        if !spec.uses_tmux()
            || query.is_empty()
            || query.len() > 512
            || query.contains(['\r', '\n', '\0'])
        {
            return Err("Enter a single-line terminal search term.".into());
        }
        let direction = if backward {
            "search-backward"
        } else {
            "search-forward"
        };
        let identity = match &spec.tmux {
            Some(identity) => identity.clone(),
            None => tmux_sessions::discover(&spec.distro)?
                .sessions
                .into_iter()
                .find(|session| matches_session(&spec, session))
                .map(|session| session.identity)
                .ok_or("The tmux session is unavailable for history search.")?,
        };
        run_guarded(&identity, &["search", direction, query], WSL_DEADLINE)
    }

    pub fn inventory(&self, distros: Vec<String>, tracked: Vec<Spec>) -> Inventory {
        let mut terminals: HashMap<String, Health> = self
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
                        attached: pty.attachment.load(Ordering::Acquire) != 0 && status.is_none(),
                        running: !pty.spec.uses_tmux() && status.is_none(),
                        exit_code: if pty.spec.uses_tmux() { None } else { status },
                        last_output: pty.stream.last.load(Ordering::Relaxed),
                        last_activity: 0,
                        bell: false,
                        bell_count: 0,
                        tmux_confirmed: false,
                        tmux_clients: None,
                        missing: false,
                    },
                )
            })
            .collect();
        let mut inventory = Inventory {
            terminals: Vec::new(),
            tmux: Vec::new(),
            complete_distros: Vec::new(),
        };
        let mut seen = HashSet::new();
        for distro in distros.into_iter().take(12) {
            if !seen.insert(distro.clone()) || host::valid_distro(&distro).is_err() {
                continue;
            }
            let control = self.distro_control(&distro);
            let Ok(_guard) = control.try_lock() else {
                continue;
            };
            if let Ok(snapshot) = tmux_sessions::discover(&distro) {
                if snapshot.complete {
                    inventory.complete_distros.push(distro);
                }
                inventory.tmux.extend(snapshot.sessions);
            }
        }
        for spec in tracked
            .into_iter()
            .take(256)
            .filter(|spec| spec.uses_tmux() && spec.verify().is_ok())
        {
            let session = inventory
                .tmux
                .iter()
                .find(|session| matches_session(&spec, session));
            let complete = inventory.complete_distros.contains(&spec.distro);
            if session.is_none() && !complete {
                continue;
            }
            let entry = terminals.entry(spec.id.clone()).or_insert(Health {
                id: spec.id,
                attached: false,
                running: false,
                exit_code: None,
                last_output: 0,
                last_activity: 0,
                bell: false,
                bell_count: 0,
                tmux_confirmed: false,
                tmux_clients: None,
                missing: false,
            });
            entry.missing = session.is_none();
            let Some(session) = session else { continue };
            entry.tmux_confirmed = true;
            entry.tmux_clients = Some(session.attached);
            entry.running = session.panes.iter().any(|pane| !pane.dead);
            if !entry.running {
                entry.exit_code = session
                    .panes
                    .iter()
                    .find_map(|pane| {
                        pane.exit_code
                            .map(i64::from)
                            .filter(|code| *code != 0)
                            .or_else(|| pane.exit_signal.as_ref().map(|_| 128))
                    })
                    .or_else(|| {
                        session
                            .panes
                            .iter()
                            .find_map(|pane| pane.exit_code.map(i64::from))
                    });
            }
            for pane in &session.panes {
                entry.last_activity = entry
                    .last_activity
                    .max(pane.window_activity.unwrap_or(0).saturating_mul(1000));
                entry.bell |= pane.window_bell;
                entry.bell_count = entry.bell_count.max(pane.bell_count);
            }
        }
        inventory.terminals = terminals.into_values().collect();
        inventory
    }

    pub fn active_powershell(&self) -> usize {
        self.ptys
            .lock()
            .unwrap()
            .values()
            .filter(|pty| !pty.spec.uses_tmux() && pty.active())
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
