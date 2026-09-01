//! The automation surface an agent drives a page through.

use anyhow::{Context as _, Result, anyhow, bail};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::scripts::{SNAPSHOT_JS, TYPE_LIMIT, click_js, type_js};

/// Navigation state of one browser tab. Mirrors `BrowseNavigationState`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NavigationState {
    /// Current page URL; empty while the tab still shows `about:blank`.
    pub url: String,
    /// Document title.
    pub title: String,
    /// Whether history has an earlier entry.
    pub can_go_back: bool,
    /// Whether history has a later entry.
    pub can_go_forward: bool,
    /// Whether a load is in flight.
    pub loading: bool,
}

/// Parses `url` and rejects anything that is not http or https.
pub fn http_url(url: &str) -> Result<url::Url> {
    let parsed = url::Url::parse(url).with_context(|| format!("invalid URL: {url}"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        bail!("BOSS browser tools only allow HTTP and HTTPS URLs.");
    }
    Ok(parsed)
}

/// Drives one page. Implementors may live on any thread; [`crate::PageHandle`]
/// forwards each call over a channel to the GPUI main thread.
///
/// `snapshot`, `click`, and `type_text` are provided on top of `eval`, so a
/// new implementation only needs the four primitives.
#[async_trait]
pub trait PageAutomation: Send + Sync {
    /// Loads `url` (http/https only) and resolves once the page finished loading.
    async fn navigate(&self, url: &str) -> Result<()>;
    /// Evaluates `js` in the page and returns its JSON-serialised result.
    async fn eval(&self, js: &str) -> Result<Value>;
    /// Captures the visible viewport as PNG bytes.
    async fn screenshot(&self) -> Result<Vec<u8>>;
    /// Current navigation state.
    async fn state(&self) -> Result<NavigationState>;

    /// Returns the ref outline of the page as pretty-printed JSON.
    async fn snapshot(&self) -> Result<String> {
        let value = self.eval(SNAPSHOT_JS).await?;
        Ok(serde_json::to_string_pretty(&value)?)
    }

    /// Clicks the element carrying `ref_` from the last snapshot.
    async fn click(&self, ref_: &str) -> Result<()> {
        let result = self.eval(&click_js(ref_)).await?;
        check_ok(result, "Browser click failed.")
    }

    /// Replaces the value of the element carrying `ref_`, optionally submitting.
    async fn type_text(&self, ref_: &str, text: &str, submit: bool) -> Result<()> {
        if text.chars().count() > TYPE_LIMIT {
            bail!("Browser typing is limited to 8,000 characters per call.");
        }
        let result = self.eval(&type_js(ref_, text, submit)).await?;
        check_ok(result, "Browser typing failed.")
    }
}

fn check_ok(result: Value, fallback: &str) -> Result<()> {
    if result.get("ok").and_then(Value::as_bool) == Some(true) {
        return Ok(());
    }
    let error = result.get("error").and_then(Value::as_str).unwrap_or(fallback);
    Err(anyhow!("{error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn http_url_accepts_only_web_schemes() {
        assert!(http_url("https://example.com").is_ok());
        assert!(http_url("http://localhost:3000/x").is_ok());
        assert!(http_url("file:///etc/passwd").is_err());
        assert!(http_url("javascript:alert(1)").is_err());
        assert!(http_url("not a url").is_err());
    }

    #[test]
    fn check_ok_reads_the_script_result() {
        assert!(check_ok(serde_json::json!({"ok": true, "ref": "e1"}), "x").is_ok());
        let err = check_ok(serde_json::json!({"ok": false, "error": "nope"}), "x").unwrap_err();
        assert_eq!(err.to_string(), "nope");
        let err = check_ok(Value::Null, "fallback").unwrap_err();
        assert_eq!(err.to_string(), "fallback");
    }
}
