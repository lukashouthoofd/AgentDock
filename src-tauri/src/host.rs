use serde::Serialize;
use std::{
    env, fs,
    io::{Read, Seek},
    path::{Path, PathBuf},
    process::{Command, Output, Stdio},
    time::{Duration, Instant},
};

pub type Result<T> = std::result::Result<T, String>;

pub fn system_exe(relative: &str) -> PathBuf {
    PathBuf::from(env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into()))
        .join("System32")
        .join(relative)
}

pub fn quiet(command: &mut Command) -> &mut Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    command.stdin(Stdio::null())
}

pub fn wsl(distro: &str) -> Command {
    #[cfg(windows)]
    let mut command = Command::new(system_exe("wsl.exe"));
    #[cfg(not(windows))]
    let mut command = Command::new("env");
    #[cfg(windows)]
    command.args(["--distribution", distro, "--exec"]);
    #[cfg(not(windows))]
    let _ = distro;
    command.env_remove("WSLENV");
    command
}

pub fn output(command: &mut Command) -> Result<Output> {
    quiet(command)
        .output()
        .map_err(|error| format!("Could not start the requested tool ({:?}).", error.kind()))
}

pub fn output_bounded(command: &mut Command, limit: Duration) -> Result<Output> {
    const MAX_OUTPUT: u64 = 1024 * 1024;
    let mut stdout = tempfile::tempfile().map_err(|_| "Could not allocate local command output.")?;
    let mut stderr = tempfile::tempfile().map_err(|_| "Could not allocate local command output.")?;
    let mut child = quiet(command)
        .stdout(stdout.try_clone().map_err(|_| "Could not redirect local command output.")?)
        .stderr(stderr.try_clone().map_err(|_| "Could not redirect local command errors.")?)
        .spawn()
        .map_err(|_| "Could not start the local terminal helper.")?;
    let deadline = Instant::now() + limit;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(15)),
            outcome => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(if outcome.is_err() { "Could not monitor the local terminal helper." }
                    else { "The local Ubuntu helper timed out. Retry the terminal operation." }.into());
            }
        }
    };
    let read = |file: &mut fs::File| -> Result<Vec<u8>> {
        file.rewind().map_err(|_| "Could not read local command output.")?;
        let mut value = Vec::new();
        file.take(MAX_OUTPUT).read_to_end(&mut value).map_err(|_| "Could not read local command output.")?;
        Ok(value)
    };
    Ok(Output { status, stdout: read(&mut stdout)?, stderr: read(&mut stderr)? })
}

pub fn text(output: &[u8]) -> String {
    if output.starts_with(&[0xff, 0xfe]) || output.get(1) == Some(&0) {
        let start = if output.starts_with(&[0xff, 0xfe]) {
            2
        } else {
            0
        };
        let wide: Vec<_> = output[start..]
            .chunks_exact(2)
            .map(|part| u16::from_le_bytes([part[0], part[1]]))
            .collect();
        String::from_utf16_lossy(&wide)
    } else {
        String::from_utf8_lossy(output).into_owned()
    }
}

pub fn distros() -> Vec<String> {
    #[cfg(windows)]
    {
        let mut command = Command::new(system_exe("wsl.exe"));
        output(command.args(["--list", "--quiet"]))
            .ok()
            .filter(|out| out.status.success())
            .map(|out| {
                text(&out.stdout)
                    .lines()
                    .map(|line| line.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}'))
                    .filter(|name| !name.is_empty())
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default()
    }
    #[cfg(not(windows))]
    vec!["Linux".to_string()]
}

pub fn valid_distro(distro: &str) -> Result<()> {
    if !distro.is_empty()
        && distro.len() <= 100
        && !distro.starts_with('-')
        && distro
            .chars()
            .all(|character| character.is_alphanumeric() || "-_. ".contains(character))
    {
        Ok(())
    } else {
        Err("Choose an installed Ubuntu distribution in Settings.".into())
    }
}

pub fn home(distro: &str) -> Result<String> {
    valid_distro(distro)?;
    let out = output_bounded(wsl(distro).args(["/bin/sh", "-c", "printf '%s' \"$HOME\""]), Duration::from_secs(12))?;
    let value = text(&out.stdout);
    if out.status.success() && value.starts_with('/') {
        Ok(value)
    } else {
        Err("Could not locate the Ubuntu home directory.".into())
    }
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Location {
    pub display: String,
    pub native: String,
    pub linux: Option<String>,
    pub distro: Option<String>,
    #[serde(skip)]
    native_git: bool,
}

fn wsl_unc(value: &str) -> Option<(&str, String)> {
    let rest = value
        .strip_prefix("\\\\wsl.localhost\\")
        .or_else(|| value.strip_prefix("\\\\wsl$\\"))?;
    let (distro, tail) = rest.split_once('\\').unwrap_or((rest, ""));
    Some((distro, format!("/{}", tail.replace('\\', "/"))))
}

fn regular_windows_path(path: &Path) -> String {
    let display = path.to_string_lossy();
    if let Some(rest) = display.strip_prefix("\\\\?\\UNC\\") {
        format!("\\\\{rest}")
    } else {
        display
            .strip_prefix("\\\\?\\")
            .unwrap_or(&display)
            .to_owned()
    }
}

impl Location {
    fn linux(path: String, distro: &str) -> Self {
        #[cfg(windows)]
        let native = format!("\\\\wsl.localhost\\{distro}{}", path.replace('/', "\\"));
        #[cfg(not(windows))]
        let native = path.clone();
        Self {
            display: path.clone(),
            native,
            linux: Some(path),
            distro: Some(distro.to_owned()),
            native_git: false,
        }
    }

    pub fn git(&self) -> Result<Command> {
        if let Some(distro) = self.git_distro() {
            let mut command = wsl(distro);
            command.arg("/usr/bin/git");
            Ok(command)
        } else {
            windows_git()
        }
    }

    pub fn git_path(&self) -> &str {
        if self.native_git {
            &self.native
        } else {
            self.linux.as_deref().unwrap_or(&self.native)
        }
    }

    pub fn git_distro(&self) -> Option<&str> {
        if self.native_git {
            None
        } else {
            self.distro.as_deref()
        }
    }
}

fn windows_git() -> Result<Command> {
    for (root, relative) in [
        ("ProgramFiles", "Git/cmd/git.exe"),
        ("LOCALAPPDATA", "Programs/Git/cmd/git.exe"),
        ("ProgramFiles(x86)", "Git/cmd/git.exe"),
    ] {
        if let Some(root) = env::var_os(root) {
            let path = PathBuf::from(root).join(relative);
            if path.is_file() {
                return Ok(Command::new(path));
            }
        }
    }
    Err("Windows Git is unavailable for this path. Use an Ubuntu-accessible folder or an existing Git installation.".into())
}

pub fn resolve(value: &str, distro: &str, must_exist: bool) -> Result<Location> {
    if value.is_empty() || value.len() > 16_384 || value.contains(['\0', '\r', '\n']) {
        return Err("Enter a Windows or Ubuntu absolute folder path.".into());
    }
    let normalized_unc = value.replace('/', "\\");
    let lower = normalized_unc.to_ascii_lowercase();
    if lower.starts_with("\\\\wsl.localhost\\") || lower.starts_with("\\\\wsl$\\") {
        let (_, tail) = normalized_unc[2..].split_once('\\').unwrap_or(("", ""));
        let canonical = format!("\\\\wsl.localhost\\{tail}");
        if let Some((name, linux_path)) = wsl_unc(&canonical) {
            return resolve(&linux_path, name, must_exist);
        }
    }
    if (value.starts_with('/') && !value.starts_with("//"))
        || value == "~"
        || value.starts_with("~/")
    {
        valid_distro(distro)?;
        let path = if value == "~" || value.starts_with("~/") {
            format!("{}{}", home(distro)?, &value[1..])
        } else {
            value.to_owned()
        };
        let location = Location::linux(path, distro);
        if must_exist && !Path::new(&location.native).is_dir() {
            return Err("The Ubuntu folder is missing or unavailable.".into());
        }
        return Ok(location);
    }

    let path = Path::new(value);
    if !path.is_absolute() {
        return Err("Enter a Windows or Ubuntu absolute folder path.".into());
    }
    let native = if must_exist {
        let path =
            fs::canonicalize(path).map_err(|_| "The Windows folder is missing or unavailable.")?;
        if !path.is_dir() {
            return Err("Select a folder.".into());
        }
        regular_windows_path(&path)
    } else {
        regular_windows_path(path)
    };
    let linux = if valid_distro(distro).is_ok() && native.as_bytes().get(1) == Some(&b':') {
        output_bounded(wsl(distro).args(["/usr/bin/wslpath", "-a", "-u", &native]), Duration::from_secs(12))
            .ok()
            .filter(|out| out.status.success())
            .map(|out| text(&out.stdout).trim_end_matches(['\r', '\n']).to_owned())
            .filter(|path| path.starts_with('/'))
    } else {
        None
    };
    let linked_git = Path::new(&native).join(".git");
    let linux_link = fs::metadata(&linked_git)
        .is_ok_and(|info| info.is_file() && info.len() < 16_384)
        && fs::read_to_string(linked_git).is_ok_and(|pointer| {
            pointer
                .strip_prefix("gitdir: ")
                .is_some_and(|target| target.starts_with('/') && !target.starts_with("//"))
        });
    let native_git = linux.is_none() || (!linux_link && windows_git().is_ok());
    let distro = linux.as_ref().map(|_| distro.to_owned());
    Ok(Location {
        display: native.clone(),
        native,
        linux,
        distro,
        native_git,
    })
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct GitInfo {
    pub branch: String,
    pub worktrees: Vec<Worktree>,
}

#[derive(Serialize)]
pub struct Worktree {
    pub path: String,
    pub branch: String,
    pub locked: bool,
    pub missing: bool,
}

fn branch_name(value: &str) -> &str {
    value.strip_prefix("refs/heads/").unwrap_or(value)
}

pub fn git_info(path: &str, distro: &str) -> Result<GitInfo> {
    let location = resolve(path, distro, true)?;
    let mut git = location.git()?;
    let out = output(git.args([
        "--no-optional-locks",
        "-C",
        location.git_path(),
        "worktree",
        "list",
        "--porcelain",
        "-z",
    ]))?;
    if !out.status.success() {
        return Ok(GitInfo::default());
    }
    let mut worktrees = Vec::<Worktree>::new();
    for item in text(&out.stdout).split('\0') {
        let (field, value) = item.split_once(' ').unwrap_or((item, ""));
        if field == "worktree" {
            worktrees.push(Worktree {
                path: value.into(),
                branch: String::new(),
                locked: false,
                missing: false,
            });
        } else if let Some(worktree) = worktrees.last_mut() {
            match field {
                "branch" => worktree.branch = branch_name(value).into(),
                "detached" => worktree.branch = "Detached".into(),
                "bare" => worktree.branch = "Bare".into(),
                "locked" => worktree.locked = true,
                "prunable" => worktree.missing = true,
                _ => {}
            }
        }
    }
    let mut git = location.git()?;
    let current = output(git.args([
        "--no-optional-locks",
        "-C",
        location.git_path(),
        "symbolic-ref",
        "--quiet",
        "--short",
        "HEAD",
    ]))?;
    let branch = if current.status.success() {
        text(&current.stdout)
            .trim_end_matches(['\r', '\n'])
            .to_owned()
    } else {
        "Detached".to_owned()
    };
    if location.display != location.git_path() {
        if let Some(distro) = &location.distro {
            for worktree in &mut worktrees {
                let converted =
                    output(wsl(distro).args(["/usr/bin/wslpath", "-w", &worktree.path]));
                if let Ok(out) = converted {
                    if out.status.success() {
                        worktree.path = text(&out.stdout).trim_end_matches(['\r', '\n']).to_owned();
                    }
                }
            }
        }
    }
    if location.native_git {
        for tree in &mut worktrees {
            if tree.path.as_bytes().get(1) == Some(&b':') || tree.path.starts_with("//") {
                tree.path = tree.path.replace('/', "\\");
            }
        }
    }
    Ok(GitInfo { branch, worktrees })
}

fn allowed_remote(remote: &str) -> bool {
    if remote.is_empty() || remote.starts_with('-') || remote.contains(['\0', '\r', '\n']) {
        return false;
    }
    if let Some((scheme, _)) = remote.split_once("://") {
        return matches!(scheme, "https" | "http" | "ssh" | "git" | "file");
    }
    !remote.contains("::")
}

pub fn clone_repo(remote: &str, path: &str, distro: &str) -> Result<Location> {
    if !allowed_remote(remote) {
        return Err("Use a Git HTTPS, SSH, file or local repository path.".into());
    }
    let location = resolve(path, distro, false)?;
    let physical = Path::new(&location.native);
    if physical.exists() {
        return Err("The clone destination already exists. Choose a new folder.".into());
    }
    if let Some(parent) = physical.parent() {
        fs::create_dir_all(parent).map_err(|_| "Could not create the clone’s parent folder.")?;
    }
    let mut git = if let Some(distro) = location.git_distro() {
        let mut command = wsl(distro);
        command.args([
            "/usr/bin/env",
            "GIT_TERMINAL_PROMPT=0",
            "GIT_ALLOW_PROTOCOL=https:http:ssh:git:file",
            "/usr/bin/git",
        ]);
        command
    } else {
        let mut command = location.git()?;
        command
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GIT_ALLOW_PROTOCOL", "https:http:ssh:git:file");
        command
    };
    let status = quiet(git.args(["clone", "--", remote, location.git_path()]))
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|_| "Could not start Git.")?;
    if !status.success() {
        return Err("Clone failed. Check the repository URL and authentication, or run Git in a terminal to see its diagnostic.".into());
    }
    resolve(path, distro, true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_git_helpers_and_decodes_wsl_list() {
        for remote in ["-c", "ext::tool", "fool://repo", "a\nb"] {
            assert!(!allowed_remote(remote));
        }
        for remote in [
            "https://github.com/team/repo",
            "git@host:repo",
            "/tmp/a b",
            "C:\\repo",
        ] {
            assert!(allowed_remote(remote));
        }
        assert_eq!(text(&[0xff, 0xfe, b'a', 0, b'\n', 0]), "a\n");
        assert_eq!(
            wsl_unc("\\\\wsl$\\Ubuntu\\a b"),
            Some(("Ubuntu", "/a b".into()))
        );
    }
}
