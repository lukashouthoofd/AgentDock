use crate::{host, workspace::valid_id};
use serde::{Deserialize, Serialize};
use std::time::Duration;

type Result<T> = host::Result<T>;

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionIdentity {
    pub distro: String,
    pub socket: String,
    pub boot_id: String,
    pub server_pid: u32,
    pub server_started: u64,
    pub session_id: String,
    pub session_created: u64,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub distro: String,
    pub sessions: Vec<Session>,
    pub complete: bool,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub identity: SessionIdentity,
    pub name: String,
    #[serde(default)]
    pub managed: bool,
    pub attached: u32,
    pub activity: Option<u64>,
    pub panes: Vec<Pane>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Pane {
    pub id: String,
    pub window_id: String,
    pub window_active: bool,
    pub active: bool,
    pub dead: bool,
    pub pid: Option<u32>,
    pub cwd: Option<String>,
    pub command: Option<String>,
    pub shell_hint: Option<String>,
    pub exit_code: Option<i32>,
    pub exit_signal: Option<String>,
    pub dead_at: Option<u64>,
    #[serde(default)]
    pub window_bell: bool,
    #[serde(default)]
    pub bell_count: u64,
    #[serde(default)]
    pub window_activity: Option<u64>,
}

fn tmux_id(value: &str, prefix: char) -> bool {
    value.strip_prefix(prefix).is_some_and(|digits| {
        !digits.is_empty()
            && digits.bytes().all(|byte| byte.is_ascii_digit())
            && digits
                .parse::<u32>()
                .is_ok_and(|id| id.to_string() == digits)
    })
}

impl SessionIdentity {
    pub fn validate(&self) -> Result<()> {
        host::valid_distro(&self.distro)?;
        if self.socket.len() <= 107
            && self.socket.starts_with('/')
            && !self.socket.chars().any(char::is_control)
            && valid_id(&self.boot_id)
            && self.server_pid > 0
            && self.server_started > 0
            && tmux_id(&self.session_id, '$')
            && self.session_created > 0
        {
            Ok(())
        } else {
            Err("This tmux session identity is invalid.".into())
        }
    }

    fn helper_identity(&self, mode: &str) -> Vec<String> {
        let mut args = helper_args(mode);
        args.extend([
            self.socket.clone(),
            self.boot_id.clone(),
            self.server_pid.to_string(),
            self.server_started.to_string(),
            self.session_id.clone(),
            self.session_created.to_string(),
        ]);
        args
    }
}

fn helper_args(mode: &str) -> Vec<String> {
    ["/usr/bin/python3", "-I", "-B", "-S", "-c", HELPER, mode]
        .into_iter()
        .map(str::to_owned)
        .collect()
}

/// A read-only snapshot from one WSL invocation. Partial snapshots retain a completeness flag.
pub fn discover(distro: &str) -> Result<Snapshot> {
    host::valid_distro(distro)?;
    let output = host::output_bounded(
        host::wsl(distro).args(helper_args("discover")).arg(distro),
        Duration::from_secs(12),
    )?;
    if !output.status.success() {
        return Err("Could not discover Ubuntu tmux sessions. Check that Ubuntu and Python 3 are available.".into());
    }
    let snapshot: Snapshot = serde_json::from_slice(&output.stdout)
        .map_err(|_| "Ubuntu returned invalid tmux discovery data.")?;
    if snapshot.distro != distro
        || snapshot.sessions.iter().any(|session| {
            session.identity.distro != distro || session.identity.validate().is_err()
        })
    {
        return Err("Ubuntu returned a mismatched tmux session identity.".into());
    }
    Ok(snapshot)
}

/// Returns arguments following WSL --exec. The helper checks the target again immediately before
/// exec, preserves the caller's terminal, and passes only the supported exact-target operations.
pub fn guarded_args(identity: &SessionIdentity, command_args: &[&str]) -> Result<Vec<String>> {
    identity.validate()?;
    let session = identity.session_id.as_str();
    let pane_cwd = "#{pane_current_path}";
    let (pane, window, action): (&str, &str, Vec<&str>) = match command_args {
        [action @ ("attach-session" | "kill-session" | "copy-mode")] => {
            ("", "", vec![action, "-t", session])
        }
        ["rename-session", name] if valid_rename(name) => {
            ("", "", vec!["rename-session", "-t", session, name])
        }
        ["split-window", direction @ ("-h" | "-v")] => (
            "",
            "",
            vec!["split-window", direction, "-t", session, "-c", pane_cwd],
        ),
        ["split-window", direction @ ("-h" | "-v"), pane] if tmux_id(pane, '%') => (
            pane,
            "",
            vec!["split-window", direction, "-t", pane, "-c", pane_cwd],
        ),
        ["select-pane", direction @ ("-L" | "-R" | "-U" | "-D")] => {
            ("", "", vec!["select-pane", direction, "-t", session])
        }
        ["select-pane", window, pane] if tmux_id(window, '@') && tmux_id(pane, '%') => (
            pane,
            window,
            vec![
                "select-pane",
                "-t",
                pane,
                ";",
                "select-window",
                "-t",
                window,
            ],
        ),
        [action @ ("select-pane" | "kill-pane" | "copy-mode"), pane] if tmux_id(pane, '%') => {
            (pane, "", vec![action, "-t", pane])
        }
        ["send-keys", "-X", direction @ ("search-forward" | "search-backward"), query]
        | ["search", direction @ ("search-forward" | "search-backward"), query]
            if valid_search(query) =>
        {
            let literal_mode = if *direction == "search-backward" {
                "search-backward-text"
            } else {
                "search-forward-text"
            };
            (
                "",
                "",
                vec![
                    "copy-mode",
                    "-t",
                    session,
                    ";",
                    "send-keys",
                    "-X",
                    "-t",
                    session,
                    "--",
                    literal_mode,
                    query,
                ],
            )
        }
        _ => return Err("This tmux operation or target is unsupported.".into()),
    };
    let mut args = identity.helper_identity("action");
    args.push(pane.to_owned());
    args.push(window.to_owned());
    let mut action: Vec<_> = action.into_iter().map(str::to_owned).collect();
    if matches!(command_args.first(), Some(&("send-keys" | "search"))) {
        if let Some(query) = action.last_mut().filter(|value| value.ends_with(';')) {
            // tmux's argv parser treats a trailing semicolon as a command separator.
            query.insert(query.len() - 1, '\\');
        }
    }
    args.extend(action);
    Ok(args)
}

fn valid_rename(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 100
        && value == value.trim()
        && !value.starts_with('-')
        && value
            .chars()
            .all(|character| character.is_alphanumeric() || " -_()".contains(character))
}

fn valid_search(value: &str) -> bool {
    !value.is_empty() && value.len() <= 1000 && !value.chars().any(char::is_control)
}

// The helper reads kernel socket ownership and tmux format metadata. It never capture-panes
// or reads another process's arguments, environment, terminal stream, or configuration.
const HELPER: &str = r##"
import json, os, re, selectors, stat, subprocess, sys, time

TMUX = "/usr/bin/tmux"
MAX_PANES = 512
MAX_SERVERS = 32
MAX_OUTPUT = 512 * 1024
MAX_SNAPSHOT = 768 * 1024
SHELLS = {"bash", "dash", "fish", "ksh", "sh", "tcsh", "zsh", "nu"}
FIELDS = (
    "uid", "pid", "session_id", "session_created", "session_attached", "session_activity",
    "session_name", "window_id", "window_active", "pane_id", "pane_active", "pane_dead",
    "pane_pid", "pane_current_path", "pane_current_command", "pane_dead_status",
    "pane_dead_signal", "pane_dead_time", "window_bell_flag", "@agentdock-bell",
    "window_activity"
)
SEPARATOR = "\u241f"
FORMAT = SEPARATOR.join("#{" + name + "}" for name in FIELDS)
UID = os.getuid()

def text(value, size):
    return value if value and len(value) <= size and value.isprintable() else None

def number(value):
    return int(value) if re.fullmatch(r"[0-9]{1,18}", value) else None

def identifier(value, prefix):
    return re.fullmatch(re.escape(prefix) + r"(0|[1-9][0-9]{0,9})", value) is not None

def managed_socket():
    directory = os.environ.get("TMUX_TMPDIR")
    try:
        base = os.path.realpath(directory, strict=True) if directory else "/tmp"
    except OSError:
        base = "/tmp"
    directory = os.path.join(base, "tmux-" + str(UID))
    try:
        info = os.lstat(directory)
        if info.st_uid == UID and stat.S_ISDIR(info.st_mode) and not info.st_mode & 0o007:
            return os.path.join(directory, "agentdock-v1")
    except OSError:
        pass
    return None

def own_socket_info(info):
    return info.st_uid == UID and stat.S_ISSOCK(info.st_mode)

def owned_socket(path):
    try:
        return own_socket_info(os.lstat(path))
    except OSError:
        return False

def pin_socket(path):
    try:
        descriptor = os.open(path, os.O_PATH | os.O_NOFOLLOW)
    except OSError:
        return None
    try:
        if own_socket_info(os.fstat(descriptor)):
            return descriptor
    except OSError:
        pass
    os.close(descriptor)
    return None

def listeners():
    sockets = {}
    with open("/proc/net/unix", "rb") as lines:
        for line in lines:
            fields = line.removesuffix(b"\n").split(None, 7)
            if (len(fields) != 8 or fields[3] != b"00010000"
                or fields[4:6] != [b"0001", b"01"] or not fields[7].startswith(b"/")
                or len(fields[7]) > 107):
                continue
            try:
                path = fields[7].decode("utf-8")
            except UnicodeDecodeError:
                continue
            if path.isprintable() and owned_socket(path):
                sockets[fields[6].decode("ascii")] = path
    return sockets

def server_start(pid):
    process = "/proc/" + str(pid)
    try:
        if os.stat(process).st_uid != UID:
            return None
        with open(process + "/comm", encoding="ascii") as descriptor:
            if descriptor.read().rstrip("\n") not in ("tmux: server", "tmux"):
                return None
        binary = os.path.basename(os.readlink(process + "/exe")).removesuffix(" (deleted)")
        if not re.fullmatch(r"tmux(?:[-._][0-9][a-z0-9.-]*)?", binary):
            return None
        with open(process + "/stat", "rb") as descriptor:
            fields = descriptor.read().rsplit(b")", 1)[1].split()
        return int(fields[19])
    except (OSError, UnicodeError, ValueError, IndexError):
        return None

def server_sockets(pid, known):
    seen = set()
    try:
        with os.scandir("/proc/" + str(pid) + "/fd") as entries:
            for entry in entries:
                try:
                    link = os.readlink(entry.path)
                except FileNotFoundError:
                    continue
                if link.startswith("socket:[") and link.endswith("]"):
                    path = known.get(link[8:-1])
                    if path:
                        seen.add(path)
    except OSError:
        return seen, False
    return seen, True

def tmux(path):
    return [TMUX, "-N", "-f", "/dev/null", "-S", path]

def pinned_path(descriptor):
    return "/proc/self/fd/" + str(descriptor)

def query(descriptor, deadline):
    if time.monotonic() >= deadline:
        return None
    try:
        with subprocess.Popen(
            tmux(pinned_path(descriptor)) + ["list-panes", "-a", "-F", FORMAT],
            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            pass_fds=(descriptor,),
        ) as child:
            try:
                data = bytearray()
                with selectors.DefaultSelector() as watcher:
                    watcher.register(child.stdout, selectors.EVENT_READ)
                    while len(data) <= MAX_OUTPUT:
                        remaining = deadline - time.monotonic()
                        if remaining <= 0 or not watcher.select(remaining):
                            return None
                        chunk = os.read(child.stdout.fileno(), min(65536, MAX_OUTPUT + 1 - len(data)))
                        if not chunk:
                            if child.wait(timeout=max(0.001, deadline - time.monotonic())) == 0:
                                return data.decode("utf-8", errors="replace").split("\n")
                            return None
                        data.extend(chunk)
                return None
            finally:
                if child.poll() is None:
                    child.kill()
    except (OSError, subprocess.TimeoutExpired):
        return None

def records(lines, pid):
    rows = []
    complete = True
    for line in lines:
        if not line:
            continue
        fields = line.split(SEPARATOR)
        if len(fields) == len(FIELDS) and number(fields[0]) == UID and number(fields[1]) == pid:
            rows.append(fields)
        else:
            complete = False
    return rows, complete

def discover(distro, boot):
    result = {"distro": distro, "sessions": [], "complete": True}
    deadline = time.monotonic() + 5
    known = listeners()
    managed = managed_socket()
    by_id = {}
    panes = 0
    servers = 0
    with os.scandir("/proc") as processes:
        for process in processes:
            if time.monotonic() >= deadline:
                result["complete"] = False
                break
            pid = number(process.name)
            if pid is None:
                continue
            epoch = server_start(pid)
            if not epoch:
                continue
            sockets, readable = server_sockets(pid, known)
            if not readable:
                result["complete"] = False
            for path in sorted(sockets):
                if servers == MAX_SERVERS or panes == MAX_PANES or time.monotonic() >= deadline:
                    result["complete"] = False
                    break
                servers += 1
                descriptor = pin_socket(path)
                if descriptor is None:
                    result["complete"] = False
                    continue
                try:
                    lines = query(descriptor, min(deadline, time.monotonic() + .8))
                finally:
                    os.close(descriptor)
                if lines is None or server_start(pid) != epoch:
                    result["complete"] = False
                    continue
                rows, valid = records(lines, pid)
                result["complete"] = result["complete"] and valid
                for row in rows:
                    (uid, server, session, created, attached, activity, name, window,
                     window_active, pane, active, dead, pane_pid, cwd, command, code, signal,
                     dead_at, bell, bell_count, window_activity) = row
                    created = number(created)
                    attached = number(attached)
                    name = text(name, 200)
                    if (not created or attached is None or not name or not identifier(session, "$")
                        or not identifier(window, "@") or not identifier(pane, "%")
                        or any(value not in ("0", "1") for value in (active, dead, window_active))):
                        result["complete"] = False
                        continue
                    if panes == MAX_PANES:
                        result["complete"] = False
                        break
                    panes += 1
                    if (path, session) not in by_id:
                        by_id[path, session] = {
                            "identity": {
                                "distro": distro, "socket": path, "bootId": boot, "serverPid": pid,
                                "serverStarted": epoch, "sessionId": session, "sessionCreated": created,
                            },
                            "name": name, "managed": path == managed,
                            "attached": attached, "activity": number(activity),
                            "panes": [],
                        }
                    command = text(command, 96)
                    by_id[path, session]["panes"].append({
                        "id": pane, "windowId": window, "windowActive": window_active == "1",
                        "active": active == "1", "dead": dead == "1",
                        "pid": number(pane_pid) if dead == "0" else None,
                        "cwd": text(cwd, 512) if cwd.startswith("/") else None,
                        "command": command,
                        "shellHint": command if command in SHELLS and dead == "0" else None,
                        "exitCode": number(code) if dead == "1" else None,
                        "exitSignal": text(signal, 48) if dead == "1" else None,
                        "deadAt": number(dead_at) if dead == "1" else None,
                        "windowBell": bell == "1",
                        "bellCount": number(bell_count) or 0,
                        "windowActivity": number(window_activity),
                    })
    result["sessions"] = sorted(by_id.values(), key=lambda item: (
        item["identity"]["socket"], item["identity"]["sessionCreated"],
        item["identity"]["sessionId"],
    ))
    return result

def checked(descriptor, path, boot, pid, started, session, created, pane, window, needs_pane):
    if BOOT_ID != boot or server_start(pid) != started or path not in server_sockets(pid, listeners())[0]:
        return None
    lines = query(descriptor, time.monotonic() + 1.5)
    if lines is None:
        return None
    rows, _ = records(lines, pid)
    matching = [
        row for row in rows
        if row[2] == session and number(row[3]) == created and (not window or row[7] == window)
        and (not needs_pane or (
            identifier(row[7], "@") and identifier(row[9], "%")
            and (row[9] == pane if pane else row[8] == "1" and row[10] == "1")
        ))
    ]
    if not matching or server_start(pid) != started or path not in server_sockets(pid, listeners())[0]:
        return None
    return matching[0]

def scope_pane_action(action, session, window, pane):
    window_target = session + ":" + window
    pane_target = window_target + "." + pane
    if action[:1] == ["select-pane"] and action[3:5] == [";", "select-window"]:
        action[2] = pane_target
        action[6] = window_target
    else:
        for index, word in enumerate(action[:-1]):
            if word == "-t":
                action[index + 1] = pane_target
    return action

with open("/proc/sys/kernel/random/boot_id", encoding="ascii") as stream:
    BOOT_ID = stream.read().strip()
mode = sys.argv[1]
if mode == "discover":
    snapshot = discover(sys.argv[2], BOOT_ID)
    while True:
        encoded = json.dumps(snapshot, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        if len(encoded) <= MAX_SNAPSHOT:
            sys.stdout.buffer.write(encoded)
            break
        snapshot["complete"] = False
        sessions = snapshot["sessions"]
        if len(sessions) > 1:
            del sessions[len(sessions) // 2:]
        else:
            panes = sessions[0]["panes"]
            del panes[len(panes) // 2:]
elif mode == "action":
    path, boot, pid, started, session, created = sys.argv[2:8]
    pane, window, action = sys.argv[8], sys.argv[9], sys.argv[10:]
    needs_pane = bool(action) and action[0] not in {"attach-session", "rename-session", "kill-session"}
    descriptor = pin_socket(path)
    if descriptor is not None:
        try:
            row = checked(descriptor, path, boot, int(pid), int(started), session, int(created),
                          pane, window, needs_pane)
            if row:
                if needs_pane:
                    action = scope_pane_action(action, session, row[7], row[9])
                # An inherited O_PATH descriptor pins this socket's filesystem inode through
                # exec and connect. A replacement at the old pathname cannot get this action.
                os.set_inheritable(descriptor, True)
                os.execv(TMUX, tmux(pinned_path(descriptor)) + action)
        finally:
            os.close(descriptor)
    print("The tmux session or pane changed. Refresh its details before retrying.", file=sys.stderr)
    sys.exit(1)
else:
    sys.exit(1)
"##;

#[cfg(test)]
mod tests {
    use super::*;

    fn identity() -> SessionIdentity {
        SessionIdentity {
            distro: "Ubuntu-24.04".into(),
            socket: "/tmp/folder with spaces/custom socket".into(),
            boot_id: "ff9c470a-e024-4075-a105-e0fa8589dd41".into(),
            server_pid: 173,
            server_started: 888,
            session_id: "$9".into(),
            session_created: 1_700_000_001,
        }
    }

    #[test]
    fn guarded_arguments_keep_the_exact_target_and_name_separate() {
        let identity = identity();
        let args = guarded_args(&identity, &["rename-session", "My Outside Session"]).unwrap();
        assert!(args.iter().any(|arg| arg == &identity.socket));
        assert!(args.ends_with(&[
            "rename-session".to_string(),
            "-t".into(),
            "$9".into(),
            "My Outside Session".into(),
        ]));
        let args = guarded_args(&identity, &["split-window", "-h", "%26"]).unwrap();
        assert!(args.ends_with(&[
            "%26".to_string(),
            "".into(),
            "split-window".into(),
            "-h".into(),
            "-t".into(),
            "%26".into(),
            "-c".into(),
            "#{pane_current_path}".into(),
        ]));
        let args = guarded_args(&identity, &["select-pane", "@4", "%26"]).unwrap();
        assert!(args.ends_with(&[
            "%26".to_string(),
            "@4".into(),
            "select-pane".into(),
            "-t".into(),
            "%26".into(),
            ";".into(),
            "select-window".into(),
            "-t".into(),
            "@4".into(),
        ]));
        let args = guarded_args(&identity, &["search", "search-backward", r"#[abc]\;"]).unwrap();
        assert!(args.ends_with(&[
            "copy-mode".to_string(),
            "-t".into(),
            "$9".into(),
            ";".into(),
            "send-keys".into(),
            "-X".into(),
            "-t".into(),
            "$9".into(),
            "--".into(),
            "search-backward-text".into(),
            r"#[abc]\\;".into(),
        ]));
    }

    #[test]
    fn guarded_arguments_reject_command_separators_and_nonexact_ids() {
        let identity = identity();
        for args in [
            vec!["rename-session", "safe;kill-server"],
            vec!["select-pane", "%1;"],
            vec!["select-pane", "@1", "1"],
            vec!["kill-pane", "first"],
            vec!["attach-session", "-d"],
            vec!["send-keys", "-X", "search-backward", "thing\n"],
        ] {
            assert!(guarded_args(&identity, &args).is_err());
        }
        for bad in ["outside", "=outside", "$+1", "$01", "$-1"] {
            let mut identity = identity.clone();
            identity.session_id = bad.into();
            assert!(identity.validate().is_err());
        }
    }
}
