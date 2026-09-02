//! What the GitHub releases API gives back, and how a release becomes an
//! update candidate.

use serde::{Deserialize, Serialize};

use crate::UpdateError;

/// The `latest-<os>.json` a bundle script writes and a release carries.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    /// Version of the build this manifest describes.
    pub version: String,
    /// Filename of the artifact an update installs from.
    pub name: String,
    /// Where to download it. Relative names resolve against the release.
    pub url: String,
    /// Base64 sha512 of the artifact.
    pub sha512: String,
    /// Size in bytes, for progress reporting.
    #[serde(default)]
    pub size: u64,
    /// When the build was made, RFC 3339.
    #[serde(default)]
    pub release_date: String,
    /// `stable` or `beta`.
    #[serde(default)]
    pub channel: String,
}

/// One asset attached to a GitHub release.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Asset {
    /// Filename as uploaded.
    pub name: String,
    /// Public download URL.
    pub browser_download_url: String,
}

/// A release as the GitHub API reports it.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct GithubRelease {
    /// Tag the release was cut from, e.g. `v0.2.0` or `v0.2.0-beta.7`.
    pub tag_name: String,
    /// Prereleases are the beta channel; stable ignores them.
    #[serde(default)]
    pub prerelease: bool,
    /// Drafts are not installable and are filtered out.
    #[serde(default)]
    pub draft: bool,
    /// Publication time, RFC 3339. Absent on a draft.
    #[serde(default)]
    pub published_at: Option<String>,
    /// Everything uploaded to the release, manifests included.
    #[serde(default)]
    pub assets: Vec<Asset>,
}

impl GithubRelease {
    /// Version the tag names, with the leading `v` removed.
    pub fn version(&self) -> &str {
        self.tag_name.strip_prefix('v').unwrap_or(&self.tag_name)
    }

    /// Asset with this exact name, if the release carries one.
    pub fn asset(&self, name: &str) -> Option<&Asset> {
        self.assets.iter().find(|a| a.name == name)
    }
}

/// An update the app can offer: a release plus the manifest for this OS.
#[derive(Clone, Debug)]
pub struct Release {
    /// Tag the release was cut from.
    pub tag: String,
    /// Version being offered.
    pub version: String,
    /// True when this came from the beta channel.
    pub prerelease: bool,
    /// Manifest read from the release's `latest-<os>.json`.
    pub manifest: Manifest,
    /// Absolute URL of the artifact, with a relative manifest URL already
    /// resolved against the release that carried it.
    pub download_url: String,
    /// Release notes, when the release has a body.
    pub notes: Option<String>,
}

/// Manifest filename for the OS this binary was built for.
pub fn manifest_name() -> &'static str {
    if cfg!(target_os = "macos") {
        "latest-mac.json"
    } else if cfg!(target_os = "windows") {
        "latest-windows.json"
    } else {
        "latest-linux.json"
    }
}

/// A tag names a beta when it carries a semver prerelease suffix. That is the
/// rule the Electron beta workflow already uses (`X.Y.Z-beta.N`), so one
/// definition of the channel covers both apps.
pub fn is_beta_tag(tag: &str) -> bool {
    let version = tag.strip_prefix('v').unwrap_or(tag);
    match semver::Version::parse(version) {
        Ok(v) => !v.pre.is_empty(),
        // A tag that is not semver cannot be shown to be a beta, and treating
        // it as one would offer it to people who never asked for prereleases.
        Err(_) => false,
    }
}

/// Compare two versions, newest first. Falls back to a string compare when a
/// version is not semver, so a malformed tag sorts predictably rather than
/// panicking.
pub fn newer(candidate: &str, current: &str) -> bool {
    match (
        semver::Version::parse(candidate),
        semver::Version::parse(current),
    ) {
        (Ok(a), Ok(b)) => a > b,
        _ => candidate > current,
    }
}

/// Pick the release a copy on `channel` should be offered, newest first.
///
/// Stable takes the newest non-prerelease. Beta takes the newest of either,
/// because a beta channel that ignored a stable release newer than the last
/// beta would strand someone on an old prerelease.
pub fn select(
    releases: &[GithubRelease],
    channel: boss_core::store::UpdateChannel,
) -> Option<&GithubRelease> {
    let beta = matches!(channel, boss_core::store::UpdateChannel::Beta);
    releases
        .iter()
        .filter(|r| !r.draft)
        .filter(|r| beta || !(r.prerelease || is_beta_tag(&r.tag_name)))
        .max_by(|a, b| {
            match (
                semver::Version::parse(a.version()),
                semver::Version::parse(b.version()),
            ) {
                (Ok(x), Ok(y)) => x.cmp(&y),
                _ => a.version().cmp(b.version()),
            }
        })
}

/// Parse a releases-API response body.
pub fn parse_releases(body: &str) -> Result<Vec<GithubRelease>, UpdateError> {
    serde_json::from_str(body).map_err(|e| UpdateError::Parse(e.to_string()))
}

/// Parse a `latest-<os>.json` asset.
pub fn parse_manifest(body: &str) -> Result<Manifest, UpdateError> {
    serde_json::from_str(body).map_err(|e| UpdateError::Parse(e.to_string()))
}
