import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type {
  ProductGraph,
  ProductGraphDocumentSource,
  ProductGraphReplaceResult,
  ProductGraphSnapshot,
  ProductGraphValidationIssue
} from '../shared/product-graph'
// @ts-expect-error Node's type-stripping test runner needs the extension.
import { validateProductGraph } from '../shared/product-graph.ts'

/** Produces the folder-project projection a missing file adopts. Returning
 *  null (no known project) seeds an empty graph instead. */
export type ProductGraphSeedSource = () => ProductGraph | null

const EMPTY_GRAPH: ProductGraph = { version: 1, nodes: [], relations: [] }

interface GraphEnvelope {
  version: unknown
  nodes: unknown[]
  relations: unknown[]
}

/** Shape check only: arrays of objects. The version gate happens separately,
 *  so an unknown version is distinguishable from a malformed file. */
function isGraphEnvelope(value: unknown): value is GraphEnvelope {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as { version?: unknown; nodes?: unknown; relations?: unknown }
  return Array.isArray(candidate.nodes)
    && Array.isArray(candidate.relations)
    && candidate.nodes.every((node) => typeof node === 'object' && node !== null)
    && candidate.relations.every((relation) => typeof relation === 'object' && relation !== null)
}

function safeIssues(graph: ProductGraph): ProductGraphValidationIssue[] {
  try {
    return validateProductGraph(graph)
  } catch {
    // A document odd enough to crash the validator is malformed, not merely
    // invalid; the caller reports it as an unusable file.
    throw new Error('Product Graph could not be validated.')
  }
}

/** Durable home of the Product Graph document.
 *
 *  One versioned JSON file in the app data directory, following the store
 *  conventions used across BOSS managers. Load rules are deterministic:
 *
 *  - missing file: adopt the folder-project projection (the legacy seed), or
 *    an empty graph when no project is known. The seed is held in memory only;
 *    an explicit replace is what makes a document durable.
 *  - malformed file (unreadable, unparsable, wrong shape, validator crash):
 *    same fallback as a missing file, flagged `malformed-file`.
 *  - unknown schema version: never adopted and never re-derived from folder
 *    state; an empty graph is served and the file stays on disk untouched
 *    until an explicit replace takes over.
 *  - valid version 1: served as-is; validation issues ride along as
 *    advisories so a hand-edited file degrades visibly instead of bricking. */
export class ProductGraphStore {
  private loading?: Promise<void>
  private snapshot: ProductGraphSnapshot = { graph: EMPTY_GRAPH, source: 'seeded-empty', issues: [] }
  private readonly seedLegacy: ProductGraphSeedSource | undefined
  private readonly graphFile: string

  // Explicit assignments: Node's strip-only TS loader (used by the unit
  // tests) cannot handle parameter properties.
  constructor(graphFile: string, seedLegacy?: ProductGraphSeedSource) {
    this.graphFile = graphFile
    this.seedLegacy = seedLegacy
  }

  /** Memoized: concurrent first callers share one read, so a late file read
   *  can never clobber a replace that got in after it. */
  load(): Promise<void> {
    this.loading ??= this.doLoad()
    return this.loading
  }

  /** The current document. Seeds on first use when the file has nothing to
   *  offer, so a fresh install always has a graph to read. */
  async current(): Promise<ProductGraphSnapshot> {
    await this.load()
    return structuredClone(this.snapshot)
  }

  /** Replace the whole document after validation. A refused document changes
   *  nothing in memory or on disk, so the previous graph keeps serving. */
  async replace(input: unknown): Promise<ProductGraphReplaceResult> {
    await this.load()
    if (!isGraphEnvelope(input) || input.version !== 1) {
      return { ok: false, issues: [], error: 'A Product Graph document is version 1 with node and relation arrays.' }
    }
    const graph = input as ProductGraph
    let issues: ProductGraphValidationIssue[]
    try {
      issues = safeIssues(graph)
    } catch (error) {
      return { ok: false, issues: [], error: error instanceof Error ? error.message : String(error) }
    }
    if (issues.length > 0) return { ok: false, issues }
    const document = structuredClone(graph)
    try {
      await mkdir(dirname(this.graphFile), { recursive: true })
      await writeFile(this.graphFile, JSON.stringify(document, null, 2))
    } catch (error) {
      return { ok: false, issues: [], error: error instanceof Error ? error.message : String(error) }
    }
    this.snapshot = { graph: document, source: 'persisted', issues: [] }
    return { ok: true, issues: [] }
  }

  private seed(): { graph: ProductGraph; source: ProductGraphDocumentSource } {
    const legacy = this.seedLegacy?.()
    if (legacy) return { graph: legacy, source: 'seeded-legacy-project' }
    return { graph: EMPTY_GRAPH, source: 'seeded-empty' }
  }

  private async doLoad(): Promise<void> {
    let text: string
    try {
      text = await readFile(this.graphFile, 'utf8')
    } catch {
      const seeded = this.seed()
      this.snapshot = { graph: seeded.graph, source: seeded.source, issues: [] }
      return
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      const seeded = this.seed()
      this.snapshot = { graph: seeded.graph, source: 'malformed-file', issues: [] }
      return
    }

    if (!isGraphEnvelope(parsed)) {
      const seeded = this.seed()
      this.snapshot = { graph: seeded.graph, source: 'malformed-file', issues: [] }
      return
    }

    // Only version 1 is understood. The document on disk stays exactly as
    // written; nothing this build serves or writes may silently re-derive it.
    if (parsed.version !== 1) {
      this.snapshot = { graph: EMPTY_GRAPH, source: 'unsupported-version', issues: [] }
      return
    }

    try {
      const issues = safeIssues(parsed as ProductGraph)
      this.snapshot = { graph: parsed as ProductGraph, source: 'persisted', issues }
    } catch {
      const seeded = this.seed()
      this.snapshot = { graph: seeded.graph, source: 'malformed-file', issues: [] }
    }
  }
}
