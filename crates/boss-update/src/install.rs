//! Applying a downloaded update.
//!
//! macOS replaces the bundle in place and relaunches. Windows and Linux
//! reveal the download instead: an app cannot overwrite its own running
//! executable on Windows, and on Linux the install could be an AppImage, a
//! package, or a tarball, each wanting a different move. Telling someone
//! plainly where the file is beats a half-working installer.

use std::path::{Path, PathBuf};

use crate::UpdateError;

/// What `install` did, so the caller knows whether to quit.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Installed {
    /// The bundle was replaced and a relaunch is staged. Quit now.
    Replaced {
        /// Where the running app now lives.
        app: PathBuf,
    },
    /// Nothing was applied; the download is waiting for the user.
    OpenManually {
        /// File to hand to the user.
        path: PathBuf,
        /// One line explaining what to do with it.
        message: String,
    },
}

/// The `.app` the running binary belongs to, if it is inside one.
///
/// `target/release/boss` during development is not, and an updater that tried
/// to replace a bundle it is not in would overwrite something else.
pub fn current_app_bundle() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    // .../BOSS.app/Contents/MacOS/boss → .../BOSS.app
    let app = exe.parent()?.parent()?.parent()?;
    (app.extension().is_some_and(|e| e == "app") && app.join("Contents/Info.plist").exists())
        .then(|| app.to_path_buf())
}

/// Apply `archive` to the app at `target`, then relaunch.
///
/// Only `.zip` is handled: that is what `bundle-macos.sh` writes and what the
/// manifest points at. A dmg would need mounting and is for people, not the
/// updater.
#[cfg(target_os = "macos")]
pub fn install_macos(archive: &Path, target: &Path) -> Result<Installed, UpdateError> {
    use std::process::Command;

    let staging = archive
        .parent()
        .ok_or_else(|| UpdateError::Io("download has no parent directory".into()))?
        .join("staged");
    let _ = std::fs::remove_dir_all(&staging);
    std::fs::create_dir_all(&staging).map_err(|e| UpdateError::Io(e.to_string()))?;

    // ditto, not a zip crate: it restores the symlinks, extended attributes,
    // and the notarization ticket a signed bundle carries. Unpacking with a
    // general-purpose unzip drops those and Gatekeeper refuses the result.
    let status = Command::new("/usr/bin/ditto")
        .args(["-x", "-k"])
        .arg(archive)
        .arg(&staging)
        .status()
        .map_err(|e| UpdateError::Io(e.to_string()))?;
    if !status.success() {
        return Err(UpdateError::Install(format!("ditto failed: {status}")));
    }

    let new_app = std::fs::read_dir(&staging)
        .map_err(|e| UpdateError::Io(e.to_string()))?
        .filter_map(Result::ok)
        .map(|e| e.path())
        .find(|p| p.extension().is_some_and(|e| e == "app"))
        .ok_or_else(|| UpdateError::Install("no .app inside the download".into()))?;

    // A download carries com.apple.quarantine, and a quarantined bundle
    // launched by another process gets a Gatekeeper prompt every time. The
    // archive was already verified against the manifest hash and its own
    // signature, so the flag has served its purpose.
    let _ = Command::new("/usr/bin/xattr")
        .args(["-d", "-r", "com.apple.quarantine"])
        .arg(&new_app)
        .status();

    // Move the old bundle aside rather than deleting it: if the rename of the
    // new one fails, there is still an app to put back.
    let backup = staging.join("previous.app");
    let _ = std::fs::remove_dir_all(&backup);
    std::fs::rename(target, &backup)
        .map_err(|e| UpdateError::Install(format!("cannot move the running app aside: {e}")))?;
    if let Err(e) = std::fs::rename(&new_app, target) {
        let _ = std::fs::rename(&backup, target);
        return Err(UpdateError::Install(format!(
            "cannot put the new app in place ({e}); the old one was restored"
        )));
    }
    let _ = std::fs::remove_dir_all(&backup);

    relaunch(target)?;
    Ok(Installed::Replaced {
        app: target.to_path_buf(),
    })
}

/// Start the updated app and leave. `open -n` detaches it from this process,
/// so it survives the quit that has to follow.
#[cfg(target_os = "macos")]
fn relaunch(app: &Path) -> Result<(), UpdateError> {
    std::process::Command::new("/usr/bin/open")
        .arg("-n")
        .arg(app)
        .spawn()
        .map(|_| ())
        .map_err(|e| UpdateError::Install(format!("cannot relaunch: {e}")))
}

/// Reveal `archive` and tell the caller what to say about it.
pub fn open_manually(archive: &Path) -> Installed {
    let message = if cfg!(target_os = "windows") {
        "The update was downloaded. Quit BOSS and run the installer to apply it."
    } else {
        "The update was downloaded. Replace your current install with it to apply it."
    };
    reveal(archive);
    Installed::OpenManually {
        path: archive.to_path_buf(),
        message: message.to_string(),
    }
}

/// Show the file in the platform's file manager. Best effort: failing to open
/// a window is not a reason to fail the update, since the path is reported too.
fn reveal(path: &Path) {
    let dir = path.parent().unwrap_or(path);
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut c = std::process::Command::new("/usr/bin/open");
        c.arg("-R").arg(path);
        c
    };
    #[cfg(target_os = "windows")]
    let mut command = {
        let mut c = std::process::Command::new("explorer.exe");
        c.arg(format!("/select,{}", path.display()));
        c
    };
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut command = {
        let mut c = std::process::Command::new("xdg-open");
        c.arg(dir);
        c
    };
    let _ = dir;
    let _ = command.spawn();
}

/// Apply a downloaded update, or explain how to.
///
/// On macOS this replaces the running bundle and relaunches — the caller must
/// quit as soon as it returns `Replaced`. Everywhere else, and in a
/// development build that is not inside an `.app`, the download is revealed
/// and left to the user.
pub fn install(archive: &Path) -> Result<Installed, UpdateError> {
    #[cfg(target_os = "macos")]
    {
        if let Some(app) = current_app_bundle() {
            return install_macos(archive, &app);
        }
    }
    Ok(open_manually(archive))
}
