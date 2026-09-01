//! Generated pi extension that exposes BOSS's bus tools.
//!
//! Port of `PiBackend.threadToolSource` in `src/main/backend/pi-backend.ts`.
//! pi loads it with `--extension <path>`; each `registerTool` HTTP-POSTs to
//! `$BOSS_THREAD_BUS_URL/agent-call` with `$BOSS_THREAD_BUS_TOKEN` as bearer
//! and `$BOSS_NATIVE_THREAD_ID` as the calling thread.

use crate::opencode::bus_tools::{
    QA_GUIDANCE, ReportToolDescriptions as R, ThreadToolDescriptions as T, computer_use_operations, js_string, qa_description,
};
use anyhow::{Context, Result};
use std::path::{Path, PathBuf};

/// Directory name under the user-data dir that holds the extension.
pub const EXTENSION_DIR_NAME: &str = "pi-boss";
/// File name of the generated extension.
pub const EXTENSION_FILE: &str = "boss_threads.ts";

/// `<user data>/pi-boss/boss_threads.ts`.
pub fn default_extension_path() -> PathBuf {
    boss_core::paths::user_data_dir().join(EXTENSION_DIR_NAME).join(EXTENSION_FILE)
}

/// Write the extension to `path` (creating parent directories) and return it.
pub fn write_extension(path: &Path) -> Result<PathBuf> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
    }
    std::fs::write(path, extension_source()).with_context(|| format!("write {}", path.display()))?;
    Ok(path.to_path_buf())
}

/// TypeScript source of the extension.
pub fn extension_source() -> String {
    let operations = computer_use_operations()
        .iter()
        .map(|op| format!("Type.Literal({})", js_string(op)))
        .collect::<Vec<_>>()
        .join(", ");
    let pairs: Vec<(&str, String)> = vec![
        ("qa_tabs", js_string(qa_description("boss_browser_tabs"))),
        ("qa_navigate", js_string(qa_description("boss_browser_navigate"))),
        ("qa_snapshot", js_string(qa_description("boss_browser_snapshot"))),
        ("qa_screenshot", js_string(qa_description("boss_browser_screenshot"))),
        ("qa_click", js_string(qa_description("boss_browser_click"))),
        ("qa_type", js_string(qa_description("boss_browser_type"))),
        ("qa_computer", js_string(qa_description("boss_computer"))),
        ("qa_guidance", js_string(QA_GUIDANCE)),
        ("operations", operations),
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
        ("reportCreate", js_string(R::CREATE)),
        ("reportUpdate", js_string(R::UPDATE)),
        ("reportTitle", js_string(R::TITLE)),
        ("reportSummary", js_string(R::SUMMARY)),
        ("reportBody", js_string(R::BODY)),
        ("reportId", js_string(R::REPORT_ID)),
    ];
    let mut out = TEMPLATE.to_string();
    for (key, value) in &pairs {
        out = out.replace(&format!("«{key}»"), value);
    }
    debug_assert!(!out.contains('«'), "unfilled placeholder in pi extension template");
    out
}

const TEMPLATE: &str = r#"import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"

async function call(name, args, signal) {
  const url = process.env.BOSS_THREAD_BUS_URL
  const token = process.env.BOSS_THREAD_BUS_TOKEN
  const nativeThreadId = process.env.BOSS_NATIVE_THREAD_ID
  if (!url || !token || !nativeThreadId) throw new Error("BOSS thread collaboration is unavailable.")
  const response = await fetch(url + "/agent-call", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + token },
    body: JSON.stringify({ backendId: "pi", nativeThreadId, tool: name, arguments: args }),
    signal
  })
  const payload = await response.json()
  if (!response.ok || !payload.ok) throw new Error(payload.error || "BOSS thread tool failed.")
  const result = payload.result
  if (result && result.__bossToolResult) {
    return {
      content: [
        { type: "text", text: result.text },
        ...(result.image ? [{ type: "image", data: result.image.data, mimeType: result.image.mimeType }] : [])
      ],
      details: result
    }
  }
  return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result }
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "boss_browser_tabs",
    label: "List BOSS browser tabs",
    description: «qa_tabs»,
    parameters: Type.Object({}),
    promptSnippet: "Inspect BOSS browser tabs",
    promptGuidelines: [«qa_guidance»],
    execute: (_id, args, signal) => call("boss_browser_tabs", args, signal)
  })
  pi.registerTool({
    name: "boss_browser_navigate",
    label: "Navigate BOSS browser",
    description: «qa_navigate»,
    parameters: Type.Object({ tabId: Type.String(), url: Type.String() }),
    execute: (_id, args, signal) => call("boss_browser_navigate", args, signal)
  })
  pi.registerTool({
    name: "boss_browser_snapshot",
    label: "Inspect BOSS browser",
    description: «qa_snapshot»,
    parameters: Type.Object({ tabId: Type.String() }),
    execute: (_id, args, signal) => call("boss_browser_snapshot", args, signal)
  })
  pi.registerTool({
    name: "boss_browser_screenshot",
    label: "Screenshot BOSS browser",
    description: «qa_screenshot»,
    parameters: Type.Object({ tabId: Type.String() }),
    execute: (_id, args, signal) => call("boss_browser_screenshot", args, signal)
  })
  pi.registerTool({
    name: "boss_browser_click",
    label: "Click BOSS browser",
    description: «qa_click»,
    parameters: Type.Object({ tabId: Type.String(), ref: Type.String() }),
    execute: (_id, args, signal) => call("boss_browser_click", args, signal)
  })
  pi.registerTool({
    name: "boss_browser_type",
    label: "Type in BOSS browser",
    description: «qa_type»,
    parameters: Type.Object({
      tabId: Type.String(),
      ref: Type.String(),
      text: Type.String(),
      submit: Type.Optional(Type.Boolean({ default: false }))
    }),
    execute: (_id, args, signal) => call("boss_browser_type", args, signal)
  })
  pi.registerTool({
    name: "boss_computer",
    label: "BOSS Computer Use",
    description: «qa_computer»,
    parameters: Type.Object({
      operation: Type.Union([
        «operations»
      ]),
      arguments: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
      showInTranscript: Type.Optional(Type.Boolean({ default: false }))
    }),
    execute: (_id, args, signal) => call("boss_computer", args, signal)
  })
  pi.registerTool({
    name: "boss_threads_list",
    label: "List BOSS threads",
    description: «list»,
    parameters: Type.Object({}),
    execute: (_id, args, signal) => call("boss_threads_list", args, signal)
  })
  pi.registerTool({
    name: "boss_threads_read",
    label: "Read BOSS thread",
    description: «read»,
    parameters: Type.Object({
      threadId: Type.String({ description: "BOSS thread id returned by boss_threads_list." }),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, default: 8 }))
    }),
    execute: (_id, args, signal) => call("boss_threads_read", args, signal)
  })
  pi.registerTool({
    name: "boss_threads_send",
    label: "Send BOSS thread message",
    description: «send»,
    parameters: Type.Object({
      threadId: Type.String({ description: "BOSS thread id returned by boss_threads_list." }),
      message: Type.String({ description: "Message to send to the other agent." }),
      expectsReply: Type.Optional(Type.Boolean({ default: true })),
      maxTurns: Type.Optional(Type.Integer({ minimum: 1, maximum: 8, default: 4 }))
    }),
    execute: (_id, args, signal) => call("boss_threads_send", args, signal)
  })
  pi.registerTool({
    name: "boss_threads_reply",
    label: "Reply to BOSS thread message",
    description: «reply»,
    parameters: Type.Object({
      messageId: Type.String({ description: "Message id from the incoming BOSS thread message." }),
      message: Type.String({ description: "Reply to send to the other agent." }),
      expectsReply: Type.Optional(Type.Boolean({ default: false }))
    }),
    execute: (_id, args, signal) => call("boss_threads_reply", args, signal)
  })
  pi.registerTool({
    name: "boss_rooms_open",
    label: "Start a room",
    description: «openRoom»,
    parameters: Type.Object({
      instruction: Type.String({ description: «openRoomInstruction» }),
      shape: Type.Union([
        Type.Literal("direct"),
        Type.Literal("reviewed"),
        Type.Literal("full")
      ], { description: «openRoomShape» }),
      project: Type.Optional(Type.String({ description: «openRoomProject» }))
    }),
    execute: (_id, args, signal) => call("boss_rooms_open", args, signal)
  })
  pi.registerTool({
    name: "boss_threads_spawn_worktree",
    label: "Spawn BOSS worktree thread",
    description: «spawnWorktree»,
    parameters: Type.Object({
      instruction: Type.String({ description: «spawnWorktreeInstruction» }),
      project: Type.Optional(Type.String({ description: «spawnWorktreeProject» })),
      agent: Type.Optional(Type.Union([
        Type.Literal("opencode"),
        Type.Literal("pi"),
        Type.Literal("codex"),
        Type.Literal("claude")
      ], { description: «spawnWorktreeAgent» }))
    }),
    execute: (_id, args, signal) => call("boss_threads_spawn_worktree", args, signal)
  })
  pi.registerTool({
    name: "boss_threads_use_worktree",
    label: "Use a BOSS worktree",
    description: «useWorktree»,
    parameters: Type.Object({}),
    execute: (_id, args, signal) => call("boss_threads_use_worktree", args, signal)
  })
  pi.registerTool({
    name: "boss_threads_leave_worktree",
    label: "Leave the BOSS worktree",
    description: «leaveWorktree»,
    parameters: Type.Object({}),
    execute: (_id, args, signal) => call("boss_threads_leave_worktree", args, signal)
  })
  pi.registerTool({
    name: "boss_git_create_change_request",
    label: "Open a pull or merge request",
    description: «createChangeRequest»,
    parameters: Type.Object({
      title: Type.Optional(Type.String({ description: «createChangeRequestTitle» })),
      body: Type.Optional(Type.String({ description: «createChangeRequestBody» })),
      baseBranch: Type.Optional(Type.String({ description: «createChangeRequestBase» })),
      draft: Type.Optional(Type.Boolean({ description: «createChangeRequestDraft» }))
    }),
    execute: (_id, args, signal) => call("boss_git_create_change_request", args, signal)
  })
  pi.registerTool({
    name: "boss_reports_create",
    label: "Create BOSS report",
    description: «reportCreate»,
    parameters: Type.Object({
      title: Type.String({ description: «reportTitle» }),
      summary: Type.Optional(Type.String({ description: «reportSummary» })),
      body: Type.String({ description: «reportBody» })
    }),
    execute: (_id, args, signal) => call("boss_reports_create", args, signal)
  })
  pi.registerTool({
    name: "boss_reports_update",
    label: "Update BOSS report",
    description: «reportUpdate»,
    parameters: Type.Object({
      reportId: Type.String({ description: «reportId» }),
      title: Type.Optional(Type.String({ description: «reportTitle» })),
      summary: Type.Optional(Type.String({ description: «reportSummary» })),
      body: Type.Optional(Type.String({ description: «reportBody» }))
    }),
    execute: (_id, args, signal) => call("boss_reports_update", args, signal)
  })
  pi.registerTool({
    name: "boss_mcp_list",
    label: "List BOSS MCP tools",
    description: "List external MCP tools available through BOSS connections. Pass tool to get one tool's full input schema before calling it.",
    parameters: Type.Object({ tool: Type.Optional(Type.String({ description: "Tool name from the catalog; returns its full input schema." })) }),
    execute: (_id, args, signal) => call("boss_mcp_list", args, signal)
  })
  pi.registerTool({
    name: "boss_mcp_call",
    label: "Call BOSS MCP tool",
    description: "Call an external MCP tool listed by boss_mcp_list.",
    parameters: Type.Object({
      tool: Type.String({ description: "Tool name from boss_mcp_list." }),
      arguments: Type.Optional(Type.Record(Type.String(), Type.Unknown()))
    }),
    execute: (_id, args, signal) => call("boss_mcp_call", args, signal)
  })
}
"#;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extension_wires_env_bus_and_every_tool() {
        let src = extension_source();
        assert!(src.starts_with(r#"import type { ExtensionAPI } from "@earendil-works/pi-coding-agent""#));
        assert!(src.contains("process.env.BOSS_THREAD_BUS_URL"));
        assert!(src.contains("process.env.BOSS_THREAD_BUS_TOKEN"));
        assert!(src.contains("process.env.BOSS_NATIVE_THREAD_ID"));
        assert!(src.contains(r#"fetch(url + "/agent-call""#));
        assert!(src.contains(r#"authorization: "Bearer " + token"#));
        assert!(src.contains(r#"body: JSON.stringify({ backendId: "pi", nativeThreadId, tool: name, arguments: args })"#));
        for name in [
            "boss_browser_tabs",
            "boss_browser_navigate",
            "boss_browser_snapshot",
            "boss_browser_screenshot",
            "boss_browser_click",
            "boss_browser_type",
            "boss_computer",
            "boss_threads_list",
            "boss_threads_read",
            "boss_threads_send",
            "boss_threads_reply",
            "boss_rooms_open",
            "boss_threads_spawn_worktree",
            "boss_threads_use_worktree",
            "boss_threads_leave_worktree",
            "boss_git_create_change_request",
            "boss_reports_create",
            "boss_reports_update",
            "boss_mcp_list",
            "boss_mcp_call",
        ] {
            assert!(src.contains(&format!("name: \"{name}\",")), "missing registerTool for {name}");
            assert!(src.contains(&format!("call(\"{name}\", args, signal)")), "missing call for {name}");
        }
        assert!(src.contains(r#"Type.Literal("list_apps"), Type.Literal("list_windows")"#));
        assert!(src.contains(&format!("promptGuidelines: [{}]", js_string(QA_GUIDANCE))));
        assert!(src.contains(&format!("description: {},", js_string(T::SPAWN_WORKTREE))));
        assert!(!src.contains('«'));
    }

    #[test]
    fn extension_is_written_to_disk() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("pi-boss").join(EXTENSION_FILE);
        let written = write_extension(&path).unwrap();
        assert_eq!(written, path);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), extension_source());
    }
}
