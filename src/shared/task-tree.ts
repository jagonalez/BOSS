import type { SupervisedThread } from './supervision'

export interface TaskNode {
  thread: SupervisedThread
  depth: number
  children: TaskNode[]
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
    const parentId = thread.lineage?.sourceThreadId
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
    const parentId = current.thread.lineage?.sourceThreadId
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
