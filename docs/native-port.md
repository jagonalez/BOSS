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
| 6a | boss-app transcript + composer + coalescer | agent | done | 21 tests; 5,000-message example streams at 8 commits/s with 0.2–1.3 ms/s render cost |
| 6b | boss-app shell: window, sidebar, tabs, settings | agent | done | 21 tests; tabs, drag reorder, shortcuts, settings page |
| 7 | boss-runtime: Runtime, SessionManager, ThreadModel, RuntimeBusHandler | lead | done | headless crate; thread tools ported, worktree/rooms/reports tools stubbed |
| 8 | Wiring: `BossApp` (ShellActions), event pump, tab views, browser tools on the bus | lead | done | verified: real Claude Code chat end to end in the native window |
| 8b1 | Rooms runtime: `RoomCoordinator` executes intents, session hooks, handover | agent (fable) | done | 7 tests; state in `rooms-manager.json`; seats go stale on restart |
| 8b2 | Rooms UI: team setup, team bar, recipient menu, replies panel, room cards | agent (opus) | done | 93 tests; `RoomPane` mounts team bar + transcript; replies panel on the right |
| 8c1 | Worktree tools: spawn/use/leave worktree, rooms_open | agent (opus) | done | 16 tests; `RoomOpener` trait filled by the app |
| 8c2 | Still stubbed: reports, notes, presence, workflows, boss_computer | lead | queued | |
| 8d | Live engine smoke tests: codex, opencode, pi against real binaries | agent (opus) | done | claude, codex, opencode pass live; pi not logged in here; fixed codex `approvalsReviewer` (user config could auto-approve) |
| 8e | Relay client for the phone app (E2E crypto, pairing, resume) | agent (fable) | done | 50 tests; byte-compatible frames, crypto, and `remote-access.json`; live socket loop only under `--ignored` |
| 8f | Tailscale web access server for the PWA | agent (opus) | done | 52 tests; same routes and PWA bundle as the TS; automations/reports snapshots empty until 8c2 |
| 8g | Polish: terminal cursor/mouse/links, window bounds, live probes and models, MCP editor, shortcuts | agent (opus) | done | 50 terminal tests; `window.json`; `ProbeState`; `SettingsEvent` for remote access |
| 9 | Delete Electron app, update README/CI | lead | queued | |
| 10 | Packaging: macOS bundle, sign, notarize, updater crate, CI matrix | agent (opus) | done | 18 tests; dmg/zip/manifest verified locally; app must call `boss-update` (see report) |

States: queued, in progress, blocked, done.

## Verified in the running app

- Window, sidebar, tabs, settings page render (macOS, debug build, 48 MB binary).
- New chat → Claude Code session over stream-json → streamed reply with markdown.
- Threads and projects persist across restarts (JSON stores); messages persist to sqlite.
- Thread bus listens on loopback; MCP hub imports and connects the user's servers.
- Live smoke tests: claude, codex, opencode complete a turn and a permission round trip; pi is not logged in on this machine.
- Workspace tests: 622 pass, 6 ignored (network or port binds).
- Room flow (shape picker → job → builder/reviewer handover) is wired but not yet verified on screen.

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
