export type ProductGraphNodeKind =
  | 'product'
  | 'component'
  | 'codebase'
  | 'checkout'
  | 'environment'
  | 'platform'
  | 'deployment'
  | 'project'
  | 'work-item'
  | 'run'
  | 'rollout'
  | 'signal'
  | 'observation'
  | 'artifact'
  | 'decision'
  | 'knowledge'

export type ProductGraphRelationKind =
  | 'contains'
  | 'part-of'
  | 'checkout-of'
  | 'built-from'
  | 'packaged-by'
  | 'provisioned-by'
  | 'deployed-by'
  | 'depends-on'
  | 'runs-in'
  | 'observed-by'
  | 'observation-of'
  | 'affects'
  | 'documented-by'
  | 'produced-by'
  | 'validated-by'
  | 'supersedes'

interface ProductGraphNodeBase<Kind extends ProductGraphNodeKind> {
  id: string
  kind: Kind
  name: string
  description?: string
  createdAt: number
  updatedAt: number
}

export interface ProductNode extends ProductGraphNodeBase<'product'> {
  purpose?: string
}

export interface ComponentNode extends ProductGraphNodeBase<'component'> {
  componentType: 'service' | 'application' | 'library' | 'job' | 'infrastructure' | 'other'
}

export interface CodebaseNode extends ProductGraphNodeBase<'codebase'> {
  sourceKind: 'git' | 'directory'
  remote?: string
  defaultBranch?: string
}

export interface CheckoutNode extends ProductGraphNodeBase<'checkout'> {
  path: string
  branch?: string
  main: boolean
}

export interface EnvironmentNode extends ProductGraphNodeBase<'environment'> {
  environmentType: 'development' | 'test' | 'staging' | 'production' | 'other'
}

export interface PlatformNode extends ProductGraphNodeBase<'platform'> {
  platformType: 'kubernetes' | 'cloud' | 'deployment' | 'local' | 'other'
  externalRef?: string
}

export interface DeploymentNode extends ProductGraphNodeBase<'deployment'> {
  version?: string
  health: 'unknown' | 'healthy' | 'degraded' | 'unhealthy'
  observedAt?: number
}

export interface ProjectNode extends ProductGraphNodeBase<'project'> {
  outcome: string
  successCriteria: string[]
  status: 'proposed' | 'planned' | 'active' | 'paused' | 'completed' | 'cancelled'
  health: 'unknown' | 'on-track' | 'at-risk' | 'off-track'
  startedAt?: number
  targetAt?: number
  completedAt?: number
}

export interface WorkItemNode extends ProductGraphNodeBase<'work-item'> {
  workType: 'research' | 'decision' | 'design' | 'architecture' | 'code' | 'qa' | 'documentation' | 'release' | 'operations'
  acceptanceCriteria: string[]
  status: 'backlog' | 'ready' | 'running' | 'blocked' | 'review' | 'done' | 'cancelled'
}

export interface RunNode extends ProductGraphNodeBase<'run'> {
  recipeId?: string
  threadIds: string[]
  status: 'queued' | 'running' | 'waiting' | 'needs-attention' | 'completed' | 'failed' | 'cancelled'
  startedAt?: number
  completedAt?: number
}

export interface RolloutStage {
  id: string
  name: string
  status: 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'rolled-back'
  environmentId?: string
  startedAt?: number
  completedAt?: number
}

export interface RolloutNode extends ProductGraphNodeBase<'rollout'> {
  status: 'draft' | 'ready' | 'running' | 'paused' | 'completed' | 'rolled-back' | 'failed'
  stages: RolloutStage[]
}

export interface SignalNode extends ProductGraphNodeBase<'signal'> {
  signalType: 'metric' | 'monitor' | 'alert' | 'incident' | 'feedback' | 'other'
  externalRef?: string
}

export interface ObservationNode extends ProductGraphNodeBase<'observation'> {
  observedAt: number
  expiresAt?: number
  status: 'informational' | 'healthy' | 'warning' | 'critical' | 'resolved'
  value?: unknown
}

export interface ArtifactNode extends ProductGraphNodeBase<'artifact'> {
  artifactType: 'plan' | 'specification' | 'document' | 'diff' | 'test-result' | 'review' | 'report' | 'pull-request' | 'site' | 'deployment-result' | 'other'
  externalRef?: string
}

export interface DecisionNode extends ProductGraphNodeBase<'decision'> {
  status: 'proposed' | 'accepted' | 'rejected' | 'superseded'
  rationale?: string
  decidedAt?: number
}

export interface KnowledgeSourcePathReceipt {
  path: string
  contentHash: string
}

/** The evidence used to generate one derived knowledge artifact.
 *
 * `revision` is the broad source revision (for example a Git commit or document
 * revision). `paths` lets an unchanged input survive unrelated repository
 * commits. `scopeHash` additionally covers discovery, including new matching
 * files; without it a changed broad revision can only be called unknown. */
export interface KnowledgeSourceReceipt {
  resourceId: string
  revision: string
  paths?: KnowledgeSourcePathReceipt[]
  scopeHash?: string
}

export interface KnowledgeNode extends ProductGraphNodeBase<'knowledge'> {
  knowledgeType: 'architecture' | 'deployment' | 'testing' | 'product-context' | 'operations' | 'other'
  content: string
  sources: KnowledgeSourceReceipt[]
  generatedAt: number
  generator: {
    model: string
    promptVersion: string
  }
  freshness: KnowledgeFreshness
}

export type ProductGraphNode =
  | ProductNode
  | ComponentNode
  | CodebaseNode
  | CheckoutNode
  | EnvironmentNode
  | PlatformNode
  | DeploymentNode
  | ProjectNode
  | WorkItemNode
  | RunNode
  | RolloutNode
  | SignalNode
  | ObservationNode
  | ArtifactNode
  | DecisionNode
  | KnowledgeNode

export interface ProductGraphRelation {
  id: string
  kind: ProductGraphRelationKind
  sourceId: string
  targetId: string
  createdAt: number
  metadata?: Record<string, unknown>
}

export interface ProductGraph {
  version: 1
  nodes: ProductGraphNode[]
  relations: ProductGraphRelation[]
}

/** How the current in-memory document was established.
 *
 *  `persisted` means it was read from disk or written by a replace. The seed
 *  outcomes stand in for a missing or unusable file: a missing file adopts the
 *  folder-project projection when one is known, a malformed file falls back to
 *  that same seed, and an unknown schema version is not adopted at all — the
 *  document stays untouched on disk until an explicit replace takes over. */
export type ProductGraphDocumentSource =
  | 'persisted'
  | 'seeded-empty'
  | 'seeded-legacy-project'
  | 'malformed-file'
  | 'unsupported-version'

export interface ProductGraphSnapshot {
  graph: ProductGraph
  source: ProductGraphDocumentSource
  /** Validation issues found in the document as loaded. Advisories on read:
   *  only a replace is gated on them. */
  issues: ProductGraphValidationIssue[]
}

export interface ProductGraphReplaceResult {
  ok: boolean
  /** Populated when validation refused the document. */
  issues: ProductGraphValidationIssue[]
  /** Populated when the document was rejected before validation, or the
   *  write itself failed. */
  error?: string
}

export type KnowledgeFreshness = 'fresh' | 'stale' | 'unknown'

export interface KnowledgeSourceState {
  resourceId: string
  reachable: boolean
  revision?: string
  /** Hash of the discovery scope, including the set of matching files. */
  scopeHash?: string
  /** Current content hashes keyed by source-relative path. */
  paths?: Record<string, string>
}

/** Re-evaluate a derived artifact without asking a model.
 *
 * An exact revision remains fresh. A changed broad revision remains fresh only
 * when a recorded discovery scope is unchanged. Matching scanned-file hashes
 * alone cannot rule out a newly added relevant file, so that case is unknown
 * rather than falsely fresh. */
export function knowledgeFreshness(
  artifact: Pick<KnowledgeNode, 'sources'>,
  states: KnowledgeSourceState[]
): KnowledgeFreshness {
  const byResource = new Map(states.map((state) => [state.resourceId, state]))
  let uncertain = false

  for (const receipt of artifact.sources) {
    const state = byResource.get(receipt.resourceId)
    if (!state?.reachable || !state.revision) return 'unknown'

    if (receipt.paths?.length) {
      if (!state.paths) {
        uncertain = true
      } else {
        for (const path of receipt.paths) {
          if (state.paths[path.path] !== path.contentHash) return 'stale'
        }
      }
    }

    if (receipt.scopeHash !== undefined) {
      if (state.scopeHash === undefined) uncertain = true
      else if (state.scopeHash !== receipt.scopeHash) return 'stale'
    }

    if (state.revision !== receipt.revision) {
      if (receipt.scopeHash !== undefined && state.scopeHash === receipt.scopeHash) continue
      if (receipt.paths?.length) uncertain = true
      else return 'stale'
    }
  }

  return uncertain ? 'unknown' : 'fresh'
}

export interface ProductGraphValidationIssue {
  code: 'invalid-node' | 'duplicate-node' | 'duplicate-relation' | 'dangling-relation' | 'self-relation' | 'invalid-relation' | 'invalid-reference'
  path: string
  message: string
}

type EndpointRule = {
  source: ProductGraphNodeKind[]
  target: ProductGraphNodeKind[]
}

const ENDPOINT_RULES: Partial<Record<ProductGraphRelationKind, EndpointRule>> = {
  'checkout-of': { source: ['checkout'], target: ['codebase'] },
  'built-from': { source: ['component'], target: ['codebase'] },
  'packaged-by': { source: ['component'], target: ['codebase'] },
  'provisioned-by': { source: ['component', 'deployment'], target: ['codebase'] },
  'deployed-by': { source: ['component', 'deployment'], target: ['codebase'] },
  'runs-in': { source: ['deployment'], target: ['environment', 'platform'] },
  'observed-by': { source: ['component', 'deployment'], target: ['signal'] },
  'observation-of': { source: ['observation'], target: ['signal', 'deployment'] },
  'affects': { source: ['project', 'work-item'], target: ['product', 'component', 'codebase', 'environment', 'platform', 'deployment'] },
  'produced-by': { source: ['artifact', 'knowledge', 'observation'], target: ['project', 'work-item', 'run', 'rollout', 'signal'] },
  'validated-by': { source: ['project', 'work-item', 'run', 'rollout'], target: ['artifact', 'signal', 'observation'] }
}

export function validateProductGraph(graph: ProductGraph): ProductGraphValidationIssue[] {
  const issues: ProductGraphValidationIssue[] = []
  const nodes = new Map<string, ProductGraphNode>()
  const relationIds = new Set<string>()

  for (const [index, node] of graph.nodes.entries()) {
    if (!node.id.trim() || !node.name.trim()) {
      issues.push({ code: 'invalid-node', path: `nodes[${index}]`, message: 'Product Graph nodes need a non-empty id and name.' })
    }
    if (nodes.has(node.id)) {
      issues.push({ code: 'duplicate-node', path: `nodes[${index}].id`, message: `Node id ${node.id} is repeated.` })
    } else {
      nodes.set(node.id, node)
    }
  }

  for (const [index, relation] of graph.relations.entries()) {
    if (relationIds.has(relation.id)) {
      issues.push({ code: 'duplicate-relation', path: `relations[${index}].id`, message: `Relation id ${relation.id} is repeated.` })
    }
    relationIds.add(relation.id)

    const source = nodes.get(relation.sourceId)
    const target = nodes.get(relation.targetId)
    if (!source || !target) {
      issues.push({
        code: 'dangling-relation',
        path: `relations[${index}]`,
        message: `Relation ${relation.id} references ${!source ? relation.sourceId : relation.targetId}, which is not in the graph.`
      })
      continue
    }
    if (source.id === target.id) {
      issues.push({ code: 'self-relation', path: `relations[${index}]`, message: `Relation ${relation.id} points ${source.id} at itself.` })
      continue
    }
    const rule = ENDPOINT_RULES[relation.kind]
    if (rule && (!rule.source.includes(source.kind) || !rule.target.includes(target.kind))) {
      issues.push({
        code: 'invalid-relation',
        path: `relations[${index}]`,
        message: `${relation.kind} cannot connect ${source.kind} to ${target.kind}.`
      })
    }
  }

  for (const [index, node] of graph.nodes.entries()) {
    if (node.kind === 'knowledge') {
      for (const [sourceIndex, source] of node.sources.entries()) {
        if (!nodes.has(source.resourceId)) {
          issues.push({
            code: 'invalid-reference',
            path: `nodes[${index}].sources[${sourceIndex}].resourceId`,
            message: `Knowledge source ${source.resourceId} is not in the graph.`
          })
        }
      }
    }
    if (node.kind === 'rollout') {
      for (const [stageIndex, stage] of node.stages.entries()) {
        if (stage.environmentId && nodes.get(stage.environmentId)?.kind !== 'environment') {
          issues.push({
            code: 'invalid-reference',
            path: `nodes[${index}].stages[${stageIndex}].environmentId`,
            message: `Rollout stage environment ${stage.environmentId} is missing or is not an environment.`
          })
        }
      }
    }
  }

  return issues
}
