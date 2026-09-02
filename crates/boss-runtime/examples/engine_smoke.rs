//! Drive one real engine binary end to end and print every event.
//!
//! `cargo run -p boss-runtime --example engine_smoke -- <claude|codex|opencode|pi> [prompt]`
//!
//! Flags: `--mode <default|accept-edits|bypass|plan>` (default `bypass`) and
//! `--allow`, which answers every `PermissionRequested` with `Allow`.

use anyhow::{Result, bail};
use boss_core::{
    Engine, EngineEvent, EngineId, ParticipantId, PermissionDecision, PermissionMode, Prompt, Session, SessionOptions, ThreadId,
};
use boss_engines::claude::ClaudeEngine;
use boss_engines::codex::CodexEngine;
use boss_engines::opencode::OpencodeEngine;
use boss_engines::pi::PiEngine;
use std::sync::Arc;
use std::time::{Duration, Instant};

const DEFAULT_PROMPT: &str =
    "Reply with exactly one word: pong. Then read the file hello.txt in the current directory and quote its contents.";
const BUDGET: Duration = Duration::from_secs(90);

struct Args {
    engine: EngineId,
    prompt: String,
    mode: PermissionMode,
    allow: bool,
}

fn parse_args() -> Result<Args> {
    let mut engine = None;
    let mut prompt = None;
    let mut mode = PermissionMode::Bypass;
    let mut allow = false;
    let mut argv = std::env::args().skip(1);
    while let Some(arg) = argv.next() {
        match arg.as_str() {
            "--allow" => allow = true,
            "--mode" => {
                let value = argv.next().unwrap_or_default();
                mode = match value.as_str() {
                    "default" => PermissionMode::Default,
                    "accept-edits" => PermissionMode::AcceptEdits,
                    "bypass" => PermissionMode::Bypass,
                    "plan" => PermissionMode::Plan,
                    other => bail!("unknown --mode {other:?}"),
                };
            }
            _ if engine.is_none() => {
                engine = Some(match arg.as_str() {
                    "claude" => EngineId::Claude,
                    "codex" => EngineId::Codex,
                    "opencode" => EngineId::Opencode,
                    "pi" => EngineId::Pi,
                    other => bail!("unknown engine {other:?}; want claude|codex|opencode|pi"),
                });
            }
            _ => prompt = Some(arg),
        }
    }
    let Some(engine) = engine else { bail!("usage: engine_smoke <claude|codex|opencode|pi> [prompt] [--mode M] [--allow]") };
    Ok(Args { engine, prompt: prompt.unwrap_or_else(|| DEFAULT_PROMPT.to_owned()), mode, allow })
}

/// The built engine, plus the opencode handle when that is the one we built:
/// its servers outlive the session and have to be stopped by name.
fn build(id: EngineId) -> (Arc<dyn Engine>, Option<Arc<OpencodeEngine>>) {
    match id {
        EngineId::Claude => (Arc::new(ClaudeEngine::new(None)), None),
        EngineId::Codex => (Arc::new(CodexEngine::new()), None),
        EngineId::Opencode => {
            let oc = Arc::new(OpencodeEngine::new());
            (oc.clone(), Some(oc))
        }
        EngineId::Pi => (Arc::new(PiEngine::new()), None),
    }
}

/// Trim long ids and collapse whitespace so one event fits on one line.
fn short(id: &str) -> String {
    let tail: String = id.chars().rev().take(6).collect::<Vec<_>>().into_iter().rev().collect();
    format!("…{tail}")
}

fn clip(text: &str, max: usize) -> String {
    let flat = text.replace('\n', "\\n");
    if flat.chars().count() <= max { flat } else { format!("{}…", flat.chars().take(max).collect::<String>()) }
}

fn line(event: &EngineEvent) -> String {
    match event {
        EngineEvent::SessionReady { native_session_id } => format!("SessionReady {}", short(native_session_id)),
        EngineEvent::MessageStarted { message_id, role } => format!("MessageStarted {} role={role:?}", short(message_id.as_str())),
        EngineEvent::TextDelta { part_id, delta, .. } => format!("TextDelta {} {:?}", short(part_id.as_str()), clip(delta, 80)),
        EngineEvent::ReasoningDelta { part_id, delta, .. } => {
            format!("ReasoningDelta {} {:?}", short(part_id.as_str()), clip(delta, 60))
        }
        EngineEvent::ToolCallStarted { part_id, name, input, .. } => {
            format!("ToolCallStarted {} {name} {}", short(part_id.as_str()), clip(&input.to_string(), 100))
        }
        EngineEvent::ToolCallInputDelta { part_id, delta, .. } => {
            format!("ToolCallInputDelta {} {}", short(part_id.as_str()), clip(delta, 40))
        }
        EngineEvent::ToolCallRunning { part_id, .. } => format!("ToolCallRunning {}", short(part_id.as_str())),
        EngineEvent::ToolCallFinished { part_id, output, error, .. } => format!(
            "ToolCallFinished {} out={:?} err={:?}",
            short(part_id.as_str()),
            output.as_deref().map(|o| clip(o, 60)),
            error.as_deref().map(|e| clip(e, 60))
        ),
        EngineEvent::MessageCompleted { message_id, usage, model } => format!(
            "MessageCompleted {} model={model:?} usage={}",
            short(message_id.as_str()),
            usage.as_ref().map_or("none".into(), |u| format!("{}in/{}out", u.input_tokens, u.output_tokens))
        ),
        EngineEvent::PermissionRequested { request, tool, input, .. } => {
            format!("PermissionRequested {} tool={tool} {}", request, clip(&input.to_string(), 100))
        }
        EngineEvent::QuestionAsked { request, prompt, options } => {
            format!("QuestionAsked {} {:?} options={options:?}", request, clip(prompt, 60))
        }
        EngineEvent::RequestWithdrawn { request } => format!("RequestWithdrawn {request}"),
        EngineEvent::Todos { items } => format!("Todos {} items", items.len()),
        EngineEvent::Status { busy } => format!("Status busy={busy}"),
        EngineEvent::Error { message, fatal } => format!("Error fatal={fatal} {:?}", clip(message, 200)),
        EngineEvent::Closed => "Closed".to_owned(),
    }
}

#[tokio::main(flavor = "multi_thread", worker_threads = 4)]
async fn main() -> Result<()> {
    let args = parse_args()?;
    let (engine, opencode) = build(args.engine);

    let probe = engine.probe().await?;
    println!("engine   {}", args.engine.as_str());
    println!("exe      {:?}", engine.executable());
    println!("probe    {}", serde_json::to_string(&probe)?);
    if !probe.installed {
        println!("RESULT   not installed");
        return Ok(());
    }
    match engine.list_models().await {
        Ok(models) => {
            for m in models.iter().take(5) {
                println!("model    {} ({}) provider={:?}", m.id, m.label, m.provider);
            }
            println!("models   {} total", models.len());
        }
        Err(err) => println!("models   FAILED: {err:#}"),
    }

    let dir = tempfile::tempdir()?;
    std::fs::write(dir.path().join("hello.txt"), "the pineapple is on the roof\n")?;
    println!("cwd      {}", dir.path().display());

    let opts = SessionOptions {
        thread_id: ThreadId::new(),
        participant_id: ParticipantId::new(),
        cwd: dir.path().to_path_buf(),
        model: None,
        permission_mode: args.mode,
        resume: None,
        append_system_prompt: None,
        system_prompt: None,
        allowed_tools: None,
        bus: None,
    };
    println!("mode     {:?} allow={}", args.mode, args.allow);

    let session: Arc<dyn Session> = match engine.start_session(opts).await {
        Ok(s) => Arc::from(s),
        Err(err) => {
            println!("RESULT   start_session failed: {err:#}");
            std::process::exit(1);
        }
    };
    let events = session.events();
    println!("prompt   {:?}", args.prompt);
    if let Err(err) = session.send(Prompt { text: args.prompt.clone(), attachments: vec![] }).await {
        println!("RESULT   send failed: {err:#}");
        session.close().await.ok();
        std::process::exit(1);
    }

    let started = Instant::now();
    let mut completed = false;
    let mut idle = false;
    let mut saw_text = String::new();
    let mut errors: Vec<String> = Vec::new();
    let mut tools = 0usize;
    let mut permissions = 0usize;
    let mut ok = false;

    while started.elapsed() < BUDGET {
        let left = BUDGET.saturating_sub(started.elapsed());
        let Ok(next) = tokio::time::timeout(left, events.recv()).await else { break };
        let Ok(event) = next else { break };
        println!("[{:>5.1}s] {}", started.elapsed().as_secs_f32(), line(&event));
        match &event {
            EngineEvent::TextDelta { delta, .. } => saw_text.push_str(delta),
            EngineEvent::MessageCompleted { .. } => completed = true,
            EngineEvent::Status { busy } => idle = !busy,
            EngineEvent::ToolCallStarted { .. } => tools += 1,
            EngineEvent::Error { message, .. } => errors.push(message.clone()),
            EngineEvent::PermissionRequested { request, .. } => {
                permissions += 1;
                if args.allow {
                    let decision = PermissionDecision::Allow { updated_input: None };
                    match session.respond_permission(request.clone(), decision).await {
                        Ok(()) => println!("         -> allowed {request}"),
                        Err(err) => println!("         -> respond_permission failed: {err:#}"),
                    }
                }
            }
            EngineEvent::Closed => break,
            _ => {}
        }
        if completed && idle {
            ok = true;
            break;
        }
    }

    println!("---");
    println!("text     {:?}", clip(saw_text.trim(), 300));
    println!("tools    {tools}");
    println!("permissions {permissions}");
    for message in &errors {
        println!("error    {message}");
    }
    // A turn that ends without a word or a tool call did nothing, however
    // tidily it finished; that is a failed smoke test, not a pass.
    let produced = !saw_text.trim().is_empty() || tools > 0;
    ok = ok && produced && errors.is_empty();
    session.close().await.ok();
    // opencode's server outlives its sessions; stop it so no child is left running.
    if let Some(oc) = &opencode {
        oc.shutdown().await;
    }

    if ok {
        println!("RESULT   ok in {:.1}s", started.elapsed().as_secs_f32());
        Ok(())
    } else {
        println!(
            "RESULT   FAILED after {:.1}s (completed={completed} idle={idle} produced={produced} errors={})",
            started.elapsed().as_secs_f32(),
            errors.len()
        );
        std::process::exit(1);
    }
}
