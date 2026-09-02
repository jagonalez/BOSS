//! Git worktrees for threads. Port of the parts of
//! `src/main/worktree-manager.ts` the thread tools need: make a checkout of
//! its own for a thread, and take it away again when nothing would be lost.
//!
//! No state file. The TS manager keeps one so the UI can list and expire
//! worktrees; a thread's checkout is already recorded in its `cwd`, and
//! everything here is derived from git itself.

use anyhow::{Result, anyhow, bail};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use tokio::process::Command;

/// A checkout made for a thread.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WorktreeInfo {
    /// Absolute path of the new checkout.
    pub path: PathBuf,
    /// Branch created for it, `boss/<slug>-<short id>`.
    pub branch: String,
}

/// Git worktrees under one root, normally `paths::worktrees_dir()`.
#[derive(Clone, Debug)]
pub struct Worktrees {
    root: PathBuf,
}

impl Worktrees {
    /// Make checkouts under `root`. The app passes
    /// `paths::worktrees_dir()`; a test passes its own directory so nothing
    /// lands in the user's real one.
    pub fn with_root(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    /// Where checkouts are made.
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Give a thread its own checkout of `project_root` on a new branch.
    ///
    /// `name` titles the branch and the directory; the repository's current
    /// `HEAD` is the base, so a worktree starts where the thread was working.
    pub async fn create(&self, project_root: &Path, name: &str) -> Result<WorktreeInfo> {
        let repo_root = PathBuf::from(git(project_root, &["rev-parse", "--show-toplevel"]).await?);
        let base = git(&repo_root, &["rev-parse", "HEAD"]).await?;
        let slug = slug(name);

        // Retried rather than failed on a collision: two threads with the
        // same title are ordinary, and the short id is what separates them.
        let mut last = None;
        for _ in 0..5 {
            let short: String = uuid::Uuid::new_v4().simple().to_string().chars().take(8).collect();
            let branch = format!("boss/{slug}-{short}");
            let path = self.root.join(repo_key(&repo_root)).join(format!("{slug}-{short}"));
            if path.exists() || branch_exists(&repo_root, &branch).await {
                continue;
            }
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent)?;
            }
            let added = git(
                &repo_root,
                &["worktree", "add", "-b", &branch, &path.to_string_lossy(), &base],
            )
            .await;
            match added {
                Ok(_) => return Ok(WorktreeInfo { path, branch }),
                Err(e) if already_exists(&e.to_string()) => last = Some(e),
                Err(e) => return Err(e),
            }
        }
        Err(last.unwrap_or_else(|| anyhow!("Could not find a free worktree name for {slug}.")))
    }

    /// Remove a checkout, keeping its branch.
    ///
    /// Refuses while anything is uncommitted or untracked: the branch
    /// survives a removal but the working copy does not, so unsaved work
    /// would be lost with no way back.
    pub async fn remove(&self, path: &Path) -> Result<()> {
        if !is_worktree(path).await {
            bail!("{} is not a Git worktree.", path.display());
        }
        let status = git(path, &["status", "--porcelain", "--untracked-files=all"]).await?;
        if !status.trim().is_empty() {
            bail!("This worktree has uncommitted or untracked changes and was not removed.");
        }
        // From the worktree itself: git resolves the main checkout from it,
        // and the caller does not have to know where that is.
        git(path, &["worktree", "remove", &path.to_string_lossy()]).await?;
        Ok(())
    }
}

/// Is this path a linked worktree (rather than a main checkout or nothing)?
pub async fn is_worktree(path: &Path) -> bool {
    match git(path, &["rev-parse", "--path-format=absolute", "--git-common-dir", "--git-dir"]).await {
        // Two different directories means a linked worktree; the main
        // checkout reports the same one twice.
        Ok(out) => {
            let mut lines = out.lines();
            match (lines.next(), lines.next()) {
                (Some(common), Some(own)) => common.trim() != own.trim(),
                _ => false,
            }
        }
        Err(_) => false,
    }
}

/// The branch checked out at `path`, if it is on one.
pub async fn branch_of(path: &Path) -> Option<String> {
    let name = git(path, &["symbolic-ref", "--quiet", "--short", "HEAD"]).await.ok()?;
    let name = name.trim().to_owned();
    if name.is_empty() { None } else { Some(name) }
}

/// A branch or directory name from a thread title. Lowercase, ASCII, and
/// short enough to read in `git branch`.
pub fn slug(value: &str) -> String {
    let mut out = String::new();
    let mut dash = false;
    for c in value.to_lowercase().chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c);
            dash = false;
        } else if !out.is_empty() && !dash {
            out.push('-');
            dash = true;
        }
        if out.len() >= 36 {
            break;
        }
    }
    let clean = out.trim_matches('-').to_owned();
    if clean.is_empty() { "thread".to_owned() } else { clean }
}

/// One directory per repository: the folder name so a person can read it,
/// plus a hash of the path so two clones with the same name stay apart.
fn repo_key(repo_root: &Path) -> String {
    let name = repo_root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let digest = Sha256::digest(repo_root.to_string_lossy().as_bytes());
    let hex: String = digest.iter().take(4).map(|b| format!("{b:02x}")).collect();
    format!("{}-{hex}", slug(&name))
}

async fn branch_exists(repo_root: &Path, branch: &str) -> bool {
    git(repo_root, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{branch}")]).await.is_ok()
}

fn already_exists(message: &str) -> bool {
    let m = message.to_lowercase();
    m.contains("already exists") || m.contains("is already checked out") || m.contains("already used by worktree")
}

/// Run git in `cwd` and return trimmed stdout, or the error git printed.
async fn git(cwd: &Path, args: &[&str]) -> Result<String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(cwd)
        .args(args)
        .output()
        .await
        .map_err(|e| anyhow!("git could not be run: {e}"))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_owned();
        let stdout = String::from_utf8_lossy(&out.stdout).trim().to_owned();
        let detail = if stderr.is_empty() { stdout } else { stderr };
        bail!(if detail.is_empty() { format!("git {} failed.", args.join(" ")) } else { detail });
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn run(cwd: &Path, args: &[&str]) -> String {
        git(cwd, args).await.unwrap_or_else(|e| panic!("git {args:?}: {e}"))
    }

    /// A repository with one commit, plus a place to put worktrees.
    async fn repo() -> (tempfile::TempDir, PathBuf, Worktrees) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("project");
        std::fs::create_dir_all(&root).unwrap();
        run(&root, &["init", "--initial-branch=main", "."]).await;
        run(&root, &["config", "user.email", "test@example.com"]).await;
        run(&root, &["config", "user.name", "Test"]).await;
        // The user's global config may sign commits; the signing key is not
        // reachable from a test.
        run(&root, &["config", "commit.gpgsign", "false"]).await;
        std::fs::write(root.join("README.md"), "hello\n").unwrap();
        run(&root, &["add", "."]).await;
        run(&root, &["commit", "-m", "first"]).await;
        let worktrees = Worktrees::with_root(dir.path().join("worktrees"));
        (dir, root, worktrees)
    }

    #[test]
    fn slugs_are_lowercase_ascii_and_bounded() {
        assert_eq!(slug("Fix the Login Bug!"), "fix-the-login-bug");
        assert_eq!(slug("  spaced  out  "), "spaced-out");
        assert_eq!(slug("***"), "thread");
        assert_eq!(slug(""), "thread");
        assert!(slug(&"a".repeat(200)).len() <= 36);
    }

    #[tokio::test]
    async fn create_makes_a_checkout_git_knows_about() {
        let (_dir, root, worktrees) = repo().await;
        let info = worktrees.create(&root, "Fix the Login Bug").await.unwrap();

        assert!(info.path.is_dir());
        assert!(info.path.join("README.md").is_file());
        assert!(info.branch.starts_with("boss/fix-the-login-bug-"), "branch was {}", info.branch);
        assert_eq!(info.branch.rsplit('-').next().unwrap().len(), 8);
        assert!(info.path.starts_with(worktrees.root()));

        let listed = run(&root, &["worktree", "list"]).await;
        let canonical = std::fs::canonicalize(&info.path).unwrap();
        assert!(
            listed.contains(&*info.path.to_string_lossy()) || listed.contains(&*canonical.to_string_lossy()),
            "worktree list was {listed}"
        );
        assert_eq!(branch_of(&info.path).await.as_deref(), Some(info.branch.as_str()));
        assert!(is_worktree(&info.path).await);
        assert!(!is_worktree(&root).await);
    }

    #[tokio::test]
    async fn two_worktrees_for_one_title_do_not_collide() {
        let (_dir, root, worktrees) = repo().await;
        let a = worktrees.create(&root, "same title").await.unwrap();
        let b = worktrees.create(&root, "same title").await.unwrap();
        assert_ne!(a.path, b.path);
        assert_ne!(a.branch, b.branch);
        // Both under one directory for this repository.
        assert_eq!(a.path.parent(), b.path.parent());
    }

    #[tokio::test]
    async fn remove_refuses_dirty_and_keeps_the_branch_when_clean() {
        let (_dir, root, worktrees) = repo().await;
        let info = worktrees.create(&root, "cleanup").await.unwrap();

        std::fs::write(info.path.join("scratch.txt"), "work in progress\n").unwrap();
        let untracked = worktrees.remove(&info.path).await.unwrap_err().to_string();
        assert!(untracked.contains("uncommitted or untracked"), "message was {untracked}");
        assert!(info.path.is_dir());

        std::fs::remove_file(info.path.join("scratch.txt")).unwrap();
        std::fs::write(info.path.join("README.md"), "changed\n").unwrap();
        let dirty = worktrees.remove(&info.path).await.unwrap_err().to_string();
        assert!(dirty.contains("uncommitted or untracked"), "message was {dirty}");

        std::fs::write(info.path.join("README.md"), "hello\n").unwrap();
        worktrees.remove(&info.path).await.unwrap();
        assert!(!info.path.exists());
        let branches = run(&root, &["branch", "--list", &info.branch]).await;
        assert!(branches.contains(&info.branch), "branch went missing: {branches}");
    }

    #[tokio::test]
    async fn remove_refuses_a_path_that_is_not_a_worktree() {
        let (_dir, root, worktrees) = repo().await;
        let e = worktrees.remove(&root).await.unwrap_err().to_string();
        assert!(e.contains("not a Git worktree"), "message was {e}");
        assert!(root.is_dir());
    }

    #[tokio::test]
    async fn create_outside_a_repository_reports_git_s_own_error() {
        let dir = tempfile::tempdir().unwrap();
        let worktrees = Worktrees::with_root(dir.path().join("worktrees"));
        assert!(worktrees.create(dir.path(), "nope").await.is_err());
    }
}
