/** Prove a mid-run permission-mode switch reaches the very next request.
 *
 *  A nested real `claude` cannot run inside a BOSS agent session (the sandbox
 *  blocks ~/.claude/session-env, so it exits before calling a tool). So the
 *  agent here is a stand-in process that speaks the same control protocol BOSS
 *  parses: it emits `can_use_tool` control requests, waits for a
 *  `control_response`, and — like the real claude — obeys a `set_permission_mode`
 *  control request by changing which calls it asks about.
 *
 *  Two mechanisms are covered, because BOSS uses a different one per backend:
 *
 *    opencode  no Auto policy of its own -> BOSS answers the requests
 *    claude    graduated Auto            -> BOSS forwards set_permission_mode
 *                                           and the agent keeps deciding
 *
 *  Run: node --experimental-strip-types scripts/verify-permission-mode.mjs
 */
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))

// The real decision, imported rather than restated, so this cannot drift from
// what the app ships.
const { hostPermissionResponse } = await import(join(here, '..', 'src', 'shared', 'permission-mode.ts'))

/** A stand-in agent.
 *
 *  Asks about 4 tool calls. Two are "sensitive" and two are "safe". Under
 *  manual it asks about all of them; under auto it asks only about the
 *  sensitive ones — the graduated behaviour BOSS must not flatten. It changes
 *  mode when told, mid-run, exactly as claude does. */
const AGENT = `
let buffer = ''
let mode = process.argv[1]
let index = 0
const CALLS = [
  { tool: 'Read', sensitive: false },
  { tool: 'Bash', sensitive: true },
  { tool: 'Read', sensitive: false },
  { tool: 'Bash', sensitive: true }
]
const step = () => {
  while (index < CALLS.length) {
    const call = CALLS[index++]
    // Under auto the agent approves its own safe calls and never asks.
    if (mode === 'auto' && !call.sensitive) {
      process.stdout.write(JSON.stringify({ type: 'self_allowed', tool: call.tool }) + '\\n')
      continue
    }
    process.stdout.write(JSON.stringify({
      type: 'control_request',
      request_id: 'req-' + index,
      request: { subtype: 'can_use_tool', tool_name: call.tool, input: {} }
    }) + '\\n')
    return
  }
  process.exit(0)
}
process.stdin.on('data', (chunk) => {
  buffer += chunk.toString()
  let i
  while ((i = buffer.indexOf('\\n')) >= 0) {
    const line = buffer.slice(0, i).trim()
    buffer = buffer.slice(i + 1)
    if (!line) continue
    const value = JSON.parse(line)
    if (value.type === 'control_request' && value.request?.subtype === 'set_permission_mode') {
      mode = value.request.mode
      process.stdout.write(JSON.stringify({ type: 'mode_changed', mode }) + '\\n')
      continue
    }
    if (value.type === 'control_response') step()
  }
})
step()
`

function run({ backend, nativeAutoMode, startMode, switchTo, label }) {
  return new Promise((resolve) => {
    // The thread's mode: ONE record, mutated mid-run.
    const thread = { mode: startMode }
    // A backend with no Auto policy of its own always asks about everything —
    // that is what nativeAutoMode: false means. Only a native-Auto backend
    // starts out filtering its own calls.
    const agentStartMode = nativeAutoMode && startMode === 'auto' ? 'auto' : 'manual'
    const child = spawn(process.execPath, ['-e', AGENT, '--', agentStartMode], {
      stdio: ['pipe', 'pipe', 'inherit']
    })

    const events = []
    let promptedUser = 0
    let hostAnswered = 0
    let agentSelfAllowed = 0
    let switched = false
    let buffer = ''

    const send = (value) => child.stdin.write(JSON.stringify(value) + '\n')

    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString()
      let i
      while ((i = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, i).trim()
        buffer = buffer.slice(i + 1)
        if (!line) continue
        const value = JSON.parse(line)

        if (value.type === 'self_allowed') {
          agentSelfAllowed++
          events.push(`${value.tool}: agent allowed it itself (its own Auto policy)`)
          continue
        }
        if (value.type === 'mode_changed') {
          events.push(`agent acknowledged set_permission_mode -> ${value.mode}`)
          continue
        }
        if (value.request?.subtype !== 'can_use_tool') continue

        // The switch lands mid-run, before the first request is answered.
        if (!switched) {
          switched = true
          thread.mode = switchTo
          events.push(`--- user switches ${startMode} -> ${switchTo} mid-run ---`)
          if (nativeAutoMode) {
            // BOSS forwards the change and lets the agent go on deciding.
            send({
              type: 'control_request',
              request_id: 'boss-mode-1',
              request: { subtype: 'set_permission_mode', mode: switchTo === 'auto' ? 'auto' : 'manual' }
            })
          }
        }

        // Read the mode NOW, with the backend's capability.
        const decision = hostPermissionResponse(thread.mode, nativeAutoMode)
        if (decision === undefined) {
          promptedUser++
          events.push(`${value.request.tool_name}: PROMPT USER (mode=${thread.mode})`)
        } else {
          hostAnswered++
          events.push(`${value.request.tool_name}: host auto-${decision === 'once' ? 'allow' : 'reject'} (mode=${thread.mode})`)
        }
        send({ type: 'control_response', response: { subtype: 'success', request_id: value.request_id } })
      }
    })

    child.on('close', () => resolve({ label, backend, promptedUser, hostAnswered, agentSelfAllowed, events }))
  })
}

const results = await Promise.all([
  run({ backend: 'opencode', nativeAutoMode: false, startMode: 'ask', switchTo: 'auto', label: 'opencode: Ask -> Auto' }),
  run({ backend: 'opencode', nativeAutoMode: false, startMode: 'auto', switchTo: 'ask', label: 'opencode: Auto -> Ask' }),
  run({ backend: 'claude', nativeAutoMode: true, startMode: 'ask', switchTo: 'auto', label: 'claude: Ask -> Auto' }),
  run({ backend: 'claude', nativeAutoMode: true, startMode: 'auto', switchTo: 'ask', label: 'claude: Auto -> Ask' })
])

for (const r of results) {
  console.log(`\n=== ${r.label} ===`)
  for (const e of r.events) console.log(`  ${e}`)
  console.log(`  prompted user: ${r.promptedUser}, host answered: ${r.hostAnswered}, agent self-allowed: ${r.agentSelfAllowed}`)
}

const [ocAskAuto, ocAutoAsk, clAskAuto, clAutoAsk] = results

const checks = [
  // opencode has no policy of its own, so BOSS answering is correct.
  ['opencode Ask -> Auto stops the prompts', ocAskAuto.promptedUser === 0 && ocAskAuto.hostAnswered === 4],
  ['opencode Auto -> Ask brings the prompts back', ocAutoAsk.promptedUser === 4],

  // claude keeps deciding. Switching to Auto silences the safe calls (it
  // approves those itself) but the sensitive ones still reach the user.
  ['claude Ask -> Auto stops prompting for safe calls', clAskAuto.agentSelfAllowed > 0],
  ['claude Ask -> Auto still escalates sensitive calls', clAskAuto.promptedUser > 0],
  ['claude: BOSS never blanket-approves for it', clAskAuto.hostAnswered === 0 && clAutoAsk.hostAnswered === 0],
  // The agent had already self-allowed one safe call before the switch landed,
  // so the remaining three all reach the user.
  ['claude Auto -> Ask prompts for everything after the switch', clAutoAsk.promptedUser === 3],
  ['claude Auto -> Ask stops the agent self-allowing', clAutoAsk.agentSelfAllowed === 1]
]

console.log('')
let ok = true
for (const [name, passed] of checks) {
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}`)
  if (!passed) ok = false
}
process.exit(ok ? 0 : 1)
