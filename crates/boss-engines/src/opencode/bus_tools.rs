//! Text the generated bus plugins tell the agent: tool descriptions and the
//! computer-use operation list.
//!
//! Ported from `src/shared/thread-bus.ts` and `src/shared/qa.ts`. Both the
//! opencode plugin files and the pi extension interpolate these, so one copy
//! lives here and `crate::pi` reads it from this module.

/// Descriptions for the `boss_threads_*`, `boss_rooms_open`, and git tools.
pub struct ThreadToolDescriptions;

impl ThreadToolDescriptions {
    /// `boss_threads_list`.
    pub const LIST: &'static str = "Find the other threads working in this project on the same backend. Start here when you need to know who else is working, or to get a thread id for reading or sending.";
    /// `boss_threads_read`.
    pub const READ: &'static str = "Catch up on what another thread has been doing, by reading its recent messages. Use it before asking a question the transcript already answers.";
    /// `boss_threads_send`.
    pub const SEND: &'static str = "Say something to another thread — a question, a piece of context it lacks, or a task. It arrives durably, and a busy thread gets it when it finishes.";
    /// `boss_threads_reply`.
    pub const REPLY: &'static str = "Answer a message another thread sent this one. Only messages addressed here can be replied to.";
    /// `boss_threads_spawn_worktree`.
    pub const SPAWN_WORKTREE: &'static str = "Hand a piece of work to a new thread with its own Git worktree, in this project or another project already open here, so it proceeds independently of this one. Call it once per piece of work: asked to take on several items, spawn a thread for each rather than one thread for all of them. Omit project to use this thread's project; otherwise pass the target project's absolute path or unique folder name. Omit agent to reuse this thread's agent; set it only when the task should run on a different configured agent. Each new thread starts from the instruction alone, so say what to do and why, not \"the second item above\".";
    /// `boss_rooms_open`.
    pub const OPEN_ROOM: &'static str = "Start a room: a thread that runs a job with the agents the user chose. Use this whenever the user agrees to have work done, rather than doing it yourself. The shape says which agents the job gets: \"direct\" is one agent that builds; \"reviewed\" is a builder and then a fresh reviewer; \"full\" researches and plans first. Ask the user which shape before calling; never choose for them. The first agent starts working immediately, so state the whole job — it cannot see this conversation.";
    /// `boss_rooms_open.instruction`.
    pub const OPEN_ROOM_INSTRUCTION: &'static str = "The job, stated in full. The agents cannot see this conversation, so say what to do and why, not \"the thing we discussed\".";
    /// `boss_rooms_open.shape`.
    pub const OPEN_ROOM_SHAPE: &'static str = "Which agents the job gets. \"direct\" builds; \"reviewed\" builds then reviews; \"full\" researches, plans, builds, then reviews. The user chooses this.";
    /// `boss_rooms_open.project`.
    pub const OPEN_ROOM_PROJECT: &'static str = "Project for the job, as an absolute path or unique folder name. Omit to use the current project.";
    /// `boss_threads_spawn_worktree.instruction`.
    pub const SPAWN_WORKTREE_INSTRUCTION: &'static str = "What the new thread should do, stated in full. It cannot see this conversation.";
    /// `boss_threads_spawn_worktree.agent`.
    pub const SPAWN_WORKTREE_AGENT: &'static str = "Agent backend for the child thread. Omit to reuse the current thread's agent.";
    /// `boss_threads_spawn_worktree.project`.
    pub const SPAWN_WORKTREE_PROJECT: &'static str = "Target project already open here, as an absolute path or unique folder name. Omit to use the current project.";
    /// `boss_threads_leave_worktree`.
    pub const LEAVE_WORKTREE: &'static str = "Come off this thread's worktree and back to the project directory, once its work is committed or merged. Git refuses while anything is uncommitted or untracked, so nothing is lost by trying; the branch is kept either way.";
    /// `boss_threads_use_worktree`.
    pub const USE_WORKTREE: &'static str = "Move this conversation onto its own Git worktree, so your changes are isolated from the project directory and from other threads. Use it when a conversation turns from working something out to changing files, and the user has not already put you on one. It keeps this conversation — nothing is handed off. It returns the new path: your working directory changes from your next message, not during this one, so do not start editing files in the new checkout until then. Fails harmlessly if this thread already has a worktree.";
    /// `boss_git_create_change_request`.
    pub const CREATE_CHANGE_REQUEST: &'static str = "Publish the committed branch and open a pull request (GitHub) or merge request (GitLab) for this thread's checkout. Use it instead of running `gh pr create` or `glab mr create` yourself: this app uses its host credentials and GitHub publishing works even when the agent shell has no SSH key. Commit first; this refuses uncommitted files. Omit title and body to fill both from the commits.";
    /// `boss_git_create_change_request.title`.
    pub const CREATE_CHANGE_REQUEST_TITLE: &'static str = "Title for the request. Omit together with body to fill both from the commits.";
    /// `boss_git_create_change_request.body`.
    pub const CREATE_CHANGE_REQUEST_BODY: &'static str = "Description for the request, as Markdown. Omit together with title to fill both from the commits.";
    /// `boss_git_create_change_request.baseBranch`.
    pub const CREATE_CHANGE_REQUEST_BASE: &'static str = "Branch to merge into. Omit to use the repository default.";
    /// `boss_git_create_change_request.draft`.
    pub const CREATE_CHANGE_REQUEST_DRAFT: &'static str = "Open it as a draft.";
}

/// Descriptions for the `boss_reports_*` tools.
pub struct ReportToolDescriptions;

impl ReportToolDescriptions {
    /// `boss_reports_create`.
    pub const CREATE: &'static str = "Create a durable report artifact when the user asks for a report, brief, dashboard narrative, analysis, or other result worth keeping outside the chat. The body supports Markdown. Return the report id so you can refine it later.";
    /// `boss_reports_update`.
    pub const UPDATE: &'static str = "Update a report artifact previously created by this thread. Pass only the fields that should change; pass an empty summary to remove it.";
    /// `title` argument.
    pub const TITLE: &'static str = "Short human-facing title for the report.";
    /// `summary` argument.
    pub const SUMMARY: &'static str = "Optional one- or two-sentence description shown in the report inbox.";
    /// `body` argument.
    pub const BODY: &'static str = "Complete report content in Markdown.";
    /// `reportId` argument.
    pub const REPORT_ID: &'static str = "Report id returned by boss_reports_create.";
}

/// Read-only desktop operations the embedded CUA driver exposes.
pub const COMPUTER_USE_INSPECTION_OPERATIONS: &[&str] = &[
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

/// Reversible native-app actions, gated by Automatic QA.
pub const COMPUTER_USE_ACTION_OPERATIONS: &[&str] = &[
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

/// Every computer-use operation, inspection first, in the order the TS listed them.
pub fn computer_use_operations() -> Vec<&'static str> {
    COMPUTER_USE_INSPECTION_OPERATIONS.iter().chain(COMPUTER_USE_ACTION_OPERATIONS.iter()).copied().collect()
}

/// Guidance paragraph handed to pi as a prompt guideline for the QA tools.
pub const QA_GUIDANCE: &str = "You can see and operate what you build: boss_browser_* drives web pages open on this machine, and boss_computer drives native applications. Reach for them whenever a claim about what something looks like or does would otherwise be a guess. That includes checking your own work after a change, answering a question about a page or an app, and reproducing a bug the user reports. Looking is cheap and does not need permission: listing tabs, reading a page, and capturing window or desktop state are always available. Computer screenshots used for inspection stay out of the transcript by default; set showInTranscript only when the user asked to see that specific screenshot. Do not describe a page you have not read or a screen you have not seen. Acting on a page or an app — navigating, clicking, typing — needs Automatic QA turned on, and the tool says so if it is not.";

/// One QA tool's description, by name. Panics on an unknown name, like the TS did.
pub fn qa_description(name: &str) -> &'static str {
    match name {
        "boss_browser_tabs" => "Find out which web pages are open, and get the tabId every other browser tool needs. Start here whenever you want to look at a page. An empty list means the user has no browser open, so ask them to open one rather than assuming the page is unreachable.",
        "boss_browser_navigate" => "Point an open browser tab at a URL, to reach a page that is not on screen yet. Needs Automatic QA. Snapshot afterwards to see what loaded.",
        "boss_browser_snapshot" => "Read what a page actually says and what can be clicked on it. Use this to answer any question about a page, to check a change you made, or to find the element you are about to click or type into. Always available, no permission needed. Element refs stay valid until the page changes, so snapshot again after anything that reloads or navigates.",
        "boss_browser_screenshot" => "See how a page looks, rather than what it says. Use this for anything visual — layout, spacing, colour, whether something is cut off or overlapping — where the text alone would not tell you. Always available, no permission needed. For reading content or finding elements, boss_browser_snapshot is the better tool.",
        "boss_browser_click" => "Click something on a page, to walk through a flow or reach a state you cannot get to by looking. Takes a ref from boss_browser_snapshot, so snapshot first. Needs Automatic QA. Snapshot again afterwards: the click is not done until you have seen what it did.",
        "boss_browser_type" => "Put text into a field on a page, to fill a form or search for something. Replaces what is there rather than appending. Takes a ref from boss_browser_snapshot, so snapshot first. Needs Automatic QA. Set submit to press Enter afterwards.",
        "boss_computer" => "See and operate native applications on this machine — anything outside a web page, including this app itself. The arguments object is passed to the OSS CUA Driver after the click action names are safely canonicalized. Looking is always available: list_apps and list_windows find what is running; get_window_state and get_desktop_state return state plus a screenshot; zoom crops a region; verify_state checks bounded postconditions. Inspection screenshots are returned to you but hidden from the transcript by default; set showInTranscript only when the user asked to see that specific screenshot. Acting needs Automatic QA. Prefer a current element_token from get_window_state over coordinates. Match the element actions in the returned tree: click action \"showmenu\" is accepted and translated to the driver action \"show_menu\"; click defaults to press. For a window action, x/y are local pixels from its get_window_state screenshot. For a desktop action, x/y are absolute pixels from get_desktop_state; never apply display scale or window offsets yourself. Follow the delivery ladder background action, fresh state, pixel action, fresh state, then delivery_mode \"foreground\". Use bring_to_front when a transient menu or focus-proxy surface must remain foreground across multiple calls. Look again after every action — an action you have not verified is not finished.",
        other => panic!("No tool named {other}."),
    }
}

/// `JSON.stringify` for a string: a quoted, escaped JS string literal.
pub fn js_string(text: &str) -> String {
    serde_json::to_string(text).expect("string serializes")
}

/// `JSON.stringify` for a list of strings.
pub fn js_string_array(items: &[&str]) -> String {
    serde_json::to_string(items).expect("string list serializes")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn js_string_matches_json_stringify() {
        assert_eq!(js_string(r#"say "hi" — now"#), r#""say \"hi\" — now""#);
        assert_eq!(js_string_array(&["a", "b"]), r#"["a","b"]"#);
    }

    #[test]
    fn operations_are_inspection_then_action() {
        let ops = computer_use_operations();
        assert_eq!(ops.len(), 23);
        assert_eq!(ops[0], "list_apps");
        assert_eq!(ops[9], "launch_app");
        assert_eq!(*ops.last().unwrap(), "invoke_menu");
    }

    #[test]
    fn every_qa_tool_has_text() {
        for name in ["boss_browser_tabs", "boss_browser_navigate", "boss_browser_snapshot", "boss_browser_screenshot", "boss_browser_click", "boss_browser_type", "boss_computer"] {
            assert!(!qa_description(name).is_empty());
        }
    }
}
