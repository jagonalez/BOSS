//! Generated opencode tool files that reach BOSS's thread bus over HTTP.
//!
//! Port of `OpenCodeServer.configureThreadBus` in `src/main/opencode-server.ts`.
//! opencode loads `*.ts` files from `$OPENCODE_CONFIG_DIR/tools`; each exported
//! `tool(...)` becomes `<file>_<export>` (so `boss_threads.ts` exporting `list`
//! is the tool `boss_threads_list`). The tool bodies read
//! `BOSS_THREAD_BUS_URL` / `BOSS_THREAD_BUS_TOKEN` from the server's
//! environment at call time and POST to `<url>/agent-call`.

use super::bus_tools::{
    ReportToolDescriptions as R, ThreadToolDescriptions as T, computer_use_operations, js_string, js_string_array,
    qa_description,
};
use anyhow::{Context, Result};
use std::path::{Path, PathBuf};

/// Directory name under the user-data dir that holds the generated config.
pub const CONFIG_DIR_NAME: &str = "opencode-boss";

/// Where the generated `OPENCODE_CONFIG_DIR` lives: `<user data>/opencode-boss`.
pub fn default_config_dir() -> PathBuf {
    boss_core::paths::user_data_dir().join(CONFIG_DIR_NAME)
}

/// Write `tools/boss_threads.ts`, `tools/boss.ts`, and `tools/boss_reports.ts`
/// under `config_dir`. Returns `config_dir` for use as `OPENCODE_CONFIG_DIR`.
pub fn write_config_dir(config_dir: &Path) -> Result<PathBuf> {
    let tools = config_dir.join("tools");
    std::fs::create_dir_all(&tools).with_context(|| format!("create {}", tools.display()))?;
    std::fs::write(tools.join("boss_threads.ts"), thread_tool_source())?;
    std::fs::write(tools.join("boss.ts"), qa_tool_source())?;
    std::fs::write(tools.join("boss_reports.ts"), report_tool_source())?;
    Ok(config_dir.to_path_buf())
}

fn fill(template: &str, pairs: &[(&str, String)]) -> String {
    let mut out = template.to_string();
    for (key, value) in pairs {
        out = out.replace(&format!("«{key}»"), value);
    }
    debug_assert!(!out.contains('«'), "unfilled placeholder in plugin template");
    out
}

/// Source of `tools/boss_threads.ts`.
pub fn thread_tool_source() -> String {
    fill(
        THREAD_TEMPLATE,
        &[
            ("list", js_string(T::LIST)),
            ("read", js_string(T::READ)),
            ("send", js_string(T::SEND)),
            ("reply", js_string(T::REPLY)),
            ("openRoom", js_string(T::OPEN_ROOM)),
            ("openRoomInstruction", js_string(T::OPEN_ROOM_INSTRUCTION)),
            ("openRoomShape", js_string(T::OPEN_ROOM_SHAPE)),
            ("openRoomProject", js_string(T::OPEN_ROOM_PROJECT)),
            ("spawnWorktree", js_string(T::SPAWN_WORKTREE)),
            ("spawnWorktreeInstruction", js_string(T::SPAWN_WORKTREE_INSTRUCTION)),
            ("spawnWorktreeProject", js_string(T::SPAWN_WORKTREE_PROJECT)),
            ("spawnWorktreeAgent", js_string(T::SPAWN_WORKTREE_AGENT)),
            ("useWorktree", js_string(T::USE_WORKTREE)),
            ("leaveWorktree", js_string(T::LEAVE_WORKTREE)),
            ("createChangeRequest", js_string(T::CREATE_CHANGE_REQUEST)),
            ("createChangeRequestTitle", js_string(T::CREATE_CHANGE_REQUEST_TITLE)),
            ("createChangeRequestBody", js_string(T::CREATE_CHANGE_REQUEST_BODY)),
            ("createChangeRequestBase", js_string(T::CREATE_CHANGE_REQUEST_BASE)),
            ("createChangeRequestDraft", js_string(T::CREATE_CHANGE_REQUEST_DRAFT)),
        ],
    )
}

/// Source of `tools/boss_reports.ts`.
pub fn report_tool_source() -> String {
    fill(
        REPORT_TEMPLATE,
        &[
            ("create", js_string(R::CREATE)),
            ("update", js_string(R::UPDATE)),
            ("title", js_string(R::TITLE)),
            ("summary", js_string(R::SUMMARY)),
            ("body", js_string(R::BODY)),
            ("reportId", js_string(R::REPORT_ID)),
        ],
    )
}

/// Source of `tools/boss.ts` (browser and computer-use tools).
pub fn qa_tool_source() -> String {
    fill(
        QA_TEMPLATE,
        &[
            ("browser_tabs", js_string(qa_description("boss_browser_tabs"))),
            ("browser_navigate", js_string(qa_description("boss_browser_navigate"))),
            ("browser_snapshot", js_string(qa_description("boss_browser_snapshot"))),
            ("browser_screenshot", js_string(qa_description("boss_browser_screenshot"))),
            ("browser_click", js_string(qa_description("boss_browser_click"))),
            ("browser_type", js_string(qa_description("boss_browser_type"))),
            ("computer", js_string(qa_description("boss_computer"))),
            ("operations", js_string_array(&computer_use_operations())),
        ],
    )
}

const THREAD_TEMPLATE: &str = r#"import { tool } from "@opencode-ai/plugin"

async function call(name, args, context) {
  const url = process.env.BOSS_THREAD_BUS_URL
  const token = process.env.BOSS_THREAD_BUS_TOKEN
  if (!url || !token) throw new Error("BOSS thread collaboration is unavailable.")
  const response = await fetch(url + "/agent-call", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + token },
    body: JSON.stringify({ backendId: "opencode", nativeThreadId: context.sessionID, tool: name, arguments: args })
  })
  const payload = await response.json()
  if (!response.ok || !payload.ok) throw new Error(payload.error || "BOSS thread tool failed.")
  const result = payload.result
  if (result && result.__bossToolResult) {
    return {
      title: "BOSS QA",
      output: result.text,
      metadata: { bossQa: true },
      attachments: result.image ? [{
        type: "file",
        mime: result.image.mimeType,
        url: "data:" + result.image.mimeType + ";base64," + result.image.data,
        filename: "boss-qa.png"
      }] : []
    }
  }
  return JSON.stringify(result, null, 2)
}

export const list = tool({
  description: «list»,
  args: {},
  execute(args, context) { return call("boss_threads_list", args, context) }
})

export const read = tool({
  description: «read»,
  args: {
    threadId: tool.schema.string().describe("Thread id returned by boss_threads_list"),
    limit: tool.schema.number().min(1).max(20).optional()
  },
  execute(args, context) { return call("boss_threads_read", args, context) }
})

export const send = tool({
  description: «send»,
  args: {
    threadId: tool.schema.string().describe("Target BOSS thread id"),
    message: tool.schema.string().describe("Concise context, question, or requested task"),
    expectsReply: tool.schema.boolean().optional(),
    maxTurns: tool.schema.number().min(1).max(8).optional()
  },
  execute(args, context) { return call("boss_threads_send", args, context) }
})

export const reply = tool({
  description: «reply»,
  args: {
    messageId: tool.schema.string().describe("Message id from the incoming BOSS thread message"),
    message: tool.schema.string().describe("Reply for the sending thread"),
    expectsReply: tool.schema.boolean().optional()
  },
  execute(args, context) { return call("boss_threads_reply", args, context) }
})

export const rooms_open = tool({
  description: «openRoom»,
  args: {
    instruction: tool.schema.string().describe(«openRoomInstruction»),
    shape: tool.schema.enum(["direct", "reviewed", "full"])
      .describe(«openRoomShape»),
    project: tool.schema.string().describe(«openRoomProject»).optional()
  },
  execute(args, context) { return call("boss_rooms_open", args, context) }
})

export const spawn_worktree = tool({
  description: «spawnWorktree»,
  args: {
    instruction: tool.schema.string().describe(«spawnWorktreeInstruction»),
    project: tool.schema.string().describe(«spawnWorktreeProject»).optional(),
    agent: tool.schema.enum(["opencode", "pi", "codex", "claude"])
      .describe(«spawnWorktreeAgent»).optional()
  },
  execute(args, context) { return call("boss_threads_spawn_worktree", args, context) }
})

export const use_worktree = tool({
  description: «useWorktree»,
  args: {},
  execute(args, context) { return call("boss_threads_use_worktree", args, context) }
})

export const leave_worktree = tool({
  description: «leaveWorktree»,
  args: {},
  execute(args, context) { return call("boss_threads_leave_worktree", args, context) }
})

export const git_create_change_request = tool({
  description: «createChangeRequest»,
  args: {
    title: tool.schema.string().optional().describe(«createChangeRequestTitle»),
    body: tool.schema.string().optional().describe(«createChangeRequestBody»),
    baseBranch: tool.schema.string().optional().describe(«createChangeRequestBase»),
    draft: tool.schema.boolean().optional().describe(«createChangeRequestDraft»)
  },
  execute(args, context) { return call("boss_git_create_change_request", args, context) }
})

export const mcp_list = tool({
  description: "List external MCP tools available through this app's connections. Pass tool to get one tool's full input schema before calling it.",
  args: {
    tool: tool.schema.string().optional().describe("Tool name from the catalog; returns its full input schema")
  },
  execute(args, context) { return call("boss_mcp_list", args, context) }
})

export const mcp_call = tool({
  description: "Call an external MCP tool listed by boss_mcp_list.",
  args: {
    tool: tool.schema.string().describe("Tool name from boss_mcp_list"),
    arguments: tool.schema.record(tool.schema.string(), tool.schema.unknown()).optional()
  },
  execute(args, context) { return call("boss_mcp_call", args, context) }
})
"#;

const REPORT_TEMPLATE: &str = r#"import { tool } from "@opencode-ai/plugin"

async function call(name, args, context) {
  const url = process.env.BOSS_THREAD_BUS_URL
  const token = process.env.BOSS_THREAD_BUS_TOKEN
  if (!url || !token) throw new Error("BOSS report tools are unavailable.")
  const response = await fetch(url + "/agent-call", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + token },
    body: JSON.stringify({ backendId: "opencode", nativeThreadId: context.sessionID, tool: name, arguments: args })
  })
  const payload = await response.json()
  if (!response.ok || !payload.ok) throw new Error(payload.error || "BOSS report tool failed.")
  return JSON.stringify(payload.result, null, 2)
}

export const create = tool({
  description: «create»,
  args: {
    title: tool.schema.string().describe(«title»),
    summary: tool.schema.string().optional().describe(«summary»),
    body: tool.schema.string().describe(«body»)
  },
  execute(args, context) { return call("boss_reports_create", args, context) }
})

export const update = tool({
  description: «update»,
  args: {
    reportId: tool.schema.string().describe(«reportId»),
    title: tool.schema.string().optional().describe(«title»),
    summary: tool.schema.string().optional().describe(«summary»),
    body: tool.schema.string().optional().describe(«body»)
  },
  execute(args, context) { return call("boss_reports_update", args, context) }
})
"#;

const QA_TEMPLATE: &str = r#"import { tool } from "@opencode-ai/plugin"

async function call(name, args, context) {
  const url = process.env.BOSS_THREAD_BUS_URL
  const token = process.env.BOSS_THREAD_BUS_TOKEN
  if (!url || !token) throw new Error("BOSS QA tools are unavailable.")
  const response = await fetch(url + "/agent-call", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + token },
    body: JSON.stringify({ backendId: "opencode", nativeThreadId: context.sessionID, tool: name, arguments: args })
  })
  const payload = await response.json()
  if (!response.ok || !payload.ok) throw new Error(payload.error || "BOSS QA tool failed.")
  const result = payload.result
  return {
    title: "BOSS QA",
    output: result.text,
    metadata: { bossQa: true },
    attachments: result.image ? [{
      type: "file",
      mime: result.image.mimeType,
      url: "data:" + result.image.mimeType + ";base64," + result.image.data,
      filename: "boss-qa.png"
    }] : []
  }
}

export const browser_tabs = tool({
  description: «browser_tabs»,
  args: {},
  execute(args, context) { return call("boss_browser_tabs", args, context) }
})
export const browser_navigate = tool({
  description: «browser_navigate»,
  args: { tabId: tool.schema.string(), url: tool.schema.string() },
  execute(args, context) { return call("boss_browser_navigate", args, context) }
})
export const browser_snapshot = tool({
  description: «browser_snapshot»,
  args: { tabId: tool.schema.string() },
  execute(args, context) { return call("boss_browser_snapshot", args, context) }
})
export const browser_screenshot = tool({
  description: «browser_screenshot»,
  args: { tabId: tool.schema.string() },
  execute(args, context) { return call("boss_browser_screenshot", args, context) }
})
export const browser_click = tool({
  description: «browser_click»,
  args: { tabId: tool.schema.string(), ref: tool.schema.string() },
  execute(args, context) { return call("boss_browser_click", args, context) }
})
export const browser_type = tool({
  description: «browser_type»,
  args: { tabId: tool.schema.string(), ref: tool.schema.string(), text: tool.schema.string(), submit: tool.schema.boolean().optional() },
  execute(args, context) { return call("boss_browser_type", args, context) }
})
export const computer = tool({
  description: «computer»,
  args: {
    operation: tool.schema.enum(«operations»),
    arguments: tool.schema.record(tool.schema.string(), tool.schema.unknown()).optional(),
    showInTranscript: tool.schema.boolean().optional()
  },
  execute(args, context) { return call("boss_computer", args, context) }
})
"#;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn thread_tools_wire_the_bus_env_and_every_tool() {
        let src = thread_tool_source();
        assert!(src.contains("process.env.BOSS_THREAD_BUS_URL"));
        assert!(src.contains("process.env.BOSS_THREAD_BUS_TOKEN"));
        assert!(src.contains(r#"fetch(url + "/agent-call""#));
        assert!(src.contains(r#"authorization: "Bearer " + token"#));
        assert!(src.contains(r#"backendId: "opencode", nativeThreadId: context.sessionID"#));
        for name in [
            "boss_threads_list",
            "boss_threads_read",
            "boss_threads_send",
            "boss_threads_reply",
            "boss_rooms_open",
            "boss_threads_spawn_worktree",
            "boss_threads_use_worktree",
            "boss_threads_leave_worktree",
            "boss_git_create_change_request",
            "boss_mcp_list",
            "boss_mcp_call",
        ] {
            assert!(src.contains(&format!("call(\"{name}\"")), "missing {name}");
        }
        assert!(src.contains(&format!("description: {},", js_string(T::LIST))));
        assert!(!src.contains('«'));
    }

    #[test]
    fn report_and_qa_tools_are_generated() {
        let reports = report_tool_source();
        assert!(reports.contains(r#"call("boss_reports_create""#));
        assert!(reports.contains(r#"call("boss_reports_update""#));
        assert!(reports.contains(&js_string(R::REPORT_ID)));
        assert!(!reports.contains('«'));

        let qa = qa_tool_source();
        assert!(qa.contains(r#"call("boss_computer""#));
        assert!(qa.contains(r#"operation: tool.schema.enum(["list_apps","#));
        assert!(qa.contains(r#""invoke_menu"]"#));
        assert!(!qa.contains('«'));
    }

    #[test]
    fn config_dir_holds_the_three_tool_files() {
        let dir = tempfile::tempdir().unwrap();
        let out = write_config_dir(dir.path()).unwrap();
        assert_eq!(out, dir.path());
        for file in ["boss_threads.ts", "boss.ts", "boss_reports.ts"] {
            let text = std::fs::read_to_string(dir.path().join("tools").join(file)).unwrap();
            assert!(text.starts_with(r#"import { tool } from "@opencode-ai/plugin""#), "{file}");
        }
    }
}
