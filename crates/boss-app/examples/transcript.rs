//! A window with a `ThreadPane` over a synthetic 5,000-message thread, with
//! an assistant reply streaming at ~40 tokens/second through the coalescer.
//!
//! Run: `./scripts/cargo run -p boss-app --example transcript`
//! Prints render statistics to stderr once a second.

use boss_app::model::ThreadModel;
use boss_app::transcript::coalesce::{self, Batched};
use boss_app::transcript::{ComposerEvent, ThreadPane, TranscriptEvent};
use boss_core::*;
use boss_core::Role;
use gpui::*;
use gpui_component::Root;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

const PRELOAD: usize = 5_000;
const TOKENS_PER_SECOND: u64 = 40;

const REPLY: &str = "Here is what I found while looking through the transcript code.\n\n\
The list is **bottom-aligned** and measured lazily, so the five thousand messages above this one \
cost nothing until you scroll to them. Each token arriving here bumps only this message's revision; \
the render cache keeps every other message's markdown untouched.\n\n\
```rust\nfn apply(model: &mut ThreadModel, batch: Vec<Batched>) {\n    for (author, event) in batch {\n        model.apply(author.as_ref(), event);\n    }\n}\n```\n\n\
Commits are coalesced to at most eight per second, which is why the text advances in small steps \
rather than one glyph at a time. Scroll up while this streams and the list stops following; a \
*Jump to latest* button appears until you come back down.\n\n\
- Turn grouping keeps consecutive replies from one author together.\n\
- A different author starts a new turn.\n\
- Tool calls render as cards with a state badge.\n\n\
That is the whole story; the rest is layout.";

struct StartStream;

fn main() {
    tracing_subscriber::fmt().with_env_filter(tracing_subscriber::EnvFilter::from_default_env()).init();
    let app = gpui_platform::application().with_assets(gpui_component_assets::Assets);
    app.run(move |cx| {
        gpui_component::init(cx);

        let (thread, participants, messages) = synthetic_thread();
        let builder = participants[0].id.clone();
        let model = cx.new(|_| ThreadModel::new(thread, participants, messages));

        let (event_tx, event_rx) = async_channel::unbounded::<Batched>();
        coalesce::drive(model.clone(), event_rx, coalesce::MAX_COMMITS_PER_SECOND, cx).detach();

        let (start_tx, start_rx) = async_channel::unbounded::<StartStream>();
        let stop = Arc::new(AtomicBool::new(false));
        cx.spawn({
            let stop = stop.clone();
            async move |cx| stream_replies(event_tx, start_rx, stop, builder, cx).await
        })
        .detach();
        start_tx.try_send(StartStream).ok();

        cx.spawn(async move |cx| {
            let options = WindowOptions {
                titlebar: Some(TitlebarOptions { title: Some("BOSS transcript".into()), ..Default::default() }),
                ..Default::default()
            };
            cx.open_window(options, |window, cx| {
                let pane = cx.new(|cx| ThreadPane::new(model.clone(), window, cx));
                let start_tx = start_tx.clone();
                let stop = stop.clone();
                let events_model = model.clone();
                cx.subscribe(&pane, move |_, event: &ComposerEvent, cx| match event {
                    ComposerEvent::Send { text, recipient, attachments } => {
                        eprintln!("send to {recipient:?} with {} attachment(s): {text:?}", attachments.len());
                        events_model.update(cx, |m, cx| {
                            m.push_user_message(text.clone(), recipient.clone(), Vec::new());
                            cx.notify();
                        });
                        start_tx.try_send(StartStream).ok();
                    }
                    ComposerEvent::Permission { request, decision, always } => {
                        eprintln!("permission {request}: {decision:?} always={always}");
                        events_model.update(cx, |m, cx| {
                            m.resolve_request(request);
                            cx.notify();
                        });
                    }
                    ComposerEvent::Answer { request, option } => {
                        eprintln!("answer {request}: {option}");
                        events_model.update(cx, |m, cx| {
                            m.resolve_request(request);
                            cx.notify();
                        });
                    }
                    ComposerEvent::Interrupt => {
                        eprintln!("interrupt");
                        stop.store(true, Ordering::Relaxed);
                    }
                })
                .detach();
                cx.subscribe(&pane, |_, event: &TranscriptEvent, _| eprintln!("transcript event: {event:?}")).detach();

                let weak = pane.downgrade();
                cx.spawn(async move |cx| {
                    loop {
                        cx.background_executor().timer(Duration::from_secs(1)).await;
                        let Ok((stats, following, turns)) = weak.update(cx, |pane, cx| {
                            pane.transcript().update(cx, |t, _| (t.take_stats(), t.is_following(), t.turn_count()))
                        }) else {
                            break;
                        };
                        if stats.items_rendered > 0 {
                            eprintln!(
                                "transcript: {turns} turns | {} items rendered in {:.2} ms ({:.0} µs/item) | cache hits {} misses {} | following={following}",
                                stats.items_rendered,
                                stats.item_render_micros as f64 / 1000.0,
                                stats.item_render_micros as f64 / stats.items_rendered as f64,
                                stats.cache_hits,
                                stats.cache_misses,
                            );
                        }
                    }
                })
                .detach();

                cx.new(|cx| Root::new(pane, window, cx))
            })
            .expect("open window");
        })
        .detach();
        cx.activate(true);
    });
}

/// Streams one assistant reply per `StartStream`, one token every 25 ms,
/// with a tool call and a permission request along the way.
async fn stream_replies(
    tx: async_channel::Sender<Batched>,
    starts: async_channel::Receiver<StartStream>,
    stop: Arc<AtomicBool>,
    author: ParticipantId,
    cx: &mut AsyncApp,
) {
    let tokens: Vec<&str> = REPLY.split_inclusive(' ').collect();
    let gap = Duration::from_millis(1000 / TOKENS_PER_SECOND);
    while starts.recv().await.is_ok() {
        stop.store(false, Ordering::Relaxed);
        let who = Some(author.clone());
        let message_id = MessageId::new();
        let text_part = PartId::new();
        let tool_part = PartId::new();
        let send = |event: EngineEvent| tx.send((who.clone(), event));

        let _ = send(EngineEvent::Status { busy: true }).await;
        let _ = send(EngineEvent::MessageStarted { message_id: message_id.clone(), role: Role::Assistant }).await;
        for (i, token) in tokens.iter().enumerate() {
            if stop.load(Ordering::Relaxed) {
                break;
            }
            if i == 12 {
                let _ = send(EngineEvent::ToolCallStarted {
                    message_id: message_id.clone(),
                    part_id: tool_part.clone(),
                    call_id: "call_1".into(),
                    name: "Read".into(),
                    input: serde_json::json!({ "path": "crates/boss-app/src/transcript/view.rs" }),
                    title: Some("crates/boss-app/src/transcript/view.rs".into()),
                })
                .await;
                let _ = send(EngineEvent::ToolCallRunning { message_id: message_id.clone(), part_id: tool_part.clone() }).await;
            }
            if i == 30 {
                let output = (1..=40).map(|n| format!("{n:>4}  // line {n} of view.rs")).collect::<Vec<_>>().join("\n");
                let _ = send(EngineEvent::ToolCallFinished { message_id: message_id.clone(), part_id: tool_part.clone(), output: Some(output), error: None }).await;
            }
            if i == 60 {
                let _ = send(EngineEvent::PermissionRequested {
                    request: RequestId::new(),
                    tool: "Edit".into(),
                    input: serde_json::json!({ "path": "crates/boss-app/src/transcript/view.rs", "old": "px_5()", "new": "px_6()" }),
                    title: Some("Widen the gutter".into()),
                    message_id: Some(message_id.clone()),
                })
                .await;
            }
            let _ = send(EngineEvent::TextDelta { message_id: message_id.clone(), part_id: text_part.clone(), delta: (*token).to_owned() }).await;
            cx.background_executor().timer(gap).await;
        }
        let _ = send(EngineEvent::MessageCompleted {
            message_id,
            usage: Some(Usage { input_tokens: 1200, output_tokens: tokens.len() as u64, ..Default::default() }),
            model: Some("synthetic".into()),
        })
        .await;
        let _ = send(EngineEvent::Status { busy: false }).await;
    }
}

const SAMPLES: [&str; 5] = [
    "Looked at the failing test. The assertion compares a `Vec<Turn>` built from a fresh model against one built after a `touch()`; the revisions differ, so the test is right and the code is wrong.",
    "## Plan\n\n1. Read the list element.\n2. Port the follow-tail logic.\n3. Wire the coalescer.\n\nNothing here needs a new dependency.",
    "Here is the fix:\n\n```rust\nlet prefix_matches = old.iter().zip(&new).all(|(a, b)| a.key == b.key);\nif prefix_matches {\n    list_state.splice(old.len()..old.len(), new.len() - old.len());\n}\n```\n\nSplicing at the tail keeps `logical_scroll_top` stable.",
    "Short reply: yes, that is the intended behaviour. Inline `code` and a [link](https://example.com) render too.",
    "| item | cost |\n|---|---|\n| parse | once per revision |\n| layout | visible items only |\n| paint | every frame |\n\nThe table is measured like any other block.",
];

fn synthetic_thread() -> (Thread, Vec<Participant>, Vec<Message>) {
    let thread_id = ThreadId::from_raw("thr_example");
    let now = time::OffsetDateTime::now_utc();
    let thread = Thread {
        id: thread_id.clone(),
        project_id: ProjectId::from_raw("prj_example"),
        title: "Transcript stress test".into(),
        kind: ThreadKind::Room { room_id: RoomId::from_raw("room_example") },
        created_at: now - time::Duration::seconds(PRELOAD as i64),
        updated_at: now,
        cwd: ".".into(),
        archived: false,
    };
    let builder = Participant { id: ParticipantId::from_raw("who_builder"), name: "Builder".into(), engine: EngineId::Claude, model: None, is_boss: false, native_session_id: None };
    let reviewer = Participant { id: ParticipantId::from_raw("who_reviewer"), name: "Reviewer".into(), engine: EngineId::Codex, model: None, is_boss: false, native_session_id: None };

    let mut messages = Vec::with_capacity(PRELOAD);
    let mut last_user: Option<MessageId> = None;
    for i in 0..PRELOAD {
        let author = if (i / 6) % 2 == 0 { &builder } else { &reviewer };
        let role = if i % 6 == 0 { Role::User } else { Role::Assistant };
        let mut msg = Message::new(thread_id.clone(), role);
        msg.id = MessageId::from_raw(format!("msg_{i:05}"));
        msg.created_at = now - time::Duration::seconds((PRELOAD - i) as i64 * 7);
        msg.status = MessageStatus::Complete;
        msg.revision = 1;
        match role {
            Role::User => {
                msg.recipient = Some(author.id.clone());
                msg.parts.push(Part::Text(TextPart { id: PartId::from_raw(format!("prt_{i}_t")), text: format!("Question {}: does turn grouping hold up after message {i}?", i / 6) }));
                if i % 96 == 0 {
                    msg.parts.push(Part::Attachment(AttachmentPart { id: PartId::from_raw(format!("prt_{i}_a")), mime: "text/plain".into(), source: "/tmp/notes.txt".into(), name: Some("notes.txt".into()) }));
                }
                if i % 50 == 49 {
                    msg.branch_of = last_user.clone();
                } else {
                    last_user = Some(msg.id.clone());
                }
            }
            _ => {
                msg.author = Some(author.id.clone());
                if i % 11 == 5 {
                    msg.parts.push(Part::Reasoning(ReasoningPart { id: PartId::from_raw(format!("prt_{i}_r")), text: "Considering whether the cache key needs the part id as well as the message revision. It does not: the revision covers every part.".into() }));
                }
                msg.parts.push(Part::Text(TextPart { id: PartId::from_raw(format!("prt_{i}_t")), text: SAMPLES[i % SAMPLES.len()].to_owned() }));
                if i % 7 == 3 {
                    let failed = i % 21 == 3;
                    msg.parts.push(Part::ToolCall(ToolCallPart {
                        id: PartId::from_raw(format!("prt_{i}_c")),
                        call_id: format!("call_{i}"),
                        name: if i % 2 == 0 { "Bash".into() } else { "Read".into() },
                        input: serde_json::json!({ "command": format!("cargo test -p boss-app -- turn_{i}") }),
                        state: if failed { ToolState::Error } else { ToolState::Done },
                        title: Some(format!("cargo test … turn_{i}")),
                        output: Some((1..=25).map(|n| format!("test turns::case_{n} ... ok")).collect::<Vec<_>>().join("\n")),
                        error: failed.then(|| "exit status 101".to_owned()),
                    }));
                }
            }
        }
        messages.push(msg);
    }
    let mut system = Message::new(thread_id, Role::System);
    system.id = MessageId::from_raw("msg_system");
    system.status = MessageStatus::Error;
    system.parts.push(Part::Text(TextPart { id: PartId::from_raw("prt_system"), text: "Reviewer's session ended unexpectedly (exit 1). It will be restarted on the next message.".into() }));
    messages.push(system);
    (thread, vec![builder, reviewer], messages)
}
