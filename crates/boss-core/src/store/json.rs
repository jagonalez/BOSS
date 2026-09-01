//! One JSON document in one file, written atomically.

use super::{Result, StoreError};
use crate::paths::user_data_dir;
use serde::Serialize;
use serde::de::DeserializeOwned;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

/// A pretty-printed JSON file. Loads treat a missing file as absent and a
/// damaged file as an error; saves write a sibling temp file and rename it
/// over the real one so a crash leaves either the old or the new file.
#[derive(Clone, Debug)]
pub struct JsonFile {
    path: PathBuf,
}

impl JsonFile {
    /// A file at exactly this path.
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }

    /// `name` under `base`, or under the user data dir when `base` is `None`.
    pub fn in_dir(base: Option<&Path>, name: &str) -> Self {
        let dir = base.map(Path::to_path_buf).unwrap_or_else(user_data_dir);
        Self::new(dir.join(name))
    }

    /// Where this file lives.
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Does the file exist on disk?
    pub fn exists(&self) -> bool {
        self.path.is_file()
    }

    /// The parsed document, or `None` when the file does not exist.
    pub fn load<T: DeserializeOwned>(&self) -> Result<Option<T>> {
        let bytes = match fs::read(&self.path) {
            Ok(bytes) => bytes,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(source) => return Err(StoreError::Io { path: self.path.clone(), source }),
        };
        serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|source| StoreError::Json { path: self.path.clone(), source })
    }

    /// The parsed document, or `T::default()` when the file does not exist.
    pub fn load_or_default<T: DeserializeOwned + Default>(&self) -> Result<T> {
        Ok(self.load()?.unwrap_or_default())
    }

    /// Write `value` as pretty JSON. Creates parent directories.
    pub fn save<T: Serialize + ?Sized>(&self, value: &T) -> Result<()> {
        let json = serde_json::to_vec_pretty(value)?;
        self.save_bytes(&json)
    }

    fn save_bytes(&self, bytes: &[u8]) -> Result<()> {
        let io = |source| StoreError::Io { path: self.path.clone(), source };
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).map_err(io)?;
        }
        let temp = self.temp_path();
        {
            let mut file = fs::File::create(&temp).map_err(io)?;
            file.write_all(bytes).map_err(io)?;
            file.sync_all().map_err(io)?;
        }
        if let Err(source) = fs::rename(&temp, &self.path) {
            let _ = fs::remove_file(&temp);
            return Err(io(source));
        }
        Ok(())
    }

    /// Sibling temp file. Includes the pid so two processes cannot clobber
    /// each other's half-written file.
    fn temp_path(&self) -> PathBuf {
        let name = self.path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        self.path.with_file_name(format!(".{name}.{}.writing", std::process::id()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    #[derive(Debug, Default, PartialEq, Serialize, Deserialize)]
    struct Doc {
        n: u32,
        s: String,
    }

    #[test]
    fn missing_file_is_default() {
        let dir = tempfile::tempdir().unwrap();
        let file = JsonFile::in_dir(Some(dir.path()), "doc.json");
        assert_eq!(file.load::<Doc>().unwrap(), None);
        assert_eq!(file.load_or_default::<Doc>().unwrap(), Doc::default());
        assert!(!file.exists());
    }

    #[test]
    fn round_trips_and_creates_parents() {
        let dir = tempfile::tempdir().unwrap();
        let file = JsonFile::new(dir.path().join("nested/deeper/doc.json"));
        let doc = Doc { n: 7, s: "seven".into() };
        file.save(&doc).unwrap();
        assert_eq!(file.load::<Doc>().unwrap(), Some(doc));
        let text = fs::read_to_string(file.path()).unwrap();
        assert!(text.contains("\n  \"n\": 7"), "pretty printed: {text}");
        // No temp file left behind.
        let leftovers: Vec<_> = fs::read_dir(file.path().parent().unwrap()).unwrap().collect();
        assert_eq!(leftovers.len(), 1);
    }

    #[test]
    fn damaged_file_is_an_error_not_a_default() {
        let dir = tempfile::tempdir().unwrap();
        let file = JsonFile::in_dir(Some(dir.path()), "doc.json");
        fs::write(file.path(), b"{ not json").unwrap();
        assert!(matches!(file.load_or_default::<Doc>(), Err(StoreError::Json { .. })));
    }

    #[test]
    fn save_replaces_existing_content() {
        let dir = tempfile::tempdir().unwrap();
        let file = JsonFile::in_dir(Some(dir.path()), "doc.json");
        file.save(&Doc { n: 1, s: "a very long string to make the first file bigger".into() }).unwrap();
        file.save(&Doc { n: 2, s: "b".into() }).unwrap();
        assert_eq!(file.load::<Doc>().unwrap().unwrap().n, 2);
    }
}
