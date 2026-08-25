# BOSS

A Codex-style desktop client for coding agents. Native-feeling chat, project
context, and a tiling workspace with Review, Files, Browser, and Terminal —
running **opencode**, **Claude**, **Codex**, or **pi** against the same UI.

## Why

Codex Desktop pairs a chat UI with an app-server that runs the coding agent.
BOSS does the same, but is not married to one engine: each backend keeps its own
sessions, models, and permission modes, and BOSS supervises them — several at
once, in parallel worktrees, with the results reviewable side by side.

Everything that does not need an agent is done locally: file browsing, diffs,
git, speech. Tokens and credentials stay on the machine.

## Features

- **Backends** — `opencode`, `claude`, `codex`, and `pi`, switchable per thread. Each carries its own models, reasoning effort, and permission modes (ask / auto / plan / accept-edits).
- **Chat** — streamed conversations, model picker, thinking-mode toggle, permission prompts, abort/stop, queued follow-ups you can edit or steer mid-run.
- **Voice** — local text-to-speech (Kokoro) and speech-to-text (Whisper), both running in-process via ONNX. Read assistant messages aloud, or dictate into the composer.
- **Projects** — open any folder; BOSS groups its threads under it. The last project you had open is remembered and reopened on launch.
- **`boss` command** — run `boss .` in a terminal to open that folder in BOSS, creating the project if the folder is not one yet. Install it from Settings → Updates; it symlinks into `/usr/local/bin`, so app updates do not break it. With BOSS already running the folder opens in that window, and opening a git worktree opens its repository with that checkout selected.
- **Worktrees** — give a thread its own git worktree so agents work in parallel without colliding. `.worktreeinclude` and `.worktreesetup` control what a fresh checkout gets (see below).
- **Delegation & fan-out** — hand a subtask to another backend, or run the same task on several at once in separate worktrees and compare the diffs.
- **Automations** — cron-scheduled agent runs with their own prompt, backend, workspace strategy, overlap policy, run history, and optional durable reports.
- **Reports** — a local inbox of Markdown artifacts created by agents or automations, with unread state and a link back to the source thread for follow-up.
- **Lab Assistant** — a durable orchestration inbox for global and per-project tasks, dependencies, ordered or parallel execution decisions, PR and GitHub Actions failure monitoring, and explicit handoff to an existing agent thread.
- **MCP** — connect stdio or HTTP servers with per-connection env, headers, and encrypted tokens; BOSS also exposes its own tools (browser, computer-use, thread bus, `publish_site`) to agents that support MCP.
- **Workspace** — a tiling layout of splits and tabs, with named views you can switch between, drag-and-drop between panes, and undo:
  - **Review** — diff of changed files across six scopes (working tree, staged, vs. a branch, per-commit, the open PR, and the review conversation), with inline comments that publish to GitHub.
  - **Files** — file tree plus a viewer that shows each file as what it is: syntax-highlighted source, rendered Markdown, a live HTML preview, an image, or a PDF.
  - **Browser** — a real, fully-isolated browser (`WebContentsView` in its own session) for QA'ing local sites.
  - **Terminal** — a real PTY running your `$SHELL`.
  - **Side chat** — a second, independent thread.
- **Sites** — publish a folder of static files (or have the agent do it via the `publish_site` tool) and preview it instantly at a localhost URL in BOSS's built-in browser. Optionally deploy to Cloudflare Workers Static Assets for a public `*.workers.dev` URL.
- **Mobile** — a small PWA served over loopback (pair it with `tailscale serve`) for reviewing reports, steering threads, running automations, and managing the Lab Assistant inbox from a phone.
- **Security** — sandboxed renderer, context isolation, no node integration for remote content, a narrow typed IPC surface, and the browse view in its own hardened session. Project files reach the UI through a scheme scoped to the open project, never `file:`.

## Architecture

```
┌───────────────────────────────────────────────────────────────┐
│ Electron main (src/main)                                       │
│  • BackendManager — opencode / claude / codex / pi adapters    │
│  • OpenCodeServer — spawns `opencode serve` when that backend  │
│    is in use: random port, generated password, auto-restart    │
│  • ProjectFiles — reads the file tree and previews from disk   │
│  • WorktreeManager — per-thread git worktrees                  │
│  • SpeechManager — in-process TTS (Kokoro) + ASR (Whisper)      │
│  • BrowseManager — isolated WebContentsView for the Browser    │
│  • typed IPC (src/shared)                                      │
├───────────────────────────────────────────────────────────────┤
│ Preload (src/preload) — contextBridge exposing window.boss     │
├───────────────────────────────────────────────────────────────┤
│ Renderer (src/renderer) — React + Vite UI                     │
└───────────────────────────────────────────────────────────────┘
```

The renderer never talks to a backend directly: every request goes through
main-process IPC, so server URLs, passwords, and API tokens never reach page
content.

Reading files is deliberately *not* a backend call. The Files tab asks the main
process, which reads the disk — so the tree and previews work the same on every
backend, including ones with no file API of their own.

## Files

The **Files** tab is a plain file browser: a lazy-loading tree on the left, and
a viewer that picks a presentation from the file's type rather than showing
everything as text.

| Type | Shown as |
| --- | --- |
| Source code | Syntax-highlighted, with line numbers |
| `.md`, `.markdown`, `.mdx` | Rendered Markdown, with a **Source** toggle |
| `.html`, `.htm` | A live preview in a sandboxed frame, with a **Source** toggle |
| `.png`, `.jpg`, `.webp`, `.gif` | The image, on a checkerboard so transparency is visible |
| `.pdf` | Inline, in Electron's PDF viewer |
| Anything else binary | A note saying so, rather than mojibake |

Reads happen in the main process, against the project directory, so this works
on every backend — including ones with no file API. Paths are resolved and
re-checked against the project root, so a path climbing out of it reads nothing.

Two deliberate limits: files over 2 MB are not rendered as text (highlighting a
huge log janks the UI), and `.svg` is shown as source rather than rendered,
because an SVG is a document that can carry script.

## Reports

When an automation finishes with an assistant response, BOSS saves the complete final answer in `userData/reports.json`. The **Reports** page is the presentation layer for that result; the automation thread remains available as its provenance and working context. Reports follow the automation's run-retention setting and disappear when their run or automation is removed.

The mobile PWA exposes the same report inbox and detail through authenticated read-only requests. Because reports are local-first, the BOSS desktop still needs to be reachable directly or through the encrypted relay for a phone to retrieve them.

## Sites

Publish any folder of static files and preview it instantly at a localhost URL — no account needed. Sites survive restarts (the registry lives in `userData/sites.json`), are unlinked from any single project, and can be opened in BOSS's built-in browser tab or your default browser.

- **Publish** — the **Sites** page has a *Publish folder…* picker, or the agent can call the `publish_site` MCP tool (registered automatically when the active backend supports MCP).
- **Deploy** — for a public URL, connect a Cloudflare account with a scoped API token. BOSS uses Workers Static Assets (manifest session → base64 upload → script deploy) and verifies served content before reporting success.

### Cloudflare setup

1. Create an API token scoped to **Account → Workers Scripts → Edit**.
2. In BOSS's **Sites** page, click **Connect…** and paste the token plus your account ID.
3. Hit **Deploy** on a site. BOSS uploads the folder as static assets and gives you a `https://<name>.<subdomain>.workers.dev/` URL.

The token is stored encrypted in `userData/sites.secret` via Electron `safeStorage`.

## Voice (TTS & ASR)

BOSS ships local speech built on [`@huggingface/transformers`](https://www.npmjs.com/package/@huggingface/transformers) — no Python, no separate runtimes. On first use, the models download automatically and are cached on disk:

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
| `BOSS_MODEL_CACHE` | Directory for downloaded models (default `~/.cache/boss/models`). Point multiple apps at the same path to share weights. |

## Getting started

Prereqs: Node 20+, plus at least one backend — `opencode`, `claude`, `codex`,
or `pi` on your PATH. opencode can also be bundled (see below); the others are
connected from **Settings → Backends**, which opens a terminal for their own
login flow.

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
| `npm run eval:lab` | Run real-model Lab coding evaluations in disposable fixtures |
| `npm run eval:assistant` | Run Lab Assistant orchestration evaluations in a simulated BOSS world |

See [Lab evaluations](docs/lab-evals.md) for scenario design, model
configuration, trace reports, and adding another runtime.

### Lab Assistant GitHub monitoring

Lab Assistant observes authenticated deliveries sent to an automation's GitHub
webhook URL. Create a GitHub-webhook automation, save it, copy its URL, expose
the loopback endpoint through your tunnel, and add the URL under the repository's
**Settings → Webhooks** with JSON payloads and these events:

- **Pull request** events keep merge state and branch ownership current.
- **Workflow run** events report completed GitHub Actions failures and recoveries.

Workflow-run deliveries feed Lab Assistant even though they do not start the
automation itself. A failed run is matched to the agent thread whose worktree
branch owns it. The agent receives the failed job and step names; if ownership
is missing or ambiguous, the decision stays in the Lab Assistant inbox for you
to route from desktop or the mobile PWA. A later successful run resolves the
incident automatically.

## Configuration

| Env var | Purpose |
| --- | --- |
| `OPENCODE_BIN` | Path to the `opencode` binary (overrides PATH/bundled) |
| `BOSS_SERVER_URL` / `BOSS_SERVER_PASSWORD` | Connect to an already-running `opencode serve` instead of spawning one |
| `BOSS_OPTIONAL_CDN` | Base URL for optional component downloads (browser-core, computer-use) |
| `BOSS_DEBUG` | Verbose logging from the opencode child process |
| `BOSS_MODEL_CACHE` | Directory for speech model downloads (default `~/.cache/boss/models`) |

### Per-project files

Two optional files in a repository's root change what a thread's Git worktree
looks like when BOSS creates one. A fresh worktree has only what Git tracks, so
without these an agent starts in a checkout with no `.env` and no dependencies.

| File | Purpose |
| --- | --- |
| `.worktreeinclude` | Gitignored files to copy into a new worktree, in `.gitignore` pattern syntax. For `.env` and local config — small files Git does not carry. Matching more than 5,000 files is refused. |
| `.worktreesetup` | A shell script run once in a new worktree, for anything that has to be *done* rather than copied — `npm install`, a build, a database. |

`.worktreesetup` runs through `/bin/sh` from the worktree root, so it needs no
executable bit. It is given `BOSS_WORKTREE_PATH` and `BOSS_PROJECT_PATH`, and
is given up on after ten minutes. If it fails the worktree is kept and the
thread is told why — a failed install does not make a checkout invalid, and
discarding it would take the branch with it.

```sh
#!/bin/sh
# .worktreesetup
npm ci --silent
```

Whether a script is needed at all depends on **Settings → Worktrees → Where
worktrees go**:

| | |
| --- | --- |
| **App data directory** (default) | Outside your projects. Nothing appears in your repositories, but Node cannot walk up to the project's `node_modules`, so a worktree starts with nothing installed. |
| **Inside the project** | In `.boss/worktrees`, where Node finds the project's modules by walking up — most Node projects then need no setup script at all. BOSS adds `.boss/` to the repository's `.git/info/exclude`, which is local to that clone and never committed. |

Existing worktrees stay where they were created; the setting applies to new ones.

If you keep worktrees outside the project, sharing the dependency tree is faster
than installing again:

```sh
#!/bin/sh
# .worktreesetup — instant, but both checkouts then share one tree, so a branch
# that changes package.json will have the wrong modules.
ln -s "$BOSS_PROJECT_PATH/node_modules" node_modules
```

## Project structure

```
src/
  main/       Electron main process (backends, server lifecycle, IPC, project files,
              worktrees, automations, browse, computer-use, optional deps)
  preload/    contextBridge typed API (window.boss)
  renderer/   React UI (sidebar, chat, panel tabs)
  shared/     IPC contracts + opencode API types (shared main/renderer)
scripts/      build/utility scripts (fetch-opencode)
```

## Roadmap

- Loose "chats" not tied to a project (scratch directory)
- Export a thread to Markdown, and share a read-only snapshot
- A live context-window meter per thread (today: totals, budget caps, and a compaction notice)
- Create a PR from the app (today: BOSS reads, comments on, and submits reviews for an existing one)
