//! Fetching an update artifact and proving it is the one the manifest named.

use std::path::{Path, PathBuf};

use base64::Engine as _;
use futures::StreamExt as _;
use sha2::{Digest, Sha512};
use tokio::io::AsyncWriteExt as _;

use crate::{Release, UpdateError};

/// Base64 sha512 of a file on disk, in the shape the manifests carry.
pub async fn sha512_of(path: &Path) -> Result<String, UpdateError> {
    let path = path.to_path_buf();
    // Hashing a several-hundred-megabyte bundle would stall the runtime, so it
    // runs where blocking is allowed.
    tokio::task::spawn_blocking(move || {
        let mut file = std::fs::File::open(&path)?;
        let mut hasher = Sha512::new();
        std::io::copy(&mut file, &mut hasher)?;
        Ok::<_, std::io::Error>(base64::engine::general_purpose::STANDARD.encode(hasher.finalize()))
    })
    .await
    .map_err(|e| UpdateError::Io(e.to_string()))?
    .map_err(|e| UpdateError::Io(e.to_string()))
}

/// Download `release` into `dir` and verify it against the manifest hash.
///
/// Reports progress as `(bytes_so_far, total)` — total is 0 when the server
/// sends no length. The file is written under a temporary name and renamed
/// only once the hash matches, so an interrupted download can never be
/// mistaken for a complete one.
pub async fn download_to(
    client: &reqwest::Client,
    release: &Release,
    dir: &Path,
    mut on_progress: impl FnMut(u64, u64),
) -> Result<PathBuf, UpdateError> {
    tokio::fs::create_dir_all(dir)
        .await
        .map_err(|e| UpdateError::Io(e.to_string()))?;

    let final_path = dir.join(&release.manifest.name);
    let partial = dir.join(format!("{}.partial", release.manifest.name));

    // A finished download from a previous run is worth keeping: an update the
    // user postponed should not be fetched twice.
    if final_path.exists() && sha512_of(&final_path).await? == release.manifest.sha512 {
        let total = release.manifest.size;
        on_progress(total, total);
        return Ok(final_path);
    }

    let response = client
        .get(&release.download_url)
        .send()
        .await
        .map_err(|e| UpdateError::Http(e.to_string()))?;
    if !response.status().is_success() {
        return Err(UpdateError::Http(format!(
            "{} for {}",
            response.status(),
            release.download_url
        )));
    }
    let total = response.content_length().unwrap_or(release.manifest.size);

    let mut file = tokio::fs::File::create(&partial)
        .await
        .map_err(|e| UpdateError::Io(e.to_string()))?;
    let mut seen = 0u64;
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| UpdateError::Http(e.to_string()))?;
        file.write_all(&chunk)
            .await
            .map_err(|e| UpdateError::Io(e.to_string()))?;
        seen += chunk.len() as u64;
        on_progress(seen, total);
    }
    file.flush()
        .await
        .map_err(|e| UpdateError::Io(e.to_string()))?;
    drop(file);

    let actual = sha512_of(&partial).await?;
    if actual != release.manifest.sha512 {
        // Leaving a file that failed its hash where install() might find it is
        // how a corrupt or substituted archive gets run.
        let _ = tokio::fs::remove_file(&partial).await;
        return Err(UpdateError::Checksum {
            expected: release.manifest.sha512.clone(),
            actual,
        });
    }

    tokio::fs::rename(&partial, &final_path)
        .await
        .map_err(|e| UpdateError::Io(e.to_string()))?;
    Ok(final_path)
}
