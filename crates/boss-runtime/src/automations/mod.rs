//! Workflows and automations: everything BOSS runs unattended.
//!
//! Port of the Electron control planes in `src/main/`:
//!
//! - `cron`   — five-field local-time cron (`cron.ts`).
//! - `types`  — the on-disk and wire shapes (`src/shared/workflow.ts`,
//!              `automation.ts`, `automation-trigger.ts`).
//! - `store`  — JSON persistence for both (`workflow-store.ts` and the
//!              persistence half of `automation-manager.ts`).
//! - `bus`    — durable subscriptions and the tick that fires them
//!              (`event-bus.ts`).
//! - `github` — webhook deliveries to prompt variables and `BossEvent`s
//!              (`automation-trigger.ts`, `workflow-events.ts`).
//! - `engine` — the workflow journal, replay, and the scheduler
//!              (`workflow-engine.ts`).
//! - `manager`— the automation run loop (`automation-manager.ts`).
//! - `host`   — what these engines need from the rest of BOSS
//!              (`workflow-host.ts`), and the `Runtime` implementation.
//!
//! Every on-disk format is byte-compatible with the Electron files, so a
//! user's `workflows.json`, `workflow-runs.json`,
//! `workflow-subscriptions.json`, `automations.json`, and
//! `automation-runs.json` load unchanged.

pub mod bus;
pub mod cron;
pub mod engine;
pub mod github;
pub mod host;
pub mod manager;
pub mod runtime_host;
pub mod store;
pub mod types;

pub use bus::EventBus;
pub use engine::WorkflowEngine;
pub use host::{AgentOutcome, AgentRequest, AutomationHost, Notice, RunOutcome, WorkflowHost};
pub use manager::AutomationManager;
pub use runtime_host::RuntimeHost;
pub use store::{AutomationStore, WorkflowStore};
pub use types::*;
