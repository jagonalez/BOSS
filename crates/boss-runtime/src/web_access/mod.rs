//! Web access: the phone PWA, served over loopback and published on the
//! user's tailnet.
//!
//! Port of `src/main/web-access.ts`. The design is unchanged, and it is the
//! reason this is short: nothing here listens beyond `127.0.0.1`. Remote
//! access is delegated to `tailscale serve`, which fronts the loopback server
//! with TLS and tailnet identity, so there is no certificate, no port forward,
//! and no public listener to get wrong.
//!
//! - [`assets`] — the page, service worker, manifest, and icons.
//! - [`config`] — `mobile-access.json`, the same shape the TS wrote.
//! - [`server`] — the route table and the token check.
//! - [`tailscale`] — the CLI calls behind the settings toggle.
//! - [`wire`] — the JSON the page already speaks.

pub mod assets;
pub mod config;
pub mod server;
pub mod tailscale;
pub mod wire;

use crate::runtime::Runtime;
pub use config::WebAccessConfig;
pub use server::{FORWARDED_EVENTS, Role, WebAccessHost};
pub use tailscale::{Tailscale, TailscaleError};

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

/// Everything the settings page shows about web access.
///
/// Matches `MobileAccessStatus` in `src/shared/mobile.ts`: the config, plus
/// whether the server is up and how the tailnet publish went.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebAccessStatus {
    /// The persisted settings, flattened as the TS status object was.
    #[serde(flatten)]
    pub config: WebAccessConfig,
    /// Whether the loopback server is listening.
    pub running: bool,
    /// Loopback URL of the phone site, when running.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    /// Why the server could not start, if it could not.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Tailnet URL when `tailscale serve` succeeded.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tailscale_url: Option<String>,
    /// The CLI's own message when it did not. Surfaced verbatim, since flags
    /// vary across tailscale versions.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tailscale_error: Option<String>,
}

/// A running web access server. Dropping it, or calling [`WebAccess::stop`],
/// shuts the listener down and resets the tailnet serve rule.
pub struct WebAccess {
    config: WebAccessConfig,
    data_dir: PathBuf,
    addr: SocketAddr,
    tailscale: Tailscale,
    tailscale_url: Option<String>,
    tailscale_error: Option<String>,
    shutdown: Option<tokio::sync::oneshot::Sender<()>>,
    task: Option<tokio::task::JoinHandle<()>>,
}

impl WebAccess {
    /// Bind `127.0.0.1:<config.port>`, serve the PWA, and publish it on the
    /// tailnet when `config.tailscale` is set.
    ///
    /// A tailscale failure is recorded on the status rather than returned:
    /// the loopback site still works over a cable or a port forward, and the
    /// settings page shows what the CLI said.
    pub async fn start(runtime: Arc<Runtime>, config: WebAccessConfig) -> anyhow::Result<Self> {
        let data_dir = runtime.data_dir.clone();
        let host = server::RuntimeHost::new(runtime);
        Self::start_with_host(host, config, data_dir, Tailscale::new()).await
    }

    /// Same, with the host and the CLI injected. Tests use this.
    pub async fn start_with_host(
        host: Arc<dyn WebAccessHost>,
        config: WebAccessConfig,
        data_dir: PathBuf,
        tailscale: Tailscale,
    ) -> anyhow::Result<Self> {
        let state = server::AppState::new(host, &config);
        let (shutdown, rx) = tokio::sync::oneshot::channel();
        let (addr, task) = server::serve(config.port, server::router(state), rx).await?;
        tracing::info!(%addr, "web access listening");
        let mut access = Self {
            config,
            data_dir,
            addr,
            tailscale,
            tailscale_url: None,
            tailscale_error: None,
            shutdown: Some(shutdown),
            task: Some(task),
        };
        if access.config.tailscale {
            access.enable().await;
        }
        Ok(access)
    }

    /// Publish the loopback server on the tailnet, recording the outcome.
    pub async fn enable(&mut self) -> Option<String> {
        self.tailscale_url = None;
        self.tailscale_error = None;
        match self.tailscale.enable(self.addr.port()).await {
            Ok(url) => self.tailscale_url = url,
            Err(e) => self.tailscale_error = Some(e.to_string()),
        }
        self.tailscale_url.clone()
    }

    /// Drop the tailnet serve rule.
    ///
    /// A failure here only leaves a stale rule behind, and re-enabling
    /// replaces it, so it is recorded rather than raised.
    pub async fn disable(&mut self) {
        self.tailscale_url = None;
        if let Err(e) = self.tailscale.disable().await {
            self.tailscale_error = Some(e.to_string());
        }
    }

    /// The machine's tailnet URL, asked of the CLI fresh.
    pub async fn tailscale_status(&self) -> Result<Option<String>, TailscaleError> {
        self.tailscale.status().await
    }

    /// What the settings page renders.
    pub fn status(&self) -> WebAccessStatus {
        WebAccessStatus {
            config: self.config.clone(),
            running: self.shutdown.is_some(),
            url: Some(format!("http://{}", self.addr)),
            error: None,
            tailscale_url: self.tailscale_url.clone(),
            tailscale_error: self.tailscale_error.clone(),
        }
    }

    /// The address actually bound. Port 0 in a test resolves to a real one.
    pub fn addr(&self) -> SocketAddr {
        self.addr
    }

    /// The settings behind this server.
    pub fn config(&self) -> &WebAccessConfig {
        &self.config
    }

    /// Persist the current settings to `mobile-access.json`.
    pub fn save(&self) -> std::io::Result<()> {
        self.config.save(&self.data_dir)
    }

    /// Stop the listener and reset the tailnet serve rule.
    pub async fn stop(mut self) {
        self.disable().await;
        if let Some(tx) = self.shutdown.take() {
            let _ = tx.send(());
        }
        if let Some(task) = self.task.take() {
            let _ = task.await;
        }
    }
}

impl Drop for WebAccess {
    fn drop(&mut self) {
        // The tailnet rule cannot be reset from Drop (it needs to await), so
        // a dropped-not-stopped server leaves one behind. Re-enabling
        // replaces it, which is the same trade the TypeScript made.
        if let Some(tx) = self.shutdown.take() {
            let _ = tx.send(());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    struct NullHost(tokio::sync::broadcast::Sender<wire::WireEvent>);

    #[async_trait::async_trait]
    impl WebAccessHost for NullHost {
        async fn handle(&self, _payload: Value) -> anyhow::Result<Value> {
            Ok(json!(null))
        }
        fn events(&self) -> tokio::sync::broadcast::Receiver<wire::WireEvent> {
            self.0.subscribe()
        }
    }

    fn config() -> WebAccessConfig {
        WebAccessConfig {
            enabled: true,
            // Port 0 so the OS picks one; a fixed port collides between tests.
            port: 0,
            token: "c".repeat(32),
            viewer_token: "v".repeat(32),
            tailscale: false,
        }
    }

    #[test]
    fn status_serializes_the_shape_the_settings_page_reads() {
        // `MobileAccessStatus` in the TS is the config flattened with the
        // runtime fields beside it, so a client reads `token` and `running`
        // off one object.
        let status = WebAccessStatus {
            config: config(),
            running: true,
            url: Some("http://127.0.0.1:4517".into()),
            error: None,
            tailscale_url: Some("http://mac.tail.ts.net".into()),
            tailscale_error: None,
        };
        let value = serde_json::to_value(&status).unwrap();
        assert_eq!(value["running"], true);
        assert_eq!(value["token"], "c".repeat(32));
        assert_eq!(value["viewerToken"], "v".repeat(32));
        assert_eq!(value["tailscaleUrl"], "http://mac.tail.ts.net");
        assert_eq!(value["url"], "http://127.0.0.1:4517");
        // Absent rather than null, as the TS status was.
        assert!(value.get("error").is_none());
        assert!(value.get("tailscaleError").is_none());
    }

    #[tokio::test]
    #[ignore = "binds a port; the sandbox refuses that. Run with the sandbox off."]
    async fn serves_the_page_over_loopback() {
        let (tx, _) = tokio::sync::broadcast::channel(4);
        let dir = tempfile::tempdir().unwrap();
        let access = WebAccess::start_with_host(
            Arc::new(NullHost(tx)),
            config(),
            dir.path().to_path_buf(),
            Tailscale::with_binary("/nonexistent/tailscale"),
        )
        .await
        .unwrap();
        assert_eq!(access.addr().ip().to_string(), "127.0.0.1");
        let body = reqwest::get(format!("http://{}/", access.addr()))
            .await
            .unwrap()
            .text()
            .await
            .unwrap();
        assert!(body.starts_with("<!doctype html>"));
        access.stop().await;
    }

    #[tokio::test]
    #[ignore = "binds a port; the sandbox refuses that. Run with the sandbox off."]
    async fn a_missing_tailscale_lands_on_the_status_not_the_error_path() {
        let (tx, _) = tokio::sync::broadcast::channel(4);
        let dir = tempfile::tempdir().unwrap();
        let mut with_tailscale = config();
        with_tailscale.tailscale = true;
        // Starting must still succeed: the loopback site works without a tailnet.
        let access = WebAccess::start_with_host(
            Arc::new(NullHost(tx)),
            with_tailscale,
            dir.path().to_path_buf(),
            Tailscale::with_binary("/nonexistent/tailscale"),
        )
        .await
        .unwrap();
        let status = access.status();
        assert!(status.running);
        assert!(status.tailscale_url.is_none());
        assert!(status.tailscale_error.unwrap().contains("tailscale.com"));
        access.stop().await;
    }

    #[tokio::test]
    #[ignore = "binds a port; the sandbox refuses that. Run with the sandbox off."]
    async fn the_config_it_started_with_persists() {
        let (tx, _) = tokio::sync::broadcast::channel(4);
        let dir = tempfile::tempdir().unwrap();
        let access = WebAccess::start_with_host(
            Arc::new(NullHost(tx)),
            config(),
            dir.path().to_path_buf(),
            Tailscale::with_binary("/nonexistent/tailscale"),
        )
        .await
        .unwrap();
        access.save().unwrap();
        let loaded = WebAccessConfig::load(dir.path());
        assert_eq!(loaded.token, "c".repeat(32));
        access.stop().await;
    }
}
