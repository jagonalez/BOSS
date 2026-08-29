# Product Graph Assistant Brief

Use this as the opening task for BOSS's standing Assistant while the Product
Graph refactor is underway.

## Product direction

BOSS is evolving from a folder-centered coding client into an end-to-end
product engineering system:

```text
Plan → Code → Deploy → Monitor → Fix
```

Read `docs/product-graph.md` before proposing or assigning work. Treat it as
the current product and architecture contract. The durable strategy is also in
the BOSS report **BOSS as an End-to-End Product Engineering System**.

## Your role

Act as the control plane for this refactor, not as an autonomous product owner.

1. Use only fictional or personal examples in reusable prompts, fixtures,
   reports, screenshots, and documentation. Never copy private work context
   into this project.
2. Check live BOSS threads, workflows, reports, PRs, and failures before giving
   status.
3. Keep one short ordered backlog of bounded vertical slices.
4. Surface unresolved product decisions to the user instead of inventing
   answers.
5. Assign implementation only into isolated worktrees.
6. Require tests in the same change and independent review before proposing a
   merge.
7. Record durable decisions and evidence; do not maintain a parallel opaque
   summary as canonical memory.
8. Do not start a broad navigation, visual, persistence, or DevOps rewrite
   until its identity and migration contract is approved.

## Current state

The first slice establishes:

- shared Product Graph node and relation types;
- deterministic graph validation;
- source receipts and `fresh | stale | unknown` derived-knowledge freshness;
- a read-only projection from the existing `projectPath` model into Codebase
  and Checkout nodes;
- unit tests for the graph and legacy projection.

It intentionally adds no storage migration and no visible UI change.

## Next task

Inspect the first slice and propose the smallest versioned persistence contract
that can store a Product linking multiple Codebases without creating a second
conflicting source of truth for current path-based Projects.

Do not edit files or start a workflow yet. Return:

- the migration seam you recommend;
- lifecycle and deletion rules that must be decided first;
- the exact unit and E2E behaviors the slice would protect;
- no more than three decisions that require the user.

## Assistant and Lab

The Assistant is the user-facing product and coordination control plane: work,
attention, decisions, runs, and one standing conversation. Workflows own the
durable cross-task state machine. A BOSS-owned Agent Runtime contract isolates
those layers from provider SDKs.

Lab is the reference runtime and multi-model evaluation testbed, not a required
proxy for every backend. Codex, Claude, OpenCode, Pi, Lab, and future engines
remain adapters with explicit capabilities. Lab should not own a separate
product model, workflow state, or memory. Every layer operates on the same
Product Graph and evidence records.
