# Hermes backend — implementation plan

Add Hermes Agent (Nous Research) as a fifth BOSS backend, alongside opencode,
codex, claude, and pi.

## Why a backend, not a provider

Hermes is an agent harness, not a model. It owns sessions, tools, permissions,
and its own model selection across 300+ models. That makes it a peer to codex
and claude, not something to configure inside opencode.

## Transport

Hermes speaks ACP (Agent Client Protocol) — JSON-RPC 2.0 over stdio, NDJSON
framed, stdout reserved for protocol traffic and stderr for logs.

    hermes acp

This is the same shape as `codex app-server --stdio`, so `codex-backend.ts` is
the working template: line framing, the `pending` map, and the
request/notify/respond helpers all carry over.

ACP is a published standard rather than a Hermes-specific protocol. A clean
implementation is reusable for any other ACP agent later.

## Method mapping

| Backend method | ACP call | Notes |
|---|---|---|
| `start()` | `initialize` | Exchange capabilities; read `agentCapabilities.loadSession` |
| `stop()` | kill process | No ACP shutdown method |
| `sessionCreate()` | `session/new` | Takes `cwd`; returns `sessionId` and available modes |
| `sessionGet()` | `session/load` | Only if `agentCapabilities.loadSession` is true |
| `sendMessage()` | `session/prompt` | Content blocks: text, image, resource |
| `abort()` | `session/cancel` | Notification, not a request |
| `thinkingSet()` | `session/set_mode` | Hermes modes are permission levels, not thinking depth — see below |
| `permissionRespond()` | answer `session/request_permission` | Agent calls *us*; we respond |
| `modelsList()` | read `session/new` result | Models arrive with the session, not from a separate call |

Verified against `hermes acp` v0.20.0 (2026.8.3). The handshake returns:

    agentCapabilities: {
      loadSession: true,
      promptCapabilities: { image: true },
      sessionCapabilities: { fork: {}, list: {}, resume: {} }
    }

So `loadSession`, `fork`, `list`, and `resume` are all supported — better than
this plan first assumed.

### Models come from session/new

`session/new` returns `{ _meta, models, modes, sessionId }`. There is no
separate models call: `models.availableModels` carries 25 entries shaped
`{ modelId, name, description }` with ids like `opencode-go:deepseek-v4-flash`,
and `models.currentModelId` names the active one. So `modelsList()` caches what
the session handshake already returned.

### Modes are permissions, not thinking

`modes.availableModes` is:

| id | Behaviour |
|---|---|
| `default` | Ask before edits |
| `accept_edits` | Auto-allow workspace and /tmp edits; still asks for sensitive paths |
| `dont_ask` | Auto-allow edits except sensitive paths |

That maps to BOSS's per-thread ask/auto mode, **not** to `thinkingSet()`.
Wiring modes to a thinking control would silently change permission behaviour.

## Streaming

The agent pushes `session/update` notifications. Translate each to a BOSS
`EventMessage`:

The discriminator is `update.sessionUpdate`, **not** `update.type` as the
published schema shows. Observed values:

| `sessionUpdate` | Payload | BOSS event |
|---|---|---|
| `agent_message_chunk` | `content: {type,text}` | `message.part.updated` |
| `agent_thought_chunk` | `content: {type,text}` | Reasoning stream — keep separate from the answer |
| `tool_call` | tool descriptor | `message.part.created` |
| `tool_call_update` | status + content | `message.part.updated`; diff blocks carry file changes |
| `usage_update` | `{size, used}` | Context-window meter |
| `available_commands_update` | command list | Hermes slash commands, for `runCommand()` |

`agent_thought_chunk` is Hermes-specific and arrives before the answer. In the
PONG probe it streamed 24 thought tokens before 2 answer tokens, so treating
the two as one stream would print the model's reasoning into the reply.

`session/prompt` resolves with `{ stopReason, usage }`. Observed `stopReason`
was `end_turn` — not one of the `Completed`/`Cancelled` values in the published
schema, so match loosely rather than on an exact enum.

## Permissions — the one inversion

Every other BOSS backend is asked for permission through its own channel. In
ACP the **agent sends a request to the client**: `session/request_permission`,
with an `options` array and an expected `outcome` of accepted/denied/cancelled.

So the flow is: hold the JSON-RPC request id, emit `permission.asked` to the
renderer, and respond when `permissionRespond()` is called. `codex-backend.ts`
already does exactly this with its `approvals` map — reuse that shape.

Mapping BOSS's three responses onto ACP options needs care: BOSS has
once/always/reject, ACP has whatever `options` the agent offers.

## What will not map

`codex-backend.ts` sets the precedent of returning empty results for
unsupported methods. Expect the same here:

- `fileTree()` / `fileContent()` — no ACP equivalent; return empty
- `revert()` / `unrevert()` — no ACP equivalent; no-op
- `fork()` — supported. `sessionCapabilities.fork` is advertised, and the
  `_meta.hermes.sessionProvenance` block tracks `rootHermesSessionId`,
  `parentHermesSessionId`, and `sessionKind`, so forks stay traceable
- `registerMcpServer()` — `session/new` accepts `mcpServers` at creation, so
  registration is per-session rather than dynamic. Likely `supportsMcp()` false
  at first.
- `diffGet()` — no direct call. Accumulate diffs from `tool_call_update`
  content blocks instead.

## Verified against the running CLI

A probe against `hermes acp` v0.20.0 completed a full round trip from BOSS's
project directory: `initialize` → `session/new` → `session/prompt` → answer.
That settles the questions this plan opened with.

1. **Capabilities** — `loadSession`, `fork`, `list`, `resume`, and image
   prompts. Richer than assumed.
2. **Models** — 25 available, returned by `session/new` rather than a separate
   call. Ids look like `opencode-go:deepseek-v4-flash`.
3. **Auth** — two `authMethods`: `opencode-go` runtime credentials, and a
   `hermes-setup` terminal method for unconfigured machines. BOSS should
   surface the second when auth fails.
4. **Sessions** — `loadSession: true`, so threads survive a BOSS restart.
5. **Sandboxing** — does *not* surface through ACP. It stays Hermes-side
   config, so BOSS cannot drive Docker/SSH/Modal isolation per thread.

Still unverified, because the probe did not trigger a tool call:

- The `session/request_permission` option ids Hermes emits. The mode
  descriptions imply a sensitive-path distinction, but the actual option
  payload needs a run that touches a real file.
- Whether `tool_call_update` carries diff content in a form `diffGet()` can
  use.

## Wiring checklist

Add `'hermes'` to `BackendId` first. `BACKEND_SHORT_LABELS` is typed
`Record<BackendId, string>`, so the typechecker then lists every exhaustive
site that needs updating — no manual hunting.

- `src/shared/backend.ts` — add `'hermes'` to `BackendId`
- `src/main/backend/hermes-backend.ts` — new, modeled on `codex-backend.ts`
- `src/main/backend/factory.ts` — add the `case 'hermes'`
- `src/main/index.ts` — register in the `BackendManager` map
- `src/renderer/src/lib/backend-labels.ts` — add the display label
- `src/renderer/src/styles.css` — add `.backend-badge.backend-hermes` colour
  (siblings at lines 1707-1709)
- Tests — `hermes-backend.test.ts`, following `claude-backend.test.ts`
