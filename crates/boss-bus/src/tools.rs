//! The bus tool catalogue: names, descriptions, and input schemas, ported
//! verbatim from `src/shared/thread-bus.ts`, `src/shared/qa.ts`, and
//! `mcpTools()` in `src/main/thread-bus.ts`.
//!
//! What an agent is told about a tool decides whether it ever reaches for
//! one, so the wording lives here once and every engine reads it from here.

use boss_core::{BusTool, EngineId};
use serde_json::{json, Value};

/// Told to the agent once, alongside the tool list, as MCP `instructions`.
pub const QA_GUIDANCE: &str = "You can see and operate what you build: boss_browser_* drives web pages open on this machine, and boss_computer drives native applications. \
Reach for them whenever a claim about what something looks like or does would otherwise be a guess. \
That includes checking your own work after a change, answering a question about a page or an app, and reproducing a bug the user reports. \
Looking is cheap and does not need permission: listing tabs, reading a page, and capturing window or desktop state are always available. \
Computer screenshots used for inspection stay out of the transcript by default; set showInTranscript only when the user asked to see that specific screenshot. \
Do not describe a page you have not read or a screen you have not seen. \
Acting on a page or an app — navigating, clicking, typing — needs Automatic QA turned on, and the tool says so if it is not.";

/// Room shapes accepted by `boss_rooms_open`, in the order the TS lists them.
pub const ROOM_SHAPES: [&str; 3] = ["direct", "reviewed", "full"];

/// Read-only operations of the embedded CUA driver exposed through `boss_computer`.
pub const COMPUTER_USE_INSPECTION_OPERATIONS: [&str; 9] = [
    "list_apps",
    "list_windows",
    "get_window_state",
    "get_accessibility_tree",
    "get_desktop_state",
    "get_screen_size",
    "get_cursor_position",
    "zoom",
    "verify_state",
];

/// Reversible native-app actions of the CUA driver; each is gated by Automatic QA.
pub const COMPUTER_USE_ACTION_OPERATIONS: [&str; 14] = [
    "launch_app",
    "bring_to_front",
    "set_window_frame",
    "click",
    "double_click",
    "right_click",
    "drag",
    "type_text",
    "press_key",
    "hotkey",
    "set_value",
    "scroll",
    "move_cursor",
    "invoke_menu",
];

/// Tools whose `tools/list` entry carries `annotations.readOnlyHint: true`.
const READ_ONLY_TOOLS: [&str; 7] = [
    "boss_threads_list",
    "boss_threads_read",
    "boss_workflow_list",
    "boss_workflow_runs",
    "boss_browser_tabs",
    "boss_browser_snapshot",
    "boss_browser_screenshot",
];

/// Whether a bus tool only observes, so an MCP client may skip its confirmation.
pub fn is_read_only(name: &str) -> bool {
    READ_ONLY_TOOLS.contains(&name)
}

mod text {
    pub const THREAD_LIST: &str = "Find the other threads working in this project on the same backend. Start here when you need to know who else is working, or to get a thread id for reading or sending.";
    pub const THREAD_READ: &str = "Catch up on what another thread has been doing, by reading its recent messages. Use it before asking a question the transcript already answers.";
    pub const THREAD_SEND: &str = "Say something to another thread — a question, a piece of context it lacks, or a task. It arrives durably, and a busy thread gets it when it finishes.";
    pub const THREAD_REPLY: &str = "Answer a message another thread sent this one. Only messages addressed here can be replied to.";
    pub const SPAWN_WORKTREE: &str = "Hand a piece of work to a new thread with its own Git worktree, in this project or another project already open here, so it proceeds independently of this one. Call it once per piece of work: asked to take on several items, spawn a thread for each rather than one thread for all of them. Omit project to use this thread's project; otherwise pass the target project's absolute path or unique folder name. Omit agent to reuse this thread's agent; set it only when the task should run on a different configured agent. Each new thread starts from the instruction alone, so say what to do and why, not \"the second item above\".";
    pub const OPEN_ROOM: &str = "Start a room: a thread that runs a job with the agents the user chose. Use this whenever the user agrees to have work done, rather than doing it yourself. The shape says which agents the job gets: \"direct\" is one agent that builds; \"reviewed\" is a builder and then a fresh reviewer; \"full\" researches and plans first. Ask the user which shape before calling; never choose for them. The first agent starts working immediately, so state the whole job — it cannot see this conversation.";
    pub const OPEN_ROOM_INSTRUCTION: &str = "The job, stated in full. The agents cannot see this conversation, so say what to do and why, not \"the thing we discussed\".";
    pub const OPEN_ROOM_SHAPE: &str = "Which agents the job gets. \"direct\" builds; \"reviewed\" builds then reviews; \"full\" researches, plans, builds, then reviews. The user chooses this.";
    pub const OPEN_ROOM_PROJECT: &str = "Project for the job, as an absolute path or unique folder name. Omit to use the current project.";
    pub const SPAWN_WORKTREE_INSTRUCTION: &str = "What the new thread should do, stated in full. It cannot see this conversation.";
    pub const SPAWN_WORKTREE_AGENT: &str = "Agent backend for the child thread. Omit to reuse the current thread's agent.";
    pub const SPAWN_WORKTREE_PROJECT: &str = "Target project already open here, as an absolute path or unique folder name. Omit to use the current project.";
    pub const LEAVE_WORKTREE: &str = "Come off this thread's worktree and back to the project directory, once its work is committed or merged. Git refuses while anything is uncommitted or untracked, so nothing is lost by trying; the branch is kept either way.";
    pub const USE_WORKTREE: &str = "Move this conversation onto its own Git worktree, so your changes are isolated from the project directory and from other threads. Use it when a conversation turns from working something out to changing files, and the user has not already put you on one. It keeps this conversation — nothing is handed off. It returns the new path: your working directory changes from your next message, not during this one, so do not start editing files in the new checkout until then. Fails harmlessly if this thread already has a worktree.";
    pub const CREATE_CHANGE_REQUEST: &str = "Publish the committed branch and open a pull request (GitHub) or merge request (GitLab) for this thread's checkout. Use it instead of running `gh pr create` or `glab mr create` yourself: this app uses its host credentials and GitHub publishing works even when the agent shell has no SSH key. Commit first; this refuses uncommitted files. Omit title and body to fill both from the commits.";
    pub const CREATE_CHANGE_REQUEST_TITLE: &str = "Title for the request. Omit together with body to fill both from the commits.";
    pub const CREATE_CHANGE_REQUEST_BODY: &str = "Description for the request, as Markdown. Omit together with title to fill both from the commits.";
    pub const CREATE_CHANGE_REQUEST_BASE: &str = "Branch to merge into. Omit to use the repository default.";
    pub const CREATE_CHANGE_REQUEST_DRAFT: &str = "Open it as a draft.";

    pub const PRESENCE_SET: &str = "Say where the user is, which sets the bar for interrupting them. Set it when they tell you: \"I am at my desk\", \"heading out\", \"in a meeting\", \"back now\". Work keeps running whatever it is set to. Lowering the bar returns what was held while it was higher, so tell them what waited rather than letting them find out by accident.";
    pub const PRESENCE_VALUE: &str = "\"desk\" while they are at the machine, and everything reaches them. \"away\" for a phone: only what needs a decision, a review, or a failure. \"quiet\" for silence with no exceptions at all — use it when they ask not to be disturbed, and never assume it.";

    pub const NOTES_RECORD: &str = "Record what survives you on this job: what was agreed, what was decided and why, and what actually changed. Write it before you finish, and update it whenever a decision is made — an agent brought in later reads these notes and nothing else, so anything missing here is lost. Keep each entry one plain sentence. Do not record what you did step by step; record what someone picking this up would need to know.";
    pub const NOTES_AGREED: &str = "What the user and the agents agreed to do. Replaces the current list.";
    pub const NOTES_DECIDED: &str = "Choices made along the way, each a plain sentence saying what and why. Replaces the current list.";
    pub const NOTES_CHANGED: &str = "What actually changed, in plain words. Replaces the current list.";

    pub const REPORT_CREATE: &str = "Create a durable report artifact when the user asks for a report, brief, dashboard narrative, analysis, or other result worth keeping outside the chat. The body supports Markdown. Return the report id so you can refine it later.";
    pub const REPORT_UPDATE: &str = "Update a report artifact previously created by this thread. Pass only the fields that should change; pass an empty summary to remove it.";
    pub const REPORT_TITLE: &str = "Short human-facing title for the report.";
    pub const REPORT_SUMMARY: &str = "Optional one- or two-sentence description shown in the report inbox.";
    pub const REPORT_BODY: &str = "Complete report content in Markdown.";
    pub const REPORT_ID: &str = "Report id returned by boss_reports_create.";

    pub const WORKFLOW_LIST: &str = "List the durable workflows for this project (and global ones): id, name, triggers, whether the user has enabled them, and the latest run. Start here before creating or running one.";
    pub const WORKFLOW_CREATE: &str = "Create a durable workflow: a small JavaScript script whose steps are journaled and replayed, so a run survives app restarts mid-sequence and resumes exactly where it left off. Use one whenever work must outlive this conversation — watching CI or a PR, a recurring check, a multi-agent pipeline. The script runs in a sandbox with ONLY these async primitives: \
agent(prompt, {backendId?, model?: {providerID, modelID}, mode?, workspace?: \"worktree\"|\"project\"|\"none\", maxMinutes?, title?}) runs an unattended agent conversation, resolving to {status: \"success\"|\"failure\"|\"timeout\"|\"aborted\", summary, text, changedFiles, threadId} — branch on status to escalate to a stronger backend; \
judge(input, options[], {rubric?}) classifies with a forced-verdict model call, resolving to {verdict, reason} — use it for every notify-or-not or is-this-real decision instead of guessing inline; \
waitFor({type, filters?}, {timeoutMs?}) suspends durably (days are fine, restarts are fine) until a matching event arrives, resolving to the event or null on timeout — event types include cron.fired, github.push, github.pull_request, github.pull_request_review, github.pull_request_review_comment, github.issue_comment, github.workflow_run, github.check_suite, with flat data fields (repo, branch, prNumber, author, conclusion, …) matched by filters; \
sleep(ms); notify(body, {title?, attention?}) pings the user (budgeted, keep it rare); ask(question, choices?) suspends until the user answers and resolves to their text; \
state.get(key) / state.set(key, value) persist across runs of this workflow (alert history, seen ids); log(message) journals a progress note; \
pr(agentOutcome, {title?, body?, baseBranch?, draft?}) opens a change request from that agent step's checkout. \
The triggering event is in scope as `event`. Determinism rules: Date.now(), argless new Date(), and Math.random() throw — take time from event.at and randomness from journaled inputs. return a JSON-safe value as the run result. \
Unless the user has set workflow approval to auto, new workflows start disabled: cron/event triggers stay dormant until the user enables them in the Workflows page. boss_workflow_run executes one immediately regardless, under this conversation's supervision.";
    pub const WORKFLOW_UPDATE: &str = "Edit a workflow this project owns (script, name, description, triggers, overlap). Under ask-mode approval an edited workflow is disabled again until the user re-enables it — editing is how you iterate, enabling is how the user approves. Runs already in flight replay against the new script: steps before the first changed call keep their results.";
    pub const WORKFLOW_RUN: &str = "Run a workflow once, now, regardless of whether it is enabled. Returns the run id, and the finished run's result is delivered back to this conversation as a message — no need to poll. Use this to test a workflow you just created.";
    pub const WORKFLOW_RUNS: &str = "Recent runs of a workflow (or all workflows in this project): status, error, result, and each journaled step with its label and state. A run with status \"waiting\" is parked on waitFor/ask — that is normal, not stuck.";
    pub const WORKFLOW_NAME: &str = "Short human-facing name, e.g. \"Datadog alert watcher\".";
    pub const WORKFLOW_DESCRIPTION: &str = "One or two sentences on what it watches and when it pings the user.";
    pub const WORKFLOW_SCRIPT: &str = "The JavaScript script body. Only the documented primitives exist — no require, fetch, fs, or timers.";
    pub const WORKFLOW_CRON: &str = "Five-field cron expression (local time) to run on a schedule, e.g. \"*/20 * * * *\". Omit for event-only or manual workflows.";
    pub const WORKFLOW_EVENT_TYPE: &str = "Event type that triggers a run, e.g. \"github.pull_request\". Supports a trailing wildcard (\"github.*\"). Omit for cron-only or manual workflows.";
    pub const WORKFLOW_EVENT_FILTERS: &str = "Equality filters on the trigger event's data fields, e.g. {\"repo\": \"acme/api\", \"branch\": \"main\"}.";
    pub const WORKFLOW_ID: &str = "Workflow id from boss_workflow_list or boss_workflow_create.";
    pub const WORKFLOW_LIMIT: &str = "How many recent runs to return (1-20, default 5).";

    pub const BROWSER_TABS: &str = "Find out which web pages are open, and get the tabId every other browser tool needs. Start here whenever you want to look at a page. An empty list means the user has no browser open, so ask them to open one rather than assuming the page is unreachable.";
    pub const BROWSER_NAVIGATE: &str = "Point an open browser tab at a URL, to reach a page that is not on screen yet. Needs Automatic QA. Snapshot afterwards to see what loaded.";
    pub const BROWSER_SNAPSHOT: &str = "Read what a page actually says and what can be clicked on it. Use this to answer any question about a page, to check a change you made, or to find the element you are about to click or type into. Always available, no permission needed. Element refs stay valid until the page changes, so snapshot again after anything that reloads or navigates.";
    pub const BROWSER_SCREENSHOT: &str = "See how a page looks, rather than what it says. Use this for anything visual — layout, spacing, colour, whether something is cut off or overlapping — where the text alone would not tell you. Always available, no permission needed. For reading content or finding elements, boss_browser_snapshot is the better tool.";
    pub const BROWSER_CLICK: &str = "Click something on a page, to walk through a flow or reach a state you cannot get to by looking. Takes a ref from boss_browser_snapshot, so snapshot first. Needs Automatic QA. Snapshot again afterwards: the click is not done until you have seen what it did.";
    pub const BROWSER_TYPE: &str = "Put text into a field on a page, to fill a form or search for something. Replaces what is there rather than appending. Takes a ref from boss_browser_snapshot, so snapshot first. Needs Automatic QA. Set submit to press Enter afterwards.";
    pub const COMPUTER: &str = "See and operate native applications on this machine — anything outside a web page, including this app itself. The arguments object is passed to the OSS CUA Driver after the click action names are safely canonicalized. Looking is always available: list_apps and list_windows find what is running; get_window_state and get_desktop_state return state plus a screenshot; zoom crops a region; verify_state checks bounded postconditions. Inspection screenshots are returned to you but hidden from the transcript by default; set showInTranscript only when the user asked to see that specific screenshot. Acting needs Automatic QA. Prefer a current element_token from get_window_state over coordinates. Match the element actions in the returned tree: click action \"showmenu\" is accepted and translated to the driver action \"show_menu\"; click defaults to press. For a window action, x/y are local pixels from its get_window_state screenshot. For a desktop action, x/y are absolute pixels from get_desktop_state; never apply display scale or window offsets yourself. Follow the delivery ladder background action, fresh state, pixel action, fresh state, then delivery_mode \"foreground\". Use bring_to_front when a transient menu or focus-proxy surface must remain foreground across multiple calls. Look again after every action — an action you have not verified is not finished.";
}

fn tool(name: &str, description: &str, input_schema: Value) -> BusTool {
    BusTool { name: name.to_owned(), description: description.to_owned(), input_schema }
}

fn empty_object() -> Value {
    json!({ "type": "object", "properties": {}, "additionalProperties": false })
}

/// Every bus tool BOSS can offer, in the order `mcpTools()` listed them.
/// The handler decides which subset a given caller sees.
pub fn tool_definitions() -> Vec<BusTool> {
    let thread_id = json!({ "type": "string", "description": "Thread id returned by boss_threads_list." });
    let message = json!({ "type": "string", "description": "Message to send to the other agent." });
    let engines: Vec<&str> = EngineId::ALL.iter().map(|e| e.as_str()).collect();
    let mut operations: Vec<&str> = COMPUTER_USE_INSPECTION_OPERATIONS.to_vec();
    operations.extend(COMPUTER_USE_ACTION_OPERATIONS);

    vec![
        tool("boss_threads_list", text::THREAD_LIST, empty_object()),
        tool(
            "boss_threads_read",
            text::THREAD_READ,
            json!({
                "type": "object",
                "properties": { "threadId": thread_id, "limit": { "type": "integer", "minimum": 1, "maximum": 20, "default": 8 } },
                "required": ["threadId"],
                "additionalProperties": false
            }),
        ),
        tool(
            "boss_threads_send",
            text::THREAD_SEND,
            json!({
                "type": "object",
                "properties": {
                    "threadId": thread_id,
                    "message": message,
                    "expectsReply": { "type": "boolean", "default": true },
                    "maxTurns": { "type": "integer", "minimum": 1, "maximum": 8, "default": 4 }
                },
                "required": ["threadId", "message"],
                "additionalProperties": false
            }),
        ),
        tool(
            "boss_threads_reply",
            text::THREAD_REPLY,
            json!({
                "type": "object",
                "properties": {
                    "messageId": { "type": "string", "description": "Message id from the incoming thread message." },
                    "message": message,
                    "expectsReply": { "type": "boolean", "default": false }
                },
                "required": ["messageId", "message"],
                "additionalProperties": false
            }),
        ),
        tool(
            "boss_rooms_open",
            text::OPEN_ROOM,
            json!({
                "type": "object",
                "properties": {
                    "instruction": { "type": "string", "description": text::OPEN_ROOM_INSTRUCTION },
                    "shape": { "type": "string", "enum": ROOM_SHAPES, "description": text::OPEN_ROOM_SHAPE },
                    "project": { "type": "string", "description": text::OPEN_ROOM_PROJECT }
                },
                "required": ["instruction", "shape"],
                "additionalProperties": false
            }),
        ),
        tool(
            "boss_threads_spawn_worktree",
            text::SPAWN_WORKTREE,
            json!({
                "type": "object",
                "properties": {
                    "instruction": { "type": "string", "description": text::SPAWN_WORKTREE_INSTRUCTION },
                    "project": { "type": "string", "description": text::SPAWN_WORKTREE_PROJECT },
                    "agent": { "type": "string", "enum": engines, "description": text::SPAWN_WORKTREE_AGENT }
                },
                "required": ["instruction"],
                "additionalProperties": false
            }),
        ),
        tool("boss_threads_use_worktree", text::USE_WORKTREE, empty_object()),
        tool("boss_threads_leave_worktree", text::LEAVE_WORKTREE, empty_object()),
        tool(
            "boss_git_create_change_request",
            text::CREATE_CHANGE_REQUEST,
            json!({
                "type": "object",
                "properties": {
                    "title": { "type": "string", "description": text::CREATE_CHANGE_REQUEST_TITLE },
                    "body": { "type": "string", "description": text::CREATE_CHANGE_REQUEST_BODY },
                    "baseBranch": { "type": "string", "description": text::CREATE_CHANGE_REQUEST_BASE },
                    "draft": { "type": "boolean", "description": text::CREATE_CHANGE_REQUEST_DRAFT }
                },
                "additionalProperties": false
            }),
        ),
        tool(
            "boss_notes_record",
            text::NOTES_RECORD,
            json!({
                "type": "object",
                "properties": {
                    "agreed": { "type": "array", "items": { "type": "string" }, "description": text::NOTES_AGREED },
                    "decided": { "type": "array", "items": { "type": "string" }, "description": text::NOTES_DECIDED },
                    "changed": { "type": "array", "items": { "type": "string" }, "description": text::NOTES_CHANGED }
                },
                "additionalProperties": false
            }),
        ),
        tool(
            "boss_presence_set",
            text::PRESENCE_SET,
            json!({
                "type": "object",
                "properties": {
                    "presence": { "type": "string", "enum": ["desk", "away", "quiet"], "description": text::PRESENCE_VALUE }
                },
                "required": ["presence"],
                "additionalProperties": false
            }),
        ),
        tool(
            "boss_reports_create",
            text::REPORT_CREATE,
            json!({
                "type": "object",
                "properties": {
                    "title": { "type": "string", "description": text::REPORT_TITLE },
                    "summary": { "type": "string", "description": text::REPORT_SUMMARY },
                    "body": { "type": "string", "description": text::REPORT_BODY }
                },
                "required": ["title", "body"],
                "additionalProperties": false
            }),
        ),
        tool(
            "boss_reports_update",
            text::REPORT_UPDATE,
            json!({
                "type": "object",
                "properties": {
                    "reportId": { "type": "string", "description": text::REPORT_ID },
                    "title": { "type": "string", "description": text::REPORT_TITLE },
                    "summary": { "type": "string", "description": text::REPORT_SUMMARY },
                    "body": { "type": "string", "description": text::REPORT_BODY }
                },
                "required": ["reportId"],
                "additionalProperties": false
            }),
        ),
        tool("boss_workflow_list", text::WORKFLOW_LIST, empty_object()),
        tool(
            "boss_workflow_create",
            text::WORKFLOW_CREATE,
            json!({
                "type": "object",
                "properties": {
                    "name": { "type": "string", "description": text::WORKFLOW_NAME },
                    "description": { "type": "string", "description": text::WORKFLOW_DESCRIPTION },
                    "script": { "type": "string", "description": text::WORKFLOW_SCRIPT },
                    "cron": { "type": "string", "description": text::WORKFLOW_CRON },
                    "eventType": { "type": "string", "description": text::WORKFLOW_EVENT_TYPE },
                    "eventFilters": { "type": "object", "description": text::WORKFLOW_EVENT_FILTERS }
                },
                "required": ["name", "script"],
                "additionalProperties": false
            }),
        ),
        tool(
            "boss_workflow_update",
            text::WORKFLOW_UPDATE,
            json!({
                "type": "object",
                "properties": {
                    "workflowId": { "type": "string", "description": text::WORKFLOW_ID },
                    "name": { "type": "string", "description": text::WORKFLOW_NAME },
                    "description": { "type": "string", "description": text::WORKFLOW_DESCRIPTION },
                    "script": { "type": "string", "description": text::WORKFLOW_SCRIPT },
                    "cron": { "type": "string", "description": text::WORKFLOW_CRON },
                    "eventType": { "type": "string", "description": text::WORKFLOW_EVENT_TYPE },
                    "eventFilters": { "type": "object", "description": text::WORKFLOW_EVENT_FILTERS }
                },
                "required": ["workflowId"],
                "additionalProperties": false
            }),
        ),
        tool(
            "boss_workflow_run",
            text::WORKFLOW_RUN,
            json!({
                "type": "object",
                "properties": { "workflowId": { "type": "string", "description": text::WORKFLOW_ID } },
                "required": ["workflowId"],
                "additionalProperties": false
            }),
        ),
        tool(
            "boss_workflow_runs",
            text::WORKFLOW_RUNS,
            json!({
                "type": "object",
                "properties": {
                    "workflowId": { "type": "string", "description": text::WORKFLOW_ID },
                    "limit": { "type": "integer", "minimum": 1, "maximum": 20, "default": 5, "description": text::WORKFLOW_LIMIT }
                },
                "additionalProperties": false
            }),
        ),
        tool("boss_browser_tabs", text::BROWSER_TABS, empty_object()),
        tool(
            "boss_browser_navigate",
            text::BROWSER_NAVIGATE,
            json!({
                "type": "object",
                "properties": { "tabId": { "type": "string" }, "url": { "type": "string" } },
                "required": ["tabId", "url"],
                "additionalProperties": false
            }),
        ),
        tool(
            "boss_browser_snapshot",
            text::BROWSER_SNAPSHOT,
            json!({
                "type": "object",
                "properties": { "tabId": { "type": "string" } },
                "required": ["tabId"],
                "additionalProperties": false
            }),
        ),
        tool(
            "boss_browser_screenshot",
            text::BROWSER_SCREENSHOT,
            json!({
                "type": "object",
                "properties": { "tabId": { "type": "string" } },
                "required": ["tabId"],
                "additionalProperties": false
            }),
        ),
        tool(
            "boss_browser_click",
            text::BROWSER_CLICK,
            json!({
                "type": "object",
                "properties": { "tabId": { "type": "string" }, "ref": { "type": "string" } },
                "required": ["tabId", "ref"],
                "additionalProperties": false
            }),
        ),
        tool(
            "boss_browser_type",
            text::BROWSER_TYPE,
            json!({
                "type": "object",
                "properties": {
                    "tabId": { "type": "string" },
                    "ref": { "type": "string" },
                    "text": { "type": "string" },
                    "submit": { "type": "boolean", "default": false }
                },
                "required": ["tabId", "ref", "text"],
                "additionalProperties": false
            }),
        ),
        tool(
            "boss_computer",
            text::COMPUTER,
            json!({
                "type": "object",
                "properties": {
                    "operation": { "type": "string", "enum": operations },
                    "arguments": {
                        "type": "object",
                        "description": "Arguments for the selected CUA Driver operation.",
                        "properties": {
                            "pid": { "type": "integer", "description": "Target process ID for a window-scoped operation." },
                            "window_id": { "type": "integer", "description": "Target window ID from list_windows/get_window_state." },
                            "element_token": { "type": "string", "description": "Preferred opaque element handle from the latest get_window_state." },
                            "x": { "type": "number", "description": "Screenshot-pixel X: window-local for get_window_state, desktop-absolute for get_desktop_state." },
                            "y": { "type": "number", "description": "Screenshot-pixel Y in the same coordinate space as x." },
                            "action": {
                                "type": "string",
                                "description": "For click: press, show_menu (or tree spelling showmenu), pick, confirm, cancel, or open."
                            },
                            "delivery_mode": {
                                "type": "string",
                                "enum": ["background", "foreground"],
                                "description": "Best-effort background by default; foreground briefly focuses the exact target window."
                            },
                            "scope": {
                                "type": "string",
                                "enum": ["window", "desktop"],
                                "description": "Pixel coordinate scope. Desktop pixels require get_desktop_state."
                            }
                        },
                        "additionalProperties": true
                    },
                    "showInTranscript": {
                        "type": "boolean",
                        "default": false,
                        "description": "Show this call's screenshot to the user. Leave false for internal inspection."
                    }
                },
                "required": ["operation"],
                "additionalProperties": false
            }),
        ),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn catalogue_has_every_expected_tool_once() {
        let tools = tool_definitions();
        let names: Vec<&str> = tools.iter().map(|t| t.name.as_str()).collect();
        let unique: HashSet<&str> = names.iter().copied().collect();
        assert_eq!(names.len(), unique.len(), "duplicate tool names");
        for expected in [
            "boss_threads_list",
            "boss_threads_read",
            "boss_threads_send",
            "boss_threads_reply",
            "boss_threads_spawn_worktree",
            "boss_threads_use_worktree",
            "boss_threads_leave_worktree",
            "boss_rooms_open",
            "boss_notes_record",
            "boss_presence_set",
            "boss_workflow_create",
            "boss_workflow_update",
            "boss_workflow_list",
            "boss_workflow_run",
            "boss_workflow_runs",
            "boss_reports_create",
            "boss_reports_update",
            "boss_browser_navigate",
            "boss_browser_click",
            "boss_browser_type",
            "boss_browser_snapshot",
            "boss_browser_screenshot",
            "boss_browser_tabs",
            "boss_computer",
            "boss_git_create_change_request",
        ] {
            assert!(unique.contains(expected), "missing {expected}");
        }
        assert_eq!(tools.len(), 25);
    }

    #[test]
    fn no_description_names_the_app() {
        // The app and the standing assistant share the name BOSS. A tool that
        // says "another BOSS thread" tells the assistant that BOSS is the
        // system around it, so asked "are you BOSS?" it answered no.
        for tool in tool_definitions() {
            for word in tool.description.split(|c: char| !c.is_alphanumeric()) {
                assert_ne!(word, "BOSS", "{} names the app", tool.name);
            }
        }
    }

    #[test]
    fn schemas_are_objects_with_valid_required_lists() {
        for tool in tool_definitions() {
            let schema = &tool.input_schema;
            assert_eq!(schema["type"], "object", "{}", tool.name);
            let properties = schema["properties"].as_object().unwrap_or_else(|| panic!("{} has properties", tool.name));
            if let Some(required) = schema.get("required") {
                for key in required.as_array().unwrap() {
                    assert!(properties.contains_key(key.as_str().unwrap()), "{} requires unknown {key}", tool.name);
                }
            }
        }
    }

    #[test]
    fn spawn_worktree_offers_every_engine_and_no_lab() {
        let tools = tool_definitions();
        let spawn = tools.iter().find(|t| t.name == "boss_threads_spawn_worktree").unwrap();
        let agents: Vec<&str> =
            spawn.input_schema["properties"]["agent"]["enum"].as_array().unwrap().iter().map(|v| v.as_str().unwrap()).collect();
        assert_eq!(agents, vec!["claude", "codex", "opencode", "pi"]);
    }

    #[test]
    fn computer_operations_cover_inspection_and_actions() {
        let tools = tool_definitions();
        let computer = tools.iter().find(|t| t.name == "boss_computer").unwrap();
        let ops = computer.input_schema["properties"]["operation"]["enum"].as_array().unwrap();
        assert_eq!(ops.len(), 23);
        assert_eq!(ops[0], "list_apps");
        assert_eq!(ops[22], "invoke_menu");
    }

    #[test]
    fn read_only_flags_match_the_ts_annotations() {
        assert!(is_read_only("boss_threads_list"));
        assert!(is_read_only("boss_browser_screenshot"));
        assert!(!is_read_only("boss_threads_send"));
        assert!(!is_read_only("boss_computer"));
        assert!(!is_read_only("mcp_x_y"));
    }
}
