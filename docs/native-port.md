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
  boss-app/           GPUI binary: window, views, wiring
src/                  old Electron app, kept as reference until deletion
docs/rooms*.md        product design for rooms (still authoritative)
```

## Pins

| Dependency | Pin | Note |
|---|---|---|
| Rust | 1.97.1 | matches zed `rust-toolchain.toml` |
| gpui, gpui_platform | git zed-industries/zed, rev in `Cargo.toml` | pre-1.0, breaking changes; bump on our schedule |
| gpui-component | git longbridge/gpui-component, rev in `Cargo.toml` | must match the zed rev it was built against |

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
| 0 | Workspace skeleton, pins, hello window builds | lead | in progress | |
| 1 | boss-core: types, events, stores | agent | queued | contract for all others |
| 2 | boss-engines: claude + pi | agent | queued | stdio, fixtures from `src/main/backend/*.test.ts` |
| 3 | boss-engines: codex + opencode | agent | queued | |
| 4 | boss-bus: MCP server + hub client | agent | queued | port `src/main/thread-bus.ts`, `mcp-hub.ts` |
| 5 | boss-terminal | agent | queued | alacritty_terminal + portable-pty |
| 6 | boss-browser | agent | queued | macOS first; Windows/Linux stubs compile |
| 7 | boss-app: shell, sidebar, transcript, composer | agent | queued | gpui-component |
| 8 | Wiring: engines → core → views, persistence on disk | lead | queued | |
| 9 | Rooms: coordinator, recipients, shapes | agent | queued | port `room-manager.ts`, `room*.ts` |
| 10 | Packaging: signing, updater, CI | later | queued | |

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
