//! Replays recorded stream-json lines through the translator and checks the
//! command line and control shapes. Nothing here spawns the CLI.

use super::args::{ENTRYPOINT, build_args, bus_url, mcp_config};
use super::protocol::*;
use super::{parse_version, static_models};
use boss_core::{
    BusAccess, EngineEvent, MessageId, ParticipantId, PartId, PermissionDecision, PermissionMode, RequestId, Role,
    SessionOptions, ThreadId,
};
use serde_json::{Value, json};

const SESSION: &str = "5f1c4c7e-0000-4000-8000-000000000001";
const MODEL: &str = "claude-opus-4-1-20250805";

fn msg(id: &str) -> MessageId {
    MessageId::from_raw(id)
}

fn part(message: &str, index: u64) -> PartId {
    PartId::from_raw(format!("{message}:{index}"))
}

fn stream(event: Value) -> Value {
    json!({ "type": "stream_event", "event": event, "session_id": SESSION, "parent_tool_use_id": null, "uuid": "u" })
}

fn init_line() -> Value {
    json!({
        "type": "system", "subtype": "init", "cwd": "/tmp/p", "session_id": SESSION,
        "tools": ["Bash", "Read", "mcp__boss_thread_bus__boss_threads_list"],
        "mcp_servers": [{ "name": "boss_thread_bus", "status": "connected" }],
        "model": MODEL, "permissionMode": "default", "slash_commands": [], "apiKeySource": "none",
        "claude_code_version": "2.1.0", "output_style": "default", "skills": [], "plugins": [],
        "agents": ["general-purpose"], "uuid": "u0"
    })
}

fn assistant(id: &str, content: Value) -> Value {
    json!({
        "type": "assistant",
        "message": { "id": id, "type": "message", "role": "assistant", "model": MODEL, "content": content,
                     "stop_reason": null, "stop_sequence": null,
                     "usage": { "input_tokens": 100, "output_tokens": 20, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0 } },
        "parent_tool_use_id": null, "session_id": SESSION, "uuid": "ua"
    })
}

fn run(translator: &mut Translator, lines: Vec<Value>) -> Vec<EngineEvent> {
    lines.into_iter().flat_map(|line| translator.translate(line)).collect()
}

/// A recorded turn: thinking, text, a Read call streamed as partial JSON, the
/// finished blocks, the tool result, a second message, and the result.
fn full_turn() -> Vec<Value> {
    vec![
        init_line(),
        stream(json!({ "type": "message_start", "message": { "id": "msg_1", "type": "message", "role": "assistant", "model": MODEL, "content": [], "stop_reason": null,
            "usage": { "input_tokens": 100, "output_tokens": 1, "cache_read_input_tokens": 40, "cache_creation_input_tokens": 5 } } })),
        stream(json!({ "type": "content_block_start", "index": 0, "content_block": { "type": "thinking", "thinking": "" } })),
        stream(json!({ "type": "content_block_delta", "index": 0, "delta": { "type": "thinking_delta", "thinking": "Let me look" } })),
        stream(json!({ "type": "content_block_delta", "index": 0, "delta": { "type": "signature_delta", "signature": "abc" } })),
        stream(json!({ "type": "content_block_stop", "index": 0 })),
        stream(json!({ "type": "content_block_start", "index": 1, "content_block": { "type": "text", "text": "" } })),
        stream(json!({ "type": "content_block_delta", "index": 1, "delta": { "type": "text_delta", "text": "I will read " } })),
        stream(json!({ "type": "content_block_delta", "index": 1, "delta": { "type": "text_delta", "text": "the file." } })),
        stream(json!({ "type": "content_block_stop", "index": 1 })),
        stream(json!({ "type": "content_block_start", "index": 2, "content_block": { "type": "tool_use", "id": "toolu_1", "name": "Read", "input": {} } })),
        stream(json!({ "type": "content_block_delta", "index": 2, "delta": { "type": "input_json_delta", "partial_json": "{\"file_path\": " } })),
        stream(json!({ "type": "content_block_delta", "index": 2, "delta": { "type": "input_json_delta", "partial_json": "\"/tmp/p/src/main.rs\"}" } })),
        stream(json!({ "type": "content_block_stop", "index": 2 })),
        stream(json!({ "type": "message_delta", "delta": { "stop_reason": "tool_use", "stop_sequence": null }, "usage": { "output_tokens": 20 } })),
        stream(json!({ "type": "message_stop" })),
        assistant("msg_1", json!([{ "type": "thinking", "thinking": "Let me look", "signature": "abc" }])),
        assistant("msg_1", json!([{ "type": "text", "text": "I will read the file." }])),
        assistant("msg_1", json!([{ "type": "tool_use", "id": "toolu_1", "name": "Read", "input": { "file_path": "/tmp/p/src/main.rs" } }])),
        json!({ "type": "user", "message": { "role": "user", "content": [{ "type": "tool_result", "tool_use_id": "toolu_1", "content": "fn main() {}" }] },
                "parent_tool_use_id": null, "session_id": SESSION, "uuid": "uu" }),
        stream(json!({ "type": "message_start", "message": { "id": "msg_2", "type": "message", "role": "assistant", "model": MODEL, "content": [], "stop_reason": null,
            "usage": { "input_tokens": 200, "output_tokens": 1 } } })),
        stream(json!({ "type": "content_block_start", "index": 0, "content_block": { "type": "text", "text": "" } })),
        stream(json!({ "type": "content_block_delta", "index": 0, "delta": { "type": "text_delta", "text": "Done." } })),
        stream(json!({ "type": "content_block_stop", "index": 0 })),
        stream(json!({ "type": "message_delta", "delta": { "stop_reason": "end_turn", "stop_sequence": null }, "usage": { "output_tokens": 3 } })),
        stream(json!({ "type": "message_stop" })),
        assistant("msg_2", json!([{ "type": "text", "text": "Done." }])),
        json!({ "type": "result", "subtype": "success", "is_error": false, "duration_ms": 1200, "duration_api_ms": 900, "num_turns": 2,
                "result": "Done.", "session_id": SESSION, "total_cost_usd": 0.0123,
                "usage": { "input_tokens": 300, "output_tokens": 23, "cache_read_input_tokens": 40, "cache_creation_input_tokens": 5 },
                "modelUsage": {}, "permission_denials": [], "uuid": "ur" }),
    ]
}

#[test]
fn a_recorded_turn_becomes_engine_events() {
    let mut translator = Translator::new();
    let events = run(&mut translator, full_turn());
    let m1 = msg("msg_1");
    let m2 = msg("msg_2");
    let read_input = json!({ "file_path": "/tmp/p/src/main.rs" });
    let expected = vec![
        EngineEvent::SessionReady { native_session_id: SESSION.into() },
        EngineEvent::MessageStarted { message_id: m1.clone(), role: Role::Assistant },
        EngineEvent::ReasoningDelta { message_id: m1.clone(), part_id: part("msg_1", 0), delta: "Let me look".into() },
        EngineEvent::TextDelta { message_id: m1.clone(), part_id: part("msg_1", 1), delta: "I will read ".into() },
        EngineEvent::TextDelta { message_id: m1.clone(), part_id: part("msg_1", 1), delta: "the file.".into() },
        EngineEvent::ToolCallStarted {
            message_id: m1.clone(),
            part_id: part("msg_1", 2),
            call_id: "toolu_1".into(),
            name: "Read".into(),
            input: json!({}),
            title: None,
        },
        EngineEvent::ToolCallInputDelta { message_id: m1.clone(), part_id: part("msg_1", 2), delta: "{\"file_path\": ".into() },
        EngineEvent::ToolCallInputDelta { message_id: m1.clone(), part_id: part("msg_1", 2), delta: "\"/tmp/p/src/main.rs\"}".into() },
        // content_block_stop parses the streamed JSON and announces the final input.
        EngineEvent::ToolCallStarted {
            message_id: m1.clone(),
            part_id: part("msg_1", 2),
            call_id: "toolu_1".into(),
            name: "Read".into(),
            input: read_input.clone(),
            title: Some("…/src/main.rs".into()),
        },
        EngineEvent::MessageCompleted {
            message_id: m1.clone(),
            usage: Some(boss_core::Usage { input_tokens: 100, output_tokens: 20, cache_read_tokens: 40, cache_write_tokens: 5, cost_usd: None }),
            model: Some(MODEL.into()),
        },
        // The finished thinking and text blocks were already streamed: no events.
        // The finished tool_use block has the input BOSS already announced: only Running.
        EngineEvent::ToolCallRunning { message_id: m1.clone(), part_id: part("msg_1", 2) },
        EngineEvent::ToolCallFinished { message_id: m1.clone(), part_id: part("msg_1", 2), output: Some("fn main() {}".into()), error: None },
        EngineEvent::MessageStarted { message_id: m2.clone(), role: Role::Assistant },
        EngineEvent::TextDelta { message_id: m2.clone(), part_id: part("msg_2", 0), delta: "Done.".into() },
        EngineEvent::MessageCompleted {
            message_id: m2.clone(),
            usage: Some(boss_core::Usage { input_tokens: 200, output_tokens: 3, ..Default::default() }),
            model: Some(MODEL.into()),
        },
        EngineEvent::MessageCompleted {
            message_id: m2.clone(),
            usage: Some(boss_core::Usage {
                input_tokens: 300,
                output_tokens: 23,
                cache_read_tokens: 40,
                cache_write_tokens: 5,
                cost_usd: Some(0.0123),
            }),
            model: Some(MODEL.into()),
        },
        EngineEvent::Status { busy: false },
    ];
    assert_eq!(events, expected);
    assert_eq!(translator.session_id(), Some(SESSION));
}

#[test]
fn a_finished_message_without_partials_is_emitted_whole() {
    // A resumed or replayed turn may arrive without stream events. The
    // finished blocks then have to create the parts themselves.
    let mut translator = Translator::new();
    let events = run(
        &mut translator,
        vec![assistant(
            "msg_9",
            json!([
                { "type": "text", "text": "Running ls." },
                { "type": "tool_use", "id": "toolu_9", "name": "Bash", "input": { "command": "ls -la" } }
            ]),
        )],
    );
    assert_eq!(
        events,
        vec![
            EngineEvent::MessageStarted { message_id: msg("msg_9"), role: Role::Assistant },
            EngineEvent::TextDelta { message_id: msg("msg_9"), part_id: part("msg_9", 0), delta: "Running ls.".into() },
            EngineEvent::ToolCallStarted {
                message_id: msg("msg_9"),
                part_id: part("msg_9", 1),
                call_id: "toolu_9".into(),
                name: "Bash".into(),
                input: json!({ "command": "ls -la" }),
                title: Some("$ ls -la".into()),
            },
            EngineEvent::ToolCallRunning { message_id: msg("msg_9"), part_id: part("msg_9", 1) },
        ]
    );
}

#[test]
fn a_finished_block_fills_in_deltas_that_were_lost() {
    let mut translator = Translator::new();
    let events = run(
        &mut translator,
        vec![
            stream(json!({ "type": "message_start", "message": { "id": "msg_3", "model": MODEL, "content": [], "usage": {} } })),
            stream(json!({ "type": "content_block_start", "index": 0, "content_block": { "type": "text", "text": "" } })),
            stream(json!({ "type": "content_block_delta", "index": 0, "delta": { "type": "text_delta", "text": "Hel" } })),
            assistant("msg_3", json!([{ "type": "text", "text": "Hello" }])),
        ],
    );
    assert_eq!(events.last(), Some(&EngineEvent::TextDelta { message_id: msg("msg_3"), part_id: part("msg_3", 0), delta: "lo".into() }));
}

#[test]
fn subagent_output_is_not_shown_as_the_main_transcript() {
    let mut translator = Translator::new();
    let mut nested = stream(json!({ "type": "message_start", "message": { "id": "msg_sub", "content": [] } }));
    nested["parent_tool_use_id"] = json!("toolu_parent");
    assert!(translator.translate(nested).is_empty());
    let mut nested_assistant = assistant("msg_sub", json!([{ "type": "text", "text": "inner" }]));
    nested_assistant["parent_tool_use_id"] = json!("toolu_parent");
    assert!(translator.translate(nested_assistant).is_empty());
}

#[test]
fn an_error_tool_result_lands_in_the_error_field() {
    let mut translator = Translator::new();
    run(&mut translator, vec![assistant("msg_4", json!([{ "type": "tool_use", "id": "toolu_4", "name": "Bash", "input": { "command": "false" } }]))]);
    let events = translator.translate(json!({ "type": "user", "message": { "role": "user", "content": [
        { "type": "tool_result", "tool_use_id": "toolu_4", "is_error": true, "content": [{ "type": "text", "text": "exit 1" }, { "type": "image", "source": {} }] }
    ] }, "parent_tool_use_id": null }));
    assert_eq!(
        events,
        vec![EngineEvent::ToolCallFinished {
            message_id: msg("msg_4"),
            part_id: part("msg_4", 0),
            output: None,
            error: Some("exit 1\n[image]".into()),
        }]
    );
    // A result for a call this session never saw is dropped, not invented.
    let events = translator.translate(json!({ "type": "user", "message": { "role": "user", "content": [
        { "type": "tool_result", "tool_use_id": "toolu_unknown", "content": "x" }
    ] }, "parent_tool_use_id": null }));
    assert!(events.is_empty());
}

#[test]
fn a_failed_result_is_an_error_unless_boss_interrupted() {
    let failed = json!({ "type": "result", "subtype": "error_during_execution", "is_error": true, "errors": ["Actual failure"], "total_cost_usd": 0.0, "usage": {} });
    let mut translator = Translator::new();
    let events = translator.translate(failed.clone());
    assert_eq!(events, vec![EngineEvent::Error { message: "Actual failure".into(), fatal: false }, EngineEvent::Status { busy: false }]);

    let mut translator = Translator::new();
    translator.set_interrupted(true);
    assert_eq!(translator.translate(failed.clone()), vec![EngineEvent::Status { busy: false }]);
    // The flag covers one result only.
    assert_eq!(translator.translate(failed).len(), 2);

    assert_eq!(result_error(&json!({ "type": "result", "subtype": "error_max_turns" })), "Claude Code failed.");
    assert_eq!(result_error(&json!({ "type": "result", "subtype": "success", "is_error": true, "result": "Invalid API key" })), "Invalid API key");
}

#[test]
fn a_permission_request_is_surfaced_and_answered() {
    let mut translator = Translator::new();
    run(&mut translator, vec![assistant("msg_5", json!([{ "type": "tool_use", "id": "toolu_5", "name": "Bash", "input": { "command": "rm -rf build" } }]))]);
    let events = translator.translate(json!({
        "type": "control_request", "request_id": "perm-1",
        "request": { "subtype": "can_use_tool", "tool_name": "Bash", "input": { "command": "rm -rf build" }, "tool_use_id": "toolu_5",
                     "permission_suggestions": [{ "type": "addRules", "behavior": "allow", "destination": "session", "rules": [{ "toolName": "Bash" }] }] }
    }));
    assert_eq!(
        events,
        vec![EngineEvent::PermissionRequested {
            request: RequestId::from_raw("perm-1"),
            tool: "Bash".into(),
            input: json!({ "command": "rm -rf build" }),
            title: Some("$ rm -rf build".into()),
            message_id: Some(msg("msg_5")),
        }]
    );
    let pending = translator.pending(&RequestId::from_raw("perm-1")).cloned().expect("pending");
    assert_eq!(pending.tool_use_id.as_deref(), Some("toolu_5"));

    // Allow without an edit echoes the original input, as the SDK does.
    let allow = permission_response(&pending, &PermissionDecision::Allow { updated_input: None });
    assert_eq!(
        allow,
        json!({ "type": "control_response", "response": { "subtype": "success", "request_id": "perm-1",
            "response": { "behavior": "allow", "updatedInput": { "command": "rm -rf build" }, "toolUseID": "toolu_5" } } })
    );
    let edited = permission_response(&pending, &PermissionDecision::Allow { updated_input: Some(json!({ "command": "rm -rf build/tmp" })) });
    assert_eq!(edited["response"]["response"]["updatedInput"], json!({ "command": "rm -rf build/tmp" }));

    let deny = permission_response(&pending, &PermissionDecision::Deny { reason: String::new() });
    assert_eq!(
        deny["response"]["response"],
        json!({ "behavior": "deny", "message": DENIED_MESSAGE, "interrupt": false, "toolUseID": "toolu_5" })
    );
    let deny = permission_response(&pending, &PermissionDecision::Deny { reason: "Not in this repo".into() });
    assert_eq!(deny["response"]["response"]["message"], "Not in this repo");

    assert!(translator.take_pending(&RequestId::from_raw("perm-1")).is_some());
    assert!(translator.pending(&RequestId::from_raw("perm-1")).is_none());
    assert!(translator.pending_requests().is_empty());
}

#[test]
fn a_permission_title_prefers_what_claude_sent() {
    let mut translator = Translator::new();
    let events = translator.translate(json!({
        "type": "control_request", "request_id": "perm-2",
        "request": { "subtype": "can_use_tool", "tool_name": "mcp__boss_thread_bus__boss_threads_send", "input": { "text": "hi" },
                     "tool_use_id": "toolu_x", "title": "Send a thread message", "display_name": "boss_thread_bus" }
    }));
    match &events[0] {
        EngineEvent::PermissionRequested { title, message_id, .. } => {
            assert_eq!(title.as_deref(), Some("Send a thread message"));
            assert_eq!(*message_id, None);
        }
        other => panic!("unexpected {other:?}"),
    }
}

#[test]
fn ask_user_question_is_a_question_and_answers_ride_back_in_the_input() {
    let questions = json!([
        { "question": "Which repository?", "header": "Repo", "options": [{ "label": "ralf", "description": "the page" }, { "label": "autofix" }], "multiSelect": false },
        { "question": "Which checks should run?", "header": "Checks", "options": ["a", "b", "c"], "multiSelect": true }
    ]);
    let mut translator = Translator::new();
    let events = translator.translate(json!({
        "type": "control_request", "request_id": "ask-1",
        "request": { "subtype": "can_use_tool", "tool_name": ASK_USER_TOOL, "input": { "questions": questions }, "tool_use_id": "toolu_q" }
    }));
    assert_eq!(
        events,
        vec![EngineEvent::QuestionAsked {
            request: RequestId::from_raw("ask-1"),
            prompt: "1. Which repository?\n2. Which checks should run?".into(),
            options: vec![],
        }]
    );
    let pending = translator.take_pending(&RequestId::from_raw("ask-1")).expect("pending");
    // Positional answers: a string or a list per question.
    let reply = permission_response(&pending, &PermissionDecision::Allow { updated_input: Some(json!(["ralf", ["a", "b"]])) });
    let updated = &reply["response"]["response"]["updatedInput"];
    assert_eq!(updated["questions"], questions, "questions travel back exactly as they arrived");
    assert_eq!(updated["answers"], json!({ "Which repository?": "ralf", "Which checks should run?": "a, b" }));
    assert_eq!(reply["response"]["response"]["behavior"], "allow", "a question is answered, not denied");

    // A skipped question is left out rather than sent as an empty string.
    let partial = question_input(&pending.input, &[vec![]]);
    assert_eq!(partial["answers"], json!({}));
    let first = question_input(&pending.input, &[vec!["ralf".into()]]);
    assert_eq!(first["answers"], json!({ "Which repository?": "ralf" }));
    // A stray answer has no question to attach to.
    let one = json!({ "questions": [questions[0].clone()] });
    let extra = question_input(&one, &[vec!["ralf".into()], vec!["a".into()]]);
    assert_eq!(extra["answers"], json!({ "Which repository?": "ralf" }));
    assert_eq!(extra["questions"].as_array().map(Vec::len), Some(1));
}

#[test]
fn a_single_question_carries_its_options() {
    let mut translator = Translator::new();
    let events = translator.translate(json!({
        "type": "control_request", "request_id": "ask-2",
        "request": { "subtype": "can_use_tool", "tool_name": ASK_USER_TOOL, "tool_use_id": "t",
                     "input": { "questions": [{ "question": "  Name?  ", "options": [{ "label": " x " }, "y", { "nope": 1 }, ""] }] } }
    }));
    assert_eq!(
        events,
        vec![EngineEvent::QuestionAsked { request: RequestId::from_raw("ask-2"), prompt: "Name?".into(), options: vec!["x".into(), "y".into()] }]
    );
}

#[test]
fn a_malformed_question_falls_back_to_a_permission_prompt() {
    assert_eq!(parse_questions("Bash", &json!({ "command": "ls" })), None);
    assert_eq!(parse_questions(ASK_USER_TOOL, &json!({})), None);
    assert_eq!(parse_questions(ASK_USER_TOOL, &json!({ "questions": "why" })), None);
    assert_eq!(parse_questions(ASK_USER_TOOL, &json!({ "questions": [] })), None);
    assert_eq!(parse_questions(ASK_USER_TOOL, &json!({ "questions": [{ "question": "   " }] })), None);
    let open = parse_questions(ASK_USER_TOOL, &json!({ "questions": [{ "question": "What should I name it?" }] })).unwrap();
    assert_eq!(open, vec![Question { question: "What should I name it?".into(), options: vec![] }]);

    let mut translator = Translator::new();
    let events = translator.translate(json!({
        "type": "control_request", "request_id": "ask-3",
        "request": { "subtype": "can_use_tool", "tool_name": ASK_USER_TOOL, "input": { "questions": [] }, "tool_use_id": "t" }
    }));
    assert!(matches!(events[0], EngineEvent::PermissionRequested { .. }));
}

#[test]
fn control_requests_boss_cannot_answer_get_a_reply() {
    let hook = json!({ "type": "control_request", "request_id": "h1", "request": { "subtype": "hook_callback", "callback_id": "hook_0", "input": {} } });
    assert_eq!(
        auto_reply(&hook),
        Some(json!({ "type": "control_response", "response": { "subtype": "error", "request_id": "h1", "error": "hook_callback is not supported by BOSS" } }))
    );
    let elicitation = json!({ "type": "control_request", "request_id": "e1", "request": { "subtype": "elicitation", "mcp_server_name": "x", "message": "?" } });
    assert_eq!(auto_reply(&elicitation).unwrap()["response"]["response"], json!({ "action": "decline" }));
    let permission = json!({ "type": "control_request", "request_id": "p1", "request": { "subtype": "can_use_tool", "tool_name": "Bash", "input": {} } });
    assert_eq!(auto_reply(&permission), None);
    assert_eq!(auto_reply(&json!({ "type": "assistant" })), None);
    // The translator ignores them too; only can_use_tool is the user's business.
    assert!(Translator::new().translate(hook).is_empty());
}

#[test]
fn a_rejected_control_request_is_reported() {
    let mut translator = Translator::new();
    let events = translator.translate(json!({ "type": "control_response", "response": { "subtype": "error", "request_id": "req_1_x", "error": "Unknown model" } }));
    assert_eq!(events, vec![EngineEvent::Error { message: "Claude Code rejected a control request: Unknown model".into(), fatal: false }]);
    let ok = translator.translate(json!({ "type": "control_response", "response": { "subtype": "success", "request_id": "req_2_x", "response": { "commands": [] } } }));
    assert!(ok.is_empty());
}

#[test]
fn init_reports_a_bus_that_did_not_connect() {
    let mut line = init_line();
    line["mcp_servers"] = json!([{ "name": "boss_thread_bus", "status": "failed" }, { "name": "other", "status": "failed" }]);
    let events = Translator::new().translate(line);
    assert_eq!(
        events,
        vec![
            EngineEvent::SessionReady { native_session_id: SESSION.into() },
            EngineEvent::Error { message: "Claude Code could not load BOSS agent tools: boss_thread_bus: failed".into(), fatal: false },
        ]
    );
    // A second init for the same session says nothing new.
    let mut translator = Translator::new();
    translator.translate(init_line());
    assert!(translator.translate(init_line()).is_empty());
}

#[test]
fn an_assistant_error_is_reported() {
    let mut line = assistant("msg_e", json!([{ "type": "text", "text": "Invalid API key" }]));
    line["error"] = json!("authentication_failed");
    let events = Translator::new().translate(line);
    assert_eq!(events.last(), Some(&EngineEvent::Error { message: "Invalid API key (authentication_failed)".into(), fatal: false }));
}

#[test]
fn unknown_lines_are_ignored() {
    let mut translator = Translator::new();
    assert!(translator.translate(json!({ "type": "keep_alive" })).is_empty());
    assert!(translator.translate(json!({ "type": "system", "subtype": "compact_boundary", "compact_metadata": { "trigger": "auto" } })).is_empty());
    assert!(translator.translate(json!({ "type": "system", "subtype": "status", "status": "compacting" })).is_empty());
    assert!(translator.translate(json!({ "nonsense": true })).is_empty());
    assert_eq!(
        translator.translate(json!({ "type": "system", "subtype": "status", "status": null, "compact_result": "failed", "compact_error": "too big" })),
        vec![EngineEvent::Error { message: "too big".into(), fatal: false }]
    );
}

// ---------------------------------------------------------------------------
// Outbound shapes

#[test]
fn initialize_carries_the_system_prompts() {
    let init = initialize_request("req_1_abc", None, None);
    assert_eq!(init, json!({ "type": "control_request", "request_id": "req_1_abc", "request": { "subtype": "initialize" } }));

    let coordinator = initialize_request("req_1_abc", Some("You are BOSS."), None);
    assert_eq!(coordinator["request"]["systemPrompt"], json!(["You are BOSS."]), "a full replacement is a one-element array");
    assert!(coordinator["request"].get("appendSystemPrompt").is_none());

    let builder = initialize_request("req_1_abc", None, Some("Brief."));
    assert_eq!(builder["request"]["appendSystemPrompt"], json!("Brief."));
    assert!(builder["request"].get("systemPrompt").is_none());
}

#[test]
fn control_requests_match_the_sdk() {
    assert_eq!(interrupt_request("r")["request"], json!({ "subtype": "interrupt" }));
    assert_eq!(set_permission_mode_request("r", PermissionMode::AcceptEdits)["request"], json!({ "subtype": "set_permission_mode", "mode": "acceptEdits" }));
    assert_eq!(set_permission_mode_request("r", PermissionMode::Bypass)["request"]["mode"], "bypassPermissions");
    assert_eq!(set_permission_mode_request("r", PermissionMode::Plan)["request"]["mode"], "plan");
    assert_eq!(set_permission_mode_request("r", PermissionMode::Default)["request"]["mode"], "default");
    assert_eq!(set_model_request("r", "opus")["request"], json!({ "subtype": "set_model", "model": "opus" }));
    assert_eq!(set_model_request("r", "opus")["request_id"], "r");
}

#[test]
fn a_user_message_carries_images_as_base64_blocks() {
    const PNG: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    let content = user_content("What is this?", &[ImageBlock { media_type: "image/png".into(), data: PNG.into() }], &[]);
    assert_eq!(
        content,
        vec![
            json!({ "type": "image", "source": { "type": "base64", "media_type": "image/png", "data": PNG } }),
            json!({ "type": "text", "text": "What is this?" }),
        ]
    );
    // Text alone is a single text block; an image alone is a single image block.
    assert_eq!(user_content("Hello", &[], &[]), vec![json!({ "type": "text", "text": "Hello" })]);
    assert_eq!(user_content("", &[ImageBlock { media_type: "image/png".into(), data: PNG.into() }], &[]).len(), 1);
    // A file Claude cannot read is named rather than dropped.
    assert_eq!(
        user_content("See attached", &[], &["report.pdf".into()]),
        vec![json!({ "type": "text", "text": "See attached\n[Attached file: report.pdf]" })]
    );
    assert!(user_content("", &[], &[]).is_empty());

    let message = user_message(vec![json!({ "type": "text", "text": "Hi" })], Some(SESSION));
    assert_eq!(
        message,
        json!({ "type": "user", "session_id": SESSION, "message": { "role": "user", "content": [{ "type": "text", "text": "Hi" }] }, "parent_tool_use_id": null })
    );
    assert_eq!(user_message(vec![], None)["session_id"], "");
}

// ---------------------------------------------------------------------------
// Command line

fn options() -> SessionOptions {
    SessionOptions {
        thread_id: ThreadId::from_raw("thr_1"),
        participant_id: ParticipantId::from_raw("who_1"),
        cwd: "/tmp/p".into(),
        model: None,
        permission_mode: PermissionMode::Default,
        resume: None,
        append_system_prompt: None,
        system_prompt: None,
        allowed_tools: None,
        bus: None,
    }
}

fn flag_value<'a>(args: &'a [String], flag: &str) -> Option<&'a str> {
    args.iter().position(|a| a == flag).and_then(|i| args.get(i + 1)).map(String::as_str)
}

#[test]
fn the_minimal_command_line_matches_the_sdk() {
    let args = build_args(&options());
    assert_eq!(
        args,
        vec![
            "--output-format",
            "stream-json",
            "--verbose",
            "--input-format",
            "stream-json",
            "--permission-prompt-tool",
            "stdio",
            "--include-partial-messages",
            "--setting-sources=project",
            "--permission-mode",
            "default",
        ]
    );
    assert!(!args.iter().any(|a| a.contains("user")), "the user's own settings file stays out");
    assert!(!args.iter().any(|a| a.contains("system-prompt")), "system prompts travel in initialize, not flags");
}

#[test]
fn every_option_has_a_flag() {
    let mut opts = options();
    opts.model = Some("opus".into());
    opts.resume = Some("abc-123".into());
    opts.permission_mode = PermissionMode::Bypass;
    opts.allowed_tools = Some(vec!["Read".into(), "Grep".into(), "Glob".into()]);
    opts.system_prompt = Some("ignored on the command line".into());
    opts.bus = Some(BusAccess {
        url: "http://127.0.0.1:4010".into(),
        token: "tok".into(),
        thread_id: ThreadId::from_raw("thr_1"),
        participant_id: ParticipantId::from_raw("who_1"),
    });
    let args = build_args(&opts);
    assert_eq!(flag_value(&args, "--model"), Some("opus"));
    assert!(args.contains(&"--resume=abc-123".to_owned()));
    assert_eq!(flag_value(&args, "--permission-mode"), Some("bypassPermissions"));
    assert!(args.contains(&"--allow-dangerously-skip-permissions".to_owned()));
    assert_eq!(flag_value(&args, "--tools"), Some("Read,Grep,Glob"));
    assert!(args.contains(&"--strict-mcp-config".to_owned()));
    assert_eq!(flag_value(&args, "--allowedTools"), Some("mcp__boss_thread_bus"));
    let config: Value = serde_json::from_str(flag_value(&args, "--mcp-config").expect("mcp config")).expect("inline json");
    assert_eq!(
        config,
        json!({ "mcpServers": { "boss_thread_bus": { "type": "http", "url": "http://127.0.0.1:4010/mcp",
            "headers": { "Authorization": "Bearer tok", "X-Boss-Thread": "thr_1", "X-Boss-Participant": "who_1" } } } })
    );
    assert!(!args.iter().any(|a| a.contains("ignored on the command line")));
}

#[test]
fn permission_modes_and_tool_lists_spell_the_way_the_cli_expects() {
    for (mode, expected) in [
        (PermissionMode::Default, "default"),
        (PermissionMode::AcceptEdits, "acceptEdits"),
        (PermissionMode::Plan, "plan"),
        (PermissionMode::Bypass, "bypassPermissions"),
    ] {
        let mut opts = options();
        opts.permission_mode = mode;
        let args = build_args(&opts);
        assert_eq!(flag_value(&args, "--permission-mode"), Some(expected));
        assert_eq!(args.contains(&"--allow-dangerously-skip-permissions".to_owned()), mode == PermissionMode::Bypass);
        assert_eq!(permission_mode_str(mode), expected);
    }
    let mut opts = options();
    opts.allowed_tools = Some(vec![]);
    assert_eq!(flag_value(&build_args(&opts), "--tools"), Some(""), "an empty list means no built-in tools, as in the SDK");
    assert!(!build_args(&options()).iter().any(|a| a == "--mcp-config"), "no bus, no MCP config");
}

#[test]
fn the_bus_url_gains_mcp_once() {
    let mut bus = BusAccess { url: "http://h:1/".into(), token: "t".into(), thread_id: ThreadId::from_raw("a"), participant_id: ParticipantId::from_raw("b") };
    assert_eq!(bus_url(&bus), "http://h:1/mcp");
    bus.url = "http://h:1/mcp".into();
    assert_eq!(bus_url(&bus), "http://h:1/mcp");
    assert_eq!(mcp_config(&bus)["mcpServers"]["boss_thread_bus"]["url"], "http://h:1/mcp");
    assert_eq!(ENTRYPOINT, ("CLAUDE_CODE_ENTRYPOINT", "sdk-ts"));
}

// ---------------------------------------------------------------------------
// Helpers

#[test]
fn tool_labels_name_the_argument_not_the_tool() {
    assert_eq!(tool_label("Bash", &json!({ "command": "  git   status\n" })), Some("$ git status".into()));
    assert_eq!(tool_label("Read", &json!({ "file_path": "/a/b/c/d.rs" })), Some("…/c/d.rs".into()));
    assert_eq!(tool_label("Read", &json!({ "file_path": "/a/b.rs" })), Some("/a/b.rs".into()));
    assert_eq!(tool_label("Grep", &json!({ "pattern": "todo", "path": "/x/y/z" })), Some("todo in …/y/z".into()));
    assert_eq!(tool_label("Grep", &json!({ "pattern": "todo" })), Some("todo".into()));
    assert_eq!(tool_label("Agent", &json!({ "description": "Find callers", "prompt": "long prompt" })), Some("Find callers".into()));
    assert_eq!(tool_label("Custom", &json!({ "only": "one string", "n": 3 })), Some("one string".into()));
    assert_eq!(tool_label("Custom", &json!({ "a": "x", "b": "y" })), None);
    assert_eq!(tool_label("Custom", &json!({})), None);
    assert_eq!(tool_label("Custom", &json!("not an object")), None);
    let long = "x".repeat(200);
    assert_eq!(tool_label("WebSearch", &json!({ "query": long })).map(|l| l.chars().count()), Some(120));
    assert_eq!(short_path("/a/b/c/"), "…/b/c");
}

#[test]
fn tool_result_text_flattens_blocks() {
    assert_eq!(tool_result_text(&json!("plain")), "plain");
    assert_eq!(tool_result_text(&json!([{ "type": "text", "text": "a" }, { "type": "text", "text": "b" }])), "a\nb");
    assert_eq!(tool_result_text(&Value::Null), "");
    assert_eq!(tool_result_text(&json!(42)), "42");
}

#[test]
fn version_and_models() {
    assert_eq!(parse_version("2.1.0 (Claude Code)\n"), Some("2.1.0 (Claude Code)".into()));
    assert_eq!(parse_version("\n\n"), None);
    let ids: Vec<String> = static_models().into_iter().map(|m| m.id).collect();
    assert_eq!(ids, vec!["sonnet", "opus", "fable", "haiku"]);
    assert!(static_models().iter().all(|m| m.provider.as_deref() == Some("anthropic")));
}
