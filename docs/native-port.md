# BOSS native port — tracking

Status page for the move from Electron + React to GPUI + Rust.
Update this file when a work package changes state. Keep entries short.

## Decision

BOSS moves to GPUI (Zed's Rust UI framework) with a Rust core.
The TypeScript main process and the React renderer are replaced.
Reasons:

- Long chats are slow because every token re-renders the DOM through React.
  A webview shell (Tauri, Wails) keeps that path. GPUI does not.
- GPUI renders lists with measured heights natively. DOM virtualization
  broke scroll anchoring and measurement in the React app.
- Every engine BOSS drives already speaks a language-neutral protocol.
  No TypeScript SDK is required. See "Engine bridges".
- Zed ships on macOS, Linux, and Windows on this framework.

Rejected: Tauri, Wails, Electrobun (same DOM cost, weak Linux webview);
Flutter (second choice; desktop webview is weak); Qt, Avalonia (no upside).

## Scope

In: window and workspace layout, sidebar, rooms and threads, transcript
view with streaming, composer, engines (claude, codex, opencode, pi),
thread bus MCP server, external MCP hub, terminal, embedded browser,
persistence, settings, secrets, auto-update hooks.

Out: Lab engine and Lab evals (dropped). Relay and mobile stay as they
are; they get a Rust twin of the wire types later.

## Layout

```
Cargo.toml            workspace
crates/
  boss-core/          domain types, events, stores, settings, paths
  boss-engines/       Engine trait + claude, codex, opencode, pi adapters
  boss-bus/           thread-bus MCP server (HTTP) + MCP hub client
  boss-terminal/      PTY + terminal grid + GPUI element
  boss-browser/       wry webview + page automation trait
  boss-runtime/       headless core: Runtime, sessions, ThreadModel fold, bus handler
  boss-app/           GPUI binary: window, views, wiring
src/                  old Electron app, kept as reference until deletion
docs/rooms*.md        product design for rooms (still authoritative)
```

## Pins

| Dependency | Pin | Note |
|---|---|---|
| Rust | 1.97.1 | matches zed `rust-toolchain.toml` |
| gpui, gpui_platform | git zed-industries/zed, unpinned in `Cargo.toml`; `Cargo.lock` holds the commit (239d0aa) | gpui-component depends on zed without a rev, so a rev here would give two copies of gpui. Bump with `./scripts/cargo update -p gpui`. |
| gpui-component | git longbridge/gpui-component, rev 5cb0946 in `Cargo.toml` | tracks zed main; bump both together |
| cargo | `./scripts/cargo` wrapper | project-local `CARGO_HOME` (`.cargo-home/`) so builds work in the sandbox; git deps need one unsandboxed `cargo fetch` |

## Engine bridges

| Engine | Transport | Replaces |
|---|---|---|
| claude | `claude --output-format stream-json --input-format stream-json --verbose --permission-prompt-tool stdio`; control requests for permission | in-process TS SDK `query()` + `canUseTool` |
| codex | `codex app-server --stdio`, JSON-RPC 2.0 | same as today |
| opencode | `opencode serve`, HTTP + SSE; generated plugin files for bus tools | same as today, SDK replaced by plain HTTP |
| pi | `pi --mode rpc`, JSON on stdio; generated extension for bus tools | same as today |
| thread bus | Rust HTTP server, `POST /mcp`, 24 tools, HMAC bearer per agent | Node http server |
| MCP hub | stdio + streamable HTTP clients | Node hub |
| fallback | ACP adapter (`@agentclientprotocol/claude-agent-acp`) as a child process | only if a Claude feature is SDK-only |

## Long-chat rules

- One message model in Rust. Views read it; views never copy it.
- Streaming commits coalesce to at most 8 per second.
- Render output per message is cached by message revision.
- Transcript uses GPUI `list` with measured heights and a stable anchor.
- Branch replies render in their own lists, not inline.
- No JSON per token across a process boundary.

## Work packages

| # | Package | Owner | State | Notes |
|---|---|---|---|---|
| 0 | Workspace skeleton, pins, hello window builds | lead | done | |
| 1a | boss-core contract: ids, message, thread, engine, event, bus, paths | lead | done | |
| 1b | boss-core stores: json, state, settings, transcript (sqlite), secrets | agent | done | 29 tests; FTS5 search; keyring behind a feature |
| 1c | boss-core rooms: routing, brief, cards, job notes, RoomManager intents | agent | done | 160 tests; `RoomManager` emits intents, app executes them |
| 1d | boss-app `ThreadModel` fold (EngineEvent → Message) | lead | done | `crates/boss-app/src/model.rs` |
| 2a | boss-engines: claude (stream-json) | agent | done | 26 tests; system prompts travel in the initialize control request |
| 2b | boss-engines: codex (app-server) | agent | done | 24 tests; bus via MCP config, no interception |
| 2c | boss-engines: opencode + pi | agent | done | 36 tests; plugins POST to `/agent-call` (bus route added in follow-up) |
| 3 | boss-bus: MCP server + hub client | agent | done | 44 tests; 25 tools; server tests need the sandbox off (port bind) |
| 4 | boss-terminal | agent | done | 26 tests; example runs; no cursor blink, no SGR mouse yet |
| 5 | boss-browser | agent | done | 16 tests; macOS verified (snapshot of example.com); Linux webview stubbed; Windows screenshot stubbed |
| 6a | boss-app transcript + composer + coalescer | agent | in progress | `list()` + render cache |
| 6b | boss-app shell: window, sidebar, tabs, settings | agent | in progress | gpui-component dock |
| 7 | boss-runtime: Runtime, SessionManager, ThreadModel, RuntimeBusHandler | lead | in progress | headless crate; thread tools ported, worktree/rooms/reports tools stubbed |
| 8 | Wiring: ShellActions impl, BusHandler impl, persistence, rooms intents | lead | queued | after 1b–6b land |
| 9 | Delete Electron app, update README/CI | lead | queued | |
| 10 | Packaging: signing, updater | later | queued | |

States: queued, in progress, blocked, done.

## Risks

- GPUI API drift between the pinned zed rev and gpui-component.
- Embedded browser: wry gives script evaluation but no unified screenshot.
  Per-platform snapshot calls are needed. Overlays draw under the webview.
- Secrets: `safeStorage` → OS keychain crate. Existing encrypted files do
  not migrate; users re-enter keys.
- Claude features present only in the TS SDK. Fallback: ACP adapter.

## Run

```
rustup toolchain install 1.97.1
cargo run -p boss-app
cargo test --workspace
```
