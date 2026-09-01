//! The pseudo-terminal: spawn a shell, pump its output, resize, write, kill.
//!
//! Mirrors `src/main/pty-manager.ts`: the shell comes from `$SHELL` (or
//! PowerShell on Windows) with `TERM=xterm-256color`, a working directory,
//! and the parent environment, or an explicit command such as an engine's
//! login CLI.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use anyhow::{Context as _, Result};
use parking_lot::Mutex;
use portable_pty::{ChildKiller, CommandBuilder, MasterPty, PtySize, native_pty_system};

use crate::throttle::FlowControl;

/// Smallest size a shell is ever told about; the same floor as the TS app.
pub const MIN_COLS: u16 = 20;
/// Smallest row count a shell is ever told about.
pub const MIN_ROWS: u16 = 5;

/// What to run and where.
#[derive(Debug, Clone, Default)]
pub struct PtySpec {
    /// Working directory. Falls back to `$HOME` when missing.
    pub cwd: Option<PathBuf>,
    /// `argv` for the child. `None` means the user's login shell.
    pub command: Option<Vec<String>>,
    /// Initial grid size.
    pub cols: u16,
    /// Initial grid size.
    pub rows: u16,
}

/// Events the reader and waiter threads send to the owner.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PtyEvent {
    /// Output was parsed into the terminal; repaint when convenient. Sent at
    /// most once per outstanding repaint.
    Wakeup,
    /// The child exited with this code.
    Exit(u32),
}

/// Handle to a live shell.
pub struct Pty {
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    alive: Arc<AtomicBool>,
    dirty: Arc<AtomicBool>,
    flow: Arc<FlowControl>,
    program: String,
}

impl std::fmt::Debug for Pty {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Pty")
            .field("program", &self.program)
            .field("alive", &self.is_alive())
            .finish()
    }
}

impl Pty {
    /// Spawn the shell and start the reader thread. Every chunk the shell
    /// writes is handed to `sink` on the reader thread; after that a single
    /// coalesced [`PtyEvent::Wakeup`] is queued on `events` until the owner
    /// calls [`Pty::clear_dirty`].
    pub fn spawn(
        spec: PtySpec,
        events: async_channel::Sender<PtyEvent>,
        flow: Arc<FlowControl>,
        sink: impl FnMut(&[u8]) + Send + 'static,
    ) -> Result<Self> {
        let size = PtySize {
            rows: spec.rows.max(MIN_ROWS),
            cols: spec.cols.max(MIN_COLS),
            pixel_width: 0,
            pixel_height: 0,
        };
        let pair = native_pty_system().openpty(size).context("open pty")?;

        let (program, args) = resolve_command(spec.command.as_deref());
        let mut cmd = CommandBuilder::new(&program);
        cmd.args(&args);
        cmd.cwd(resolve_cwd(spec.cwd.as_deref()));
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        cmd.env("TERM_PROGRAM", "BOSS");

        let mut child = pair.slave.spawn_command(cmd).context("spawn shell")?;
        // The slave end must be dropped so the reader sees EOF when the
        // child exits.
        drop(pair.slave);

        let reader = pair.master.try_clone_reader().context("pty reader")?;
        let writer = pair.master.take_writer().context("pty writer")?;
        let killer = child.clone_killer();

        let alive = Arc::new(AtomicBool::new(true));
        let dirty = Arc::new(AtomicBool::new(false));

        spawn_reader(reader, events.clone(), flow.clone(), dirty.clone(), alive.clone(), sink);

        {
            let alive = alive.clone();
            let flow = flow.clone();
            std::thread::Builder::new()
                .name("boss-pty-wait".into())
                .spawn(move || {
                    let code = match child.wait() {
                        Ok(status) => status.exit_code(),
                        Err(_) => 1,
                    };
                    alive.store(false, Ordering::SeqCst);
                    // A paused reader must be able to unwind.
                    flow.release();
                    let _ = events.try_send(PtyEvent::Exit(code));
                })
                .context("spawn waiter thread")?;
        }

        Ok(Self {
            master: Mutex::new(pair.master),
            writer: Mutex::new(writer),
            killer: Mutex::new(killer),
            alive,
            dirty,
            flow,
            program,
        })
    }

    /// The program that was launched (full path or name as given).
    pub fn program(&self) -> &str {
        &self.program
    }

    /// Whether the child is still running.
    pub fn is_alive(&self) -> bool {
        self.alive.load(Ordering::SeqCst)
    }

    /// Send input to the shell.
    pub fn write(&self, bytes: &[u8]) -> Result<()> {
        if bytes.is_empty() {
            return Ok(());
        }
        let mut writer = self.writer.lock();
        writer.write_all(bytes)?;
        writer.flush()?;
        Ok(())
    }

    /// Tell the shell its window changed. Values below the floor are clamped.
    pub fn resize(&self, cols: u16, rows: u16) -> Result<()> {
        self.master
            .lock()
            .resize(PtySize {
                rows: rows.max(MIN_ROWS),
                cols: cols.max(MIN_COLS),
                pixel_width: 0,
                pixel_height: 0,
            })
            .context("resize pty")
    }

    /// Terminate the child. Idempotent.
    pub fn kill(&self) {
        if self.is_alive() {
            let _ = self.killer.lock().kill();
        }
        self.flow.release();
    }

    /// The owner has painted; allow the next `Wakeup` to be queued.
    pub fn clear_dirty(&self) {
        self.dirty.store(false, Ordering::SeqCst);
    }

    /// Flow control shared with the reader thread.
    pub fn flow(&self) -> &Arc<FlowControl> {
        &self.flow
    }
}

impl Drop for Pty {
    fn drop(&mut self) {
        self.kill();
    }
}

fn spawn_reader(
    mut reader: Box<dyn Read + Send>,
    events: async_channel::Sender<PtyEvent>,
    flow: Arc<FlowControl>,
    dirty: Arc<AtomicBool>,
    alive: Arc<AtomicBool>,
    mut sink: impl FnMut(&[u8]) + Send + 'static,
) {
    let _ = std::thread::Builder::new()
        .name("boss-pty-read".into())
        .spawn(move || {
            let mut buf = vec![0u8; 64 * 1024];
            loop {
                let n = match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => n,
                };
                sink(&buf[..n]);
                if !dirty.swap(true, Ordering::SeqCst) && events.try_send(PtyEvent::Wakeup).is_err()
                {
                    break;
                }
                if flow.record(n) {
                    tracing::debug!(bytes = n, "terminal output paused: backlog above high watermark");
                }
                while flow.is_paused() && alive.load(Ordering::SeqCst) {
                    flow.wait_while_paused(Duration::from_millis(50));
                }
            }
        });
}

/// Pick the program and arguments to run. Explicit commands win; otherwise
/// the user's shell, as a login shell so a Finder-launched app still gets
/// the user's PATH.
pub fn resolve_command(command: Option<&[String]>) -> (String, Vec<String>) {
    if let Some([program, args @ ..]) = command
        && !program.is_empty()
    {
        return (program.clone(), args.to_vec());
    }
    if cfg!(windows) {
        return ("powershell.exe".to_string(), Vec::new());
    }
    let shell = std::env::var("SHELL")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "/bin/zsh".to_string());
    (shell, vec!["-l".to_string()])
}

/// Use `cwd` when it exists, else the home directory, else `/`.
pub fn resolve_cwd(cwd: Option<&Path>) -> PathBuf {
    if let Some(dir) = cwd
        && dir.is_dir()
    {
        return dir.to_path_buf();
    }
    dirs_home().unwrap_or_else(|| PathBuf::from("/"))
}

fn dirs_home() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .filter(|p| p.is_dir())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explicit_command_splits_program_and_args() {
        let cmd = vec!["claude".to_string(), "login".to_string(), "--x".to_string()];
        let (program, args) = resolve_command(Some(&cmd));
        assert_eq!(program, "claude");
        assert_eq!(args, vec!["login", "--x"]);
    }

    #[test]
    fn empty_command_falls_back_to_shell() {
        let (program, _) = resolve_command(Some(&[]));
        assert!(!program.is_empty());
        let (program2, _) = resolve_command(None);
        assert_eq!(program, program2);
    }

    #[test]
    fn missing_cwd_falls_back() {
        let dir = resolve_cwd(Some(Path::new("/definitely/not/here")));
        assert!(dir.is_dir());
        let tmp = std::env::temp_dir();
        assert_eq!(resolve_cwd(Some(&tmp)), tmp);
    }
}
