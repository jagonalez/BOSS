use super::*;

const RELEASES: &str = include_str!("fixtures/releases.json");
const MAC_STABLE: &str = include_str!("fixtures/latest-mac.json");
const MAC_BETA: &str = include_str!("fixtures/latest-mac-beta.json");

fn releases() -> Vec<GithubRelease> {
    parse_releases(RELEASES).expect("fixture parses")
}

#[test]
fn parses_a_releases_response() {
    let all = releases();
    assert_eq!(all.len(), 4);
    assert_eq!(all[0].tag_name, "v0.3.0-beta.12");
    assert!(all[0].prerelease);
    assert!(all[1].draft);
    assert_eq!(all[2].version(), "0.2.0");
}

#[test]
fn parses_a_manifest() {
    let manifest = parse_manifest(MAC_STABLE).expect("fixture parses");
    assert_eq!(manifest.version, "0.2.0");
    assert_eq!(manifest.name, "BOSS-0.2.0-mac.zip");
    assert_eq!(manifest.channel, "stable");
    // camelCase in the file, snake_case in Rust: a rename that silently broke
    // would leave the field empty rather than fail to parse.
    assert_eq!(manifest.release_date, "2026-08-21T17:30:00Z");
}

#[test]
fn stable_skips_prereleases() {
    let all = releases();
    let found = select(&all, UpdateChannel::Stable).expect("a stable release");
    assert_eq!(found.tag_name, "v0.2.0");
}

#[test]
fn beta_takes_the_prerelease_when_it_is_newer() {
    let all = releases();
    let found = select(&all, UpdateChannel::Beta).expect("a beta release");
    assert_eq!(found.tag_name, "v0.3.0-beta.12");
}

#[test]
fn drafts_are_never_offered() {
    // v0.4.0 is the highest version in the fixture but is still a draft.
    let all = releases();
    for channel in [UpdateChannel::Stable, UpdateChannel::Beta] {
        let found = select(&all, channel).expect("a release");
        assert_ne!(found.tag_name, "v0.4.0");
    }
}

#[test]
fn beta_falls_back_to_a_newer_stable() {
    // Someone on beta whose last prerelease has been superseded by a stable
    // release should be moved forward, not stranded.
    let mut all = releases();
    all.retain(|r| !r.draft);
    all[0].tag_name = "v0.1.5-beta.1".to_string();
    let found = select(&all, UpdateChannel::Beta).expect("a release");
    assert_eq!(found.tag_name, "v0.2.0");
}

#[test]
fn a_prerelease_tag_is_a_beta() {
    assert!(is_beta_tag("v0.3.0-beta.12"));
    assert!(is_beta_tag("0.3.0-beta.1"));
    assert!(!is_beta_tag("v0.3.0"));
    assert!(!is_beta_tag("0.3.0"));
    // Not semver, so nothing proves it is a prerelease.
    assert!(!is_beta_tag("nightly"));
}

#[test]
fn version_comparison_follows_semver() {
    assert!(newer("0.3.0", "0.2.9"));
    assert!(newer("0.3.0", "0.3.0-beta.1"));
    assert!(!newer("0.3.0-beta.1", "0.3.0"));
    assert!(!newer("0.2.0", "0.2.0"));
}

#[tokio::test]
async fn resolve_reports_nothing_when_already_current() {
    let updater = Updater::new("9.9.9");
    let found = updater
        .resolve(&releases(), UpdateChannel::Stable)
        .await
        .expect("resolve succeeds");
    assert!(found.is_none());
}

#[tokio::test]
async fn resolve_reports_a_missing_manifest() {
    let mut all = releases();
    all.retain(|r| r.tag_name == "v0.2.0");
    all[0].assets.retain(|a| !a.name.starts_with("latest-"));
    let updater = Updater::new("0.1.0");
    let error = updater
        .resolve(&all, UpdateChannel::Stable)
        .await
        .expect_err("no manifest to read");
    assert!(matches!(error, UpdateError::MissingManifest { .. }));
}

#[test]
fn an_absolute_manifest_url_is_used_as_is() {
    let all = releases();
    let stable = all.iter().find(|r| r.tag_name == "v0.2.0").unwrap();
    let release = build_release(stable, parse_manifest(MAC_STABLE).unwrap());
    assert_eq!(
        release.download_url,
        "https://github.com/jagonalez/BOSS/releases/download/v0.2.0/BOSS-0.2.0-mac.zip"
    );
    assert!(!release.prerelease);
}

#[test]
fn a_relative_manifest_url_resolves_against_the_release() {
    // A local build writes the bare filename, since it has no tag to point at.
    let all = releases();
    let beta = all.iter().find(|r| r.tag_name == "v0.3.0-beta.12").unwrap();
    let release = build_release(beta, parse_manifest(MAC_BETA).unwrap());
    assert_eq!(
        release.download_url,
        "https://github.com/jagonalez/BOSS/releases/download/v0.3.0-beta.12/BOSS-0.3.0-beta.12-mac.zip"
    );
    assert!(release.prerelease);
}

#[test]
fn the_manifest_name_matches_this_platform() {
    let name = manifest_name();
    assert!(name.starts_with("latest-") && name.ends_with(".json"));
    if cfg!(target_os = "macos") {
        assert_eq!(name, "latest-mac.json");
    }
}

#[tokio::test]
async fn hashes_a_file_the_way_the_manifests_do() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("artifact.zip");
    std::fs::write(&path, b"boss").expect("write");
    // Same value `shasum -a 512 -b | xxd -r -p | base64` gives for "boss",
    // which is what packaging/common.sh runs.
    assert_eq!(
        sha512_of(&path).await.expect("hash"),
        "P0Yr36TvAzKbhnebr112AcOJnctH0lJJ6gfIUjczU//n1FAiaXXsz+VmiHhjsEIpcfUSA0krykzBLzKgghdVXA=="
    );
}

#[tokio::test]
async fn a_download_that_fails_its_checksum_is_removed() {
    let dir = tempfile::tempdir().expect("tempdir");
    let release = Release {
        tag: "v0.2.0".into(),
        version: "0.2.0".into(),
        prerelease: false,
        manifest: parse_manifest(MAC_STABLE).unwrap(),
        // Never fetched: the cached-file path is what this exercises.
        download_url: "http://127.0.0.1:1/never".into(),
        notes: None,
    };
    // A leftover file whose bytes do not match forces a re-download, which
    // then fails to connect rather than handing back the bad file.
    std::fs::write(dir.path().join(&release.manifest.name), b"wrong").expect("write");
    let error = download::download_to(&reqwest::Client::new(), &release, dir.path(), |_, _| {})
        .await
        .expect_err("cannot reach the server");
    assert!(matches!(error, UpdateError::Http(_)));
}

#[tokio::test]
async fn a_verified_download_already_on_disk_is_reused() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut manifest = parse_manifest(MAC_STABLE).unwrap();
    manifest.name = "cached.zip".into();
    let path = dir.path().join(&manifest.name);
    std::fs::write(&path, b"boss").expect("write");
    manifest.sha512 = sha512_of(&path).await.expect("hash");
    manifest.size = 4;
    let release = Release {
        tag: "v0.2.0".into(),
        version: "0.2.0".into(),
        prerelease: false,
        manifest,
        download_url: "http://127.0.0.1:1/never".into(),
        notes: None,
    };
    let mut reported = (0, 0);
    let got = download::download_to(&reqwest::Client::new(), &release, dir.path(), |a, b| {
        reported = (a, b)
    })
    .await
    .expect("the cached file is accepted");
    assert_eq!(got, path);
    assert_eq!(reported, (4, 4));
}

#[test]
fn a_development_build_is_not_inside_an_app_bundle() {
    // The test binary lives in target/debug/deps, so replacing "the bundle"
    // must not be attempted.
    assert!(current_app_bundle().is_none());
}

#[test]
fn the_fallback_names_the_downloaded_file() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("BOSS-0.2.0-mac.zip");
    std::fs::write(&path, b"boss").expect("write");
    match open_manually(&path) {
        Installed::OpenManually { path: got, message } => {
            assert_eq!(got, path);
            assert!(message.contains("downloaded"));
        }
        other => panic!("expected a manual install, got {other:?}"),
    }
}

/// Hits github.com. Run with `--ignored` when the releases feed itself is in
/// question; the rest of the suite covers the logic with fixtures.
#[tokio::test]
#[ignore = "network"]
async fn checks_the_real_releases_feed() {
    let updater = Updater::new("0.0.1");
    let found = updater.check(UpdateChannel::Stable).await.expect("check");
    if let Some(release) = found {
        assert!(!release.manifest.sha512.is_empty());
        assert!(release.download_url.starts_with("https://"));
    }
}
