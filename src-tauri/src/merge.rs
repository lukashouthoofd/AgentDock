use crate::host::{self, Location, Result};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File},
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    process::Output,
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

static MERGE_LOCK: Mutex<()> = Mutex::new(());
const REFLOG_TAIL: u64 = 64 * 1024;
const NOTICE_LIMIT: usize = 8;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Branch {
    pub name: String,
    pub oid: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub branch: String,
    pub head: String,
    pub branches: Vec<Branch>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Outcome {
    pub changed: bool,
    pub branch: String,
    pub source: String,
    pub head: String,
}

fn run(repo: &Location, args: &[&str]) -> Result<Output> {
    let mut git = repo.git()?;
    git.arg("--no-optional-locks")
        .arg("-C")
        .arg(repo.git_path())
        .args(args);
    host::output(&mut git)
}

fn object_id(oid: &str) -> bool {
    matches!(oid.len(), 40 | 64) && oid.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn branch_label(reference: &str) -> Option<&str> {
    reference
        .strip_prefix("refs/heads/")
        .filter(|name| !name.is_empty() && name.len() < 1024 && !name.chars().any(char::is_control))
}

fn current_branch(repo: &Location) -> Result<String> {
    let reference = run(repo, &["symbolic-ref", "--quiet", "HEAD"])?;
    if !reference.status.success() {
        return Err("Check out a local branch in this worktree before merging.".into());
    }
    let reference = std::str::from_utf8(&reference.stdout)
        .map_err(|_| "The checked-out branch cannot be represented in the workspace.")?;
    branch_label(reference.trim_end_matches(['\r', '\n']))
        .map(str::to_string)
        .ok_or_else(|| "Could not read the checked-out branch.".into())
}

fn checked_out(repo: &Location) -> Result<(String, String)> {
    let branch = current_branch(repo)?;
    let head = run(repo, &["rev-parse", "--verify", "HEAD"])?;
    let oid = host::text(&head.stdout);
    let oid = oid.trim_end_matches(['\r', '\n']);
    if !head.status.success() || !object_id(oid) {
        return Err("The checked-out branch needs a commit before merging.".into());
    }
    Ok((branch, oid.into()))
}

pub fn preview(path: &str, distro: &str) -> Result<Preview> {
    let repo = host::resolve(path, distro, true)?;
    let (branch, head) = checked_out(&repo)?;
    let refs = run(
        &repo,
        &[
            "for-each-ref",
            "--sort=refname",
            "--format=%(refname)%00%(objectname)",
            "refs/heads/",
        ],
    )?;
    if !refs.status.success() {
        return Err("Could not list local branches.".into());
    }
    let branches = refs
        .stdout
        .split(|byte| *byte == b'\n')
        .filter_map(|line| {
            let line = std::str::from_utf8(line).ok()?.trim_end_matches('\r');
            let (reference, oid) = line.split_once('\0')?;
            let name = branch_label(reference)?;
            (name != branch && object_id(oid)).then(|| Branch {
                name: name.into(),
                oid: oid.into(),
            })
        })
        .collect();
    Ok(Preview {
        branch,
        head,
        branches,
    })
}

fn in_progress(repo: &Location) -> Result<bool> {
    // These pseudorefs are scoped to the selected worktree.
    for reference in [
        "MERGE_HEAD",
        "CHERRY_PICK_HEAD",
        "REVERT_HEAD",
        "REBASE_HEAD",
    ] {
        if run(repo, &["rev-parse", "--verify", "--quiet", reference])?
            .status
            .success()
        {
            return Ok(true);
        }
    }
    Ok(false)
}

fn check_destination(repo: &Location, branch: &str, head: &str) -> Result<()> {
    if checked_out(repo)? != (branch.into(), head.into()) {
        return Err(
            "The worktree changed after the merge preview. Open Merge Branch again.".into(),
        );
    }
    Ok(())
}

fn check_source(repo: &Location, reference: &str, oid: &str) -> Result<()> {
    let current = run(repo, &["show-ref", "--verify", "--hash", reference])?;
    if !current.status.success()
        || host::text(&current.stdout).trim_end_matches(['\r', '\n']) != oid
    {
        return Err(
            "The source branch changed after the merge preview. Open Merge Branch again.".into(),
        );
    }
    Ok(())
}

pub fn execute(
    path: &str,
    distro: &str,
    expected_head: &str,
    expected_branch: &str,
    source: &str,
    source_oid: &str,
) -> Result<Outcome> {
    if !object_id(expected_head) || !object_id(source_oid) || expected_branch == source {
        return Err("Select a different local branch to merge.".into());
    }
    let reference = format!("refs/heads/{source}");
    branch_label(&reference).ok_or("Select a valid local branch.")?;
    let repo = host::resolve(path, distro, true)?;
    let _guard = MERGE_LOCK
        .lock()
        .map_err(|_| "The local merge control is unavailable.")?;
    check_destination(&repo, expected_branch, expected_head)?;
    check_source(&repo, &reference, source_oid)?;
    if in_progress(&repo)? {
        return Err("Finish or abort the Git operation in this worktree before merging.".into());
    }
    let status = run(
        &repo,
        &[
            "status",
            "--porcelain=v1",
            "-z",
            "--untracked-files=normal",
            "--ignore-submodules=none",
        ],
    )?;
    if !status.status.success() {
        return Err("Could not inspect the worktree for local changes.".into());
    }
    if !status.stdout.is_empty() {
        return Err(
            "Commit, stash or remove local changes in this worktree before merging.".into(),
        );
    }

    // Use the confirmed object ID even if the source reference moves after this point.
    check_destination(&repo, expected_branch, expected_head)?;
    let message = format!("Merge branch '{source}'");
    let merged = run(
        &repo,
        &["merge", "--no-edit", "-m", &message, "--", source_oid],
    )?;
    if !merged.status.success() {
        return Err(if in_progress(&repo)? {
            "Git left a merge in progress. Resolve or abort it in the worktree’s terminal."
        } else {
            "Git declined the merge. Use the worktree’s terminal to inspect its status and Git configuration."
        }.into());
    }

    let (branch, head) = checked_out(&repo)?;
    if branch != expected_branch
        || !run(&repo, &["merge-base", "--is-ancestor", source_oid, &head])?
            .status
            .success()
        || !run(
            &repo,
            &["merge-base", "--is-ancestor", expected_head, &head],
        )?
        .status
        .success()
    {
        return Err(
            "The resulting worktree changed unexpectedly. Inspect its Git status in the terminal."
                .into(),
        );
    }
    Ok(Outcome {
        changed: head != expected_head,
        branch,
        source: source.into(),
        head,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Observed {
    pub changed: bool,
    pub branch: String,
    pub source: String,
    pub head: String,
    pub old_head: String,
    pub timestamp: u64,
    pub key: String,
}

struct Entry<'a> {
    old: &'a str,
    new: &'a str,
    timestamp: u64,
    action: &'a str,
}

impl<'a> Entry<'a> {
    fn parse(line: &'a [u8]) -> Option<Self> {
        let (left, action) = std::str::from_utf8(line).ok()?.split_once('\t')?;
        let mut parts = left.splitn(3, ' ');
        let old = parts.next()?;
        let new = parts.next()?;
        let mut date = parts.next()?.rsplitn(3, ' ');
        date.next()?;
        let timestamp = date.next()?.parse().ok()?;
        (object_id(old) && object_id(new)).then_some(Self {
            old,
            new,
            timestamp,
            action: action.trim_end_matches('\r'),
        })
    }
}

enum Action<'a> {
    FastForward(&'a str),
    MergeCommit(Option<&'a str>),
}

impl<'a> Action<'a> {
    fn parse(action: &'a str) -> Option<Self> {
        if action.starts_with("commit (merge): ") {
            return Some(Self::MergeCommit(None));
        }
        let (source, detail) = action.strip_prefix("merge ")?.rsplit_once(": ")?;
        if detail == "Fast-forward" {
            Some(Self::FastForward(source))
        } else if detail.starts_with("Merge made by the ") && detail.ends_with(" strategy.") {
            Some(Self::MergeCommit(Some(source)))
        } else {
            None
        }
    }

    fn merged_tips(&self, repo: &Location, entry: &Entry<'_>) -> Result<Vec<String>> {
        if entry.old == entry.new {
            return Ok(Vec::new());
        }
        if matches!(self, Action::FastForward(_)) {
            let verified = run(repo, &["merge-base", "--is-ancestor", entry.old, entry.new])?
                .status
                .success();
            return Ok(if verified {
                vec![entry.new.into()]
            } else {
                Vec::new()
            });
        }
        let parents = run(repo, &["rev-list", "--parents", "-1", entry.new])?;
        let values = host::text(&parents.stdout);
        let mut values = values.split_ascii_whitespace();
        if !parents.status.success()
            || values.next() != Some(entry.new)
            || values.next() != Some(entry.old)
        {
            return Ok(Vec::new());
        }
        Ok(values
            .filter(|oid| object_id(oid))
            .map(str::to_string)
            .collect())
    }

    fn source(&self, repo: &Location, tips: &[String]) -> String {
        let source = match self {
            Self::FastForward(source) | Self::MergeCommit(Some(source)) => Some(*source),
            Self::MergeCommit(None) => None,
        };
        if let Some(source) = source.filter(|name| !name.chars().any(char::is_whitespace)) {
            let reference = if source.starts_with("refs/heads/") {
                source.to_string()
            } else {
                format!("refs/heads/{source}")
            };
            if let Some(name) = branch_label(&reference) {
                if run(repo, &["show-ref", "--verify", "--hash", &reference]).is_ok_and(|value| {
                    value.status.success()
                        && tips
                            .iter()
                            .any(|tip| tip == host::text(&value.stdout).trim_end())
                }) {
                    return name.into();
                }
            }
        }
        "Local commits".into()
    }
}

fn reflog_file(repo: &Location, distro: &str) -> Result<Option<PathBuf>> {
    let path = run(
        repo,
        &[
            "rev-parse",
            "--path-format=absolute",
            "--git-path",
            "logs/HEAD",
        ],
    )?;
    if !path.status.success() {
        return Ok(None);
    }
    let path = host::text(&path.stdout);
    let Some((directory, "HEAD")) = path.trim_end_matches(['\r', '\n']).rsplit_once(['/', '\\'])
    else {
        return Ok(None);
    };
    match host::resolve(directory, repo.distro.as_deref().unwrap_or(distro), true) {
        Ok(directory) => Ok(Some(Path::new(&directory.native).join("HEAD"))),
        Err(_) => Ok(None),
    }
}

fn tail(path: &Path) -> std::io::Result<Vec<u8>> {
    if !fs::symlink_metadata(path)?.is_file() {
        return Ok(Vec::new());
    }
    let mut file = File::open(path)?;
    let length = file.metadata()?.len();
    let start = length.saturating_sub(REFLOG_TAIL);
    file.seek(SeekFrom::Start(start))?;
    let mut data = Vec::new();
    file.take(REFLOG_TAIL).read_to_end(&mut data)?;

    // An append can be in flight. Align both ends to complete reflog records.
    let end = data
        .iter()
        .rposition(|byte| *byte == b'\n')
        .map_or(0, |index| index + 1);
    data.truncate(end);
    if start > 0 {
        let first = data
            .iter()
            .position(|byte| *byte == b'\n')
            .map_or(end, |index| index + 1);
        data.drain(..first);
    }
    Ok(data)
}

pub fn observe(path: &str, distro: &str, since: u64) -> Result<Vec<Observed>> {
    if since == 0 {
        return Ok(Vec::new());
    }
    let repo = host::resolve(path, distro, true)?;
    let Some(log) = reflog_file(&repo, distro)? else {
        return Ok(Vec::new());
    };
    let data = match tail(&log) {
        Ok(data) if data.is_empty() => return Ok(Vec::new()),
        Ok(data) => data,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(_) => return Err("Could not read this worktree’s Git reflog.".into()),
    };
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let since = since.max(now.saturating_sub(300));

    let mut observations = Vec::new();
    let mut current = true;
    let mut branch = None;
    let mut identity = None;
    for line in data.rsplit(|byte| *byte == b'\n') {
        let Some(entry) = Entry::parse(line) else {
            continue;
        };
        if entry.action.starts_with("checkout: ")
            || entry.action.starts_with("rebase ")
            || entry.action.starts_with("branch: renamed ")
        {
            current = false;
        }
        if entry.timestamp < since || entry.timestamp > now.saturating_add(5) {
            continue;
        }
        let Some(action) = Action::parse(entry.action) else {
            continue;
        };
        let tips = action.merged_tips(&repo, &entry)?;
        if tips.is_empty() {
            continue;
        }
        let worktree_id = identity.get_or_insert_with(|| {
            let canonical = fs::canonicalize(&log).unwrap_or_else(|_| log.clone());
            let distro = repo.distro.as_deref().unwrap_or(distro);
            let path = canonical.as_os_str().to_string_lossy();
            format!("{:x}", Sha256::digest(format!("{path}\0{distro}")))
        });
        let destination = if current {
            branch
                .get_or_insert_with(|| current_branch(&repo).unwrap_or_else(|_| "Worktree".into()))
                .clone()
        } else {
            "Worktree".into()
        };
        observations.push(Observed {
            changed: true,
            branch: destination,
            source: action.source(&repo, &tips),
            head: entry.new.into(),
            old_head: entry.old.into(),
            timestamp: entry.timestamp,
            key: format!(
                "{worktree_id}:{}:{}:{}",
                entry.timestamp, entry.old, entry.new
            ),
        });
        if observations.len() == NOTICE_LIMIT {
            break;
        }
    }
    observations.reverse();
    Ok(observations)
}

#[cfg(all(test, not(windows)))]
mod tests {
    use super::*;
    use std::{fs, path::Path, process::Command};

    fn git(path: &Path, args: &[&str]) {
        let result = Command::new("/usr/bin/git")
            .arg("-C")
            .arg(path)
            .args(args)
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "{:?}: {}",
            args,
            String::from_utf8_lossy(&result.stderr)
        );
    }

    fn fixture() -> tempfile::TempDir {
        let root = tempfile::Builder::new()
            .prefix("AgentDock Merge ")
            .tempdir()
            .unwrap();
        git(root.path(), &["init", "-b", "main"]);
        git(
            root.path(),
            &["config", "user.email", "fixture@example.invalid"],
        );
        git(root.path(), &["config", "user.name", "Merge Fixture"]);
        fs::write(root.path().join("fixture"), "original\n").unwrap();
        git(root.path(), &["add", "."]);
        git(root.path(), &["commit", "-m", "Baseline"]);
        git(root.path(), &["switch", "-c", "workers/feature"]);
        fs::write(root.path().join("fixture"), "feature\n").unwrap();
        git(root.path(), &["commit", "-am", "Feature"]);
        git(root.path(), &["switch", "main"]);
        root
    }

    fn ship(root: &Path, preview: &Preview) -> Result<Outcome> {
        let source = &preview.branches[0];
        execute(
            root.to_str().unwrap(),
            "Linux",
            &preview.head,
            &preview.branch,
            &source.name,
            &source.oid,
        )
    }

    #[test]
    fn verifies_fast_forward_and_noop() {
        let root = fixture();
        let path = root.path().to_str().unwrap();
        let before = preview(path, "Linux").unwrap();
        assert_eq!(before.branch, "main");
        assert_eq!(before.branches[0].name, "workers/feature");
        let result = ship(root.path(), &before).unwrap();
        assert!(result.changed);
        assert_eq!(result.head, before.branches[0].oid);
        let after = preview(path, "Linux").unwrap();
        assert!(!ship(root.path(), &after).unwrap().changed);
    }

    #[test]
    fn rejects_dirty_and_moved_sources() {
        let root = fixture();
        let path = root.path().to_str().unwrap();
        let before = preview(path, "Linux").unwrap();
        let dirty = root.path().join("untracked");
        fs::write(&dirty, "dirty").unwrap();
        assert!(ship(root.path(), &before)
            .err()
            .unwrap()
            .contains("local changes"));
        fs::remove_file(dirty).unwrap();
        git(root.path(), &["branch", "-f", "workers/feature", "main"]);
        assert!(ship(root.path(), &before)
            .err()
            .unwrap()
            .contains("source branch changed"));
    }

    #[test]
    fn verifies_a_clean_non_fast_forward_merge() {
        let root = fixture();
        fs::write(root.path().join("separate"), "main\n").unwrap();
        git(root.path(), &["add", "separate"]);
        git(root.path(), &["commit", "-m", "Independent change"]);
        let before = preview(root.path().to_str().unwrap(), "Linux").unwrap();
        let outcome = ship(root.path(), &before).unwrap();
        assert!(outcome.changed);
        assert_ne!(outcome.head, before.branches[0].oid);
        assert_eq!(outcome.branch, "main");
    }

    #[test]
    fn preserves_conflict_for_terminal_resolution() {
        let root = fixture();
        fs::write(root.path().join("fixture"), "main\n").unwrap();
        git(root.path(), &["commit", "-am", "Divergence"]);
        let before = preview(root.path().to_str().unwrap(), "Linux").unwrap();
        assert!(ship(root.path(), &before)
            .err()
            .unwrap()
            .contains("merge in progress"));
        assert!(root.path().join(".git/MERGE_HEAD").is_file());
        git(root.path(), &["merge", "--abort"]);
    }
    fn now() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs()
    }

    #[test]
    fn observes_only_recent_real_fast_forward_in_a_reflog() {
        let root = fixture();
        let path = root.path().to_str().unwrap();
        let start = now();
        let before = preview(path, "Linux").unwrap();
        git(root.path(), &["merge", "--ff-only", "workers/feature"]);
        git(root.path(), &["merge", "--ff-only", "workers/feature"]);
        git(
            root.path(),
            &["commit", "--allow-empty", "-m", "A normal commit"],
        );
        let notices = observe(path, "Linux", start).unwrap();
        assert_eq!(notices.len(), 1);
        assert!(notices[0].changed);
        assert_eq!(notices[0].branch, "main");
        assert_eq!(notices[0].source, "workers/feature");
        assert_eq!(notices[0].old_head, before.head);
        assert_eq!(notices[0].head, before.branches[0].oid);
        let alias = format!("{path}/.");
        assert_eq!(
            observe(&alias, "Linux", start).unwrap()[0].key,
            notices[0].key
        );
        assert!(observe(path, "Linux", 0).unwrap().is_empty());
        assert!(observe(path, "Linux", now() + 10).unwrap().is_empty());
    }

    #[test]
    fn observes_merge_commit_in_the_linked_worktree_only() {
        let root = fixture();
        let group = tempfile::tempdir().unwrap();
        let linked = group.path().join("linked worktree");
        let path = linked.to_str().unwrap();
        git(
            root.path(),
            &["worktree", "add", "-b", "integration", path, "main"],
        );
        git(
            &linked,
            &["commit", "--allow-empty", "-m", "Integration prep"],
        );
        let start = now();
        git(&linked, &["merge", "--no-edit", "workers/feature"]);
        let notices = observe(path, "Linux", start).unwrap();
        assert_eq!(notices.len(), 1);
        assert_eq!(notices[0].branch, "integration");
        assert_eq!(notices[0].source, "workers/feature");
        assert!(observe(root.path().to_str().unwrap(), "Linux", start)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn waits_for_conflict_resolution_and_ignores_non_merge_parentage() {
        let root = fixture();
        let path = root.path().to_str().unwrap();
        let start = now();
        fs::write(root.path().join("fixture"), "main\n").unwrap();
        git(root.path(), &["commit", "-am", "Divergence"]);
        let before = preview(path, "Linux").unwrap();
        assert!(ship(root.path(), &before).is_err());
        assert!(observe(path, "Linux", start).unwrap().is_empty());
        git(root.path(), &["checkout", "--theirs", "fixture"]);
        git(root.path(), &["add", "fixture"]);
        git(root.path(), &["commit", "--no-edit"]);
        let notices = observe(path, "Linux", start).unwrap();
        assert_eq!(notices.len(), 1);
        assert_eq!(notices[0].old_head, before.head);
    }
}
