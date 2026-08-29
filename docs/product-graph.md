# Product Graph RFC

**Status:** Initial contract
**Scope:** Product support foundation; no visible UI or persistence migration yet

## Decision

BOSS will add a Product Graph above its existing path-based execution model.
The graph represents Products, Components, Codebases, Checkouts, Environments,
Platforms, Deployments, Projects, Work Items, Runs, Rollouts, Signals,
Observations, Artifacts, Decisions, and derived Knowledge.

The existing `projectPath` contract remains the technical execution boundary
during migration. Its user-facing concept will eventually become a Codebase,
while the path selected for a thread becomes a Checkout.

## Why

BOSS currently organizes work as:

```text
folder → thread → agent → worktree → diff
```

That works for a coding task in one repository. It cannot faithfully represent
product work spanning several repositories, deployments, operational systems,
documents, decisions, rollout stages, and production signals.

The target lifecycle is:

```text
Plan → Code → Deploy → Monitor → Fix
  ↑                              │
  └──────── learn and refine ────┘
```

Product support comes before deployment mutations. Kubernetes, Terraform,
deployment, and observability connectors are useful only after BOSS can explain
which Product and Component a resource belongs to, why it is changing, which
environment is affected, and what evidence determines success.

## Privacy guardrail

BOSS is a personal project that may be used with private work. Bundled docs,
tests, screenshots, demos, evaluation fixtures, prompts, and reports must use
fictional or personal examples only. They must not contain employer product
names, repository names or paths, architecture details, operational data,
customer information, or copied internal documentation.

Private context discovered through a user connection remains local to that
connection and is not promoted into reusable fixtures or project documentation.
Future export and publishing flows must make the included Product Graph slice
and source receipts visible before anything leaves BOSS.

## Vocabulary

- **Product** — the long-lived customer-facing or internal product.
- **Component** — a deployable or operational part of a Product.
- **Codebase** — a logical source repository or directory-backed source root.
- **Checkout** — one local folder containing a Codebase. Main checkouts and
  worktrees are peers beneath the same Codebase.
- **Environment** — development, test, staging, production, or another delivery
  context.
- **Platform** — shared infrastructure such as a Kubernetes cluster, cloud
  account, or deployment system.
- **Deployment** — one Component running in an Environment.
- **Project** — work over time toward a defined outcome.
- **Work Item** — one unit of research, decision, design, code, QA,
  documentation, release, or operations work.
- **Run** — agents executing a Work Item through a Recipe.
- **Rollout** — staged delivery of a Project.
- **Signal** — a metric, monitor, alert, incident, feedback source, or related
  definition.
- **Observation** — a timestamped, optionally expiring value from a Signal or
  Deployment.
- **Artifact** — a plan, specification, diff, test result, review, report, PR,
  site, or deployment result.
- **Decision** — a proposed, accepted, rejected, or superseded product or
  technical choice.
- **Knowledge** — derived source-backed analysis, never unqualified canonical
  memory.

## Fictional multi-codebase example

```text
Product: Orbit (fictional)
  └─ Component: Gateway
      ├─ BUILT_FROM       ~/dev/orbit-app
      ├─ PACKAGED_BY      ~/dev/orbit-chart
      ├─ PROVISIONED_BY   ~/dev/orbit-infrastructure
      ├─ DEPLOYED_BY      ~/dev/orbit-release
      ├─ Deployment: Gateway staging
      │   ├─ RUNS_IN      staging
      │   └─ OBSERVED_BY  Beacon
      └─ Deployment: Gateway production
          ├─ RUNS_IN      production
          └─ OBSERVED_BY  Beacon
```

A feature Project may affect every Codebase and Deployment above. Coding Runs
remain isolated per Checkout, while the parent Project keeps one outcome,
rollout, and evidence trail.

## Identity and migration

### Existing contract

`projectScope(path)` already provides a useful migration seam:

- linked Git worktrees share one `projectId`;
- `projectPath` resolves to the main checkout;
- `executionPath` identifies the active checkout;
- non-Git folders receive a stable directory-derived identity;
- global threads have no repository scope.

### Compatibility projection

The initial compatibility function maps:

```text
projectId    → Codebase.id
projectPath  → main Checkout.path
executionPath/worktrees → additional Checkouts
```

It does not write storage or alter current behavior. It allows later storage
and UI work to compare the new representation with the existing source of
truth before a migration is enabled.

### Persistence envelope

The graph begins with an explicit version:

```ts
interface ProductGraph {
  version: 1
  nodes: ProductGraphNode[]
  relations: ProductGraphRelation[]
}
```

A main-process store now persists this envelope durably in the app data
directory and reloads it across restarts. Renderer access is a narrow typed
pair — read the current document, or replace it whole after runtime shape and
semantic validation; no partial writes and no user-visible Product surface yet.
Replacements are serialized and written through an atomic rename so competing
requests cannot leave memory and disk on different versions. The load rules are
deterministic: a missing file adopts the folder-project compatibility
projection (or starts empty when no project is known) without writing it; a
malformed file falls back to that same seed; an unknown schema version is
never adopted and stays on disk untouched until an explicit replace. A
persisted document that fails validation still loads, with its issues exposed
as advisories, while a refused replace changes nothing. Lifecycle, ownership,
and deletion rules for graph content remain open; existing state files stay
authoritative for folder projects.

## Relationships

Relations are directional and independently identified. The first contract
supports:

```text
contains       part-of          checkout-of
built-from     packaged-by      provisioned-by
deployed-by    depends-on       runs-in
observed-by    observation-of   affects
documented-by  produced-by      validated-by
supersedes
```

Validation rejects duplicate identities, missing endpoints, self-relations,
and invalid endpoints for relations whose semantics are already unambiguous.
More endpoint rules should be added only when the product contract is clear;
prematurely strict graph semantics would make migration harder.

## Trusted knowledge

BOSS should not maintain one opaque AI-written memory. It distinguishes:

1. **Authoritative context** — human-authored or externally owned Product
   purpose, documentation, runbooks, policy, ownership, and constraints.
2. **Decisions and history** — immutable records that may be superseded.
3. **Live observations** — connector data with timestamps and TTLs.
4. **Derived knowledge** — AI-generated analysis with source receipts.

A Knowledge source receipt records the source revision, files actually read,
their hashes, and optionally a discovery-scope hash that covers matching new
files. Freshness is evaluated deterministically:

- exact source revision: fresh;
- changed broad revision with identical discovery scope and input hashes:
  fresh;
- changed input or discovery scope: stale;
- unchanged scanned files without a discovery receipt after the repository
  revision changed: unknown;
- unreachable or unverifiable source: unknown.

The `unknown` state matters. File hashes alone cannot prove that a newly added
relevant file was not omitted.

AI may regenerate disposable derived Knowledge. Changes to authoritative
context, policy, and accepted Decisions require explicit promotion or approval.

## Agent context packs

Agents should receive a relevant graph slice, not every connected repository
and document. A future context pack should contain:

- Product and Project intent;
- affected Components and resources;
- applicable accepted Decisions and policy;
- fresh derived Knowledge;
- recent, non-expired operational Observations;
- links to authoritative sources;
- explicit stale or unknown context that must be reinspected.

The pack and every generated plan should retain the graph node ids and source
receipts used to produce it.

## Assistant role

The standing Assistant will operate on the same Product, Project, Work Item,
Run, Decision, and Rollout records shown in the UI. It should not maintain a
parallel chat-only task model.

Assistant is the user-facing coordination and attention surface. Durable
Workflows execute the cross-task state machine. They dispatch bounded agent
runs through a BOSS-owned runtime contract.

Lab remains valuable, but it is not the coordinator and is not a mandatory
pipe in front of every provider:

- **Assistant** decides what needs attention and helps shape work.
- **Workflows** durably sequence, retry, pause, ask, review, and record work.
- **Agent Runtime contract** defines run input, streamed events, permissions,
  capabilities, cancellation, result, and evidence independently of a vendor.
- **Backend adapters** translate that contract to Codex, Claude, OpenCode, Pi,
  Lab, or another runtime.
- **Lab** is the reference runtime and model testbed for OpenAI-compatible
  endpoints, plus the place to run controlled behavioral evaluations.

Provider-specific capabilities remain visible through negotiation rather than
being erased into a lowest-common-denominator API. A Workflow can require a
capability and fail routing before a run starts. A backend that does not support
the required permission, tool, image, steering, or session behavior is not an
eligible executor for that step.

The existing `Backend` interface and capability descriptors are the migration
seam. They should be narrowed into a workflow-facing `AgentRuntime` contract;
provider SDK objects and wire events stay inside adapters. SDK upgrades then
rerun the same deterministic adapter-conformance and behavior suites rather
than forcing Product or Workflow logic to change.

Testing has three distinct layers:

1. **Adapter conformance** — deterministic fixtures verify lifecycle,
   permissions, cancellation, events, and result normalization for every
   backend without judging model quality.
2. **Model behavior** — Lab runs the same task scenarios across selected local
   and hosted models, recording tool use, changed files, tests, cost, and time.
3. **Factory behavior** — Assistant and Workflow scenarios verify planning,
   routing, approvals, retries, evidence, and rollout gates end to end.

Pi stays only if it satisfies useful capability profiles. A backend is not
required to imitate features it cannot safely support, and removing an adapter
does not change the Product Graph or Workflow model.

During this refactor, its bounded coordination role is:

1. read this RFC before proposing work;
2. preserve the privacy guardrail in every prompt, fixture, report, and task;
3. select one vertical slice at a time;
4. surface unresolved product decisions rather than guessing;
5. delegate implementation into isolated worktrees;
6. request independent review;
7. maintain durable progress and evidence;
8. avoid broad navigation or visual rewrites before identity and migration
   contracts are tested.

The ready-to-use coordination prompt is in
`docs/product-graph-assistant-brief.md`.

## Delivery sequence

1. Shared graph types, validation, knowledge freshness, and compatibility
   projection.
2. Versioned persistence and migration tests.
3. Product Graph editor and default single-Codebase Product experience.
4. Project and Work Item records linked to existing threads, workflows,
   reports, PRs, CI incidents, and worktrees.
5. Multi-Codebase planning, execution, and evidence aggregation.
6. Manual Rollouts, Environments, Deployments, Signals, and observation gates.
7. Read-only deployment and observability integrations.
8. Controlled deployment and closed-loop remediation.

## Explicit non-goals for the first slice

- Renaming the sidebar before the replacement Product/Project surfaces exist.
- Persisting a second source of truth beside current project state.
- Executing Kubernetes, Terraform, or deployment mutations.
- Automatically rewriting canonical product documentation.
- Building a generic CMDB or a full Linear/Jira replacement.

## Open questions

1. Is Product the highest visible scope, or is Workspace/Organization needed?
2. Can a Project affect multiple Products?
3. Is Component broad enough for deployable services and non-deployable
   modules, or should those split?
4. Which graph changes require human approval?
5. How are shared Environments and Platforms owned across Products?
6. Which external system is the first read-only integration after Product
   support: Kubernetes, GitHub Actions, Terraform, or an observability system?
7. Which fictional or personal Project fixture should validate the model first?
