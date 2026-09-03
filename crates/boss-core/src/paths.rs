//! Where BOSS keeps its files. Same layout as the Electron app's
//! `app.getPath('userData')` so that data can migrate.

use std::path::PathBuf;

pub const APP_DIR_NAME: &str = "BOSS-native";

/// `~/Library/Application Support/BOSS-native` on macOS, `%APPDATA%/BOSS-native` on
/// Windows, `~/.config/BOSS-native` on Linux. Separate from the Electron app until the import lands. `BOSS_USER_DATA` overrides.
pub fn user_data_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("BOSS_USER_DATA") {
        return PathBuf::from(dir);
    }
    dirs::config_dir().unwrap_or_else(|| PathBuf::from(".")).join(APP_DIR_NAME)
}

pub fn worktrees_dir() -> PathBuf {
    user_data_dir().join("worktrees")
}

pub fn logs_dir() -> PathBuf {
    user_data_dir().join("logs")
}
