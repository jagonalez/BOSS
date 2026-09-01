//! User settings, one `settings.json`.
//!
//! The Electron app spread these over renderer local storage, `state.json`,
//! the MCP hub's file, and the Telegram bot's file. Here they are one
//! document. Every field has a default so an older or hand-edited file
//! still loads. Secret values (MCP tokens, the Telegram bot token) are not
//! here; they live in [`super::Secrets`] under the keys named below.

use super::json::JsonFile;
use super::Result;
use crate::engine::{EngineId, PermissionMode};
use crate::ids::ThreadId;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use time::OffsetDateTime;

/// Current on-disk version of `settings.json`.
pub const SETTINGS_VERSION: u32 = 1;

/// Window appearance.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Theme {
    /// Follow the OS.
    #[default]
    System,
    /// Always light.
    Light,
    /// Always dark.
    Dark,
}

/// Which releases the updater offers. Absent means stable: someone who
/// never chose a channel is not moved onto prereleases by an update.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UpdateChannel {
    /// Tagged releases only.
    #[default]
    Stable,
    /// Signed prereleases from main as well.
    Beta,
}

/// Bounds for a font size, in points. Half a point is a real step.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SizeRange {
    /// Smallest allowed size.
    pub min: f32,
    /// Largest allowed size.
    pub max: f32,
    /// Size used when nothing is set or the value is not finite.
    pub default: f32,
}

impl SizeRange {
    /// Round to half points and clamp into the range.
    pub fn clamp(self, value: f32) -> f32 {
        if !value.is_finite() {
            return self.default;
        }
        ((value * 2.0).round() / 2.0).clamp(self.min, self.max)
    }
}

/// The conversation: wide enough to matter, bounded so the layout works.
pub const READING_SIZE: SizeRange = SizeRange { min: 12.0, max: 22.0, default: 14.5 };
/// The terminal, read in columns and so run smaller.
pub const TERMINAL_SIZE: SizeRange = SizeRange { min: 10.0, max: 20.0, default: 13.0 };

/// The type the window draws in. Prose and terminal sizes are independent
/// because they are read differently.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "snake_case")]
pub struct Typography {
    /// Font id for chrome and prose (`"system"`, `"inter"`, ...).
    pub ui_font: String,
    /// Font id for code and the terminal.
    pub mono_font: String,
    /// Conversation size in points.
    pub reading_size: f32,
    /// Terminal size in points.
    pub terminal_size: f32,
}

impl Default for Typography {
    fn default() -> Self {
        Self {
            ui_font: "system".into(),
            mono_font: "system".into(),
            reading_size: READING_SIZE.default,
            terminal_size: TERMINAL_SIZE.default,
        }
    }
}

impl Typography {
    /// Pull both sizes back into their ranges.
    pub fn normalized(mut self) -> Self {
        self.reading_size = READING_SIZE.clamp(self.reading_size);
        self.terminal_size = TERMINAL_SIZE.clamp(self.terminal_size);
        self
    }
}

/// How an MCP server is reached.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum McpTransport {
    /// Spawn a command and speak over its stdio.
    #[default]
    Stdio,
    /// Streamable HTTP at a URL.
    Http,
}

/// One external MCP server the hub connects to. Tool names are namespaced
/// `mcp_<slug>_<tool>`. Secret values are not stored here: the HTTP auth
/// token lives in secrets under [`McpConnection::auth_token_key`].
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "snake_case")]
pub struct McpConnection {
    /// Stable id, minted by BOSS.
    pub id: String,
    /// What the user called it.
    pub name: String,
    /// Namespace in tool names; unique across connections.
    pub slug: String,
    /// Disabled connections are kept but not started.
    pub enabled: bool,
    /// stdio or http.
    pub transport: McpTransport,
    /// stdio: executable.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    /// stdio: arguments.
    pub args: Vec<String>,
    /// stdio: extra environment.
    pub env: BTreeMap<String, String>,
    /// http: server URL.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    /// http: Authorization scheme prefix ("Bearer", "Basic", "token").
    /// Empty sends the bare token.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auth_scheme: Option<String>,
    /// http: extra request headers.
    pub headers: BTreeMap<String, String>,
    /// When the user added it.
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
}

impl Default for McpConnection {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: String::new(),
            slug: String::new(),
            enabled: true,
            transport: McpTransport::Stdio,
            command: None,
            args: Vec::new(),
            env: BTreeMap::new(),
            url: None,
            auth_scheme: None,
            headers: BTreeMap::new(),
            created_at: OffsetDateTime::UNIX_EPOCH,
        }
    }
}

impl McpConnection {
    /// Secrets key for this connection's HTTP auth token.
    pub fn auth_token_key(&self) -> String {
        format!("mcp.{}.auth_token", self.id)
    }
}

/// Lowercase, `[a-z0-9]` runs kept, everything else collapsed to `_`,
/// trimmed, at most 24 chars. Same rule as the Electron hub.
pub fn slugify(name: &str) -> String {
    let mut out = String::new();
    let mut pending_sep = false;
    for ch in name.to_lowercase().chars() {
        if ch.is_ascii_alphanumeric() {
            if pending_sep && !out.is_empty() {
                out.push('_');
            }
            pending_sep = false;
            out.push(ch);
        } else {
            pending_sep = true;
        }
        if out.len() >= 24 {
            break;
        }
    }
    out.truncate(24);
    while out.ends_with('_') {
        out.pop();
    }
    out
}

/// Which events reach a channel. `Attention` is the useful default: what
/// blocks progress plus failures.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NotifyLevel {
    /// Nothing.
    Off,
    /// Decisions, reviews, failures.
    #[default]
    Attention,
    /// Everything, including routine completions.
    All,
}

/// Where the user is, which sets the bar for interrupting them.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Presence {
    /// The desktop is the front door; everything gets through.
    #[default]
    Desk,
    /// Only what needs a person.
    Away,
    /// Silence, no exceptions.
    Quiet,
}

/// Desktop and channel notification switches.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "snake_case")]
pub struct NotificationSettings {
    /// Show native desktop notifications at all.
    pub desktop: bool,
    /// Which events desktop notifications carry.
    pub level: NotifyLevel,
    /// The user's current bar for being interrupted.
    pub presence: Presence,
    /// Play a sound with attention events.
    pub sound: bool,
}

impl Default for NotificationSettings {
    fn default() -> Self {
        Self { desktop: true, level: NotifyLevel::Attention, presence: Presence::Desk, sound: false }
    }
}

/// Telegram bridge. The bot token lives in secrets under
/// [`TelegramSettings::TOKEN_KEY`].
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "snake_case")]
pub struct TelegramSettings {
    /// Poll the bot and relay messages.
    pub enabled: bool,
    /// Thread that Telegram messages land in.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    /// Chats allowed to talk to the bot.
    pub allowed_chat_ids: Vec<i64>,
    /// Chat that completed pairing, if any.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub paired_chat_id: Option<i64>,
    /// Which events are forwarded.
    pub level: NotifyLevel,
}

impl TelegramSettings {
    /// Secrets key for the bot token.
    pub const TOKEN_KEY: &'static str = "telegram.bot_token";
}

/// Everything the user can set. Serializes to `settings.json`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "snake_case")]
pub struct Settings {
    /// On-disk version, for migrations.
    pub version: u32,
    /// Light, dark, or follow the OS.
    pub theme: Theme,
    /// Fonts and sizes.
    pub typography: Typography,
    /// Engine new chats start with.
    pub default_engine: EngineId,
    /// Model each engine starts with, keyed by `EngineId::as_str()`;
    /// absent means the engine's default.
    pub default_models: BTreeMap<String, String>,
    /// Permission mode new threads start with.
    pub permission_mode: PermissionMode,
    /// Executable to run instead of the one on `PATH`, keyed by
    /// `EngineId::as_str()`.
    pub engine_executables: BTreeMap<String, PathBuf>,
    /// External MCP servers.
    pub mcp_connections: Vec<McpConnection>,
    /// Desktop notifications.
    pub notifications: NotificationSettings,
    /// Telegram bridge.
    pub telegram: TelegramSettings,
    /// Which releases the updater offers.
    pub update_channel: UpdateChannel,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            version: SETTINGS_VERSION,
            theme: Theme::System,
            typography: Typography::default(),
            default_engine: EngineId::Claude,
            default_models: BTreeMap::new(),
            permission_mode: PermissionMode::Default,
            engine_executables: BTreeMap::new(),
            mcp_connections: Vec::new(),
            notifications: NotificationSettings::default(),
            telegram: TelegramSettings::default(),
            update_channel: UpdateChannel::Stable,
        }
    }
}

impl Settings {
    /// Default model for `engine`, if the user set one.
    pub fn default_model(&self, engine: EngineId) -> Option<&str> {
        self.default_models.get(engine.as_str()).map(String::as_str)
    }

    /// Set or clear the default model for `engine`.
    pub fn set_default_model(&mut self, engine: EngineId, model: Option<String>) {
        match model {
            Some(model) => self.default_models.insert(engine.as_str().to_owned(), model),
            None => self.default_models.remove(engine.as_str()),
        };
    }

    /// Executable override for `engine`, if the user set one.
    pub fn engine_executable(&self, engine: EngineId) -> Option<&Path> {
        self.engine_executables.get(engine.as_str()).map(PathBuf::as_path)
    }

    /// Set or clear the executable override for `engine`.
    pub fn set_engine_executable(&mut self, engine: EngineId, path: Option<PathBuf>) {
        match path {
            Some(path) => self.engine_executables.insert(engine.as_str().to_owned(), path),
            None => self.engine_executables.remove(engine.as_str()),
        };
    }

    /// One MCP connection by id.
    pub fn mcp_connection(&self, id: &str) -> Option<&McpConnection> {
        self.mcp_connections.iter().find(|c| c.id == id)
    }

    /// A slug for `name` that no existing connection uses: the base slug,
    /// then `base_2`, `base_3`, ...
    pub fn unique_mcp_slug(&self, name: &str) -> String {
        let base = slugify(name);
        let base = if base.is_empty() { "mcp".to_string() } else { base };
        let taken = |slug: &str| self.mcp_connections.iter().any(|c| c.slug == slug);
        if !taken(&base) {
            return base;
        }
        let mut n = 2;
        loop {
            let candidate = format!("{base}_{n}");
            if !taken(&candidate) {
                return candidate;
            }
            n += 1;
        }
    }

    /// Add a connection, minting its id, slug, and `created_at`. Returns
    /// the stored value.
    pub fn add_mcp_connection(&mut self, mut connection: McpConnection) -> McpConnection {
        connection.id = format!("mcp_{}", uuid::Uuid::new_v4().simple());
        connection.slug = self.unique_mcp_slug(&connection.name);
        connection.created_at = OffsetDateTime::now_utc();
        self.mcp_connections.push(connection.clone());
        connection
    }

    /// Remove a connection by id. Returns whether it existed.
    pub fn remove_mcp_connection(&mut self, id: &str) -> bool {
        let before = self.mcp_connections.len();
        self.mcp_connections.retain(|c| c.id != id);
        self.mcp_connections.len() != before
    }

    /// Bring loaded values back into range.
    fn normalized(mut self) -> Self {
        self.version = SETTINGS_VERSION;
        self.typography = self.typography.normalized();
        self
    }
}

/// `settings.json` with an in-memory copy. `Send + Sync`.
#[derive(Debug)]
pub struct SettingsStore {
    file: JsonFile,
    current: Mutex<Settings>,
}

impl SettingsStore {
    /// Load `settings.json` from `base`, or from the user data dir when
    /// `base` is `None`. A missing file yields defaults; a damaged file is
    /// an error.
    pub fn open(base: Option<&Path>) -> Result<Self> {
        let file = JsonFile::in_dir(base, "settings.json");
        let current = file.load_or_default::<Settings>()?.normalized();
        Ok(Self { file, current: Mutex::new(current) })
    }

    /// Open under the user data dir.
    pub fn open_default() -> Result<Self> {
        Self::open(None)
    }

    /// A copy of the current settings.
    pub fn get(&self) -> Settings {
        self.lock().clone()
    }

    /// Edit settings in place and save. Returns the new value.
    pub fn update(&self, edit: impl FnOnce(&mut Settings)) -> Result<Settings> {
        let mut current = self.lock();
        edit(&mut current);
        let next = std::mem::take(&mut *current).normalized();
        *current = next;
        self.file.save(&*current)?;
        Ok(current.clone())
    }

    /// Replace settings wholesale and save.
    pub fn replace(&self, settings: Settings) -> Result<Settings> {
        self.update(|current| *current = settings)
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Settings> {
        self.current.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_when_missing() {
        let dir = tempfile::tempdir().unwrap();
        let store = SettingsStore::open(Some(dir.path())).unwrap();
        assert_eq!(store.get(), Settings::default());
        assert!(!dir.path().join("settings.json").exists());
    }

    #[test]
    fn round_trips_every_field() {
        let dir = tempfile::tempdir().unwrap();
        let store = SettingsStore::open(Some(dir.path())).unwrap();
        let saved = store
            .update(|s| {
                s.theme = Theme::Dark;
                s.typography.reading_size = 16.0;
                s.default_engine = EngineId::Codex;
                s.set_default_model(EngineId::Claude, Some("claude-opus".into()));
                s.set_default_model(EngineId::Pi, Some("gpt-5".into()));
                s.set_default_model(EngineId::Pi, None);
                s.permission_mode = PermissionMode::AcceptEdits;
                s.set_engine_executable(EngineId::Pi, Some(PathBuf::from("/opt/pi/bin/pi")));
                s.add_mcp_connection(McpConnection {
                    name: "GitHub".into(),
                    transport: McpTransport::Http,
                    url: Some("https://mcp.example/".into()),
                    auth_scheme: Some("Bearer".into()),
                    ..Default::default()
                });
                s.notifications.level = NotifyLevel::All;
                s.notifications.presence = Presence::Away;
                s.telegram.enabled = true;
                s.telegram.allowed_chat_ids = vec![42];
                s.update_channel = UpdateChannel::Beta;
            })
            .unwrap();
        let reopened = SettingsStore::open(Some(dir.path())).unwrap().get();
        assert_eq!(reopened, saved);
        assert_eq!(reopened.default_model(EngineId::Claude), Some("claude-opus"));
        assert_eq!(reopened.default_model(EngineId::Pi), None);
        assert_eq!(reopened.default_models.keys().collect::<Vec<_>>(), vec!["claude"], "keys are engine ids");
        assert_eq!(reopened.engine_executable(EngineId::Pi), Some(Path::new("/opt/pi/bin/pi")));
        assert_eq!(reopened.mcp_connections[0].slug, "github");
        assert!(reopened.mcp_connections[0].id.starts_with("mcp_"));
        assert_eq!(reopened.mcp_connections[0].auth_token_key(), format!("mcp.{}.auth_token", reopened.mcp_connections[0].id));
    }

    #[test]
    fn old_and_partial_files_load() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("settings.json"),
            r#"{ "theme": "light", "lab": { "enabled": true }, "cloudflare": {}, "typography": { "reading_size": 99 }, "default_models": { "codex": "o3" } }"#,
        )
        .unwrap();
        let s = SettingsStore::open(Some(dir.path())).unwrap().get();
        assert_eq!(s.theme, Theme::Light);
        assert_eq!(s.typography.reading_size, READING_SIZE.max, "out-of-range sizes are clamped");
        assert_eq!(s.typography.ui_font, "system");
        assert_eq!(s.default_model(EngineId::Codex), Some("o3"));
        assert_eq!(s.version, SETTINGS_VERSION);
        assert_eq!(s.default_engine, EngineId::Claude);
    }

    #[test]
    fn damaged_file_is_an_error() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("settings.json"), b"nope").unwrap();
        assert!(SettingsStore::open(Some(dir.path())).is_err());
    }

    #[test]
    fn slugs_follow_hub_rules_and_stay_unique() {
        assert_eq!(slugify("GitHub"), "github");
        assert_eq!(slugify("  My--Cool Server!! "), "my_cool_server");
        assert_eq!(slugify("a_very_long_name_that_goes_past_twenty_four"), "a_very_long_name_that_go");
        assert_eq!(slugify("!!!"), "");
        let mut s = Settings::default();
        let a = s.add_mcp_connection(McpConnection { name: "Repo".into(), ..Default::default() });
        let b = s.add_mcp_connection(McpConnection { name: "repo".into(), ..Default::default() });
        let c = s.add_mcp_connection(McpConnection { name: "###".into(), ..Default::default() });
        assert_eq!(a.slug, "repo");
        assert_eq!(b.slug, "repo_2");
        assert_eq!(c.slug, "mcp");
        assert!(s.remove_mcp_connection(&b.id));
        assert!(!s.remove_mcp_connection(&b.id));
        assert_eq!(s.mcp_connection(&a.id).unwrap().name, "Repo");
    }

    #[test]
    fn size_clamp_rounds_to_half_points() {
        assert_eq!(READING_SIZE.clamp(14.3), 14.5);
        assert_eq!(READING_SIZE.clamp(14.2), 14.0);
        assert_eq!(READING_SIZE.clamp(1.0), 12.0);
        assert_eq!(READING_SIZE.clamp(f32::NAN), 14.5);
        assert_eq!(TERMINAL_SIZE.clamp(100.0), 20.0);
    }
}
