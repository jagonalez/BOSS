/**
 * Drive the OpenCode backend against a real OpenCode server.
 *
 * The unit tests stub fetch, so they prove BOSS builds the request it intends
 * to. They cannot prove the server accepts it, or that the response matches the
 * shape the code reads. That gap is what let modelsList read a key the server
 * never returned. This closes it: it spawns the bundled binary, points the
 * backend at it, and calls each read-only method for real.
 *
 * Read-only by design. Anything that needs a model or provider credentials
 * (prompt, command, summarize) is skipped — those need a paid call and a
 * configured provider, so they stay manual.
 *
 * Usage: node scripts/probe-opencode-sdk.mjs
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
// Built and removed per run, so the probe has a known-empty project to work in
// and leaves nothing behind to commit or to drift.
const fixture = join(root, 'out', 'probe-fixture')

function resolveBinary() {
  const candidates = [
    process.env.OPENCODE_BIN,
    join(root, 'resources', 'opencode', 'opencode'),
    // The worktree may not have had fetch:opencode run in it; fall back to the
    // main checkout's copy rather than making the probe unrunnable.
    join(root, '..', '..', '..', 'resources', 'opencode', 'opencode')
  ].filter(Boolean)
  for (const candidate of candidates) if (existsSync(candidate)) return candidate
  throw new Error('opencode binary not found. Run npm run fetch:opencode, or set OPENCODE_BIN.')
}

async function waitForHealth(baseUrl, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/app`)
      if (res.ok) return
    } catch {
      /* not listening yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`OpenCode server did not become healthy within ${timeoutMs}ms`)
}

const results = []
async function check(name, fn) {
  try {
    const value = await fn()
    results.push({ name, ok: true, detail: value })
    console.log(`  ok   ${name}${value ? ` — ${value}` : ''}`)
  } catch (error) {
    results.push({ name, ok: false, detail: String(error.message ?? error) })
    console.log(`  FAIL ${name} — ${error.message ?? error}`)
  }
}

const binary = resolveBinary()
rmSync(fixture, { recursive: true, force: true })
mkdirSync(fixture, { recursive: true })
// fileContent asserts on this text, so the file and the assertion have to agree.
writeFileSync(join(fixture, 'README.md'), 'hello world\n')

console.log(`opencode: ${binary}`)
console.log(`fixture:  ${fixture}\n`)

const port = 4200 + Math.floor(process.pid % 300)
const child = spawn(binary, ['serve', '--port', String(port), '--hostname', '127.0.0.1'], {
  cwd: fixture,
  stdio: ['ignore', 'pipe', 'pipe']
})
child.stderr.on('data', (chunk) => {
  if (process.env.PROBE_VERBOSE) process.stderr.write(`[opencode] ${chunk}`)
})

const baseUrl = `http://127.0.0.1:${port}`
let exitCode = 0
try {
  await waitForHealth(baseUrl)
  console.log(`server up on ${baseUrl}\n`)

  const { OpenCodeBackend } = await import('../out/probe/opencode-backend.js')
  const server = {
    start: async () => {},
    stop: async () => {},
    setProject: async () => {},
    info: { healthy: true, version: 'probe' },
    projectPath: fixture,
    baseUrl,
    // The server is spawned without auth for the probe, so an empty header is
    // correct here rather than a placeholder that looks meaningful.
    authHeader: ''
  }
  const events = { start() {}, stop() {}, onEvent: undefined }
  const api = { async request() { return { status: 204, body: undefined } } }
  const backend = new OpenCodeBackend(server, api, events)

  console.log('read-only methods against the real server:')

  let created
  await check('sessionCreate', async () => {
    created = await backend.sessionCreate('probe session', fixture)
    if (!created?.id) throw new Error('no session id returned')
    return created.id
  })

  await check('sessionsList', async () => {
    const sessions = await backend.sessionsList()
    if (!Array.isArray(sessions)) throw new Error('expected an array')
    return `${sessions.length} session(s)`
  })

  await check('sessionGet', async () => {
    const session = await backend.sessionGet(created.id)
    if (session.id !== created.id) throw new Error('wrong session returned')
    return session.id
  })

  await check('sessionRename', async () => {
    const renamed = await backend.sessionRename(created.id, 'probe renamed')
    return renamed.title ?? '(no title field)'
  })

  await check('messagesList', async () => {
    const messages = await backend.messagesList(created.id)
    if (!Array.isArray(messages)) throw new Error('expected an array')
    return `${messages.length} message(s)`
  })

  await check('todosGet', async () => {
    const todos = await backend.todosGet(created.id)
    return `${Array.isArray(todos) ? todos.length : '?'} todo(s)`
  })

  await check('diffGet', async () => {
    const diffs = await backend.diffGet(created.id)
    return `${Array.isArray(diffs) ? diffs.length : '?'} diff(s)`
  })

  // The regression that started this: the old code read a key the server does
  // not return, so this silently produced zero models.
  await check('modelsList returns models', async () => {
    const models = await backend.modelsList()
    if (!Array.isArray(models)) throw new Error('expected an array')
    if (models.length === 0) throw new Error('no models returned — the provider shape is wrong again')
    const sample = models[0]
    if (!sample.id || !sample.provider) throw new Error(`malformed entry: ${JSON.stringify(sample)}`)
    return `${models.length} models, e.g. ${sample.provider}/${sample.id}`
  })

  await check('fileTree', async () => {
    const nodes = await backend.fileTree('')
    if (!Array.isArray(nodes)) throw new Error('expected an array')
    return `${nodes.length} entr(ies)`
  })

  await check('fileContent', async () => {
    const content = await backend.fileContent('README.md')
    const text = JSON.stringify(content)
    if (!text.includes('hello')) throw new Error(`did not read the fixture file: ${text.slice(0, 120)}`)
    return 'read README.md'
  })

  await check('sessionDelete', async () => {
    await backend.sessionDelete(created.id)
    return 'deleted'
  })

  const failed = results.filter((result) => !result.ok)
  console.log(`\n${results.length - failed.length}/${results.length} passed`)
  if (failed.length) {
    console.log('failed:')
    for (const failure of failed) console.log(`  - ${failure.name}: ${failure.detail}`)
    exitCode = 1
  }
} catch (error) {
  console.error(`probe error: ${error.message ?? error}`)
  exitCode = 1
} finally {
  child.kill('SIGTERM')
}
process.exit(exitCode)
