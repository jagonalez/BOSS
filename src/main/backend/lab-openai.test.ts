import assert from 'node:assert/strict'
import test from 'node:test'
import type { MessageWithParts } from '@shared/opencode'
// @ts-expect-error Application code uses bundler resolution.
import { cropHistory, openAiMessagesFromHistory, parseChatChunk } from './lab-openai.ts'
// @ts-expect-error Application code uses bundler resolution.
import { ToolCallAccumulator, parseToolArguments } from './lab-tool-call.ts'

test('parseChatChunk extracts a streaming text delta', () => {
  const parsed = parseChatChunk('{"choices":[{"delta":{"content":"Hello"},"finish_reason":null}]}')
  assert.deepEqual(parsed, { text: 'Hello' })
})

test('parseChatChunk extracts tool-call deltas from a chunk', () => {
  const chunk = {
    choices: [{
      delta: {
        tool_calls: [{ index: 0, id: 'call_1', function: { name: 'bash', arguments: '{"command":"ls"' } }]
      },
      finish_reason: null
    }]
  }
  const parsed = parseChatChunk(JSON.stringify(chunk))
  assert.deepEqual(parsed?.toolCalls, [
    { index: 0, id: 'call_1', name: 'bash', arguments: '{"command":"ls"' }
  ])
})

test('parseChatChunk surfaces finish_reason', () => {
  const parsed = parseChatChunk('{"choices":[{"delta":{},"finish_reason":"tool_calls"}]}')
  assert.deepEqual(parsed, { finishReason: 'tool_calls' })
})

test('parseChatChunk extracts DeepSeek-style reasoning_content deltas', () => {
  const parsed = parseChatChunk('{"choices":[{"delta":{"reasoning_content":"checking the failing test"},"finish_reason":null}]}')
  assert.deepEqual(parsed, { reasoning: 'checking the failing test' })
})

test('parseChatChunk extracts the alternate reasoning field name', () => {
  const parsed = parseChatChunk('{"choices":[{"delta":{"reasoning":"reading the diff"},"finish_reason":null}]}')
  assert.deepEqual(parsed, { reasoning: 'reading the diff' })
})

test('parseChatChunk keeps text and reasoning apart in one chunk', () => {
  const parsed = parseChatChunk('{"choices":[{"delta":{"content":"answer","reasoning_content":"why"},"finish_reason":null}]}')
  assert.deepEqual(parsed, { text: 'answer', reasoning: 'why' })
})

test('parseChatChunk handles a non-stream message fallback', () => {
  const chunk = {
    choices: [{
      message: { content: 'done', tool_calls: [{ id: 'c1', function: { name: 'read_file', arguments: '{"path":"x"}' } }] },
      finish_reason: 'stop'
    }]
  }
  const parsed = parseChatChunk(JSON.stringify(chunk))
  assert.equal(parsed?.text, 'done')
  assert.deepEqual(parsed?.toolCalls, [{ index: 0, id: 'c1', name: 'read_file', arguments: '{"path":"x"}' }])
})

test('parseChatChunk returns undefined for non-JSON or empty chunks', () => {
  assert.equal(parseChatChunk('not json'), undefined)
  assert.equal(parseChatChunk('[DONE]'), undefined)
  assert.equal(parseChatChunk('{"choices":[]}'), undefined)
})

test('parseChatChunk ignores tool_calls with no index by defaulting to 0', () => {
  const parsed = parseChatChunk('{"choices":[{"delta":{"tool_calls":[{"function":{"arguments":"{}"}}]}}]}')
  assert.deepEqual(parsed?.toolCalls, [{ index: 0, arguments: '{}' }])
})

test('parseChatChunk handles the legacy function_call delta shape', () => {
  const parsed = parseChatChunk('{"choices":[{"delta":{"function_call":{"name":"read_file","arguments":"{\\"path\\":\\"x\\"}"}},"finish_reason":"function_call"}]}')
  assert.deepEqual(parsed?.toolCalls, [{ index: 0, name: 'read_file', arguments: '{"path":"x"}' }])
  assert.equal(parsed?.finishReason, 'function_call')
})

test('openAiMessagesFromHistory opens with the system prompt', () => {
  const messages = openAiMessagesFromHistory([], 'be helpful')
  assert.deepEqual(messages, [{ role: 'system', content: 'be helpful' }])
})

test('openAiMessagesFromHistory maps text-only turns', () => {
  const history = [
    { info: { id: 'a', sessionID: 's', role: 'user' as const }, parts: [{ id: 'a-p', type: 'text' as const, sessionID: 's', messageID: 'a', text: 'hi' }] },
    { info: { id: 'b', sessionID: 's', role: 'assistant' as const }, parts: [{ id: 'b-p', type: 'text' as const, sessionID: 's', messageID: 'b', text: 'hello!' }] }
  ]
  const messages = openAiMessagesFromHistory(history, 'sys')
  assert.deepEqual(messages, [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hello!' }
  ])
})

test('openAiMessagesFromHistory round-trips a tool call and its result', () => {
  const history = [
    {
      info: { id: 'a', sessionID: 's', role: 'assistant' as const },
      parts: [
        {
          id: 'call-1',
          type: 'tool' as const,
          sessionID: 's',
          messageID: 'a',
          state: { status: 'completed' as const, tool: 'bash', input: { command: 'ls' }, output: 'file.txt' }
        }
      ]
    }
  ]
  const messages = openAiMessagesFromHistory(history, 'sys')
  assert.equal(messages.length, 3)
  assert.deepEqual(messages[1], {
    role: 'assistant',
    content: null,
    tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'bash', arguments: '{"command":"ls"}' } }]
  })
  assert.deepEqual(messages[2], { role: 'tool', tool_call_id: 'call-1', content: 'file.txt' })
})

test('openAiMessagesFromHistory drops unreachable reasoning parts', () => {
  const history = [
    {
      info: { id: 'a', sessionID: 's', role: 'assistant' as const },
      parts: [
        { id: 'a-r', type: 'reasoning' as const, sessionID: 's', messageID: 'a', text: 'thinking...' },
        { id: 'a-t', type: 'text' as const, sessionID: 's', messageID: 'a', text: 'answer' }
      ]
    }
  ]
  const messages = openAiMessagesFromHistory(history, 'sys')
  assert.deepEqual(messages, [
    { role: 'system', content: 'sys' },
    { role: 'assistant', content: 'answer' }
  ])
})

test('openAiMessagesFromHistory marks attached files like the manager does', () => {
  const history = [
    {
      info: { id: 'a', sessionID: 's', role: 'user' as const },
      parts: [
        { id: 'a-f', type: 'file' as const, sessionID: 's', messageID: 'a', state: { status: 'completed' as const, name: 'note.txt' } },
        { id: 'a-t', type: 'text' as const, sessionID: 's', messageID: 'a', text: 'read this' }
      ]
    }
  ]
  const messages = openAiMessagesFromHistory(history, 'sys')
  assert.match(messages[1].content as string, /Attached file/)
  assert.match(messages[1].content as string, /read this/)
})

function textMessage(id: string, role: 'user' | 'assistant', text: string): MessageWithParts {
  return {
    info: { id, sessionID: 's', role },
    parts: [{ id: `${id}-p`, type: 'text' as const, sessionID: 's', messageID: id, text }]
  }
}

/** A single assistant message carrying a completed tool call and its result,
 *  which is how the store keeps them. */
function toolPair(prefix: string): MessageWithParts[] {
  return [{
    info: { id: `${prefix}-a`, sessionID: 's', role: 'assistant' as const },
    parts: [{
      id: `${prefix}-call`,
      type: 'tool' as const,
      sessionID: 's',
      messageID: `${prefix}-a`,
      state: { status: 'completed' as const, tool: 'bash', input: { command: 'test' }, output: 'the-tool-output' }
    }]
  }]
}

test('cropHistory leaves a small history untouched', () => {
  const history = [textMessage('u', 'user', 'hi'), textMessage('a', 'assistant', 'hello')]
  const { history: kept, omitted } = cropHistory(history, 10_000)
  assert.equal(omitted, false)
  assert.equal(kept.length, 2)
})

test('cropHistory trims old messages but keeps the original instruction', () => {
  // Each assistant reply is ~100 chars; a small budget drops the middle.
  const history = [textMessage('u', 'user', 'the original task')]
  for (let i = 0; i < 10; i++) history.push(textMessage(`a${i}`, 'assistant', `reply number ${i} `.repeat(8)))
  const { history: kept, omitted } = cropHistory(history, 400)
  assert.equal(omitted, true)
  assert.equal(kept[0].info.id, 'u')
  // The newest messages survive.
  assert.ok(kept.some((message) => message.info.id === 'a9'))
})

test('cropHistory keeps whole messages from the tail and never splits a tool message', () => {
  const history = [textMessage('u', 'user', 'task')]
  for (let i = 0; i < 5; i++) history.push(...toolPair(`p${i}`))
  const { history: kept, omitted } = cropHistory(history, 300)
  assert.equal(omitted, true)
  // Every kept tool message is intact: the call and its result ship together.
  for (const message of kept) {
    for (const part of message.parts) {
      if (part.type !== 'tool') continue
      assert.equal(part.state?.tool, 'bash')
      assert.equal(part.state?.output, 'the-tool-output')
    }
  }
  assert.ok(kept.some((message) => message.info.id === 'p4-a'))
})
test('parseChatChunk drops a null id and name so a later chunk cannot erase them', () => {
  // The exact wire shape DeepSeek sends via OpenCode Zen: the opening chunk
  // names the call, and every later chunk repeats id/name as explicit null.
  const opening = parseChatChunk(
    '{"choices":[{"index":0,"finish_reason":null,"delta":{"role":null,"content":"","tool_calls":[{"index":0,"id":"chatcmpl-tool-b303","type":"function","function":{"name":"read_file","arguments":""}}]}}]}'
  )
  assert.deepEqual(opening?.toolCalls, [{ index: 0, id: 'chatcmpl-tool-b303', name: 'read_file', arguments: '' }])

  const continuation = parseChatChunk(
    '{"choices":[{"index":0,"finish_reason":null,"delta":{"role":null,"content":"","tool_calls":[{"index":0,"id":null,"type":null,"function":{"name":null,"arguments":"{\\"path\\": \\"a.txt\\"}"}}]}}]}'
  )
  // No id and no name keys at all — a null must not travel as a value.
  assert.deepEqual(continuation?.toolCalls, [{ index: 0, arguments: '{"path": "a.txt"}' }])
})

test('a null-repeating provider stream reassembles into one executable call', () => {
  const acc = new ToolCallAccumulator()
  for (const chunk of [
    '{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"chatcmpl-tool-b303","type":"function","function":{"name":"read_file","arguments":""}}]}}]}',
    '{"choices":[{"delta":{"tool_calls":[{"index":0,"id":null,"type":null,"function":{"name":null,"arguments":""}}]}}]}',
    '{"choices":[{"delta":{"tool_calls":[{"index":0,"id":null,"type":null,"function":{"name":null,"arguments":"{\\"path\\": \\"requests/models.py\\"}"}}]}}]}'
  ]) {
    for (const delta of parseChatChunk(chunk)?.toolCalls ?? []) acc.push(delta)
  }
  const [call] = acc.calls()
  assert.equal(call.name, 'read_file')
  assert.equal(call.id, 'chatcmpl-tool-b303')
  assert.deepEqual(parseToolArguments(call.arguments), { path: 'requests/models.py' })
})
