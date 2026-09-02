//! The loopback HTTP server the phone talks to.
//!
//! Port of `WebAccess.route` in `src/main/web-access.ts`. Remote access is
//! delegated to the user's tailnet: `tailscale serve <port>` proxies this
//! server with TLS and tailnet identity, so nothing here listens beyond
//! 127.0.0.1.
//!
//! The page speaks one request protocol, not a REST surface: every call is a
//! `POST /api/request` carrying a `{ type, ... }` `BackendRequest`, answered
//! with `{ ok, result }`. Events arrive on an SSE stream at `/api/events`.
//! Both are kept exactly as the served page expects them.

use super::assets;
use super::config::WebAccessConfig;
use super::wire::{self, MessageWithParts, SessionInfo, SupervisionSnapshot, ThreadUsageTotals};
use crate::runtime::Runtime;
use axum::Router;
use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response, Sse, sse::Event};
use axum::routing::{get, post};
use boss_core::*;
use futures::stream::Stream;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

/// Bodies above this are refused, matching the TS `body.length > 256_000`.
const MAX_BODY_BYTES: usize = 256_000;

/// Newest message the phone list asks for when no limit is given.
const DEFAULT_MESSAGE_LIMIT: usize = 60;

/// Event types the phone page reacts to; the rest are desktop concerns.
///
/// Copied from `FORWARDED_EVENTS` in `src/main/web-access.ts`. Sending the
/// others is not merely wasteful — the page's `applyEvent` refetches a thread
/// on anything starting with `session.`, so an unfiltered stream turns every
/// desktop-only event into an HTTP round trip from the phone.
pub const FORWARDED_EVENTS: &[&str] = &[
    "session.created",
    "session.updated",
    "session.deleted",
    "session.status",
    "session.idle",
    "session.error",
    "message.updated",
    "message.part.updated",
    "message.part.created",
    "permission.asked",
    "permission.updated",
    "permission.replied",
    "automations.updated",
    "assistant.updated",
    "thread.followups.updated",
];

/// Which credential a request presented.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    /// The full-control token: may send, stop, approve, and run.
    Control,
    /// The viewer token: may read, and nothing else.
    ReadOnly,
}

impl Role {
    fn as_str(self) -> &'static str {
        match self {
            Role::Control => "control",
            Role::ReadOnly => "read-only",
        }
    }
}

/// Requests exposed over local (Tailscale) access.
///
/// From `LOCAL_REQUESTS` in `src/shared/mobile.ts`, narrowed to the ones this
/// runtime can actually answer. A type absent here is refused with 403 rather
/// than reaching the runtime, so the allowlist is the security boundary and
/// the match below is only a dispatch table.
const LOCAL_REQUESTS: &[&str] = &[
    "backend.list",
    "supervision.snapshot",
    "thread.list",
    "thread.get",
    "thread.messages",
    "thread.send",
    "thread.abort",
    "thread.permission",
    "thread.todos",
    "automation.list",
    "report.list",
    "assistant.snapshot",
];

/// Requests the read-only token may make. From `READ_ONLY_REQUESTS` in
/// `src/shared/mobile.ts`.
const READ_ONLY_REQUESTS: &[&str] = &[
    "backend.list",
    "supervision.snapshot",
    "thread.list",
    "thread.get",
    "thread.messages",
    "thread.todos",
    "automation.list",
    "report.list",
    "assistant.snapshot",
];

/// Whether `type` may be called over local access at all.
pub fn local_request_allowed(request_type: &str) -> bool {
    LOCAL_REQUESTS.contains(&request_type)
}

/// Whether `role` may call `type`.
pub fn request_allowed(request_type: &str, role: Role) -> bool {
    role == Role::Control || READ_ONLY_REQUESTS.contains(&request_type)
}

/// What the phone server needs from the app. `Runtime` is the real one; tests
/// use a fake so the route table can be exercised without engines or sqlite.
#[async_trait::async_trait]
pub trait WebAccessHost: Send + Sync + 'static {
    /// Answer one `BackendRequest`. The `Err` message reaches the phone.
    async fn handle(&self, request: Value) -> anyhow::Result<Value>;
    /// Every session event, already filtered by [`FORWARDED_EVENTS`].
    fn events(&self) -> tokio::sync::broadcast::Receiver<wire::WireEvent>;
}

/// State shared by the route handlers.
pub struct AppState {
    host: Arc<dyn WebAccessHost>,
    /// Only the two tokens; the rest of the config is the app's business.
    control_token: String,
    viewer_token: String,
}

impl AppState {
    /// Build the state the router needs from a host and the tokens on disk.
    pub fn new(host: Arc<dyn WebAccessHost>, config: &WebAccessConfig) -> Arc<Self> {
        Arc::new(Self {
            host,
            control_token: config.token.clone(),
            viewer_token: config.viewer_token.clone(),
        })
    }

    /// Match the presented credential against both tokens in constant time.
    ///
    /// Both comparisons always run: returning early on the control token
    /// would leak, through timing, which of the two a guess was closer to.
    fn role(&self, headers: &HeaderMap, query: &HashMap<String, String>) -> Option<Role> {
        let supplied = headers
            .get(header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer "))
            .map(str::to_owned)
            .or_else(|| query.get("token").cloned())
            .unwrap_or_default();
        let control = constant_time_eq(supplied.as_bytes(), self.control_token.as_bytes());
        let viewer = constant_time_eq(supplied.as_bytes(), self.viewer_token.as_bytes());
        match (control, viewer) {
            (true, _) => Some(Role::Control),
            (_, true) => Some(Role::ReadOnly),
            _ => None,
        }
    }
}

/// Compare without an early exit on the first differing byte.
///
/// The length check is not itself constant time, but a token's length is not
/// a secret: both are 32 characters by construction, so a wrong length is a
/// wrong guess regardless.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b) {
        diff |= x ^ y;
    }
    diff == 0
}

/// The whole route table: the PWA shell plus the phone's API.
///
/// Built separately from the listener so tests can drive it with
/// `tower::ServiceExt::oneshot` and never bind a port.
pub fn router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/", get(page))
        .route("/manifest.webmanifest", get(manifest))
        .route("/sw.js", get(service_worker))
        .route("/icon-{name}", get(icon))
        .route("/api/access", get(access))
        .route("/api/events", get(events))
        .route("/api/request", post(request))
        .with_state(state)
        .layer(axum::extract::DefaultBodyLimit::max(MAX_BODY_BYTES))
}

async fn page() -> Response {
    ([(header::CONTENT_TYPE, "text/html; charset=utf-8")], assets::MOBILE_PAGE).into_response()
}

// PWA assets stay unauthenticated: a manifest, a service worker, and an icon
// carry no user data, and the browser fetches them before the page can attach
// a token.
async fn manifest() -> Response {
    ([(header::CONTENT_TYPE, "application/manifest+json")], assets::WEB_MANIFEST).into_response()
}

async fn service_worker() -> Response {
    (
        [
            (header::CONTENT_TYPE, "text/javascript"),
            // A service worker must not be cached, or an update never lands.
            (header::CACHE_CONTROL, "no-cache"),
        ],
        assets::SERVICE_WORKER,
    )
        .into_response()
}

/// `/icon-<size>.png`. The manifest asks for 192, which no file is, so the
/// smallest shipped icon at or above the request is served.
async fn icon(axum::extract::Path(name): axum::extract::Path<String>) -> Response {
    let Some(size) = name.strip_suffix(".png").and_then(|n| n.parse::<u32>().ok()) else {
        return not_found();
    };
    match assets::icon_at_least(size) {
        Some(body) => (
            [(header::CONTENT_TYPE, "image/png"), (header::CACHE_CONTROL, "max-age=86400")],
            body,
        )
            .into_response(),
        None => not_found(),
    }
}

fn not_found() -> Response {
    (StatusCode::NOT_FOUND, axum::Json(json!({ "error": "not found" }))).into_response()
}

fn unauthorized() -> Response {
    (StatusCode::UNAUTHORIZED, axum::Json(json!({ "error": "unauthorized" }))).into_response()
}

/// Which role the presented token has. The page calls this to decide whether
/// to draw the reply box and the approve buttons.
async fn access(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<HashMap<String, String>>,
) -> Response {
    match state.role(&headers, &query) {
        Some(role) => axum::Json(json!({ "role": role.as_str() })).into_response(),
        None => unauthorized(),
    }
}

/// The event stream. `EventSource` cannot set headers, so the page passes its
/// token in the query string here and only here.
async fn events(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<HashMap<String, String>>,
) -> Response {
    if state.role(&headers, &query).is_none() {
        return unauthorized();
    }
    let stream = event_stream(state.host.events());
    Sse::new(stream)
        // A phone sleeps and a proxy times out idle connections; a comment
        // every 15 seconds keeps both from tearing the stream down.
        .keep_alive(axum::response::sse::KeepAlive::new().interval(Duration::from_secs(15)))
        .into_response()
}

fn event_stream(
    mut rx: tokio::sync::broadcast::Receiver<wire::WireEvent>,
) -> impl Stream<Item = Result<Event, std::convert::Infallible>> {
    async_stream::stream! {
        loop {
            match rx.recv().await {
                Ok(event) => {
                    if let Ok(data) = serde_json::to_string(&event) {
                        yield Ok(Event::default().data(data));
                    }
                }
                // A slow phone that fell behind keeps its stream; the page
                // refetches on the next event it does see.
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            }
        }
    }
}

/// The one API route. Everything the page does arrives here as a
/// `BackendRequest`, and the answer is `{ ok, result }` or `{ ok: false, error }`.
async fn request(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<HashMap<String, String>>,
    body: axum::body::Bytes,
) -> Response {
    let Some(role) = state.role(&headers, &query) else {
        return unauthorized();
    };
    let payload: Value = match serde_json::from_slice(&body) {
        Ok(value) => value,
        Err(e) => {
            return (StatusCode::BAD_REQUEST, axum::Json(json!({ "ok": false, "error": e.to_string() })))
                .into_response();
        }
    };
    let request_type = payload.get("type").and_then(Value::as_str).unwrap_or("").to_string();
    if !local_request_allowed(&request_type) {
        return (
            StatusCode::FORBIDDEN,
            axum::Json(json!({ "error": format!("\"{request_type}\" is not available over mobile access.") })),
        )
            .into_response();
    }
    if !request_allowed(&request_type, role) {
        return (
            StatusCode::FORBIDDEN,
            axum::Json(json!({ "error": format!("\"{request_type}\" requires a control token.") })),
        )
            .into_response();
    }
    match state.host.handle(payload).await {
        Ok(result) => axum::Json(json!({ "ok": true, "result": result })).into_response(),
        Err(e) => (
            StatusCode::BAD_REQUEST,
            axum::Json(json!({ "ok": false, "error": e.to_string() })),
        )
            .into_response(),
    }
}

/// Serves the phone's requests out of a [`Runtime`].
pub struct RuntimeHost {
    runtime: Arc<Runtime>,
    events: tokio::sync::broadcast::Sender<wire::WireEvent>,
}

impl RuntimeHost {
    /// Subscribe to the runtime and start translating its events into the
    /// page's wire format, dropping the ones the page ignores.
    pub fn new(runtime: Arc<Runtime>) -> Arc<Self> {
        let (tx, _) = tokio::sync::broadcast::channel(1024);
        let host = Arc::new(Self { runtime: runtime.clone(), events: tx.clone() });
        let mut rx = runtime.subscribe();
        runtime.handle.spawn(async move {
            loop {
                match rx.recv().await {
                    Ok(event) => {
                        let Some(wire) = wire::engine_event_to_wire(&event) else { continue };
                        if !FORWARDED_EVENTS.contains(&wire.kind.as_str()) {
                            continue;
                        }
                        // An error here only means no phone is listening.
                        let _ = tx.send(wire);
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                }
            }
        });
        host
    }

    /// The project path a thread runs under, for the phone's thread cards.
    fn project_path(&self, thread: &Thread) -> String {
        self.runtime
            .state
            .project(&thread.project_id)
            .map(|p| p.root.display().to_string())
            .unwrap_or_else(|| thread.cwd.display().to_string())
    }

    fn threads(&self) -> Vec<Thread> {
        let mut threads = self.runtime.state.threads();
        // Newest first, as the phone's list expects; it does not sort again.
        threads.sort_by_key(|t| std::cmp::Reverse(t.updated_at));
        threads
    }

    fn thread(&self, payload: &Value) -> anyhow::Result<Thread> {
        let id = payload
            .get("threadId")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow::anyhow!("threadId is required"))?;
        self.runtime
            .state
            .thread(&ThreadId::from_raw(id))
            .ok_or_else(|| anyhow::anyhow!("thread {id} not found"))
    }

    fn messages(&self, payload: &Value) -> anyhow::Result<Vec<MessageWithParts>> {
        let thread = self.thread(payload)?;
        let limit = payload
            .get("limit")
            .and_then(Value::as_u64)
            .map_or(DEFAULT_MESSAGE_LIMIT, |n| n as usize);
        let all = self.runtime.load_messages(&thread.id);
        // The phone asks for the newest N and renders them oldest-first, so
        // the tail is taken without reversing.
        let start = all.len().saturating_sub(limit);
        Ok(all[start..].iter().map(wire::message_to_wire).collect())
    }

    async fn send(&self, payload: &Value) -> anyhow::Result<Value> {
        let thread = self.thread(payload)?;
        let text = payload
            .get("parts")
            .and_then(Value::as_array)
            .map(|parts| {
                parts
                    .iter()
                    .filter(|p| p.get("type").and_then(Value::as_str) == Some("text"))
                    .filter_map(|p| p.get("text").and_then(Value::as_str))
                    .collect::<Vec<_>>()
                    .join("\n")
            })
            .unwrap_or_default();
        if text.trim().is_empty() {
            anyhow::bail!("a reply needs some text");
        }
        let participant = self.runtime.primary_participant(&thread)?;
        self.runtime
            .send(&thread, &participant, Prompt { text, attachments: Vec::new() })
            .await?;
        Ok(json!({ "ok": true }))
    }

    async fn abort(&self, payload: &Value) -> anyhow::Result<Value> {
        let thread = self.thread(payload)?;
        let participant = self.runtime.primary_participant(&thread)?;
        let key = crate::sessions::SessionKey {
            thread_id: thread.id.clone(),
            participant_id: participant.id,
        };
        self.runtime.sessions.interrupt(&key).await?;
        Ok(json!({ "ok": true }))
    }

    async fn permission(&self, payload: &Value) -> anyhow::Result<Value> {
        let thread = self.thread(payload)?;
        let id = payload
            .get("permissionId")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow::anyhow!("permissionId is required"))?;
        // The page sends the three answers the desktop offers. "always" is a
        // plain allow here: a per-tool standing grant lives in settings, and
        // the phone must not be able to widen them.
        let decision = match payload.get("response").and_then(Value::as_str).unwrap_or("reject") {
            "once" | "always" => PermissionDecision::Allow { updated_input: None },
            _ => PermissionDecision::Deny { reason: "Denied from the phone.".into() },
        };
        let participant = self.runtime.primary_participant(&thread)?;
        let key = crate::sessions::SessionKey {
            thread_id: thread.id.clone(),
            participant_id: participant.id,
        };
        self.runtime.sessions.respond_permission(&key, RequestId::from_raw(id), decision).await?;
        Ok(json!({ "ok": true }))
    }
}

#[async_trait::async_trait]
impl WebAccessHost for RuntimeHost {
    async fn handle(&self, payload: Value) -> anyhow::Result<Value> {
        let request_type = payload.get("type").and_then(Value::as_str).unwrap_or_default();
        match request_type {
            "thread.list" => {
                let list: Vec<SessionInfo> = self
                    .threads()
                    .iter()
                    .map(|t| {
                        wire::thread_to_session(t, &self.project_path(t), self.runtime.is_busy(&t.id))
                    })
                    .collect();
                Ok(serde_json::to_value(list)?)
            }
            "thread.get" => {
                let thread = self.thread(&payload)?;
                let busy = self.runtime.is_busy(&thread.id);
                let info = wire::thread_to_session(&thread, &self.project_path(&thread), busy);
                Ok(serde_json::to_value(info)?)
            }
            "supervision.snapshot" => {
                let threads: Vec<_> = self
                    .threads()
                    .iter()
                    .map(|t| {
                        wire::thread_to_supervised(
                            t,
                            &self.project_path(t),
                            self.runtime.is_busy(&t.id),
                            None,
                        )
                    })
                    .collect();
                let snapshot = SupervisionSnapshot {
                    generated_at: (time::OffsetDateTime::now_utc().unix_timestamp_nanos()
                        / 1_000_000) as i64,
                    threads,
                    totals: ThreadUsageTotals::default(),
                };
                Ok(serde_json::to_value(snapshot)?)
            }
            "thread.messages" => Ok(serde_json::to_value(self.messages(&payload)?)?),
            "thread.send" => self.send(&payload).await,
            "thread.abort" => self.abort(&payload).await,
            "thread.permission" => self.permission(&payload).await,
            // Todos live on the running session, not in a store yet.
            "thread.todos" => Ok(json!([])),
            "backend.list" => Ok(json!(
                self.runtime.sessions.engines().map(|e| e.id().as_str()).collect::<Vec<_>>()
            )),
            // Automations, reports, and the assistant are work package 8c2.
            // An empty snapshot renders those tabs as empty rather than as an
            // error the user cannot act on.
            "automation.list" => Ok(json!({ "automations": [], "runs": [] })),
            "report.list" => Ok(json!({ "reports": [] })),
            "assistant.snapshot" => Ok(json!({
                "tasks": [], "taskPlans": {}, "pullRequests": [], "ciIncidents": [],
                "questions": [], "activities": [], "mergeOrders": {}
            })),
            other => anyhow::bail!("Unsupported request: {other}"),
        }
    }

    fn events(&self) -> tokio::sync::broadcast::Receiver<wire::WireEvent> {
        self.events.subscribe()
    }
}

/// Serve `router` on `127.0.0.1:<port>` until `shutdown` fires.
pub(super) async fn serve(
    port: u16,
    router: Router,
    shutdown: tokio::sync::oneshot::Receiver<()>,
) -> anyhow::Result<(std::net::SocketAddr, tokio::task::JoinHandle<()>)> {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port)).await?;
    let addr = listener.local_addr()?;
    let serve = axum::serve(listener, router).with_graceful_shutdown(async move {
        let _ = shutdown.await;
    });
    let task = tokio::spawn(async move {
        if let Err(error) = serve.await {
            tracing::error!(%error, "web access server stopped");
        }
    });
    Ok((addr, task))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::{Body, to_bytes};
    use axum::http::Request;
    use tower::ServiceExt;

    /// A host with no runtime behind it: the route table, the token check,
    /// and the allowlist are what these tests are about.
    struct FakeHost {
        events: tokio::sync::broadcast::Sender<wire::WireEvent>,
        /// Every request type that reached the host, so a 403 can be told
        /// from a handled request that happened to return nothing.
        seen: std::sync::Mutex<Vec<String>>,
    }

    impl FakeHost {
        fn new() -> Arc<Self> {
            let (events, _) = tokio::sync::broadcast::channel(16);
            Arc::new(Self { events, seen: std::sync::Mutex::new(Vec::new()) })
        }
    }

    #[async_trait::async_trait]
    impl WebAccessHost for FakeHost {
        async fn handle(&self, payload: Value) -> anyhow::Result<Value> {
            let request_type =
                payload.get("type").and_then(Value::as_str).unwrap_or_default().to_string();
            self.seen.lock().unwrap().push(request_type.clone());
            match request_type.as_str() {
                "thread.list" => Ok(json!([{ "id": "t1", "title": "One" }])),
                "thread.send" => Ok(json!({ "ok": true })),
                _ => anyhow::bail!("boom"),
            }
        }

        fn events(&self) -> tokio::sync::broadcast::Receiver<wire::WireEvent> {
            self.events.subscribe()
        }
    }

    fn config() -> WebAccessConfig {
        WebAccessConfig {
            enabled: true,
            port: 4517,
            token: "c".repeat(32),
            viewer_token: "v".repeat(32),
            tailscale: false,
        }
    }

    fn app(host: Arc<dyn WebAccessHost>) -> Router {
        router(AppState::new(host, &config()))
    }

    async fn body_string(response: Response) -> String {
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        String::from_utf8(bytes.to_vec()).unwrap()
    }

    fn get(path: &str) -> Request<Body> {
        Request::builder().uri(path).body(Body::empty()).unwrap()
    }

    fn post_request(token: &str, payload: Value) -> Request<Body> {
        Request::builder()
            .method("POST")
            .uri("/api/request")
            .header("authorization", format!("Bearer {token}"))
            .header("content-type", "application/json")
            .body(Body::from(payload.to_string()))
            .unwrap()
    }

    #[tokio::test]
    async fn the_page_is_served_unauthenticated() {
        let response = app(FakeHost::new()).oneshot(get("/")).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers()[header::CONTENT_TYPE],
            "text/html; charset=utf-8"
        );
        let body = body_string(response).await;
        assert!(body.starts_with("<!doctype html>"), "{}", &body[..40.min(body.len())]);
        // The page must reach the routes this server actually serves.
        assert!(body.contains("/api/request"));
        assert!(body.contains("/api/events"));
        assert!(body.contains("manifest.webmanifest"));
    }

    #[tokio::test]
    async fn the_pwa_assets_are_served_unauthenticated() {
        let manifest = app(FakeHost::new()).oneshot(get("/manifest.webmanifest")).await.unwrap();
        assert_eq!(manifest.status(), StatusCode::OK);
        assert_eq!(manifest.headers()[header::CONTENT_TYPE], "application/manifest+json");
        let text = body_string(manifest).await;
        let parsed: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(parsed["name"], "BOSS");
        assert_eq!(parsed["icons"][0]["src"], "./icon-192.png");

        let sw = app(FakeHost::new()).oneshot(get("/sw.js")).await.unwrap();
        assert_eq!(sw.status(), StatusCode::OK);
        // A cached service worker means an update never lands.
        assert_eq!(sw.headers()[header::CACHE_CONTROL], "no-cache");
        assert!(body_string(sw).await.contains("boss-shell-v2"));
    }

    #[tokio::test]
    async fn the_manifests_icons_all_resolve() {
        for size in [192, 512] {
            let response =
                app(FakeHost::new()).oneshot(get(&format!("/icon-{size}.png"))).await.unwrap();
            assert_eq!(response.status(), StatusCode::OK, "icon-{size}.png");
            assert_eq!(response.headers()[header::CONTENT_TYPE], "image/png");
            let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
            assert_eq!(&body[1..4], b"PNG");
        }
    }

    #[tokio::test]
    async fn an_oversized_icon_falls_back_to_the_largest_shipped() {
        let response = app(FakeHost::new()).oneshot(get("/icon-4096.png")).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn a_nonsense_icon_name_is_a_404() {
        let response = app(FakeHost::new()).oneshot(get("/icon-huge.png")).await.unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn the_api_needs_a_token() {
        let response = app(FakeHost::new())
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/request")
                    .body(Body::from(json!({ "type": "thread.list" }).to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn a_wrong_token_is_refused() {
        let response = app(FakeHost::new())
            .oneshot(post_request(&"x".repeat(32), json!({ "type": "thread.list" })))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn the_control_token_reaches_the_host() {
        let host = FakeHost::new();
        let response = app(host.clone())
            .oneshot(post_request(&"c".repeat(32), json!({ "type": "thread.list" })))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body: Value = serde_json::from_str(&body_string(response).await).unwrap();
        assert_eq!(body["ok"], true);
        assert_eq!(body["result"][0]["id"], "t1");
        assert_eq!(host.seen.lock().unwrap().as_slice(), ["thread.list"]);
    }

    #[tokio::test]
    async fn access_reports_the_role_of_each_token() {
        for (token, expected) in [("c", "control"), ("v", "read-only")] {
            let response = app(FakeHost::new())
                .oneshot(
                    Request::builder()
                        .uri("/api/access")
                        .header("authorization", format!("Bearer {}", token.repeat(32)))
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            let body: Value = serde_json::from_str(&body_string(response).await).unwrap();
            assert_eq!(body["role"], expected);
        }
    }

    #[tokio::test]
    async fn the_viewer_token_may_read_but_not_send() {
        let host = FakeHost::new();
        let read = app(host.clone())
            .oneshot(post_request(&"v".repeat(32), json!({ "type": "thread.list" })))
            .await
            .unwrap();
        assert_eq!(read.status(), StatusCode::OK);

        let write = app(host.clone())
            .oneshot(post_request(
                &"v".repeat(32),
                json!({ "type": "thread.send", "threadId": "t1", "parts": [] }),
            ))
            .await
            .unwrap();
        assert_eq!(write.status(), StatusCode::FORBIDDEN);
        assert!(body_string(write).await.contains("requires a control token"));
        // The refusal happened before the host saw it, not inside it.
        assert_eq!(host.seen.lock().unwrap().as_slice(), ["thread.list"]);
    }

    #[tokio::test]
    async fn a_request_off_the_allowlist_never_reaches_the_host() {
        let host = FakeHost::new();
        // A real, dangerous request type that local access must not expose.
        let response = app(host.clone())
            .oneshot(post_request(&"c".repeat(32), json!({ "type": "settings.set" })))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        assert!(body_string(response).await.contains("not available over mobile access"));
        assert!(host.seen.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_host_error_comes_back_as_the_page_expects() {
        let response = app(FakeHost::new())
            .oneshot(post_request(&"c".repeat(32), json!({ "type": "thread.abort", "threadId": "t1" })))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let body: Value = serde_json::from_str(&body_string(response).await).unwrap();
        // The page throws on `ok === false` and shows `error`.
        assert_eq!(body["ok"], false);
        assert_eq!(body["error"], "boom");
    }

    #[tokio::test]
    async fn malformed_json_does_not_reach_the_host() {
        let host = FakeHost::new();
        let response = app(host.clone())
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/request")
                    .header("authorization", format!("Bearer {}", "c".repeat(32)))
                    .body(Body::from("{ not json"))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert!(host.seen.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn the_event_stream_takes_its_token_from_the_query_string() {
        // EventSource cannot set an Authorization header, so this path is the
        // only way the page can authenticate its stream.
        let ok = app(FakeHost::new())
            .oneshot(get(&format!("/api/events?token={}", "c".repeat(32))))
            .await
            .unwrap();
        assert_eq!(ok.status(), StatusCode::OK);
        assert!(ok.headers()[header::CONTENT_TYPE].to_str().unwrap().starts_with("text/event-stream"));

        let denied = app(FakeHost::new()).oneshot(get("/api/events?token=nope")).await.unwrap();
        assert_eq!(denied.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn forwarded_events_reach_the_stream_as_sse_frames() {
        let host = FakeHost::new();
        let response = app(host.clone())
            .oneshot(get(&format!("/api/events?token={}", "c".repeat(32))))
            .await
            .unwrap();
        host.events
            .send(wire::WireEvent {
                kind: "session.status".into(),
                properties: json!({ "sessionID": "t1" }),
            })
            .unwrap();
        let mut body = response.into_body().into_data_stream();
        use futures::StreamExt;
        let frame = body.next().await.unwrap().unwrap();
        let text = String::from_utf8(frame.to_vec()).unwrap();
        assert!(text.starts_with("data: "), "{text}");
        assert!(text.contains("session.status"), "{text}");
        assert!(text.ends_with("\n\n"), "{text:?}");
    }

    #[test]
    fn the_forwarded_set_matches_the_typescript() {
        // Straight from FORWARDED_EVENTS in src/main/web-access.ts. A type
        // dropped here is an event the phone silently stops reacting to.
        assert_eq!(FORWARDED_EVENTS.len(), 15);
        for expected in [
            "session.created",
            "session.updated",
            "session.deleted",
            "session.status",
            "session.idle",
            "session.error",
            "message.updated",
            "message.part.updated",
            "message.part.created",
            "permission.asked",
            "permission.updated",
            "permission.replied",
            "automations.updated",
            "assistant.updated",
            "thread.followups.updated",
        ] {
            assert!(FORWARDED_EVENTS.contains(&expected), "{expected} is missing");
        }
    }

    #[test]
    fn every_read_only_request_is_also_a_local_request() {
        for request_type in READ_ONLY_REQUESTS {
            assert!(
                LOCAL_REQUESTS.contains(request_type),
                "{request_type} is read-only but not reachable"
            );
        }
    }

    #[test]
    fn constant_time_eq_still_compares_correctly() {
        assert!(constant_time_eq(b"abc", b"abc"));
        assert!(!constant_time_eq(b"abc", b"abd"));
        assert!(!constant_time_eq(b"abc", b"ab"));
        assert!(constant_time_eq(b"", b""));
    }
}
