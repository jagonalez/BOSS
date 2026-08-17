import type { MessageWithParts } from './opencode'

/** The text of a thread's most recent assistant reply.
 *
 *  Three callers need this: the automation summary, the reviewer verdict, and
 *  the task result. They had begun to grow separate copies that disagreed on
 *  which parts count as text.
 */
export function lastAssistantText(messages: MessageWithParts[]): string {
  const assistant = [...messages].reverse().find((message) => message.info?.role === 'assistant')
  if (!assistant) return ''
  return assistant.parts
    .filter((part) => part.type === 'text')
    .map((part) => part.text ?? '')
    .join('\n')
}

/** A one-line summary of what a thread finished doing.
 *
 *  Prefers an explicit `SUMMARY:` line, because a prompt can ask for one and
 *  get a deliberate answer. Falls back to the last non-empty line, which is
 *  where an agent that was not asked usually puts its conclusion.
 */
export function extractSummary(messages: MessageWithParts[]): string | undefined {
  const text = lastAssistantText(messages)
  const match = [...text.matchAll(/^SUMMARY:\s*(.+)$/gim)].pop()
  const line = match?.[1] ?? text.trim().split('\n').filter(Boolean).pop()
  return line ? line.trim().slice(0, 300) : undefined
}
