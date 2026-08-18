/**
 * Drive a real Claude Agent SDK run.
 *
 * The unit tests check the pieces BOSS owns — how a request is shaped, how a
 * decision is built. They cannot prove the SDK accepts the options BOSS passes,
 * or that a turn produces the messages the backend reads. This does: it runs
 * one cheap prompt through query() with the same options the backend uses, and
 * reports what came back.
 *
 * Costs a real (small) API call against whatever subscription the CLI is
 * logged in as. Read-only prompt, no tools.
 *
 * Usage: node scripts/probe-claude-sdk.mjs
 */
import { query } from '@anthropic-ai/claude-agent-sdk'

const seen = new Set()
let text = ''
let sessionId
let resultError

const run = query({
  prompt: 'Reply with exactly: BOSS probe ok',
  options: {
    cwd: process.cwd(),
    permissionMode: 'default',
    includePartialMessages: true,
    appendSystemPrompt: 'Answer in as few words as possible.',
    // No tools, so canUseTool should never fire. If it does, that is worth
    // knowing — it would mean a bare prompt can still block on permission.
    canUseTool: async (toolName) => {
      console.log(`  canUseTool fired unexpectedly for ${toolName}`)
      return { behavior: 'deny', message: 'probe denies tools', interrupt: false }
    }
  }
})

for await (const message of run) {
  seen.add(message.type)
  if (message.type === 'system' && message.subtype === 'init') {
    sessionId = message.session_id
  } else if (message.type === 'assistant') {
    for (const block of message.message?.content ?? []) {
      if (block.type === 'text') text += block.text
    }
  } else if (message.type === 'result') {
    if (message.subtype !== 'success') resultError = message.subtype
  }
}

console.log('message types seen:', [...seen].sort().join(', '))
console.log('session id:        ', sessionId ?? '(none)')
console.log('assistant text:    ', JSON.stringify(text.trim()))
console.log('result:            ', resultError ?? 'success')

const ok = seen.has('assistant') && seen.has('result') && !resultError && text.trim().length > 0
console.log(ok ? '\nPASS — a real turn completed' : '\nFAIL — see above')
process.exit(ok ? 0 : 1)
