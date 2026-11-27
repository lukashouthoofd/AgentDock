use crate::host::{self, Location, Result};
use serde::Serialize;
use std::{process::Output, sync::Mutex};

static MERGE_LOCK: Mutex<()> = Mutex::new(());

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

fn checked_out(repo: &Location) -> Result<(String, String)> {
    let reference = run(repo, &["symbolic-ref", "--quiet", "HEAD"])?;
    if !reference.status.success() {
        return Err("Check out a local branch in this worktree before merging.".into());
    }
    let reference = std::str::from_utf8(&reference.stdout)
        .map_err(|_| "The checked-out branch cannot be represented in the workspace.")?;
    let branch = branch_label(reference.trim_end_matches(['\r', '\n']))
        .ok_or("Could not read the checked-out branch.")?;

    let head = run(repo, &["rev-parse", "--verify", "HEAD"])?;
    let oid = host::text(&head.stdout);
    let oid = oid.trim_end_matches(['\r', '\n']);
    if !head.status.success() || !object_id(oid) {
        return Err("The checked-out branch needs a commit before merging.".into());
    }
    Ok((branch.into(), oid.into()))
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
}
