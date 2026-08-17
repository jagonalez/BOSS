#!/usr/bin/env node
/**
 * The Tasks plugin's MCP server.
 *
 * A worked example of the shape a BOSS plugin server takes: newline-delimited
 * JSON-RPC on stdin and stdout, three methods, and every piece of state behind
 * a tool. The view calls these same tools, so what the agent can do and what
 * the board shows can never drift apart.
 *
 * State lives in BOSS_PLUGIN_DATA_DIR, which BOSS creates and passes in.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

const DATA_DIR = process.env.BOSS_PLUGIN_DATA_DIR ?? '.'
const STORE = join(DATA_DIR, 'tasks.json')

async function load() {
  try {
    const parsed = JSON.parse(await readFile(STORE, 'utf8'))
    return Array.isArray(parsed.tasks) ? parsed.tasks : []
  } catch {
    return []
  }
}

async function save(tasks) {
  await mkdir(dirname(STORE), { recursive: true })
  await writeFile(STORE, JSON.stringify({ version: 1, tasks }, null, 2))
}

const TOOLS = [
  {
    name: 'list',
    description: 'List every task, newest first. Returns id, title, notes, done and createdAt.',
    inputSchema: {
      type: 'object',
      properties: {
        includeDone: { type: 'boolean', description: 'Include finished tasks. Defaults to true.' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'add',
    description: 'Add a task to the board.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'What needs doing.' },
        notes: { type: 'string', description: 'Optional detail.' }
      },
      required: ['title'],
      additionalProperties: false
    }
  },
  {
    name: 'complete',
    description: 'Mark a task done, or reopen it by passing done false.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        done: { type: 'boolean', description: 'Defaults to true.' }
      },
      required: ['id'],
      additionalProperties: false
    }
  },
  {
    name: 'remove',
    description: 'Delete a task from the board.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false
    }
  }
]

/**
 * Every tool call is a read-modify-write on one file, so they run one at a
 * time. Without this, two calls arriving together both read the old list and
 * the second write loses the first task — which is exactly what happened the
 * first time this server was tested.
 */
let queue = Promise.resolve()
function serialize(work) {
  const result = queue.then(work, work)
  // The chain must not stay rejected, or one failed call blocks every later one.
  queue = result.then(
    () => undefined,
    () => undefined
  )
  return result
}

async function callTool(name, args) {
  const tasks = await load()
  switch (name) {
    case 'list': {
      const includeDone = args?.includeDone !== false
      return { tasks: tasks.filter((task) => includeDone || !task.done) }
    }
    case 'add': {
      const title = typeof args?.title === 'string' ? args.title.trim() : ''
      if (!title) throw new Error('A task needs a title.')
      const task = {
        id: randomUUID(),
        title,
        notes: typeof args?.notes === 'string' ? args.notes : '',
        done: false,
        createdAt: Date.now()
      }
      // Newest first, which is the order the board renders.
      await save([task, ...tasks])
      return { task }
    }
    case 'complete': {
      const id = String(args?.id ?? '')
      const done = args?.done !== false
      const found = tasks.find((task) => task.id === id)
      if (!found) throw new Error(`No task with id ${id}.`)
      found.done = done
      await save(tasks)
      return { task: found }
    }
    case 'remove': {
      const id = String(args?.id ?? '')
      const remaining = tasks.filter((task) => task.id !== id)
      if (remaining.length === tasks.length) throw new Error(`No task with id ${id}.`)
      await save(remaining)
      return { removed: id }
    }
    default:
      throw new Error(`Unknown tool: ${name}`)
  }
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

async function handle(request) {
  const { id, method, params } = request
  if (method === 'initialize') {
    return {
      protocolVersion: '2025-06-18',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'boss-plugin-tasks', version: '1.0.0' },
      instructions:
        'A task board the user can see. Add a task when the user agrees on something to do later, and complete it once done. The board view shows the same list, so it updates as you go.'
    }
  }
  if (method === 'tools/list') return { tools: TOOLS }
  if (method === 'tools/call') {
    try {
      const result = await serialize(() => callTool(params?.name, params?.arguments ?? {}))
      return { content: [{ type: 'text', text: JSON.stringify(result) }] }
    } catch (error) {
      return { content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }], isError: true }
    }
  }
  // Notifications have no id and want no reply.
  if (id === undefined) return undefined
  throw new Error(`Unsupported method: ${method}`)
}

let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let index = buffer.indexOf('\n')
  while (index >= 0) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (line) {
      void (async () => {
        let request
        try {
          request = JSON.parse(line)
        } catch {
          return
        }
        try {
          const result = await handle(request)
          if (request.id !== undefined && result !== undefined) {
            send({ jsonrpc: '2.0', id: request.id, result })
          }
        } catch (error) {
          if (request.id !== undefined) {
            send({
              jsonrpc: '2.0',
              id: request.id,
              error: { code: -32603, message: error instanceof Error ? error.message : String(error) }
            })
          }
        }
      })()
    }
    index = buffer.indexOf('\n')
  }
})
