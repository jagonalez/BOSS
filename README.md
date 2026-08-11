# Ralf

A Codex-style desktop client for [opencode](https://opencode.ai). Native-feeling chat, project context, and a resizable panel with Review, Files, Browser, and Terminal — all powered by an isolated `opencode serve` running locally.

## Why

Codex Desktop pairs a chat UI with an app-server that runs the coding agent. Ralf does the same with opencode: the Electron shell is a thin client over opencode's HTTP server, so the heavy lifting (agent, tools, LSP, MCP, permissions) is done by the same engine you trust in the terminal.

## Features

- **Chat** — streamed conversations with opencode, model picker, thinking-mode toggle, permission prompts, abort/stop.
- **Voice** — local text-to-speech (Kokoro) and speech-to-text (Whisper), both running in-process via ONNX. Read assistant messages aloud, or dictate into the composer.
- **Projects** — open any folder; Ralf restarts `opencode serve` in that directory and groups its chats under it. Sessions are grouped by their directory (opencode has no native chat-vs-project concept — we bucket them ourselves). The last project you had open is remembered and reopened on launch.
- **Panel** (right side, resizable via the edge handle) — add any of these as closable tabs:
  - **Review** — per-session diff of changed files (single instance only).
  - **Files** — file tree + viewer for the current project.
  - **Browser** — a real, fully-isolated browser (`WebContentsView` in its own session) for QA'ing local sites.
  - **Terminal** — run shell commands against the project via the session.
  - **Side chat** — a second, independent chat session.
- **Sites** — publish a folder of static files (or have the agent do it via the `publish_site` tool) and preview it instantly at a localhost URL in Ralf's built-in browser. Optionally deploy to Cloudflare Workers Static Assets for a public `*.workers.dev` URL.
- **Security** — sandboxed renderer, context isolation, no node integration for remote content, `webviewTag` disabled, a narrow typed IPC surface, and the browse view runs in its own hardened session.

## Architecture

```
┌───────────────────────────────────────────────────────────────┐
│ Electron main (src/main)                                       │
│  • OpenCodeServer — spawns `opencode serve` on a random port   │
│    with a generated password, health-checks, auto-restarts     │
│  • EventStream — forwards opencode SSE to the renderer         │
│  • SpeechManager — in-process TTS (Kokoro) + ASR (Whisper)      │
│  • BrowseManager — isolated WebContentsView for the Browser    │
│  • typed IPC (src/shared)                                      │
├───────────────────────────────────────────────────────────────┤
│ Preload (src/preload) — contextBridge exposing window.ralf     │
├───────────────────────────────────────────────────────────────┤
│ Renderer (src/renderer) — React + Vite UI                     │
└───────────────────────────────────────────────────────────────┘
```

The renderer never talks to opencode directly: every request goes through main-process IPC, so the server URL/password never leak to page content.

## Sites

Publish any folder of static files and preview it instantly at a localhost URL — no account needed. Sites survive restarts (the registry lives in `userData/sites.json`), are unlinked from any single project, and can be opened in Ralf's built-in browser tab or your default browser.

- **Publish** — the **Sites** page has a *Publish folder…* picker, or the agent can call the `publish_site` MCP tool (registered automatically when the active backend supports MCP).
- **Deploy** — for a public URL, connect a Cloudflare account with a scoped API token. Ralf uses Workers Static Assets (manifest session → base64 upload → script deploy) and verifies served content before reporting success.

### Cloudflare setup

1. Create an API token scoped to **Account → Workers Scripts → Edit**.
2. In Ralf's **Sites** page, click **Connect…** and paste the token plus your account ID.
3. Hit **Deploy** on a site. Ralf uploads the folder as static assets and gives you a `https://<name>.<subdomain>.workers.dev/` URL.

The token is stored encrypted in `userData/sites.secret` via Electron `safeStorage`.

## Voice (TTS & ASR)Ralf ships local speech built on [`@huggingface/transformers`](https://www.npmjs.com/package/@huggingface/transformers) — no Python, no separate runtimes. On first use, the models download automatically and are cached on disk:

| Model | Size (approx.) | Used for |
| --- | --- | --- |
| `onnx-community/Kokoro-82M-v1.0-ONNX` (q8) | ~90 MB | TTS |
| `onnx-community/whisper-base` (q8) | ~150 MB | ASR |

**Read responses aloud (TTS)**
- Hover any assistant message and click the speaker icon.
- Or enable **Settings → Voice → "Speak responses aloud"** to auto-read new responses.
- Pick a voice (28 Kokoro voices) and hit **Preview** in Settings. First click downloads the model; afterwards it's instant.

**Dictate a message (ASR)**
- Click the **mic button** in the composer, start talking — the transcript streams in live and stays editable.
- Click the mic again to stop. First use prompts macOS for microphone access (System Settings → Privacy & Security → Microphone) and downloads the Whisper model.

### Configuration

| Env var | Purpose |
| --- | --- |
| `RALF_MODEL_CACHE` | Directory for downloaded models (default `~/.cache/ralf/models`). Point multiple apps at the same path to share weights. |

## Getting started

Prereqs: Node 20+, and `opencode` on your PATH (or bundle it — see below).

```bash
npm install
npm run dev
```

### Bundle the opencode binary (for packaging)

```bash
npm run fetch:opencode   # copies your local `opencode` into resources/opencode/
npm run pack             # builds + packages into dist/ (bundles the binary)
```

The packaged app uses the bundled binary; in dev it uses your PATH `opencode`.

## Scripts

| Script | Description |
| --- | --- |
| `npm run dev` | Run in development (Vite HMR + Electron) |
| `npm run typecheck` | Type-check main, preload, and renderer |
| `npm run build` | Build main/preload/renderer to `out/` |
| `npm run fetch:opencode` | Bundle an `opencode` binary for packaging |
| `npm run pack` | Package for the current platform (`dist/`) |
| `npm run dist` | Build installers (dmg/nsis/AppImage) |

## Configuration

| Env var | Purpose |
| --- | --- |
| `OPENCODE_BIN` | Path to the `opencode` binary (overrides PATH/bundled) |
| `RALF_SERVER_URL` / `RALF_SERVER_PASSWORD` | Connect to an already-running `opencode serve` instead of spawning one |
| `RALF_OPTIONAL_CDN` | Base URL for optional component downloads (browser-core, computer-use) |
| `RALF_DEBUG` | Verbose logging from the opencode child process |
| `RALF_MODEL_CACHE` | Directory for speech model downloads (default `~/.cache/ralf/models`) |

## Project structure

```
src/
  main/       Electron main process (server lifecycle, IPC, browse, computer-use, optional deps)
  preload/    contextBridge typed API (window.ralf)
  renderer/   React UI (sidebar, chat, panel tabs)
  shared/     IPC contracts + opencode API types (shared main/renderer)
scripts/      build/utility scripts (fetch-opencode)
```

## Roadmap

- Real PTY terminal (currently one-shot commands via `/session/:id/shell`)
- Loose "chats" not tied to a project (scratch directory)
- v2: Ralf-owned project registry with one `opencode serve` per open project for parallel multi-project work
- App icon, signing, auto-updates
