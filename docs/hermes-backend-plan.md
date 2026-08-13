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
| `thinkingSet()` | `session/set_mode` | Maps to Hermes modes, not a thinking level |
| `permissionRespond()` | answer `session/request_permission` | Agent calls *us*; we respond |
| `modelsList()` | TBD | `provider:model` format, e.g. `openrouter:z-ai/glm-5.1` |

## Streaming

The agent pushes `session/update` notifications. Translate each to a BOSS
`EventMessage`:

| ACP update | BOSS event |
|---|---|
| `agent_message_chunk` | `message.part.updated` |
| `tool_call` | `message.part.created` |
| `tool_call_update` | `message.part.updated`; `content[].type === 'diff'` carries file changes |
| `plan` | `session.todos` — closest fit to BOSS todos |

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
- `fork()` — Hermes docs mention session fork, but it is not in the core ACP
  schema; check `_meta` for an extension
- `registerMcpServer()` — `session/new` accepts `mcpServers` at creation, so
  registration is per-session rather than dynamic. Likely `supportsMcp()` false
  at first.
- `diffGet()` — no direct call. Accumulate diffs from `tool_call_update`
  content blocks instead.

## Open questions — need the CLI installed

The published ACP schema does not answer these, and the Hermes docs explicitly
omit payload shapes:

1. What does `hermes acp` advertise in `agentCapabilities`?
2. How are models listed and selected over ACP? The docs mention a model menu
   in Buzz Desktop, but not the method behind it.
3. Which `session/request_permission` option ids does Hermes emit?
4. Does it support `session/load`, and does it survive a BOSS restart?
5. Does the sandboxing (Docker/SSH/Modal) surface through ACP, or is it config
   only?

Answer these by running `hermes acp` and capturing the handshake before
writing the backend.

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
