//! Plain HTTP client for the opencode server, replacing `@opencode-ai/sdk`.
//!
//! Routes follow the OpenAPI the server exposes (see the SDK's `sdk.gen.js`).
//! Every request carries `?directory=` so a session is read under the scope it
//! was created in, and HTTP basic auth (`opencode:<password>`) matching
//! `OPENCODE_SERVER_USERNAME` / `OPENCODE_SERVER_PASSWORD`.

use anyhow::{Context, Result};
use boss_core::ModelInfo;
use reqwest::{Method, RequestBuilder, Response, StatusCode};
use serde_json::{Value, json};

/// A non-2xx answer from the server, kept typed so callers can fall back on 404.
#[derive(Debug, thiserror::Error)]
#[error("OpenCode {what} failed ({status}): {body}")]
pub struct HttpError {
    /// Which call failed, for the message.
    pub what: String,
    /// HTTP status code.
    pub status: StatusCode,
    /// Response body, usually opencode's JSON error.
    pub body: String,
}

/// `GET /global/health` answer.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Health {
    /// Server reports itself healthy.
    pub healthy: bool,
    /// opencode version string.
    pub version: String,
}

/// HTTP client bound to one server (base URL + credentials).
#[derive(Clone, Debug)]
pub struct OpencodeClient {
    http: reqwest::Client,
    base_url: String,
    username: String,
    password: String,
}

impl OpencodeClient {
    /// Client for `base_url` (no trailing slash) with basic-auth credentials.
    pub fn new(base_url: impl Into<String>, username: impl Into<String>, password: impl Into<String>) -> Self {
        let base_url = base_url.into();
        Self {
            http: reqwest::Client::builder().build().expect("reqwest client"),
            base_url: base_url.trim_end_matches('/').to_string(),
            username: username.into(),
            password: password.into(),
        }
    }

    /// The server's base URL.
    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    /// `Authorization` header value, as the TS `authHeader` getter produced it.
    pub fn auth_header(&self) -> String {
        use base64::Engine as _;
        let raw = format!("{}:{}", self.username, self.password);
        format!("Basic {}", base64::engine::general_purpose::STANDARD.encode(raw))
    }

    fn request(&self, method: Method, path: &str, directory: Option<&str>) -> RequestBuilder {
        let mut req = self
            .http
            .request(method, format!("{}{}", self.base_url, path))
            .basic_auth(&self.username, Some(&self.password));
        if let Some(dir) = directory {
            req = req.query(&[("directory", dir)]);
        }
        req
    }

    async fn send(&self, req: RequestBuilder, what: &str) -> Result<Response> {
        let res = req.send().await.with_context(|| format!("OpenCode {what}: request failed"))?;
        let status = res.status();
        if status.is_success() {
            return Ok(res);
        }
        let body = res.text().await.unwrap_or_default();
        Err(HttpError { what: what.to_string(), status, body }.into())
    }

    async fn json(&self, req: RequestBuilder, what: &str) -> Result<Value> {
        let res = self.send(req, what).await?;
        let text = res.text().await.with_context(|| format!("OpenCode {what}: read body"))?;
        if text.trim().is_empty() {
            return Ok(Value::Null);
        }
        serde_json::from_str(&text).with_context(|| format!("OpenCode {what}: bad JSON: {text}"))
    }

    /// `GET /global/health`. `Ok(None)` when the server is not answering yet.
    pub async fn health(&self) -> Option<Health> {
        let res = self.request(Method::GET, "/global/health", None).send().await.ok()?;
        if !res.status().is_success() {
            return None;
        }
        let body: Value = res.json().await.ok()?;
        Some(Health {
            healthy: body.get("healthy").and_then(Value::as_bool).unwrap_or(false),
            version: body.get("version").and_then(Value::as_str).unwrap_or("").to_string(),
        })
    }

    /// `POST /session` — returns the session record (`id`, `directory`, `title`, ...).
    pub async fn session_create(&self, directory: &str, title: Option<&str>) -> Result<Value> {
        let body = match title {
            Some(t) => json!({ "title": t }),
            None => json!({}),
        };
        self.json(self.request(Method::POST, "/session", Some(directory)).json(&body), "session create").await
    }

    /// `GET /session/{id}`.
    pub async fn session_get(&self, directory: &str, id: &str) -> Result<Value> {
        self.json(self.request(Method::GET, &format!("/session/{id}"), Some(directory)), "session get").await
    }

    /// `POST /session/{id}/prompt_async` — accepted, streams via events.
    pub async fn prompt_async(&self, directory: &str, id: &str, body: &Value) -> Result<()> {
        self.send(self.request(Method::POST, &format!("/session/{id}/prompt_async"), Some(directory)).json(body), "prompt")
            .await?;
        Ok(())
    }

    /// `POST /session/{id}/abort`.
    pub async fn abort(&self, directory: &str, id: &str) -> Result<()> {
        self.send(self.request(Method::POST, &format!("/session/{id}/abort"), Some(directory)), "abort").await?;
        Ok(())
    }

    /// Answer a permission: `once`, `always`, or `reject`.
    ///
    /// Tries the session-scoped route first
    /// (`POST /session/{id}/permissions/{permissionID}` with `{response}`) and
    /// falls back to the newer `POST /permission/{requestID}/reply` with
    /// `{reply}` when the server answers 404.
    pub async fn permission_respond(&self, directory: &str, session_id: &str, permission_id: &str, response: &str) -> Result<()> {
        let v1 = self
            .request(Method::POST, &format!("/session/{session_id}/permissions/{permission_id}"), Some(directory))
            .json(&json!({ "response": response }));
        match self.send(v1, "permission response").await {
            Ok(_) => Ok(()),
            Err(err) if is_not_found(&err) => {
                let v2 = self
                    .request(Method::POST, &format!("/permission/{permission_id}/reply"), Some(directory))
                    .json(&json!({ "reply": response }));
                self.send(v2, "permission reply").await.map(|_| ())
            }
            Err(err) => Err(err),
        }
    }

    /// `POST /question/{requestID}/reply` with one answer list per question.
    pub async fn question_reply(&self, directory: &str, request_id: &str, answers: &[Vec<String>]) -> Result<()> {
        let req = self
            .request(Method::POST, &format!("/question/{request_id}/reply"), Some(directory))
            .json(&json!({ "answers": answers }));
        self.send(req, "question reply").await.map(|_| ())
    }

    /// `POST /question/{requestID}/reject`.
    pub async fn question_reject(&self, directory: &str, request_id: &str) -> Result<()> {
        self.send(self.request(Method::POST, &format!("/question/{request_id}/reject"), Some(directory)), "question reject")
            .await
            .map(|_| ())
    }

    /// `GET /config/providers` — `{ providers: Provider[], default: {...} }`.
    pub async fn providers(&self, directory: Option<&str>) -> Result<Value> {
        self.json(self.request(Method::GET, "/config/providers", directory), "provider list").await
    }

    /// Open the SSE stream. `/global/event` wraps every directory's events; older
    /// servers only have `/event`, so 404/405 falls back to that.
    pub async fn open_event_stream(&self) -> Result<Response> {
        let res = self.request(Method::GET, "/global/event", None).send().await.context("event stream")?;
        let res = match res.status() {
            StatusCode::NOT_FOUND | StatusCode::METHOD_NOT_ALLOWED => {
                self.request(Method::GET, "/event", None).send().await.context("event stream")?
            }
            _ => res,
        };
        if !res.status().is_success() {
            anyhow::bail!("event stream status {}", res.status());
        }
        Ok(res)
    }
}

fn is_not_found(err: &anyhow::Error) -> bool {
    err.downcast_ref::<HttpError>().is_some_and(|e| e.status == StatusCode::NOT_FOUND)
}

/// Flatten `GET /config/providers` into `ModelInfo`s: each provider's `models`
/// is a record keyed by model id.
pub fn models_from_providers(body: &Value) -> Vec<ModelInfo> {
    let mut out = Vec::new();
    let Some(providers) = body.get("providers").and_then(Value::as_array) else {
        return out;
    };
    for provider in providers {
        let provider_id = provider.get("id").and_then(Value::as_str).unwrap_or("");
        let Some(models) = provider.get("models").and_then(Value::as_object) else {
            continue;
        };
        for (key, model) in models {
            let id = model.get("id").and_then(Value::as_str).unwrap_or(key);
            let label = model.get("name").and_then(Value::as_str).unwrap_or(id);
            out.push(ModelInfo {
                id: id.to_string(),
                label: label.to_string(),
                provider: (!provider_id.is_empty()).then(|| provider_id.to_string()),
            });
        }
    }
    out
}

/// Split BOSS's `provider/model` string into opencode's `{providerID, modelID}`.
/// A bare id without a provider is returned as `None`: opencode needs both.
pub fn split_model(model: &str) -> Option<Value> {
    let (provider, id) = model.split_once('/')?;
    if provider.is_empty() || id.is_empty() {
        return None;
    }
    Some(json!({ "providerID": provider, "modelID": id }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn providers_flatten_to_models() {
        let body = json!({
            "providers": [
                { "id": "anthropic", "models": {
                    "claude-opus-4-5": { "id": "claude-opus-4-5", "name": "Claude Opus 4.5" },
                    "claude-haiku": { "id": "claude-haiku", "name": "Claude Haiku" }
                }},
                { "id": "openai", "models": { "gpt-5": { "id": "gpt-5", "name": "GPT-5" } } },
                { "id": "empty" }
            ],
            "default": { "anthropic": "claude-opus-4-5" }
        });
        let mut models = models_from_providers(&body);
        models.sort_by(|a, b| a.id.cmp(&b.id));
        assert_eq!(models.len(), 3);
        assert_eq!(models[0], ModelInfo { id: "claude-haiku".into(), label: "Claude Haiku".into(), provider: Some("anthropic".into()) });
        assert_eq!(models[2].provider.as_deref(), Some("openai"));
        assert!(models_from_providers(&json!({})).is_empty());
    }

    #[test]
    fn model_string_splits_into_provider_and_id() {
        assert_eq!(split_model("anthropic/claude-opus-4-5"), Some(json!({ "providerID": "anthropic", "modelID": "claude-opus-4-5" })));
        assert_eq!(split_model("openrouter/anthropic/claude"), Some(json!({ "providerID": "openrouter", "modelID": "anthropic/claude" })));
        assert_eq!(split_model("gpt-5"), None);
        assert_eq!(split_model("/x"), None);
    }

    #[test]
    fn auth_header_is_basic_opencode_password() {
        let client = OpencodeClient::new("http://127.0.0.1:1/", "opencode", "secret");
        assert_eq!(client.base_url(), "http://127.0.0.1:1");
        assert_eq!(client.auth_header(), "Basic b3BlbmNvZGU6c2VjcmV0");
    }
}
