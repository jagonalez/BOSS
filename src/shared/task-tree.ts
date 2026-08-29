import type { SupervisedThread } from './supervision'

export interface TaskNode {
  thread: SupervisedThread
  depth: number
  children: TaskNode[]
}

/** The parent identity adapters agree on today.
 *
 * BOSS-created workers carry lineage, which also records why they were made.
 * Native backends generally expose only a parent session id. Prefer the richer
 * relationship without requiring every backend to manufacture BOSS metadata. */
function parentThreadId(thread: SupervisedThread): string | undefined {
  return thread.lineage?.sourceThreadId ?? thread.parentID
}

/** Nest threads under the thread each one came from.
 *
 *  The manager has always recorded delegation lineage; supervision just never
 *  carried it, so overview lists showed both a worker and the thread that spawned it
 *  as unrelated peers. Roots keep the order they arrived in, which is already
 *  most-recent-first, and children sort oldest-first so a task reads in the
 *  order the work actually happened.
 *
 *  A thread whose source is not in the same snapshot stays a root. That is the
 *  common case for a filtered or truncated list, so it must not hide the thread.
 */
export function buildTaskTree(threads: SupervisedThread[]): TaskNode[] {
  const nodes = new Map<string, TaskNode>()
  for (const thread of threads) {
    nodes.set(thread.threadId, { thread, depth: 0, children: [] })
  }

  const roots: TaskNode[] = []
  for (const thread of threads) {
    const node = nodes.get(thread.threadId)
    if (!node) continue
    const parentId = parentThreadId(thread)
    const parent = parentId === undefined ? undefined : nodes.get(parentId)
    // A cycle would otherwise strand every thread in it, so a thread that
    // cannot reach a root through its ancestors is treated as a root itself.
    if (!parent || parent === node || !reachesRoot(parent, nodes)) {
      roots.push(node)
      continue
    }
    parent.children.push(node)
  }

  for (const node of roots) assignDepth(node, 0)
  return roots
}

function reachesRoot(node: TaskNode, nodes: Map<string, TaskNode>): boolean {
  const seen = new Set<string>([node.thread.threadId])
  let current = node
  for (;;) {
    const parentId = parentThreadId(current.thread)
    if (parentId === undefined) return true
    const parent = nodes.get(parentId)
    if (!parent) return true
    if (seen.has(parentId)) return false
    seen.add(parentId)
    current = parent
  }
}

function assignDepth(node: TaskNode, depth: number): void {
  node.depth = depth
  node.children.sort((a, b) => a.thread.updatedAt - b.thread.updatedAt)
  for (const child of node.children) assignDepth(child, depth + 1)
}

/** Flatten the tree depth-first so a list surface can render it in one pass. */
export function flattenTaskTree(nodes: TaskNode[]): TaskNode[] {
  const flat: TaskNode[] = []
  const visit = (node: TaskNode): void => {
    flat.push(node)
    for (const child of node.children) visit(child)
  }
  for (const node of nodes) visit(node)
  return flat
}

/** Every worker below one thread, in display order and with depth relative to
 * that thread.
 *
 * This does not require the owner itself to be present in the snapshot. That
 * matters for native children: an adapter may discover a child before it has
 * imported or bound the native parent session. Cycles and repeated edges are
 * ignored so malformed backend data cannot hang a renderer. */
export function descendantTaskNodes(threads: SupervisedThread[], threadId: string): TaskNode[] {
  const children = new Map<string, SupervisedThread[]>()
  for (const thread of threads) {
    const parentId = parentThreadId(thread)
    if (!parentId || thread.threadId === parentId) continue
    const siblings = children.get(parentId) ?? []
    siblings.push(thread)
    children.set(parentId, siblings)
  }
  for (const siblings of children.values()) siblings.sort((a, b) => a.updatedAt - b.updatedAt)

  const descendants: TaskNode[] = []
  const seen = new Set<string>([threadId])
  const visit = (parentId: string, depth: number): void => {
    for (const thread of children.get(parentId) ?? []) {
      if (seen.has(thread.threadId)) continue
      seen.add(thread.threadId)
      const node: TaskNode = { thread, depth, children: [] }
      descendants.push(node)
      visit(thread.threadId, depth + 1)
    }
  }
  visit(threadId, 0)
  return descendants
}
