//! Drives native applications through the embedded `cua-driver` helper.
//!
//! Port of `src/main/computer-use.ts`, `src/main/computer-use-state.ts` and
//! the `boss_computer` half of `src/main/qa-tools.ts`.
//!
//! Shape of the thing: a long-lived `serve --embedded` daemon owns the
//! accessibility session, and every tool call is a short-lived
//! `call <tool> <json>` process that talks to it over a unix socket. The
//! daemon runs as BOSS's own child so macOS attributes its TCC prompts — and
//! therefore its Accessibility and Screen Recording grants — to BOSS rather
//! than to a separate app the user would have to trust twice.
//!
//! Two gates stand in front of it, and they are different gates:
//!   - the *enabled* flag (`computer-use.json`), which is the user's standing
//!     choice about whether the daemon may run at all, and
//!   - the QA policy, which decides per call whether an acting operation may
//!     go through. Looking needs only that QA is not switched off.

use anyhow::{Result, anyhow, bail};
use boss_core::{BusContent, BusToolResult};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

/// The bundle id the driver is told to attribute its embedded session to.
const HOST_BUNDLE_ID: &str = "dev.boss.app";

/// A single tool call may not run forever; the TS used the same minute.
const CALL_TIMEOUT: Duration = Duration::from_secs(60);

/// How long the daemon gets to open its socket before the start is a failure.
const START_TIMEOUT: Duration = Duration::from_secs(15);

/// Text handed back to the agent is capped, as in the TS, so a driver that
/// dumps a whole accessibility tree cannot blow out a context window.
const MAX_TEXT: usize = 80_000;

/// Read-only operations of the driver that BOSS exposes.
///
/// Browser, clipboard, recording, configuration, maintenance and session
/// tools stay outside this scoped surface: BOSS already owns those
/// capabilities, or they carry authority beyond inspecting one desktop.
pub const COMPUTER_USE_INSPECTION_OPERATIONS: [&str; 9] = [
    "list_apps",
    "list_windows",
    "get_window_state",
    "get_accessibility_tree",
    "get_desktop_state",
    "get_screen_size",
    "get_cursor_position",
    "zoom",
    "verify_state",
];

/// Reversible native-app actions. Every one is gated by Automatic QA.
pub const COMPUTER_USE_ACTION_OPERATIONS: [&str; 14] = [
    "launch_app",
    "bring_to_front",
    "set_window_frame",
    "click",
    "double_click",
    "right_click",
    "drag",
    "type_text",
    "press_key",
    "hotkey",
    "set_value",
    "scroll",
    "move_cursor",
    "invoke_menu",
];

/// Every operation BOSS will pass to the driver, inspection first.
pub fn computer_use_operations() -> Vec<&'static str> {
    COMPUTER_USE_INSPECTION_OPERATIONS
        .iter()
        .chain(COMPUTER_USE_ACTION_OPERATIONS.iter())
        .copied()
        .collect()
}

/// Whether an operation changes the machine, and so needs Automatic QA.
pub fn is_action_operation(operation: &str) -> bool {
    COMPUTER_USE_ACTION_OPERATIONS.contains(&operation)
}

fn is_known_operation(operation: &str) -> bool {
    is_action_operation(operation) || COMPUTER_USE_INSPECTION_OPERATIONS.contains(&operation)
}

/// What the app shows in settings: whether the platform can do this at all,
/// whether the user turned it on, and whether the daemon is actually up.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct ComputerUseStatus {
    pub supported: bool,
    pub enabled: bool,
    pub running: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// macOS privacy grants the driver needs. `available` is false off macOS,
/// where there is nothing to check and nothing to ask for.
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct ComputerUsePermissions {
    pub available: bool,
    pub accessibility: bool,
    #[serde(rename = "screenRecording")]
    pub screen_recording: bool,
}

/// Which System Settings privacy pane a request is about.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PrivacyPane {
    Accessibility,
    ScreenRecording,
}

/// The persisted enable choice. Byte-compatible with the Electron
/// `computer-use.json`: `{ "version": 1, "enabled": bool }`, two-space
/// indented, so a user who switches between the two apps keeps their setting.
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
struct StoredComputerUseState {
    version: u32,
    enabled: bool,
}

/// Read the remembered enable choice. Anything unreadable, malformed, or
/// from a version this build does not know reads as off — a preference that
/// cannot be understood must not silently enable desktop control.
pub fn load_computer_use_enabled(file: &Path) -> bool {
    let Ok(text) = std::fs::read_to_string(file) else {
        return false;
    };
    let Ok(stored) = serde_json::from_str::<Value>(&text) else {
        return false;
    };
    stored.get("version").and_then(Value::as_u64) == Some(1)
        && stored.get("enabled") == Some(&Value::Bool(true))
}

/// Remember the enable choice. A write failure is not fatal: the live
/// setting still applies for this run.
pub fn save_computer_use_enabled(file: &Path, enabled: bool) {
    let state = StoredComputerUseState {
        version: 1,
        enabled,
    };
    let Ok(json) = serde_json::to_string_pretty(&state) else {
        return;
    };
    if let Some(parent) = file.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(file, json);
}

/// How much an agent may do without asking. Ported from `QaPolicy` in
/// `src/shared/qa.ts`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum QaPolicy {
    /// No QA tools at all, not even looking.
    Off,
    /// Looking is allowed; acting is refused and the agent is told to ask.
    Suggest,
    /// Looking and acting are both allowed.
    #[default]
    Automatic,
}

impl QaPolicy {
    pub fn is_automatic(self) -> bool {
        self == Self::Automatic
    }
}

/// The per-thread QA policy, with a global default.
///
/// Automatic by default, as the TS settled on: an agent that can look at what
/// it built catches its own mistakes, and every one it does not catch reaches
/// the user instead. Persisted to `qa-policies.json` in the same `version: 2`
/// shape the Electron app wrote, so the setting survives the port.
#[derive(Debug, Serialize, Deserialize)]
pub struct QaPolicies {
    version: u32,
    #[serde(rename = "defaultPolicy")]
    default_policy: QaPolicy,
    policies: std::collections::HashMap<String, QaPolicy>,
    #[serde(skip)]
    file: PathBuf,
}

impl QaPolicies {
    /// Read the stored policies, falling back to the automatic default. A
    /// version this build does not know is ignored rather than guessed at,
    /// which leaves the default in place instead of inventing a policy.
    pub fn open(data_dir: &Path) -> Self {
        let file = data_dir.join("qa-policies.json");
        let mut this = Self {
            version: 2,
            default_policy: QaPolicy::Automatic,
            policies: std::collections::HashMap::new(),
            file,
        };
        let Ok(text) = std::fs::read_to_string(&this.file) else {
            return this;
        };
        let Ok(stored) = serde_json::from_str::<Value>(&text) else {
            return this;
        };
        if let Some(map) = stored.get("policies").and_then(Value::as_object) {
            for (k, v) in map {
                if let Ok(p) = serde_json::from_value::<QaPolicy>(v.clone()) {
                    this.policies.insert(k.clone(), p);
                }
            }
        }
        // v1 had no default; only v2 carries one worth reading.
        if stored.get("version").and_then(Value::as_u64) == Some(2) {
            if let Some(p) = stored
                .get("defaultPolicy")
                .cloned()
                .and_then(|v| serde_json::from_value(v).ok())
            {
                this.default_policy = p;
            }
        }
        this
    }

    pub fn policy(&self, key: &str) -> QaPolicy {
        self.policies
            .get(key)
            .copied()
            .unwrap_or(self.default_policy)
    }

    pub fn default_policy(&self) -> QaPolicy {
        self.default_policy
    }

    pub fn set_default(&mut self, policy: QaPolicy) {
        self.default_policy = policy;
        self.save();
    }

    /// Set one key's policy, or `None` to fall back to the default.
    pub fn set_policy(&mut self, key: &str, policy: Option<QaPolicy>) {
        match policy {
            Some(p) => {
                self.policies.insert(key.to_owned(), p);
            }
            None => {
                self.policies.remove(key);
            }
        }
        self.save();
    }

    fn save(&self) {
        if let Some(parent) = self.file.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Ok(json) = serde_json::to_string_pretty(self) {
            let _ = std::fs::write(&self.file, json);
        }
    }
}

/// Click actions the driver accepts, keyed by the squashed spelling the
/// accessibility tree prints.
const CLICK_ACTIONS: [(&str, &str); 8] = [
    ("press", "press"),
    ("click", "press"),
    ("showmenu", "show_menu"),
    ("rightclick", "show_menu"),
    ("pick", "pick"),
    ("confirm", "confirm"),
    ("cancel", "cancel"),
    ("open", "open"),
];

/// Convert compact action names printed by the driver's accessibility tree
/// back to the canonical names `click` accepts.
///
/// The tree renders `AXShowMenu` as `showmenu`, while click expects
/// `show_menu`. Passing the rendered spelling through unchanged is unsafe:
/// the macOS driver treats an unknown action as `AXPress`, so a typo would
/// press a control instead of opening its menu. Normalize every documented
/// spelling and fail closed on anything else. Coordinates and every
/// non-action argument are left exactly as they arrived — pixel-to-point and
/// Retina conversion belong to the driver, not here.
pub fn normalize_arguments(
    operation: &str,
    args: Map<String, Value>,
) -> Result<Map<String, Value>> {
    if operation != "click" {
        return Ok(args);
    }
    let Some(Value::String(raw)) = args.get("action") else {
        return Ok(args);
    };
    let raw = raw.clone();
    // Strip one leading "AX" (the tree's own prefix), not every leading `a`.
    let trimmed = raw.trim();
    let stripped = match trimmed.get(..2) {
        Some(prefix) if prefix.eq_ignore_ascii_case("ax") => &trimmed[2..],
        _ => trimmed,
    };
    let squashed: String = stripped
        .chars()
        .filter(|c| !matches!(c, ' ' | '\t' | '_' | '-'))
        .flat_map(char::to_lowercase)
        .collect();
    let Some((_, action)) = CLICK_ACTIONS.iter().find(|(k, _)| *k == squashed) else {
        bail!(
            "Computer click action \u{201c}{raw}\u{201d} is not supported. \
             Use press, show_menu, pick, confirm, cancel, or open."
        );
    };
    if raw == *action {
        return Ok(args);
    }
    let mut out = args;
    out.insert("action".into(), Value::String((*action).to_owned()));
    Ok(out)
}

/// Where the driver binary lives.
///
/// In a bundle it sits flat in the resources directory. Flat, not as a nested
/// `CuaDriver.app`: a nested app signed by another team sent notarization into
/// manual review, and its signature covers an `Info.plist` that a stray
/// recursive copy could drop. The bare binary carries its own signature, which
/// a flat copy preserves. Older layouts and a locally installed driver are
/// still tried, so a machine mid-upgrade keeps working.
pub fn resolve_driver_binary() -> PathBuf {
    let exe = if cfg!(target_os = "windows") {
        "cua-driver.exe"
    } else {
        "cua-driver"
    };
    if let Ok(explicit) = std::env::var("CUA_DRIVER_BIN") {
        if !explicit.is_empty() {
            return PathBuf::from(explicit);
        }
    }
    for dir in resource_dirs() {
        let flat = dir.join("cua-driver").join(exe);
        if flat.is_file() {
            return flat;
        }
        let nested = dir
            .join("cua-driver")
            .join("CuaDriver.app")
            .join("Contents")
            .join("MacOS")
            .join(exe);
        if nested.is_file() {
            return nested;
        }
    }
    let installed = PathBuf::from("/Applications/CuaDriver.app/Contents/MacOS/cua-driver");
    if installed.is_file() {
        return installed;
    }
    // Nothing bundled: fall back to whatever the PATH resolves, which is what
    // a development checkout with an installed driver wants.
    PathBuf::from(exe)
}

/// Directories that may hold bundled helper binaries, nearest first.
///
/// Bundled: `BOSS.app/Contents/Resources` on macOS, `usr/share/boss` beside
/// the binary on Linux, `resources` beside the exe on Windows. Development:
/// the repo's `resources/`, found by walking up from the binary. `dev` and
/// `bundled` are both tried rather than branched on an `is_packaged` flag,
/// because there is no such flag here and a wrong guess would be silent.
fn resource_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(bin_dir) = exe.parent() {
            // macOS bundle: Contents/MacOS/boss -> Contents/Resources
            if let Some(contents) = bin_dir.parent() {
                dirs.push(contents.join("Resources"));
            }
            dirs.push(bin_dir.join("resources"));
            dirs.push(bin_dir.join("../share/boss"));
            // Development: target/debug/boss or target/release/boss, plus the
            // deps/ and examples/ layers cargo uses for test binaries.
            for up in 1..=5 {
                let mut root = bin_dir.to_path_buf();
                for _ in 0..up {
                    root = root.join("..");
                }
                dirs.push(root.join("resources"));
            }
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        dirs.push(cwd.join("resources"));
    }
    dirs
}

/// The unix socket the daemon and its call processes meet on. Per-process, so
/// two copies of BOSS do not fight over one driver session.
fn socket_path() -> PathBuf {
    std::env::temp_dir().join(format!("boss-cua-{}.sock", std::process::id()))
}

/// A socket the daemon has opened. `is_file` is accepted as well because the
/// test fixture (and some driver builds) touch a plain file to signal ready.
fn socket_ready(path: &Path) -> bool {
    std::fs::metadata(path).is_ok()
}

/// The embedded CUA driver: its enable flag, its daemon, and its tool calls.
pub struct ComputerUse {
    state_file: PathBuf,
    inner: Mutex<Inner>,
}

struct Inner {
    enabled: bool,
    error: Option<String>,
    /// The `serve --embedded` child. Killed on disable, on emergency stop and
    /// on drop, so quitting BOSS never leaves a driver holding the desktop.
    daemon: Option<std::process::Child>,
    socket: PathBuf,
}

impl ComputerUse {
    /// Open the driver against `state_file` (`computer-use.json`), reading the
    /// user's remembered enable choice but not yet starting anything.
    pub fn new(state_file: PathBuf) -> Self {
        let enabled = load_computer_use_enabled(&state_file);
        Self {
            state_file,
            inner: Mutex::new(Inner {
                enabled,
                error: None,
                daemon: None,
                socket: PathBuf::new(),
            }),
        }
    }

    /// Open the driver with its state file in BOSS's data directory.
    pub fn in_data_dir(data_dir: &Path) -> Self {
        Self::new(data_dir.join("computer-use.json"))
    }

    pub fn status(&self) -> ComputerUseStatus {
        let mut inner = self.inner.lock().unwrap();
        let running = Self::running(&mut inner);
        ComputerUseStatus {
            supported: true,
            enabled: inner.enabled,
            running,
            error: inner.error.clone(),
        }
    }

    /// Whether the daemon is alive *and* its socket is up. Reaping here rather
    /// than in a watcher thread keeps a driver that died on its own from being
    /// reported as ready until something else notices.
    fn running(inner: &mut Inner) -> bool {
        let Some(child) = inner.daemon.as_mut() else {
            return false;
        };
        match child.try_wait() {
            Ok(Some(_)) => {
                inner.daemon = None;
                false
            }
            Ok(None) => !inner.socket.as_os_str().is_empty() && socket_ready(&inner.socket),
            Err(_) => false,
        }
    }

    pub fn enabled(&self) -> bool {
        self.inner.lock().unwrap().enabled
    }

    /// Turn desktop control on or off and remember the choice.
    pub async fn set_enabled(&self, on: bool) -> ComputerUseStatus {
        {
            let mut inner = self.inner.lock().unwrap();
            inner.enabled = on;
        }
        save_computer_use_enabled(&self.state_file, on);
        if on {
            self.start().await;
        } else {
            self.stop_daemon();
        }
        self.status()
    }

    /// Start a fresh daemon for an enable choice remembered from a prior run.
    pub async fn restore(&self) -> ComputerUseStatus {
        if self.enabled() {
            self.start().await;
        }
        self.status()
    }

    /// Kill the daemon and forget the enable flag. The "stop now" the user
    /// reaches for when an agent is doing something they did not expect: it
    /// takes effect without waiting for a call in flight to return.
    pub fn emergency_stop(&self) {
        self.inner.lock().unwrap().enabled = false;
        save_computer_use_enabled(&self.state_file, false);
        self.stop_daemon();
    }

    async fn start(&self) {
        self.stop_daemon();
        let socket = socket_path();
        // A socket left by a previous run would look ready before this
        // daemon has bound it, so a call could race off to nothing.
        let _ = std::fs::remove_file(&socket);
        {
            let mut inner = self.inner.lock().unwrap();
            inner.error = None;
            inner.socket = socket.clone();
        }
        let bin = resolve_driver_binary();
        if let Err(e) = self.start_daemon(&bin, &socket).await {
            let message = if e.downcast_ref::<std::io::Error>().map(std::io::Error::kind)
                == Some(std::io::ErrorKind::NotFound)
            {
                "cua-driver is not installed (see cua.ai/docs/how-to-guides/driver/install)"
                    .to_owned()
            } else {
                e.to_string()
            };
            self.inner.lock().unwrap().error = Some(message);
            self.stop_daemon();
        }
    }

    /// Spawn the daemon as BOSS's own child so TCC attributes to BOSS, then
    /// wait for its socket.
    async fn start_daemon(&self, bin: &Path, socket: &Path) -> Result<()> {
        let child = std::process::Command::new(bin)
            .args(["serve", "--embedded", "--socket"])
            .arg(socket)
            .env("CUA_DRIVER_EMBEDDED", "1")
            .env("CUA_DRIVER_HOST_BUNDLE_ID", HOST_BUNDLE_ID)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()?;
        self.inner.lock().unwrap().daemon = Some(child);

        let deadline = std::time::Instant::now() + START_TIMEOUT;
        loop {
            {
                let mut inner = self.inner.lock().unwrap();
                if Self::running(&mut inner) {
                    return Ok(());
                }
                if inner.daemon.is_none() {
                    bail!("cua-driver daemon did not start");
                }
            }
            if std::time::Instant::now() >= deadline {
                bail!("cua-driver daemon did not start");
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }

    fn stop_daemon(&self) {
        let (daemon, socket) = {
            let mut inner = self.inner.lock().unwrap();
            (inner.daemon.take(), std::mem::take(&mut inner.socket))
        };
        if let Some(mut child) = daemon {
            let _ = child.kill();
            let _ = child.wait();
        }
        if !socket.as_os_str().is_empty() {
            let _ = std::fs::remove_file(&socket);
        }
    }

    /// Run one driver operation.
    ///
    /// `policy` is the caller's QA policy. Acting operations need Automatic;
    /// looking needs only that QA is not switched off, which is the whole
    /// point — an agent that cannot look cannot check its own work.
    pub async fn call(
        &self,
        operation: &str,
        args: Map<String, Value>,
        policy: QaPolicy,
    ) -> Result<BusToolResult> {
        if !is_known_operation(operation) {
            bail!(
                "Computer tool \u{201c}{operation}\u{201d} is not available in BOSS's scoped QA surface."
            );
        }
        if policy == QaPolicy::Off {
            bail!(
                "QA tools are disabled for this thread. Ask the user to change QA to Suggest or Automatic."
            );
        }
        if is_action_operation(operation) && !policy.is_automatic() {
            bail!(
                "QA is in Suggest mode. Ask the user to enable Automatic QA before you run computer action {operation}."
            );
        }
        let args = normalize_arguments(operation, args)?;
        let socket = {
            let mut inner = self.inner.lock().unwrap();
            if !inner.enabled || !Self::running(&mut inner) {
                bail!(
                    "Computer Use is disabled. Enable Automatic QA or turn on Computer Use before trying again."
                );
            }
            inner.socket.clone()
        };

        // A per-call file rather than a stream: the driver writes PNG bytes,
        // and reading them back is cheaper than teaching the protocol to carry
        // base64 through a pipe that also carries the text result.
        let shot_dir = std::env::temp_dir().join("boss-qa");
        std::fs::create_dir_all(&shot_dir)?;
        let shot = shot_dir.join(format!("{}.png", uuid::Uuid::new_v4()));

        let bin = resolve_driver_binary();
        let payload = Value::Object(args).to_string();
        let mut cmd = tokio::process::Command::new(&bin);
        cmd.arg("call")
            .arg(operation)
            .arg(&payload)
            .arg("--socket")
            .arg(&socket)
            .arg("--screenshot-out-file")
            .arg(&shot)
            .env("CUA_DRIVER_EMBEDDED", "1")
            .env("CUA_DRIVER_HOST_BUNDLE_ID", HOST_BUNDLE_ID)
            .stdin(std::process::Stdio::null())
            .kill_on_drop(true);

        let output = match tokio::time::timeout(CALL_TIMEOUT, cmd.output()).await {
            Ok(result) => result?,
            Err(_) => {
                let _ = std::fs::remove_file(&shot);
                bail!("Computer tool {operation} timed out.");
            }
        };

        if !output.status.success() {
            let _ = std::fs::remove_file(&shot);
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
            let stdout = String::from_utf8_lossy(&output.stdout).trim().to_owned();
            let code = output
                .status
                .code()
                .map(|c| c.to_string())
                .unwrap_or_else(|| "signal".into());
            let message = if !stderr.is_empty() {
                stderr
            } else if !stdout.is_empty() {
                stdout
            } else {
                format!("Computer tool {operation} failed with exit code {code}.")
            };
            return Err(anyhow!(message));
        }

        let mut text = String::from_utf8_lossy(&output.stdout).trim().to_owned();
        if text.is_empty() {
            text = format!("Computer tool {operation} completed.");
        }
        if text.len() > MAX_TEXT {
            // Cut on a character boundary: the text is handed to the agent as
            // a string, and half a codepoint is not one.
            let mut end = MAX_TEXT;
            while end > 0 && !text.is_char_boundary(end) {
                end -= 1;
            }
            text.truncate(end);
        }

        // Most operations return no image; a missing file is not an error.
        let image = std::fs::read(&shot).ok().map(|bytes| BusContent::Image {
            data: base64_encode(&bytes),
            mime_type: "image/png".into(),
        });
        let _ = std::fs::remove_file(&shot);

        let mut content = vec![BusContent::Text { text }];
        content.extend(image);
        Ok(BusToolResult {
            content,
            is_error: false,
        })
    }

    /// Serve one `boss_computer` bus call: unwrap the tool arguments, run the
    /// operation, and answer with a `BusToolResult` either way.
    ///
    /// An error comes back as `is_error` text rather than a thrown error
    /// because the agent has to read it: "turn on Automatic QA" is the most
    /// useful thing a refused call can say.
    pub async fn call_bus_tool(&self, args: &Value, policy: QaPolicy) -> BusToolResult {
        // The TS turned Computer Use on the moment a thread's QA policy became
        // automatic, so an agent under automatic QA never met a disabled
        // driver. There is no policy-change event to hang that off here, so
        // the first call under automatic QA does it — but only when the user
        // has never decided. An explicit off, including the emergency stop,
        // writes the state file and therefore stands: the whole point of that
        // button is that the next call does not undo it.
        if policy.is_automatic() && !self.enabled() && !self.state_file.exists() {
            self.set_enabled(true).await;
        }
        let operation = args
            .get("operation")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_owned();
        let input = match args.get("arguments") {
            Some(Value::Object(map)) => map.clone(),
            _ => Map::new(),
        };
        match self.call(&operation, input, policy).await {
            Ok(result) => result,
            Err(e) => BusToolResult::error(e.to_string()),
        }
    }
}

impl Drop for ComputerUse {
    fn drop(&mut self) {
        self.stop_daemon();
    }
}

/// Whether this call's screenshot belongs in the user-facing transcript.
///
/// Inspection screenshots are working context the model asked for, not
/// attachments it chose to show, and a transcript of forty near-identical
/// desktop captures is unreadable. The flag travels on the call itself, which
/// every backend keeps as the tool part's input, so the image still reaches
/// the model either way.
pub fn should_surface_tool_image(tool: &str, input: &Value) -> bool {
    if !is_computer_tool(tool) {
        return true;
    }
    let parsed;
    let value = match input {
        Value::String(s) => match serde_json::from_str::<Value>(s) {
            Ok(v) => {
                parsed = v;
                &parsed
            }
            Err(_) => return false,
        },
        other => other,
    };
    value.get("showInTranscript") == Some(&Value::Bool(true))
}

/// `boss_computer`, under its bare name or an MCP client's prefixed one.
pub fn is_computer_tool(tool: &str) -> bool {
    tool == "boss_computer" || tool.ends_with("__boss_computer")
}

/// Base64, standard alphabet with padding — the encoding MCP image content
/// uses. Written out rather than pulled from a crate the bus does not already
/// carry into this module's dependency set.
fn base64_encode(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

// ---------------------------------------------------------------------------
// macOS privacy grants
// ---------------------------------------------------------------------------

/// Whether the driver has the macOS grants it needs.
///
/// In embedded mode the daemon is BOSS's child, so BOSS's own TCC grants *are*
/// the driver's grants and asking the system about this process is the right
/// question. Both calls are the read-only preflight form: neither shows the
/// user a dialog.
pub fn permissions() -> ComputerUsePermissions {
    #[cfg(target_os = "macos")]
    {
        ComputerUsePermissions {
            available: true,
            accessibility: macos::accessibility_trusted(),
            screen_recording: macos::screen_capture_allowed(),
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        ComputerUsePermissions::default()
    }
}

/// Ask for one of the two grants, then report whether it is now held.
///
/// Screen Recording is asked for in process: the preflight/request pair is
/// exactly what the capture APIs use, so the grant lands on BOSS, which is
/// where the embedded daemon needs it.
///
/// Accessibility goes through `cua-driver permissions grant` rather than an
/// in-process prompt. Building the `AXIsProcessTrustedWithOptions` options
/// dictionary by hand is a lot of untestable unsafe for a call that only
/// opens System Settings, and the driver's own command does more than that:
/// it launches through LaunchServices so the dialogs attribute correctly,
/// explains both grants, and verifies live capture afterwards.
///
/// `false` means "not granted yet", not "refused" — the user has to finish in
/// System Settings, and nothing here can do it for them.
pub async fn request_permission(pane: PrivacyPane) -> bool {
    #[cfg(target_os = "macos")]
    {
        match pane {
            PrivacyPane::Accessibility => {
                let mut cmd = tokio::process::Command::new(resolve_driver_binary());
                cmd.args(["permissions", "grant"])
                    .env("CUA_DRIVER_EMBEDDED", "1")
                    .env("CUA_DRIVER_HOST_BUNDLE_ID", HOST_BUNDLE_ID)
                    .stdin(std::process::Stdio::null())
                    .kill_on_drop(true);
                // The command waits on a human, so it gets its own long
                // deadline rather than the per-call one.
                let _ = tokio::time::timeout(Duration::from_secs(300), cmd.output()).await;
                macos::accessibility_trusted()
            }
            PrivacyPane::ScreenRecording => {
                macos::request_screen_capture();
                macos::screen_capture_allowed()
            }
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = pane;
        false
    }
}

#[cfg(target_os = "macos")]
mod macos {
    //! Direct framework calls rather than a wrapper crate: these are three C
    //! functions with no object graph behind them, and the frameworks are
    //! already linked into the binary.
    use std::ffi::c_void;

    type Boolean = u8;

    #[link(name = "ApplicationServices", kind = "framework")]
    unsafe extern "C" {
        /// Passing a null options dictionary is the documented read-only
        /// form: it answers the question without showing the user a dialog.
        /// Prompting needs an options dictionary, which BOSS does not build —
        /// `cua-driver permissions grant` is the supported way to ask, and it
        /// puts the request under the driver's own identity where the grant
        /// has to land anyway.
        fn AXIsProcessTrustedWithOptions(options: *const c_void) -> Boolean;
    }

    #[link(name = "CoreGraphics", kind = "framework")]
    unsafe extern "C" {
        fn CGPreflightScreenCaptureAccess() -> Boolean;
        fn CGRequestScreenCaptureAccess() -> Boolean;
    }

    /// Whether this process is a trusted Accessibility client. Never prompts.
    pub fn accessibility_trusted() -> bool {
        unsafe { AXIsProcessTrustedWithOptions(std::ptr::null()) != 0 }
    }

    /// Whether Screen Recording is granted. Preflight, so it never prompts.
    pub fn screen_capture_allowed() -> bool {
        unsafe { CGPreflightScreenCaptureAccess() != 0 }
    }

    /// Put the Screen Recording request in front of the user. Returns whether
    /// the grant is held once the dialog is done with.
    pub fn request_screen_capture() -> bool {
        unsafe { CGRequestScreenCaptureAccess() != 0 }
    }
}

/// A stand-in driver for tests: `serve` touches the socket and waits; `call`
/// echoes the tool and its arguments back as JSON, exactly as the real
/// driver's contract requires, and writes a PNG when asked for a state
/// capture. Shared with `bus_handler`'s tests, which drive the same daemon
/// through the tool route an agent takes.
#[cfg(test)]
pub(crate) fn write_fake_driver(dir: &Path) -> PathBuf {
    use std::io::Write;
    let path = dir.join("fake-cua-driver");
    let script = r#"#!/bin/sh
cmd="$1"; shift
if [ "$cmd" = serve ]; then
  socket=""
  while [ $# -gt 0 ]; do
    [ "$1" = --socket ] && socket="$2"
    shift
  done
  [ -n "$socket" ] || exit 2
  : > "$socket"
  trap 'rm -f "$socket"; exit 0' TERM INT
  while true; do sleep 0.2; done
elif [ "$cmd" = call ]; then
  tool="$1"; payload="$2"; shift 2
  shot=""
  while [ $# -gt 0 ]; do
    [ "$1" = --screenshot-out-file ] && shot="$2"
    shift
  done
  case "$tool" in
    zoom) echo "driver refused $tool" >&2; exit 3 ;;
    get_window_state|get_desktop_state)
      [ -n "$shot" ] && printf 'PNGBYTES' > "$shot" ;;
  esac
  printf '{"tool":"%s","arguments":%s}' "$tool" "$payload"
else
  exit 2
fi
"#;
    let mut f = std::fs::File::create(&path).unwrap();
    f.write_all(script.as_bytes()).unwrap();
    drop(f);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    path
}

/// The driver binary is resolved from `CUA_DRIVER_BIN`, which is process
/// wide, so every test that needs a fake one runs under a single lock.
#[cfg(test)]
static ENV_LOCK: Mutex<()> = Mutex::new(());

/// Points `CUA_DRIVER_BIN` at a fake driver for as long as it is held.
#[cfg(test)]
pub(crate) struct FakeDriver {
    _dir: tempfile::TempDir,
    _guard: std::sync::MutexGuard<'static, ()>,
}

#[cfg(test)]
impl FakeDriver {
    pub(crate) fn install() -> Self {
        let guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let dir = tempfile::tempdir().unwrap();
        let bin = write_fake_driver(dir.path());
        unsafe { std::env::set_var("CUA_DRIVER_BIN", &bin) };
        Self {
            _dir: dir,
            _guard: guard,
        }
    }
}

#[cfg(test)]
impl Drop for FakeDriver {
    fn drop(&mut self) {
        unsafe { std::env::remove_var("CUA_DRIVER_BIN") };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    fn text_of(r: &BusToolResult) -> String {
        r.content
            .iter()
            .filter_map(|c| match c {
                BusContent::Text { text } => Some(text.clone()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[test]
    fn defaults_off_when_no_valid_preference_exists() {
        let dir = tmp();
        let file = dir.path().join("computer-use.json");
        assert!(!load_computer_use_enabled(&file));
        std::fs::write(&file, "{ not json").unwrap();
        assert!(!load_computer_use_enabled(&file));
        std::fs::write(&file, r#"{"version":1,"enabled":"yes"}"#).unwrap();
        assert!(!load_computer_use_enabled(&file));
        // A future version must not read as enabled by accident.
        std::fs::write(&file, r#"{"version":2,"enabled":true}"#).unwrap();
        assert!(!load_computer_use_enabled(&file));
    }

    #[test]
    fn enable_and_disable_choices_survive_a_new_reader() {
        let dir = tmp();
        let file = dir.path().join("computer-use.json");
        save_computer_use_enabled(&file, true);
        assert!(load_computer_use_enabled(&file));
        save_computer_use_enabled(&file, false);
        assert!(!load_computer_use_enabled(&file));
    }

    #[test]
    fn state_file_is_byte_compatible_with_the_electron_file() {
        let dir = tmp();
        let file = dir.path().join("computer-use.json");
        save_computer_use_enabled(&file, true);
        // JSON.stringify(value, null, 2) — two-space indent, no trailing newline.
        assert_eq!(
            std::fs::read_to_string(&file).unwrap(),
            "{\n  \"version\": 1,\n  \"enabled\": true\n}"
        );
        save_computer_use_enabled(&file, false);
        assert_eq!(
            std::fs::read_to_string(&file).unwrap(),
            "{\n  \"version\": 1,\n  \"enabled\": false\n}"
        );
    }

    #[test]
    fn the_scoped_surface_matches_the_driver_tools_boss_exposes() {
        let ops = computer_use_operations();
        assert_eq!(ops.len(), 23);
        assert!(ops.contains(&"get_window_state"));
        assert!(ops.contains(&"get_desktop_state"));
        assert!(ops.contains(&"bring_to_front"));
        assert!(ops.contains(&"invoke_menu"));
        // Dropped from the driver's surface; exposing them would be a lie.
        assert!(!ops.contains(&"screenshot"));
        assert!(!ops.contains(&"wait"));
        // Nothing outside the scoped surface, however plausible its name.
        assert!(!is_known_operation("kill_app"));
        assert!(!is_known_operation("read_clipboard"));
    }

    #[test]
    fn the_advertised_schema_and_the_enforced_surface_cannot_drift() {
        // The operation list exists twice: once in the tool schema an agent
        // reads, once in the gate that enforces it. If they drift, an agent is
        // either offered an operation that will be refused or silently allowed
        // one it was never told about. Neither is acceptable, and nothing else
        // in the tree catches it.
        let tools = boss_bus::tools::tool_definitions();
        let computer = tools.iter().find(|t| t.name == "boss_computer").expect("boss_computer is advertised");
        let advertised: Vec<&str> = computer.input_schema["properties"]["operation"]["enum"]
            .as_array()
            .expect("the schema enumerates its operations")
            .iter()
            .map(|v| v.as_str().unwrap())
            .collect();
        assert_eq!(advertised, computer_use_operations());
        for operation in &advertised {
            assert!(is_known_operation(operation), "{operation} is offered but would be refused");
        }
    }

    #[test]
    fn every_native_app_mutation_is_classified_as_an_action() {
        for op in COMPUTER_USE_ACTION_OPERATIONS {
            assert!(is_action_operation(op), "{op}");
        }
        for op in COMPUTER_USE_INSPECTION_OPERATIONS {
            assert!(!is_action_operation(op), "{op}");
        }
    }

    #[test]
    fn tree_action_spellings_are_canonicalized_without_changing_targeting() {
        let args = |v: Value| v.as_object().unwrap().clone();
        let advertised = args(serde_json::json!({
            "pid": 4242, "window_id": 73, "element_token": "snapshot:9",
            "action": "showmenu", "delivery_mode": "foreground"
        }));
        let out = normalize_arguments("click", advertised.clone()).unwrap();
        assert_eq!(out["action"], "show_menu");
        assert_eq!(out["pid"], 4242);
        assert_eq!(out["element_token"], "snapshot:9");
        assert_eq!(out["delivery_mode"], "foreground");

        for spelling in ["AXShowMenu", "right-click", "show menu", "Show_Menu"] {
            let out = normalize_arguments("click", args(serde_json::json!({ "action": spelling })))
                .unwrap();
            assert_eq!(out["action"], "show_menu", "{spelling}");
        }
        assert_eq!(
            normalize_arguments("click", args(serde_json::json!({"action": "click"}))).unwrap()["action"],
            "press"
        );

        // A non-click operation is untouched even if it carries an action.
        let scroll = args(serde_json::json!({"action": "showmenu"}));
        assert_eq!(
            normalize_arguments("scroll", scroll.clone()).unwrap(),
            scroll
        );

        // Coordinates pass through with their sign and fraction intact: pixel
        // conversion belongs to the driver.
        let pixels = args(serde_json::json!({"pid": 4242, "x": -80.5, "y": 1440.25}));
        assert_eq!(
            normalize_arguments("click", pixels.clone()).unwrap(),
            pixels
        );
    }

    #[test]
    fn unknown_click_actions_fail_closed_instead_of_becoming_a_press() {
        let args = serde_json::json!({"action": "show-menu-typo"})
            .as_object()
            .unwrap()
            .clone();
        let err = normalize_arguments("click", args).unwrap_err().to_string();
        assert!(err.contains("not supported"), "{err}");
        assert!(err.contains("show_menu"), "{err}");
    }

    #[test]
    fn inspection_screenshots_stay_out_of_the_transcript_unless_asked_for() {
        let call = serde_json::json!({"operation": "get_window_state"});
        assert!(!should_surface_tool_image("boss_computer", &call));
        let shown = serde_json::json!({"operation": "get_window_state", "showInTranscript": true});
        assert!(should_surface_tool_image("boss_computer", &shown));
        // Backends that keep the input as a JSON string get the same answer.
        assert!(should_surface_tool_image(
            "boss_computer",
            &Value::String(shown.to_string())
        ));
        assert!(!should_surface_tool_image(
            "boss_computer",
            &Value::String("not json".into())
        ));
        // An MCP client's prefixed name is still the computer tool.
        assert!(!should_surface_tool_image("mcp__x__boss_computer", &call));
        // Every other tool keeps its old, visible behaviour.
        assert!(should_surface_tool_image("boss_browser_screenshot", &call));
    }

    #[tokio::test]
    async fn a_disabled_driver_refuses_even_a_look() {
        let dir = tmp();
        let cu = ComputerUse::in_data_dir(dir.path());
        assert!(!cu.status().enabled);
        assert!(!cu.status().running);
        let err = cu
            .call("list_apps", Map::new(), QaPolicy::Automatic)
            .await
            .unwrap_err()
            .to_string();
        assert!(err.contains("Computer Use is disabled"), "{err}");
    }

    #[tokio::test]
    async fn an_operation_outside_the_scoped_surface_never_reaches_the_driver() {
        let dir = tmp();
        let cu = ComputerUse::in_data_dir(dir.path());
        let err = cu
            .call("read_clipboard", Map::new(), QaPolicy::Automatic)
            .await
            .unwrap_err()
            .to_string();
        assert!(err.contains("scoped QA surface"), "{err}");
        // Refused before the disabled check, so the reason names the real problem.
        assert!(!err.contains("disabled"), "{err}");
    }

    #[tokio::test]
    async fn acting_needs_automatic_qa_but_looking_never_does() {
        let _fake = FakeDriver::install();
        let dir = tmp();
        let cu = ComputerUse::in_data_dir(dir.path());
        assert!(
            cu.set_enabled(true).await.running,
            "fake daemon should come up"
        );

        let err = cu
            .call("click", Map::new(), QaPolicy::Suggest)
            .await
            .unwrap_err()
            .to_string();
        assert!(err.contains("Automatic QA"), "{err}");
        assert!(err.contains("click"), "{err}");

        // The same call goes through once QA is automatic.
        let ok = cu
            .call("click", Map::new(), QaPolicy::Automatic)
            .await
            .unwrap();
        assert!(text_of(&ok).contains("\"tool\":\"click\""));

        // Looking is allowed with QA off — this is the whole point of the gate.
        let look = cu
            .call("list_apps", Map::new(), QaPolicy::Suggest)
            .await
            .unwrap();
        assert!(text_of(&look).contains("\"tool\":\"list_apps\""));
    }

    #[tokio::test]
    async fn the_call_carries_the_normalized_arguments_to_the_driver() {
        let _fake = FakeDriver::install();
        let dir = tmp();
        let cu = ComputerUse::in_data_dir(dir.path());
        cu.set_enabled(true).await;

        let args = serde_json::json!({"pid": 4242, "window_id": 73, "action": "showmenu"})
            .as_object()
            .unwrap()
            .clone();
        let result = cu.call("click", args, QaPolicy::Automatic).await.unwrap();
        let echoed: Value = serde_json::from_str(&text_of(&result)).unwrap();
        assert_eq!(echoed["tool"], "click");
        assert_eq!(echoed["arguments"]["action"], "show_menu");
        assert_eq!(echoed["arguments"]["pid"], 4242);
        assert_eq!(echoed["arguments"]["window_id"], 73);
    }

    #[tokio::test]
    async fn a_state_capture_comes_back_as_image_content() {
        let _fake = FakeDriver::install();
        let dir = tmp();
        let cu = ComputerUse::in_data_dir(dir.path());
        cu.set_enabled(true).await;

        let result = cu
            .call("get_window_state", Map::new(), QaPolicy::Suggest)
            .await
            .unwrap();
        assert_eq!(result.content.len(), 2, "text then image");
        match &result.content[1] {
            BusContent::Image { data, mime_type } => {
                assert_eq!(mime_type, "image/png");
                use base64::Engine;
                assert_eq!(
                    base64::engine::general_purpose::STANDARD
                        .decode(data)
                        .unwrap(),
                    b"PNGBYTES"
                );
            }
            other => panic!("expected an image, got {other:?}"),
        }

        // An operation that produces no screenshot returns text alone rather
        // than an empty image block.
        let plain = cu
            .call("list_windows", Map::new(), QaPolicy::Suggest)
            .await
            .unwrap();
        assert_eq!(plain.content.len(), 1);
    }

    #[tokio::test]
    async fn a_failing_driver_reports_its_own_message() {
        let _fake = FakeDriver::install();
        let dir = tmp();
        let cu = ComputerUse::in_data_dir(dir.path());
        cu.set_enabled(true).await;
        // The fake exits 3 on this operation with a message on stderr, which
        // is how the real driver reports "I could not do that".
        let err = cu
            .call("zoom", Map::new(), QaPolicy::Suggest)
            .await
            .unwrap_err()
            .to_string();
        assert_eq!(err, "driver refused zoom");
    }

    #[tokio::test]
    async fn the_bus_arm_answers_errors_as_readable_text() {
        let dir = tmp();
        let cu = ComputerUse::in_data_dir(dir.path());
        let result = cu
            .call_bus_tool(
                &serde_json::json!({"operation": "click"}),
                QaPolicy::Suggest,
            )
            .await;
        assert!(result.is_error);
        assert!(
            text_of(&result).contains("Automatic QA"),
            "{:?}",
            result.content
        );

        let missing = cu
            .call_bus_tool(&serde_json::json!({}), QaPolicy::Automatic)
            .await;
        assert!(missing.is_error);
        assert!(text_of(&missing).contains("scoped QA surface"));
    }

    #[tokio::test]
    async fn the_bus_arm_passes_the_arguments_object_through() {
        let _fake = FakeDriver::install();
        let dir = tmp();
        let cu = ComputerUse::in_data_dir(dir.path());
        cu.set_enabled(true).await;
        let result = cu
            .call_bus_tool(
                &serde_json::json!({
                    "operation": "click",
                    "arguments": {"pid": 7, "action": "AXShowMenu"},
                    "showInTranscript": true
                }),
                QaPolicy::Automatic,
            )
            .await;
        assert!(!result.is_error, "{:?}", result.content);
        let echoed: Value = serde_json::from_str(&text_of(&result)).unwrap();
        assert_eq!(
            echoed["arguments"],
            serde_json::json!({"pid": 7, "action": "show_menu"})
        );
    }

    #[tokio::test]
    async fn disabling_stops_the_daemon_and_remembers_the_choice() {
        let _fake = FakeDriver::install();
        let dir = tmp();
        let file = dir.path().join("computer-use.json");
        let cu = ComputerUse::in_data_dir(dir.path());
        assert!(cu.set_enabled(true).await.running);
        assert!(load_computer_use_enabled(&file));

        let status = cu.set_enabled(false).await;
        assert!(!status.enabled);
        assert!(!status.running);
        assert!(!load_computer_use_enabled(&file));

        // A remembered "on" starts a fresh daemon on the next run.
        let restored = ComputerUse::in_data_dir(dir.path());
        assert!(
            !restored.restore().await.running,
            "a remembered off stays off"
        );
        save_computer_use_enabled(&file, true);
        let restored = ComputerUse::in_data_dir(dir.path());
        assert!(
            restored.restore().await.running,
            "a remembered on comes back up"
        );
    }

    #[tokio::test]
    async fn emergency_stop_kills_the_daemon_and_clears_the_flag() {
        let _fake = FakeDriver::install();
        let dir = tmp();
        let file = dir.path().join("computer-use.json");
        let cu = ComputerUse::in_data_dir(dir.path());
        cu.set_enabled(true).await;
        cu.emergency_stop();
        let status = cu.status();
        assert!(!status.enabled);
        assert!(!status.running);
        assert!(
            !load_computer_use_enabled(&file),
            "the choice must not come back on restart"
        );
        let err = cu
            .call("list_apps", Map::new(), QaPolicy::Automatic)
            .await
            .unwrap_err()
            .to_string();
        assert!(err.contains("disabled"), "{err}");
    }

    #[tokio::test]
    async fn a_missing_driver_is_reported_rather_than_looking_ready() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        unsafe { std::env::set_var("CUA_DRIVER_BIN", "/nonexistent/cua-driver") };
        let dir = tmp();
        let cu = ComputerUse::in_data_dir(dir.path());
        let status = cu.set_enabled(true).await;
        unsafe { std::env::remove_var("CUA_DRIVER_BIN") };
        assert!(
            status.enabled,
            "the user's choice is remembered even though it failed"
        );
        assert!(!status.running);
        let error = status.error.unwrap_or_default();
        assert!(error.contains("not installed"), "{error}");
    }

    #[tokio::test]
    async fn automatic_qa_starts_the_driver_on_first_use_but_never_undoes_a_choice() {
        let _fake = FakeDriver::install();
        let dir = tmp();
        let cu = ComputerUse::in_data_dir(dir.path());
        assert!(!cu.enabled(), "nothing is running before the first call");
        let result = cu
            .call_bus_tool(
                &serde_json::json!({"operation": "list_apps"}),
                QaPolicy::Automatic,
            )
            .await;
        assert!(!result.is_error, "{:?}", result.content);
        assert!(
            cu.status().running,
            "the first automatic call brings the driver up"
        );

        // The emergency stop writes an explicit off, which the next call must
        // respect rather than quietly restarting the driver.
        cu.emergency_stop();
        let refused = cu
            .call_bus_tool(
                &serde_json::json!({"operation": "list_apps"}),
                QaPolicy::Automatic,
            )
            .await;
        assert!(refused.is_error);
        assert!(
            text_of(&refused).contains("disabled"),
            "{:?}",
            refused.content
        );
        assert!(!cu.status().running);
    }

    #[tokio::test]
    async fn suggest_qa_does_not_start_the_driver_on_its_own() {
        let _fake = FakeDriver::install();
        let dir = tmp();
        let cu = ComputerUse::in_data_dir(dir.path());
        let result = cu
            .call_bus_tool(
                &serde_json::json!({"operation": "list_apps"}),
                QaPolicy::Suggest,
            )
            .await;
        assert!(result.is_error);
        assert!(
            !cu.status().running,
            "only automatic QA implies the user wanted this on"
        );
    }

    #[tokio::test]
    async fn qa_switched_off_refuses_even_a_look() {
        let _fake = FakeDriver::install();
        let dir = tmp();
        let cu = ComputerUse::in_data_dir(dir.path());
        cu.set_enabled(true).await;
        let err = cu
            .call("list_apps", Map::new(), QaPolicy::Off)
            .await
            .unwrap_err()
            .to_string();
        assert!(err.contains("QA tools are disabled"), "{err}");
    }

    #[test]
    fn qa_policies_default_to_automatic_and_survive_a_new_reader() {
        let dir = tmp();
        {
            let mut p = QaPolicies::open(dir.path());
            assert_eq!(p.default_policy(), QaPolicy::Automatic);
            assert_eq!(p.policy("thread-1"), QaPolicy::Automatic);
            p.set_policy("thread-1", Some(QaPolicy::Off));
            p.set_default(QaPolicy::Suggest);
        }
        let p = QaPolicies::open(dir.path());
        assert_eq!(p.policy("thread-1"), QaPolicy::Off);
        // Every other thread now follows the changed global default.
        assert_eq!(p.policy("thread-2"), QaPolicy::Suggest);

        // Clearing a thread's override puts it back on the default.
        let mut p = p;
        p.set_policy("thread-1", None);
        assert_eq!(
            QaPolicies::open(dir.path()).policy("thread-1"),
            QaPolicy::Suggest
        );
    }

    #[test]
    fn qa_policies_read_the_electron_file_shape() {
        let dir = tmp();
        std::fs::write(
            dir.path().join("qa-policies.json"),
            r#"{"version":2,"defaultPolicy":"suggest","policies":{"t1":"automatic","t2":"off"}}"#,
        )
        .unwrap();
        let p = QaPolicies::open(dir.path());
        assert_eq!(p.default_policy(), QaPolicy::Suggest);
        assert_eq!(p.policy("t1"), QaPolicy::Automatic);
        assert_eq!(p.policy("t2"), QaPolicy::Off);
        assert_eq!(p.policy("t3"), QaPolicy::Suggest);

        // v1 carried no default, so the automatic default stands rather than
        // a value read out of a field that did not exist.
        std::fs::write(
            dir.path().join("qa-policies.json"),
            r#"{"version":1,"policies":{"t1":"off"}}"#,
        )
        .unwrap();
        let p = QaPolicies::open(dir.path());
        assert_eq!(p.default_policy(), QaPolicy::Automatic);
        assert_eq!(p.policy("t1"), QaPolicy::Off);

        // Unreadable state must not silently widen anyone's permissions past
        // the shipped default, nor narrow them into a surprise.
        std::fs::write(dir.path().join("qa-policies.json"), "{ not json").unwrap();
        assert_eq!(
            QaPolicies::open(dir.path()).default_policy(),
            QaPolicy::Automatic
        );
    }

    #[test]
    fn permissions_are_unavailable_off_macos_and_answered_on_it() {
        let p = permissions();
        assert_eq!(p.available, cfg!(target_os = "macos"));
        if !p.available {
            assert!(!p.accessibility);
            assert!(!p.screen_recording);
        }
    }

    #[test]
    fn the_driver_is_resolved_from_the_environment_first() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        unsafe { std::env::set_var("CUA_DRIVER_BIN", "/somewhere/else/cua-driver") };
        assert_eq!(
            resolve_driver_binary(),
            PathBuf::from("/somewhere/else/cua-driver")
        );
        unsafe { std::env::remove_var("CUA_DRIVER_BIN") };
        // With nothing bundled the resolution still yields a name to exec, so
        // a development machine with the driver on PATH works.
        assert!(resolve_driver_binary().file_name().is_some());
    }
}
