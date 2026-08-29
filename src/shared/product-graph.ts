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

type UnknownRecord = Record<string, unknown>

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string'
}

function isOptionalNumber(value: unknown): boolean {
  return value === undefined || isFiniteNumber(value)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
}

function isOneOf<const Choice extends string>(value: unknown, choices: readonly Choice[]): value is Choice {
  return typeof value === 'string' && (choices as readonly string[]).includes(value)
}

const NODE_KINDS: readonly ProductGraphNodeKind[] = [
  'product', 'component', 'codebase', 'checkout', 'environment', 'platform',
  'deployment', 'project', 'work-item', 'run', 'rollout', 'signal',
  'observation', 'artifact', 'decision', 'knowledge'
]

const RELATION_KINDS: readonly ProductGraphRelationKind[] = [
  'contains', 'part-of', 'checkout-of', 'built-from', 'packaged-by',
  'provisioned-by', 'deployed-by', 'depends-on', 'runs-in', 'observed-by',
  'observation-of', 'affects', 'documented-by', 'produced-by', 'validated-by',
  'supersedes'
]

function nodeShapeError(value: unknown, path: string): string | null {
  if (!isRecord(value)) return `${path} must be an object.`
  if (typeof value.id !== 'string') return `${path}.id must be a string.`
  if (!isOneOf(value.kind, NODE_KINDS)) return `${path}.kind is not a supported Product Graph node kind.`
  if (typeof value.name !== 'string') return `${path}.name must be a string.`
  if (!isOptionalString(value.description)) return `${path}.description must be a string when present.`
  if (!isFiniteNumber(value.createdAt)) return `${path}.createdAt must be a finite number.`
  if (!isFiniteNumber(value.updatedAt)) return `${path}.updatedAt must be a finite number.`

  switch (value.kind) {
    case 'product':
      return isOptionalString(value.purpose) ? null : `${path}.purpose must be a string when present.`
    case 'component':
      return isOneOf(value.componentType, ['service', 'application', 'library', 'job', 'infrastructure', 'other'])
        ? null : `${path}.componentType is invalid.`
    case 'codebase':
      if (!isOneOf(value.sourceKind, ['git', 'directory'])) return `${path}.sourceKind is invalid.`
      if (!isOptionalString(value.remote)) return `${path}.remote must be a string when present.`
      return isOptionalString(value.defaultBranch) ? null : `${path}.defaultBranch must be a string when present.`
    case 'checkout':
      if (typeof value.path !== 'string') return `${path}.path must be a string.`
      if (!isOptionalString(value.branch)) return `${path}.branch must be a string when present.`
      return typeof value.main === 'boolean' ? null : `${path}.main must be a boolean.`
    case 'environment':
      return isOneOf(value.environmentType, ['development', 'test', 'staging', 'production', 'other'])
        ? null : `${path}.environmentType is invalid.`
    case 'platform':
      if (!isOneOf(value.platformType, ['kubernetes', 'cloud', 'deployment', 'local', 'other'])) return `${path}.platformType is invalid.`
      return isOptionalString(value.externalRef) ? null : `${path}.externalRef must be a string when present.`
    case 'deployment':
      if (!isOptionalString(value.version)) return `${path}.version must be a string when present.`
      if (!isOneOf(value.health, ['unknown', 'healthy', 'degraded', 'unhealthy'])) return `${path}.health is invalid.`
      return isOptionalNumber(value.observedAt) ? null : `${path}.observedAt must be a finite number when present.`
    case 'project':
      if (typeof value.outcome !== 'string') return `${path}.outcome must be a string.`
      if (!isStringArray(value.successCriteria)) return `${path}.successCriteria must contain strings.`
      if (!isOneOf(value.status, ['proposed', 'planned', 'active', 'paused', 'completed', 'cancelled'])) return `${path}.status is invalid.`
      if (!isOneOf(value.health, ['unknown', 'on-track', 'at-risk', 'off-track'])) return `${path}.health is invalid.`
      for (const field of ['startedAt', 'targetAt', 'completedAt'] as const) {
        if (!isOptionalNumber(value[field])) return `${path}.${field} must be a finite number when present.`
      }
      return null
    case 'work-item':
      if (!isOneOf(value.workType, ['research', 'decision', 'design', 'architecture', 'code', 'qa', 'documentation', 'release', 'operations'])) return `${path}.workType is invalid.`
      if (!isStringArray(value.acceptanceCriteria)) return `${path}.acceptanceCriteria must contain strings.`
      return isOneOf(value.status, ['backlog', 'ready', 'running', 'blocked', 'review', 'done', 'cancelled'])
        ? null : `${path}.status is invalid.`
    case 'run':
      if (!isOptionalString(value.recipeId)) return `${path}.recipeId must be a string when present.`
      if (!isStringArray(value.threadIds)) return `${path}.threadIds must contain strings.`
      if (!isOneOf(value.status, ['queued', 'running', 'waiting', 'needs-attention', 'completed', 'failed', 'cancelled'])) return `${path}.status is invalid.`
      if (!isOptionalNumber(value.startedAt)) return `${path}.startedAt must be a finite number when present.`
      return isOptionalNumber(value.completedAt) ? null : `${path}.completedAt must be a finite number when present.`
    case 'rollout': {
      if (!isOneOf(value.status, ['draft', 'ready', 'running', 'paused', 'completed', 'rolled-back', 'failed'])) return `${path}.status is invalid.`
      if (!Array.isArray(value.stages)) return `${path}.stages must be an array.`
      for (const [index, stage] of value.stages.entries()) {
        const stagePath = `${path}.stages[${index}]`
        if (!isRecord(stage)) return `${stagePath} must be an object.`
        if (typeof stage.id !== 'string') return `${stagePath}.id must be a string.`
        if (typeof stage.name !== 'string') return `${stagePath}.name must be a string.`
        if (!isOneOf(stage.status, ['pending', 'running', 'paused', 'completed', 'failed', 'rolled-back'])) return `${stagePath}.status is invalid.`
        if (!isOptionalString(stage.environmentId)) return `${stagePath}.environmentId must be a string when present.`
        if (!isOptionalNumber(stage.startedAt)) return `${stagePath}.startedAt must be a finite number when present.`
        if (!isOptionalNumber(stage.completedAt)) return `${stagePath}.completedAt must be a finite number when present.`
      }
      return null
    }
    case 'signal':
      if (!isOneOf(value.signalType, ['metric', 'monitor', 'alert', 'incident', 'feedback', 'other'])) return `${path}.signalType is invalid.`
      return isOptionalString(value.externalRef) ? null : `${path}.externalRef must be a string when present.`
    case 'observation':
      if (!isFiniteNumber(value.observedAt)) return `${path}.observedAt must be a finite number.`
      if (!isOptionalNumber(value.expiresAt)) return `${path}.expiresAt must be a finite number when present.`
      return isOneOf(value.status, ['informational', 'healthy', 'warning', 'critical', 'resolved'])
        ? null : `${path}.status is invalid.`
    case 'artifact':
      if (!isOneOf(value.artifactType, ['plan', 'specification', 'document', 'diff', 'test-result', 'review', 'report', 'pull-request', 'site', 'deployment-result', 'other'])) return `${path}.artifactType is invalid.`
      return isOptionalString(value.externalRef) ? null : `${path}.externalRef must be a string when present.`
    case 'decision':
      if (!isOneOf(value.status, ['proposed', 'accepted', 'rejected', 'superseded'])) return `${path}.status is invalid.`
      if (!isOptionalString(value.rationale)) return `${path}.rationale must be a string when present.`
      return isOptionalNumber(value.decidedAt) ? null : `${path}.decidedAt must be a finite number when present.`
    case 'knowledge': {
      if (!isOneOf(value.knowledgeType, ['architecture', 'deployment', 'testing', 'product-context', 'operations', 'other'])) return `${path}.knowledgeType is invalid.`
      if (typeof value.content !== 'string') return `${path}.content must be a string.`
      if (!Array.isArray(value.sources)) return `${path}.sources must be an array.`
      for (const [index, source] of value.sources.entries()) {
        const sourcePath = `${path}.sources[${index}]`
        if (!isRecord(source)) return `${sourcePath} must be an object.`
        if (typeof source.resourceId !== 'string') return `${sourcePath}.resourceId must be a string.`
        if (typeof source.revision !== 'string') return `${sourcePath}.revision must be a string.`
        if (!isOptionalString(source.scopeHash)) return `${sourcePath}.scopeHash must be a string when present.`
        if (source.paths !== undefined) {
          if (!Array.isArray(source.paths)) return `${sourcePath}.paths must be an array when present.`
          for (const [pathIndex, receipt] of source.paths.entries()) {
            if (!isRecord(receipt) || typeof receipt.path !== 'string' || typeof receipt.contentHash !== 'string') {
              return `${sourcePath}.paths[${pathIndex}] must contain string path and contentHash fields.`
            }
          }
        }
      }
      if (!isFiniteNumber(value.generatedAt)) return `${path}.generatedAt must be a finite number.`
      if (!isRecord(value.generator) || typeof value.generator.model !== 'string' || typeof value.generator.promptVersion !== 'string') {
        return `${path}.generator must contain string model and promptVersion fields.`
      }
      return isOneOf(value.freshness, ['fresh', 'stale', 'unknown']) ? null : `${path}.freshness is invalid.`
    }
  }

  return `${path}.kind is not a supported Product Graph node kind.`
}

/** Runtime shape validation for data crossing IPC or read from disk. Semantic
 * validation happens separately after this function proves the value is safe
 * to treat as a ProductGraph. */
export function productGraphShapeError(value: unknown): string | null {
  if (!isRecord(value)) return 'Product Graph document must be an object.'
  if (value.version !== 1) return 'Product Graph document version must be 1.'
  if (!Array.isArray(value.nodes)) return 'Product Graph document nodes must be an array.'
  if (!Array.isArray(value.relations)) return 'Product Graph document relations must be an array.'

  for (const [index, node] of value.nodes.entries()) {
    const error = nodeShapeError(node, `nodes[${index}]`)
    if (error) return error
  }
  for (const [index, relation] of value.relations.entries()) {
    const path = `relations[${index}]`
    if (!isRecord(relation)) return `${path} must be an object.`
    if (typeof relation.id !== 'string') return `${path}.id must be a string.`
    if (!isOneOf(relation.kind, RELATION_KINDS)) return `${path}.kind is not a supported Product Graph relation kind.`
    if (typeof relation.sourceId !== 'string') return `${path}.sourceId must be a string.`
    if (typeof relation.targetId !== 'string') return `${path}.targetId must be a string.`
    if (!isFiniteNumber(relation.createdAt)) return `${path}.createdAt must be a finite number.`
    if (relation.metadata !== undefined && !isRecord(relation.metadata)) return `${path}.metadata must be an object when present.`
  }
  return null
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
