/** Remove one deleted thread without invalidating the conversations that are
 * still open in other panes. Thread data is cached by id, so replacing either
 * whole record makes every surviving ChatView look like a new conversation
 * until it is selected and loaded again. */
export function pruneDeletedThreadCaches<Message, Todo>(
  messages: Record<string, Message>,
  todos: Record<string, Todo>,
  threadId: string
): { messages: Record<string, Message>; todos: Record<string, Todo> } {
  const nextMessages = { ...messages }
  const nextTodos = { ...todos }
  delete nextMessages[threadId]
  delete nextTodos[threadId]
  return { messages: nextMessages, todos: nextTodos }
}
