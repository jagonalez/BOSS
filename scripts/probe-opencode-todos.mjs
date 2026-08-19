/**
 * Ground truth for the todo bug: run a real prompt that makes the agent write
 * todos, and dump the tool parts as the server actually sends them, plus what
 * todosGet returns. The point is to see where the tool name lives and what the
 * status strings are, rather than trusting the generated types.
 *
 * Usage: npm run probe:opencode:todos
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const fixture = join(root, 'out', 'probe-todo-fixture')

function resolveBinary() {
  const candidates = [
    process.env.OPENCODE_BIN,
    join(root, 'resources', 'opencode', 'opencode'),
    join(root, '..', '..', '..', 'resources', 'opencode', 'opencode')
  ].filter(Boolean)
  for (const c of candidates) if (existsSync(c)) return c
  throw new Error('opencode binary not found. Run npm run fetch:opencode, or set OPENCODE_BIN.')
}

async function waitForHealth(baseUrl, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try { const r = await fetch(`${baseUrl}/app`); if (r.ok) return } catch {}
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error('server did not become healthy')
}

const binary = resolveBinary()
rmSync(fixture, { recursive: true, force: true })
mkdirSync(fixture, { recursive: true })
writeFileSync(join(fixture, 'README.md'), 'hello world\n')

const port = 4600 + Math.floor(process.pid % 300)
// The sandbox cannot write to ~/.local/share, and opencode opens its log there
// before it listens. Point its data dirs at a writable place for the probe.
const dataHome = join(root, 'out', 'probe-todo-home')
mkdirSync(dataHome, { recursive: true })
const child = spawn(binary, ['serve', '--port', String(port), '--hostname', '127.0.0.1'], {
  cwd: fixture,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, XDG_DATA_HOME: join(dataHome, '.local', 'share'), XDG_CACHE_HOME: join(dataHome, '.cache') }
})
child.stderr.on('data', (c) => { if (process.env.PROBE_VERBOSE) process.stderr.write(`[oc] ${c}`) })
const baseUrl = `http://127.0.0.1:${port}`

let exitCode = 0
try {
  await waitForHealth(baseUrl)
  console.log(`server up on ${baseUrl}`)

  const { OpenCodeBackend } = await import('../out/probe/opencode-backend.js')
  const server = {
    start: async () => {}, stop: async () => {}, setProject: async () => {},
    info: { healthy: true, version: 'probe' }, projectPath: fixture, baseUrl, authHeader: ''
  }
  const backend = new OpenCodeBackend(server, { async request() { return { status: 204 } } }, { start() {}, stop() {} })

  const session = await backend.sessionCreate('todo probe', fixture)
  console.log(`session ${session.id}`)

  // Watch the raw event stream so we see parts exactly as the server sends them.
  const toolParts = []
  let idle = false
  const es = fetch(`${baseUrl}/event`, { headers: { accept: 'text/event-stream' } }).then(async (res) => {
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return
      buf += decoder.decode(value, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.startsWith('data:')) continue
        try {
          const ev = JSON.parse(line.slice(5))
          const part = ev.properties?.part ?? ev.part
          if (part?.type === 'tool') toolParts.push(part)
          if (ev.type === 'session.idle') idle = true
          if (ev.type === 'session.error') console.log('SESSION ERROR:', JSON.stringify(ev).slice(0, 600))
          if (process.env.DUMP_EVENTS) console.log('EV', ev.type, JSON.stringify(ev).slice(0, 300))
        } catch {}
      }
    }
  })

  const models = await backend.modelsList()
  console.log('providers available:', [...new Set(models.map((m) => m.provider))].join(', '))
  console.log('deepseek-ish models:', models.filter((m) => /deepseek/i.test(`${m.provider}/${m.id}`)).map((m) => `${m.provider}/${m.id}`).join(', ') || '(none)')
  // Deepseek v4 flash: cheap enough to run this probe repeatedly.
  const want = process.env.PROBE_MODEL
  const model = want
    ? models.find((m) => `${m.provider}/${m.id}` === want || m.id === want)
    : models.find((m) => /deepseek/i.test(m.id) && /v4/i.test(m.id) && /flash/i.test(m.id))
      ?? models.find((m) => /deepseek/i.test(m.id) && /flash/i.test(m.id))
      ?? models.find((m) => /deepseek/i.test(m.id))
  if (!model) throw new Error('no models configured — set up a provider to run this probe')
  console.log(`model ${model.provider}/${model.id}`)

  console.log('\nprompting (this makes a real paid call)...')
  await backend.sendMessage(
    session.id,
    [{ type: 'text', text: 'Use your todo tool to plan exactly three short steps for tidying this repo, then mark each one completed as you go. Do not edit any files.' }],
    { model: { providerID: model.provider, modelID: model.id } }
  )

  // Sample the list while the run is live. The reported symptom is that it
  // stays 0/x during the run and is empty after it, so both matter.
  const samples = []
  let lastSample = null
  const deadline = Date.now() + 180_000
  while (!idle && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 400))
    try {
      const live = await backend.todosGet(session.id)
      const shot = live.map((t) => t.status).join(',')
      // Only record changes, so the output shows the progression rather than
      // one line per poll.
      if (shot !== lastSample) { samples.push(shot); lastSample = shot }
    } catch (e) { samples.push(`err:${e.message}`) }
  }
  console.log('\nlive todosGet samples during the run:')
  for (const s of samples) console.log(`  [${s}]`)
  console.log(idle ? 'session went idle' : 'timed out waiting for idle')

  const msgs = await backend.messagesList(session.id)
  console.log(`\n=== messages: ${msgs.length} ===`)
  for (const m of msgs) {
    console.log(`- ${m.info?.role}: ${(m.parts ?? []).map((p) => p.type + (p.tool ? `(${p.tool})` : '')).join(' ')}`)
    for (const p of m.parts ?? []) {
      if (p.type === 'text') console.log(`    text: ${String(p.text ?? '').slice(0, 300)}`)
    }
    if (m.info?.error) console.log(`    ERROR: ${JSON.stringify(m.info.error).slice(0, 400)}`)
  }

  console.log(`\n=== tool parts seen: ${toolParts.length} ===`)
  const todoish = toolParts.filter((p) => String(p.tool ?? '').toLowerCase().includes('todo'))
  console.log('distinct tool names:', JSON.stringify([...new Set(toolParts.map((p) => p.tool))]))
  console.log('where does the name live? top-level part.tool vs part.state.tool:')
  console.log('  part.tool set on:', toolParts.filter((p) => p.tool).length, 'of', toolParts.length)
  console.log('  part.state.tool set on:', toolParts.filter((p) => p.state?.tool).length, 'of', toolParts.length)
  console.log('todowrite statuses seen:', JSON.stringify(todoish.map((p) => p.state?.status)))
  // The event stream sends the same part id repeatedly as it advances. What
  // matters is that each distinct todowrite call reaches completed once.
  const byCall = new Map()
  for (const p of todoish) byCall.set(p.callID ?? p.id, p.state?.status)
  console.log('distinct todowrite calls:', byCall.size, 'final statuses:', JSON.stringify([...byCall.values()]))
  console.log(`todo-ish parts: ${todoish.length}`)
  for (const p of todoish.slice(0, 4)) {
    console.log(JSON.stringify({
      'part.tool': p.tool,
      'part.state.tool': p.state?.tool,
      'part.state.status': p.state?.status
    }))
  }
  console.log('\nfull first todo part:')
  console.log(JSON.stringify(todoish[0], null, 2)?.slice(0, 1200))

  // Replay the manager's gate over the parts the server really sent. This is
  // the check that matters: it says how many times the UI would have been
  // refreshed during the run, which is what the user watches.
  // The shipped predicate, not a copy of it, so this probe fails if the fix
  // regresses.
  const { isCompletedTodoToolCall } = await import('../out/probe/shared-opencode.js')
  const oldGate = (part) => part.type === 'tool' && part.state?.status === 'completed'
    && String(part.state?.tool ?? '').toLowerCase().includes('todo')
  console.log(`\nrefreshes the OLD gate (state.tool only) would fire: ${toolParts.filter(oldGate).length}`)
  console.log(`refreshes the SHIPPED gate fires: ${toolParts.filter(isCompletedTodoToolCall).length}`)


  const todos = await backend.todosGet(session.id)
  console.log('ids present on every todo:', todos.every((t) => Boolean(t.id)), JSON.stringify(todos.map((t) => t.id)))
  console.log(`\n=== todosGet: ${todos.length} todo(s) ===`)
  console.log(JSON.stringify(todos, null, 2).slice(0, 1500))
  console.log('\nstatuses:', JSON.stringify(todos.map((t) => t.status)))
} catch (e) {
  console.error(`probe error: ${e.stack ?? e.message ?? e}`)
  exitCode = 1
} finally {
  child.kill('SIGTERM')
}
process.exit(exitCode)
