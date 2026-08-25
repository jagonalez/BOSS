import assert from 'node:assert/strict'
import test from 'node:test'
// @ts-expect-error Node's strip-types runner requires the TypeScript extension.
import { splitCodexTurnItems } from './codex-turn-order.ts'

const item = (id: string, type: string): { id: string; type: string } => ({ id, type })

test('keeps a steered user message between the work before and after it', () => {
  const slices = splitCodexTurnItems([
    item('user-0', 'userMessage'),
    item('reasoning-0', 'reasoning'),
    item('tool-0', 'dynamicToolCall'),
    item('user-1', 'userMessage'),
    item('reasoning-1', 'reasoning'),
    item('tool-1', 'dynamicToolCall'),
    item('answer', 'agentMessage')
  ])

  assert.deepEqual(slices.map((slice) => ({
    role: slice.role,
    index: slice.index,
    ids: slice.role === 'user' ? [slice.item.id] : slice.items.map((entry) => entry.id)
  })), [
    { role: 'user', index: 0, ids: ['user-0'] },
    { role: 'assistant', index: 0, ids: ['reasoning-0', 'tool-0'] },
    { role: 'user', index: 1, ids: ['user-1'] },
    { role: 'assistant', index: 1, ids: ['reasoning-1', 'tool-1', 'answer'] }
  ])
})

test('drops hook prompts without changing the surrounding order', () => {
  const slices = splitCodexTurnItems([
    item('user', 'userMessage'),
    item('hook', 'hookPrompt'),
    item('answer', 'agentMessage')
  ])

  assert.deepEqual(slices.map((slice) => slice.role === 'user'
    ? slice.item.id
    : slice.items.map((entry) => entry.id).join(',')), ['user', 'answer'])
})
