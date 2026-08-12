# R.A.L.F. Automations — Design

Status: draft for review
Date: 2026-08-11

## Summary

An automation is a saved prompt that runs on a schedule, or on demand, against a selected backend and model. All runs execute locally inside the app. Each run creates a normal R.A.L.F. thread, so the user reviews a run the same way they review any conversation. Project automations run in a fresh git worktree by default.

## Goals

- Define a schedule with a cron cadence, in a simple way.
- Run an automation at any time with one click.
- Pause and edit an automation.
- Select the backend and the model per automation.
- Review each run as a thread.
- Reuse the existing worktree, thread, and backend systems. Add little new machinery.

## Non-goals

- Cloud execution. Runs happen only while the app is open.
- A workflow engine. One automation is one prompt, not a pipeline.

## Data model

Store automations in `automations.json` under `userData`, next to `worktrees.json`. This follows the current persistence pattern in `src/main/worktree-manager.ts`.

```ts
interface Automation {
  id: string
  name: string
  prompt: string
  projectId: string            // 'global' = no project; first-class, not an edge case
  projectPath: string          // '' when global
  backendId: BackendId
  model?: BackendModelPreference
  mode: BackendModeId          // default 'auto'; runs are headless
  schedule: AutomationSchedule
  workspace: 'worktree' | 'project' | 'none'
  enabled: boolean             // false = paused; manual runs still allowed
  overlapPolicy: 'skip' | 'queue'
  maxRunMinutes: number        // default 30
  keepRuns: number             // default 50
  createdAt: number
  updatedAt: number
}

type AutomationSchedule =
  | { kind: 'cron'; expression: string }   // evaluated in local time
  | { kind: 'manual' }                     // run-now only

interface AutomationRun {
  id: string
  automationId: string
  threadId: string             // the run IS a thread
  worktreeId?: string
  trigger: 'schedule' | 'manual'
  promptSnapshot: string       // audit: what actually ran
  status: 'running' | 'success' | 'failure' | 'timeout' | 'skipped' | 'aborted'
  summary?: string             // short agent-written outcome line
  changedFiles: number
  startedAt: number
  finishedAt?: number
}
```

Store runs in `automation-runs.json`. Keep the last `keepRuns` runs per automation. When a run falls off the end, delete its thread and remove its worktree if the worktree is clean.

## Scheduling

Add an `AutomationScheduler` in the main process, owned by `BackendManager` or beside it in `src/main/index.ts`. It mirrors the existing worktree cleanup timer (`manager.ts:216`).

- Parse cron expressions with the `croner` package. It is small and has no dependencies.
- Compute `nextRunAt` per automation. Wake on a single timer set to the earliest `nextRunAt`. Recompute after every run, edit, pause, and resume.
- The UI shows the schedule as presets (hourly, daily at HH:MM, weekly, weekdays) with a raw cron field behind an "advanced" toggle. Presets write cron expressions. There is one source of truth.
- Missed runs: the app was closed at fire time. Follow Claude Desktop's behavior: on launch, fire one catch-up run per automation for the most recently missed time only, and show "missed N runs" for the rest. A per-automation `catchUp: boolean` (default true) turns this off.
- Overlap: if the previous run is still active, `skip` records a run with status `skipped`. `queue` starts the run when the previous run ends. Default `skip`.

## Execution

A run is a thread. The run pipeline reuses `BackendManager` end to end:

1. If `workspace === 'worktree'`: create a worktree via `WorktreeManager.create` with branch `ralf/auto-<slug>-<shortId>`. `.worktreeinclude` copying applies for free.
2. Create a thread in the automation's project scope with `sessionCreateInScope`, with `executionPath` set to the worktree path. Title: `<automation name> · <date>`.
3. Send the prompt with the automation's model and mode. Wrap the prompt with a short header: "You run as the scheduled automation <name>. End with one line: SUMMARY: <what you did>."
4. Track completion through the existing busy/idle signal. On idle, parse the SUMMARY line into `run.summary`, read the diff via `diffGet`, and set `changedFiles`.
5. Enforce `maxRunMinutes` with `abort(threadId)` and status `timeout`.

Headless rules:

- Runs use mode `auto` or `accept-edits`. The creation form warns when the user picks `ask` or `plan`.
- Auto-deny permission prompts and interactive questions after a short wait, then mark the run "needs attention" in the run list. A run must never block forever.

Worktree lifetime:

- Run made no changes: remove the worktree at run end.
- Run made changes: keep the worktree. The user opens the run thread, reviews the diff with the existing diff view, and continues the conversation in place ("also fix X", "commit and push this"). Normal worktree auto-cleanup applies after that.
- `workspace: 'project'` runs in the main checkout. Use it for read-only automations (reports, triage, standup digests). `none` is for global automations.

## Projects

The project link is optional. There are two first-class kinds of automation:

- **Project automations** run against a repo. They get worktrees, diffs, and branch names. The link matters because worktrees, execution paths, and thread scope all hang off `projectId` (`src/main/project-identity.ts`).
- **Projectless automations** run as global threads, like global chats. Examples: a morning digest of yesterday's Slack messages, a summary of git changes across repos, an inbox triage. They use `workspace: 'none'`, cannot create worktrees (same rule as `WorktreeManager.create`), and rely on the backend's tools and MCP connections instead of a checkout.

The UI presents the project field as optional. Creating an automation from inside a project pre-fills that project. Creating one from the global Automations section leaves it empty. Internally, store `projectId: 'global'` — the same sentinel global chats already use — so no code path needs a new null case.

## UI

- Sidebar: an "Automations" section per project, plus global automations, mirroring the global-chats pattern.
- Automation page: config (name, prompt, backend, model, mode, schedule, workspace) on top; run history below. Each run row: status dot, trigger, summary line, changed-file count, duration. Click a row to open the run thread in the normal `ChatView`.
- Controls: Run now (always available, even when paused), Stop, Pause/Resume, Edit, Delete. Delete asks before it removes run threads and worktrees.
- **Stop.** A running run always shows a Stop button — on the automation page, in the run list, and in the sidebar next to the automation's activity indicator. Stop calls the existing `abort(threadId)` and sets status `aborted`. Pause only prevents future fires; it never kills an in-flight run silently — pausing while a run is active asks "also stop the current run?". Keep the aborted run's worktree so the user can inspect what the agent did before the stop.
- Notifications: a native OS notification on `failure`, `timeout`, and "needs attention". Notify on success only when the run changed files. Per-automation toggle.

## Later, if wanted

- A "create PR from this run" button on runs with changes.
- A `ralf_automations_create` thread-bus tool, so an agent can set up an automation from a conversation.
- Export/import of an automation as JSON.
- Run-to-run memory (pass the previous run's summary into the next prompt).

## Background execution

Local scheduled tasks in both Codex and Claude Desktop require the app to be running. Neither installs a daemon. R.A.L.F. should match that model — it is proven, and it avoids a launchd/systemd installer and a second headless process. Soften the constraint in three layers:

1. **v1 — app open.** The in-app scheduler fires while any window exists. Catch-up on launch covers gaps.
2. **v1 — tray mode.** A setting: "Keep R.A.L.F. running in the menu bar when all windows close." Closing the window then hides it instead of quitting (`window.hide()` + a `Tray`), so schedules keep firing. This is the standard Electron pattern (Slack, Discord).
3. **Later — launch at login.** `app.setLoginItemSettings({ openAtLogin: true, openAsHidden: true })` so the scheduler is alive after a reboot without the user thinking about it.

A true daemon (runs with zero app process) stays out of scope. If a user needs that, OS cron plus the backend's own CLI is the honest answer.

## Open questions

1. `queue` overlap policy: worth building in v1, or ship `skip` only?
2. Should the automation prompt support small template variables (`{{date}}`, `{{branch}}`)?
3. Should tray mode be on by default, or opt-in? Opt-in surprises nobody; on-by-default makes schedules reliable.
