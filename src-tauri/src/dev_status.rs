use crate::host::{self, Location, Worktree};
use serde::{Deserialize, Serialize};
use std::{
    env,
    io::Read,
    path::{Path, PathBuf},
    process::{Command, ExitStatus, Stdio},
    sync::mpsc,
    thread,
    time::{Duration, Instant},
};

const COMMAND_LIMIT: Duration = Duration::from_secs(10);
const OUTPUT_LIMIT: u64 = 1024 * 1024;
const LIST_LIMIT: usize = 60;
type Result<T> = std::result::Result<T, String>;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Branches {
    current: String,
    branches: Vec<Branch>,
    worktrees: Vec<Worktree>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Branch {
    name: String,
    is_current: bool,
    upstream: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Pull {
    number: u64,
    title: String,
    url: String,
    head_ref_name: String,
    base_ref_name: String,
    is_draft: bool,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Container {
    name: String,
    image: String,
    status: String,
    ports: String,
}

struct Report {
    status: ExitStatus,
    text: String,
}

fn run(command: &mut Command, name: &str) -> Result<Report> {
    let deadline = Instant::now() + COMMAND_LIMIT;
    let mut child = host::quiet(command)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| format!("Could not start {name} in this project environment."))?;

    let Some(stdout) = child.stdout.take() else {
        let _ = child.kill();
        return Err(format!("Could not read {name} output."));
    };
    let (sender, receiver) = mpsc::sync_channel(1);
    thread::Builder::new()
        .name("development-status-output".into())
        .spawn(move || {
            let mut bytes = Vec::new();
            let read = stdout.take(OUTPUT_LIMIT + 1).read_to_end(&mut bytes);
            let _ = sender.send((read, bytes));
        })
        .map_err(|_| {
            let _ = child.kill();
            format!("Could not read {name} output.")
        })?;

    let timeout = || format!("{name} did not respond in time.");
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(25)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(timeout());
            }
            Err(_) => {
                let _ = child.kill();
                return Err(format!("Could not check {name} status."));
            }
        }
    };

    let (read, bytes) = receiver
        .recv_timeout(deadline.saturating_duration_since(Instant::now()))
        .map_err(|_| timeout())?;
    read.map_err(|_| format!("Could not read {name} output."))?;
    if bytes.len() as u64 > OUTPUT_LIMIT {
        return Err(format!("{name} returned too much data."));
    }
    Ok(Report {
        status,
        text: String::from_utf8_lossy(&bytes).into_owned(),
    })
}

fn git(location: &Location, args: &[&str]) -> Result<Report> {
    let mut command = location.git()?;
    command
        .args(["--no-optional-locks", "-C", location.git_path()])
        .args(args);
    run(&mut command, "Git")
}

fn project_location(path: &str, distro: &str) -> Result<Location> {
    if path == "~" || path.starts_with("~/") {
        return Err("Open the folder in AgentDock before using the development panel.".into());
    }
    #[cfg(windows)]
    if path.strip_prefix(r"\\?\").unwrap_or(path).as_bytes().get(1) == Some(&b':') {
        // The project's native path is already known. Bound the optional WSL translation too.
        let mut location = host::resolve(path, "", true)?;
        if host::valid_distro(distro).is_ok() {
            let mut command = host::wsl(distro);
            if let Ok(report) = run(
                command.args(["/usr/bin/wslpath", "-a", "-u", &location.native]),
                "Ubuntu",
            ) {
                let path = report.text.trim_end_matches(['\r', '\n']);
                if report.status.success() && path.starts_with('/') {
                    location.distro = Some(distro.into());
                    location.linux = Some(path.into());
                }
            }
        }
        return Ok(location);
    }
    host::resolve(path, distro, true)
}

pub fn branches(path: &str, distro: &str) -> Result<Branches> {
    let location = project_location(path, distro)?;
    let refs = git(
        &location,
        &[
            "for-each-ref",
            "--count=60",
            "--sort=-committerdate",
            "--format=%(refname:lstrip=2)%00%(HEAD)%00%(upstream:short)",
            "refs/heads",
        ],
    )?;
    if !refs.status.success() {
        return Err("Git could not read branches in this folder.".into());
    }
    let head = git(&location, &["symbolic-ref", "--quiet", "--short", "HEAD"])?;
    let tree = git(&location, &["worktree", "list", "--porcelain", "-z"])?;
    if !tree.status.success() {
        return Err("Git could not list the worktrees in this repository.".into());
    }

    Ok(Branches {
        current: if head.status.success() {
            head.text.trim_end_matches(['\r', '\n']).into()
        } else {
            "Detached".into()
        },
        branches: refs
            .text
            .lines()
            .filter_map(|line| {
                let mut fields = line.split('\0');
                let name = fields.next()?.to_owned();
                let is_current = fields.next()? == "*";
                let upstream = fields.next()?.to_owned();
                Some(Branch {
                    name,
                    is_current,
                    upstream,
                })
            })
            .collect(),
        worktrees: parse_worktrees(&tree.text),
    })
}

fn parse_worktrees(text: &str) -> Vec<Worktree> {
    text.split("\0\0")
        .filter_map(|block| {
            let mut entries = block.split('\0');
            let path = entries.next()?.strip_prefix("worktree ")?.to_owned();
            let mut worktree = Worktree {
                path,
                branch: String::new(),
                locked: false,
                missing: false,
            };
            for entry in entries {
                let (kind, value) = entry.split_once(' ').unwrap_or((entry, ""));
                match kind {
                    "branch" => {
                        worktree.branch = value.strip_prefix("refs/heads/").unwrap_or(value).into()
                    }
                    "detached" => worktree.branch = "Detached".into(),
                    "bare" => worktree.branch = "Bare".into(),
                    "locked" => worktree.locked = true,
                    "prunable" => worktree.missing = true,
                    _ => {}
                }
            }
            Some(worktree)
        })
        .take(LIST_LIMIT)
        .collect()
}

fn windows_tool(binary: &str, location: &Location) -> Option<PathBuf> {
    let relative = match binary {
        "gh" => "GitHub CLI/gh.exe",
        "docker" => "Docker/Docker/resources/bin/docker.exe",
        _ => return None,
    };
    if let Some(path) = env::var_os("ProgramFiles").map(|base| PathBuf::from(base).join(relative)) {
        if path.is_file() {
            return Some(path);
        }
    }
    let search = env::var_os("PATH")?;
    let project = Path::new(&location.native);
    env::split_paths(&search)
        .filter(|entry| entry.is_absolute() && !entry.starts_with(project))
        .map(|entry| entry.join(format!("{binary}.exe")))
        .find(|entry| entry.is_file())
}

fn cli(location: &Location, binary: &str, args: &[&str], name: &str) -> Result<Report> {
    let mut command = if let Some(distro) = &location.distro {
        let mut command = host::wsl(distro);
        let script = r#"
cd -- "$1" || exit 126
shift
executable=$(command -v "$1") || exit 127
case "$executable" in
    "$PWD"/*) exit 127 ;;
    /*) ;;
    *) exit 127 ;;
esac
shift
unset GH_REPO
export GH_PROMPT_DISABLED=1 GH_NO_UPDATE_NOTIFIER=1 GH_NO_EXTENSION_UPDATE_NOTIFIER=1 NO_COLOR=1
exec "$executable" "$@"
"#;
        command.args([
            "/usr/bin/timeout",
            "--kill-after=1s",
            "8s",
            "/bin/sh",
            "-c",
            script,
            "agentdock-development",
            location.git_path(),
            binary,
        ]);
        command
    } else {
        let executable = windows_tool(binary, location)
            .ok_or_else(|| format!("{name} is unavailable in this project environment."))?;
        let mut command = Command::new(executable);
        if binary == "gh" {
            command.current_dir(&location.native);
        }
        command
            .env("GH_PROMPT_DISABLED", "1")
            .env("GH_NO_UPDATE_NOTIFIER", "1")
            .env("GH_NO_EXTENSION_UPDATE_NOTIFIER", "1")
            .env("NO_COLOR", "1")
            .env_remove("GH_REPO");
        command
    };
    let report = run(command.args(args), name)?;
    match report.status.code() {
        Some(124 | 137) => Err(format!("{name} did not respond in time.")),
        Some(126 | 127) => Err(format!(
            "{name} is unavailable in this project environment."
        )),
        _ => Ok(report),
    }
}

pub fn pulls(path: &str, distro: &str) -> Result<Vec<Pull>> {
    let location = project_location(path, distro)?;
    let report = cli(
        &location,
        "gh",
        &[
            "pr",
            "list",
            "--state",
            "open",
            "--limit",
            "25",
            "--json",
            "number,title,url,headRefName,baseRefName,isDraft",
        ],
        "GitHub CLI",
    )?;
    if !report.status.success() {
        return Err("Could not read open pull requests. Check the GitHub remote and your existing GitHub CLI access.".into());
    }
    serde_json::from_str(&report.text)
        .map_err(|_| "GitHub CLI returned an unexpected format.".into())
}

pub fn containers(path: &str, distro: &str) -> Result<Vec<Container>> {
    const FORMAT: &str = r#"{"name":{{json .Names}},"image":{{json .Image}},"status":{{json .Status}},"ports":{{json .Ports}}}"#;
    let location = project_location(path, distro)?;
    let report = cli(
        &location,
        "docker",
        &["ps", "--format", FORMAT],
        "Docker CLI",
    )?;
    if !report.status.success() {
        return Err("Could not reach the Docker engine for this project environment.".into());
    }
    report
        .text
        .lines()
        .filter(|line| !line.trim().is_empty())
        .take(LIST_LIMIT)
        .map(|line| {
            serde_json::from_str(line)
                .map_err(|_| "Docker CLI returned an unexpected format.".into())
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_local_branches_and_existing_worktrees() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("primary Git project");
        let sibling = directory.path().join("other worktree");
        let path = root.to_str().unwrap();
        let git = |args: &[&str]| {
            let output = Command::new("git").args(args).output().unwrap();
            assert!(output.status.success());
        };
        git(&["init", "-q", "-b", "main", path]);
        git(&[
            "-C",
            path,
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.invalid",
            "commit",
            "--allow-empty",
            "-qm",
            "Initial",
        ]);
        git(&[
            "-C",
            path,
            "worktree",
            "add",
            "-qb",
            "worker",
            sibling.to_str().unwrap(),
        ]);
        git(&["-C", path, "branch", "a"]);
        let distro = if cfg!(windows) { "" } else { "Linux" };
        let panels = branches(path, distro).unwrap();
        assert_eq!(panels.current, "main");
        assert_eq!(panels.branches.len(), 3);
        assert!(panels.branches.iter().any(|item| item.name == "a"));
        assert!(panels
            .branches
            .iter()
            .any(|item| item.name == "main" && item.is_current));
        assert!(panels.worktrees.iter().any(|item| item.branch == "worker"
            && item.path.replace('\\', "/") == sibling.to_str().unwrap().replace('\\', "/")));
    }

    #[test]
    fn parses_detached_locked_and_pruned_worktrees() {
        let input = "worktree /path with spaces\0HEAD 123\0detached\0locked dependency\0\0worktree /missing\0HEAD 456\0branch refs/heads/fix\0prunable missing path\0\0";
        let result = parse_worktrees(input);
        assert_eq!(result.len(), 2);
        assert!(result[0].locked);
        assert_eq!(result[0].branch, "Detached");
        assert_eq!(result[0].path, "/path with spaces");
        assert!(result[1].missing);
        assert_eq!(result[1].branch, "fix");
    }
}
