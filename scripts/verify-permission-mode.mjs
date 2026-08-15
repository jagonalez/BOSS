/** Prove a mid-run permission-mode switch reaches the very next request.
 *
 *  A nested real `claude` cannot run inside a BOSS agent session (the sandbox
 *  blocks ~/.claude/session-env, so it exits before calling a tool). So the
 *  agent here is a stand-in process that speaks the same control protocol BOSS
 *  parses: it emits `can_use_tool` control requests and waits for a
 *  `control_response` before sending the next one.
 *
 *  What this actually proves is the part that broke: the mode is READ PER
 *  REQUEST from one mutable record, while the process that was launched under
 *  the old mode keeps running. The launch flag is deliberately never updated,
 *  which is what makes the switch meaningful.
 *
 *  Run: node scripts/verify-permission-mode.mjs
 */
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))

// The real decision, imported rather than restated, so this cannot drift from
// what the app ships.
const { hostPermissionResponse } = await import(join(here, '..', 'src', 'shared', 'permission-mode.ts'))

/** A stand-in agent. Asks to use a tool, waits for the answer, asks again. */
const AGENT = `
let buffer = ''
let asked = 0
const TOTAL = 4
const ask = () => {
  asked++
  process.stdout.write(JSON.stringify({
    type: 'control_request',
    request_id: 'req-' + asked,
    request: { subtype: 'can_use_tool', tool_name: 'Write', input: { file_path: 'f' + asked + '.txt' } }
  }) + '\\n')
}
process.stdin.on('data', (chunk) => {
  buffer += chunk.toString()
  let i
  while ((i = buffer.indexOf('\\n')) >= 0) {
    const line = buffer.slice(0, i).trim()
    buffer = buffer.slice(i + 1)
    if (!line) continue
    const value = JSON.parse(line)
    if (value.type !== 'control_response') continue
    if (asked >= TOTAL) { process.exit(0) }
    ask()
  }
})
ask()
`

function run({ startMode, switchTo, switchAfter, label }) {
  return new Promise((resolve) => {
    // The thread's mode: ONE record, mutated mid-run. This is the single source
    // of truth the fix introduces.
    const thread = { mode: startMode }
    // What the process was launched under. Never updated — a real CLI reads
    // --permission-mode once at spawn and cannot be told again.
    const launchedUnder = startMode

    const child = spawn(process.execPath, ['-e', AGENT], { stdio: ['pipe', 'pipe', 'inherit'] })
    const events = []
    let promptedUser = 0
    let autoAnswered = 0
    let handled = 0
    let buffer = ''

    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString()
      let i
      while ((i = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, i).trim()
        buffer = buffer.slice(i + 1)
        if (!line) continue
        const value = JSON.parse(line)
        if (value.request?.subtype !== 'can_use_tool') continue

        handled++
        // The switch lands mid-run, between two requests, with the process
        // still alive and still launched under the old mode.
        if (handled === switchAfter) {
          thread.mode = switchTo
          events.push(`--- user switches ${startMode} -> ${switchTo}; process still running under --permission-mode ${launchedUnder} ---`)
        }

        // Read the mode NOW, not at spawn. This line is the fix.
        const decision = hostPermissionResponse(thread.mode)
        if (decision === undefined) {
          promptedUser++
          events.push(`request ${handled}: PROMPT USER (mode=${thread.mode})`)
        } else {
          autoAnswered++
          events.push(`request ${handled}: auto-${decision === 'once' ? 'allow' : 'reject'} (mode=${thread.mode})`)
        }
        child.stdin.write(JSON.stringify({
          type: 'control_response',
          response: { subtype: 'success', request_id: value.request_id }
        }) + '\n')
      }
    })

    child.on('close', () => resolve({ label, startMode, switchTo, launchedUnder, promptedUser, autoAnswered, events }))
  })
}

// Switch after the first request, so requests 2..4 must follow the new mode.
const askToAuto = await run({ startMode: 'ask', switchTo: 'auto', switchAfter: 1, label: 'Ask -> Auto' })
const autoToAsk = await run({ startMode: 'auto', switchTo: 'ask', switchAfter: 1, label: 'Auto -> Ask' })
const askToPlan = await run({ startMode: 'ask', switchTo: 'plan', switchAfter: 1, label: 'Ask -> Plan' })

for (const r of [askToAuto, autoToAsk, askToPlan]) {
  console.log(`\n=== ${r.label} ===`)
  console.log(`  process launched under: --permission-mode ${r.launchedUnder} (never relaunched)`)
  for (const e of r.events) console.log(`  ${e}`)
  console.log(`  prompted user: ${r.promptedUser}, auto-answered: ${r.autoAnswered}`)
}

const checks = [
  // Request 1 is decided at the moment of the switch, so it already follows
  // Auto; the point is that requests 2..4 never prompt again.
  ['Ask -> Auto stops the prompts', askToAuto.promptedUser === 0 && askToAuto.autoAnswered === 4],
  ['Auto -> Ask brings the prompts back', autoToAsk.promptedUser === 4],
  ['Ask -> Plan starts refusing', askToPlan.autoAnswered === 4 && askToPlan.promptedUser === 0]
]

console.log('')
let ok = true
for (const [name, passed] of checks) {
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}`)
  if (!passed) ok = false
}
process.exit(ok ? 0 : 1)
