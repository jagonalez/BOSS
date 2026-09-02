//! Checking for, downloading, and applying BOSS updates.
//!
//! The native app has no electron-updater, so this reads the GitHub releases
//! API for `jagonalez/BOSS` directly. A release carries a `latest-<os>.json`
//! written by the bundle scripts in `packaging/`: version, artifact name,
//! download URL, and a base64 sha512 the download is checked against.
//!
//! Channels follow the same rule the Electron beta workflow set — a beta is a
//! GitHub prerelease whose tag carries a semver prerelease suffix
//! (`vX.Y.Z-beta.N`). There is no per-channel manifest to look for.
//!
//! ```no_run
//! # async fn f() -> anyhow::Result<()> {
//! use boss_core::store::UpdateChannel;
//! use boss_update::Updater;
//!
//! let updater = Updater::new(env!("CARGO_PKG_VERSION"));
//! if let Some(release) = updater.check(UpdateChannel::Stable).await? {
//!     let file = updater.download(&release, |done, total| {
//!         tracing::info!(done, total, "downloading");
//!     }).await?;
//!     boss_update::install(&file)?;
//! }
//! # Ok(()) }
//! ```

mod download;
mod install;
mod release;

use std::path::{Path, PathBuf};
use std::time::Duration;

use boss_core::store::UpdateChannel;

pub use download::sha512_of;
pub use install::{Installed, current_app_bundle, install, open_manually};
pub use release::{
    Asset, GithubRelease, Manifest, Release, is_beta_tag, manifest_name, newer, parse_manifest,
    parse_releases, select,
};

/// GitHub repository the releases are published to.
pub const REPO: &str = "jagonalez/BOSS";

/// Page to send someone to when an update cannot be applied automatically.
pub const RELEASES_PAGE: &str = "https://github.com/jagonalez/BOSS/releases";

/// Why a check, download, or install did not finish.
#[derive(Debug, thiserror::Error)]
pub enum UpdateError {
    /// The releases API or a download could not be reached.
    #[error("update request failed: {0}")]
    Http(String),
    /// A response was not the JSON this expects.
    #[error("cannot read the update metadata: {0}")]
    Parse(String),
    /// The newest release carries no manifest for this platform.
    #[error("release {tag} has no {name}")]
    MissingManifest {
        /// Tag of the release that was missing it.
        tag: String,
        /// Manifest filename that was looked for.
        name: String,
    },
    /// The download did not hash to what the manifest promised.
    #[error("the download did not match its checksum (expected {expected}, got {actual})")]
    Checksum {
        /// Hash the manifest carried.
        expected: String,
        /// Hash the downloaded bytes produced.
        actual: String,
    },
    /// Reading or writing a file failed.
    #[error("update file error: {0}")]
    Io(String),
    /// Replacing the installed app failed.
    #[error("cannot install the update: {0}")]
    Install(String),
}

/// Checks for updates and applies them.
pub struct Updater {
    client: reqwest::Client,
    current_version: String,
    api_base: String,
    download_dir: Option<PathBuf>,
}

impl Updater {
    /// An updater for a copy running `current_version`.
    pub fn new(current_version: impl Into<String>) -> Self {
        Self {
            // A check runs on launch, where a hung socket would keep the
            // update state "checking" forever.
            client: reqwest::Client::builder()
                .timeout(Duration::from_secs(300))
                .connect_timeout(Duration::from_secs(15))
                .user_agent(concat!("BOSS/", env!("CARGO_PKG_VERSION")))
                .build()
                .unwrap_or_default(),
            current_version: current_version.into(),
            api_base: "https://api.github.com".to_string(),
            download_dir: None,
        }
    }

    /// Point the updater at another API host. For tests against a local server.
    pub fn with_api_base(mut self, base: impl Into<String>) -> Self {
        self.api_base = base.into();
        self
    }

    /// Where downloads land. Defaults to `<user data>/updates`.
    pub fn with_download_dir(mut self, dir: impl Into<PathBuf>) -> Self {
        self.download_dir = Some(dir.into());
        self
    }

    /// Version this copy reports.
    pub fn current_version(&self) -> &str {
        &self.current_version
    }

    fn downloads(&self) -> PathBuf {
        self.download_dir
            .clone()
            .unwrap_or_else(|| boss_core::paths::user_data_dir().join("updates"))
    }

    /// The newest release on `channel`, or `None` when this copy is current.
    ///
    /// Asks for the last 30 releases rather than `/releases/latest`: that
    /// endpoint never returns a prerelease, so the beta channel would see
    /// nothing.
    pub async fn check(&self, channel: UpdateChannel) -> Result<Option<Release>, UpdateError> {
        let url = format!("{}/repos/{REPO}/releases?per_page=30", self.api_base);
        let body = self.get_text(&url).await?;
        let releases = parse_releases(&body)?;
        self.resolve(&releases, channel).await
    }

    /// Pick a release from an already-fetched list and read its manifest.
    /// Split out from `check` so the selection rules are testable without a
    /// network round trip.
    pub async fn resolve(
        &self,
        releases: &[GithubRelease],
        channel: UpdateChannel,
    ) -> Result<Option<Release>, UpdateError> {
        let Some(found) = select(releases, channel) else {
            return Ok(None);
        };
        if !newer(found.version(), &self.current_version) {
            return Ok(None);
        }
        let name = manifest_name();
        let asset = found
            .asset(name)
            .ok_or_else(|| UpdateError::MissingManifest {
                tag: found.tag_name.clone(),
                name: name.to_string(),
            })?;
        let manifest = parse_manifest(&self.get_text(&asset.browser_download_url).await?)?;
        Ok(Some(build_release(found, manifest)))
    }

    /// Fetch a release's artifact and verify it. Returns the file on disk.
    pub async fn download(
        &self,
        release: &Release,
        on_progress: impl FnMut(u64, u64),
    ) -> Result<PathBuf, UpdateError> {
        download::download_to(&self.client, release, &self.downloads(), on_progress).await
    }

    async fn get_text(&self, url: &str) -> Result<String, UpdateError> {
        let response = self
            .client
            .get(url)
            .header("Accept", "application/vnd.github+json")
            .send()
            .await
            .map_err(|e| UpdateError::Http(e.to_string()))?;
        if !response.status().is_success() {
            return Err(UpdateError::Http(format!(
                "{} for {url}",
                response.status()
            )));
        }
        response
            .text()
            .await
            .map_err(|e| UpdateError::Http(e.to_string()))
    }
}

/// Turn a release and its manifest into an update candidate, resolving a
/// relative manifest URL against the assets of the release that carried it.
fn build_release(found: &GithubRelease, manifest: Manifest) -> Release {
    let download_url = if manifest.url.starts_with("http") {
        manifest.url.clone()
    } else {
        found
            .asset(&manifest.name)
            .map(|a| a.browser_download_url.clone())
            .unwrap_or_else(|| {
                format!(
                    "https://github.com/{REPO}/releases/download/{}/{}",
                    found.tag_name, manifest.name
                )
            })
    };
    Release {
        tag: found.tag_name.clone(),
        version: manifest.version.clone(),
        prerelease: found.prerelease || is_beta_tag(&found.tag_name),
        manifest,
        download_url,
        notes: None,
    }
}

/// Apply a downloaded update at `path`. See [`install::install`].
pub fn apply(path: &Path) -> Result<Installed, UpdateError> {
    install::install(path)
}

#[cfg(test)]
mod tests;
