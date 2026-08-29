import { createHash } from 'node:crypto'
import { basename } from 'node:path'
import type { ProjectCheckout, ProjectScope } from './project-identity'
import type { CheckoutNode, CodebaseNode, ProductGraph, ProductGraphRelation } from '../shared/product-graph'

export interface LegacyProjectGraphInput {
  scope: ProjectScope
  checkouts: ProjectCheckout[]
  sourceKind?: CodebaseNode['sourceKind']
  now: number
}

function stableId(prefix: string, value: string): string {
  return `${prefix}_${createHash('sha256').update(value).digest('hex').slice(0, 24)}`
}

/** Compatibility projection for the path-based Project model.
 *
 * It deliberately does not persist or rename anything. Callers can construct
 * the future Codebase/Checkout view beside today's `projectPath` behavior and
 * compare it before a storage migration is introduced. */
export function legacyProjectGraph(input: LegacyProjectGraphInput): ProductGraph {
  const { scope, now } = input
  if (!scope.projectPath || scope.projectId === 'global') return { version: 1, nodes: [], relations: [] }

  const codebaseId = scope.projectId.startsWith('project_')
    ? `codebase_${scope.projectId.slice('project_'.length)}`
    : stableId('codebase', scope.projectId)
  const codebase: CodebaseNode = {
    id: codebaseId,
    kind: 'codebase',
    name: basename(scope.projectPath) || scope.projectPath,
    sourceKind: input.sourceKind ?? 'directory',
    createdAt: now,
    updatedAt: now
  }

  const seen = new Set<string>()
  const projected = [...input.checkouts]
  if (!projected.some((checkout) => checkout.path === scope.executionPath)) {
    projected.push({ path: scope.executionPath, main: scope.executionPath === scope.projectPath })
  }
  const checkouts: CheckoutNode[] = []
  const relations: ProductGraphRelation[] = []
  for (const checkout of projected) {
    if (!checkout.path || seen.has(checkout.path)) continue
    seen.add(checkout.path)
    const checkoutId = stableId('checkout', `${codebaseId}\0${checkout.path}`)
    checkouts.push({
      id: checkoutId,
      kind: 'checkout',
      name: checkout.main ? `${codebase.name} · main checkout` : `${codebase.name} · ${checkout.branch ?? basename(checkout.path)}`,
      path: checkout.path,
      ...(checkout.branch ? { branch: checkout.branch } : {}),
      main: checkout.main,
      createdAt: now,
      updatedAt: now
    })
    relations.push({
      id: stableId('relation', `${checkoutId}\0checkout-of\0${codebaseId}`),
      kind: 'checkout-of',
      sourceId: checkoutId,
      targetId: codebaseId,
      createdAt: now
    })
  }

  return { version: 1, nodes: [codebase, ...checkouts], relations }
}
