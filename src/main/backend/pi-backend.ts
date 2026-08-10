import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { Backend } from './backend'
import type { EventMessage, SessionInfo, MessageWithParts, Todo, FileDiff, FileNode, FileContent } from '@shared/opencode'

type RpcRequest = { id?: string; type: string; [k: string]: unknown }
type RpcResponse = { id?: string; type: 'response'; command: string; success: boolean; data?: unknown; error?: string }

type Pending = { resolve: (v: unknown) => void; reject: (e: unknown) => void }

export class PiBackend implements Backend {
  readonly id = 'pi' as const
  private proc: ChildProcess | null = null
  private buffer = ''
  private nextId = 1
  private pending = new Map<string, Pending>()
  private projectPath = ''
  private eventCb?: (ev: EventMessage) => void

  private infoState = {
    version: '',
    healthy: false,
  }

  constructor(private cwd?: string) {}

  async start(): Promise<void> {
    if (this.proc) return
    // spawn pi --mode rpc, JSONL over stdio, frame on \n only (rpc.md: Framing)
    this.proc = spawn('pi', ['--mode', 'rpc'], {
      cwd: this.cwd ?? process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe']
    })
    const stdout = this.proc.stdout!
    const decoder = new TextDecoder()
    let buf = ''
    stdout.on('data', (chunk) => {
      buf += decoder.decode(chunk, { stream: true })
      let idx: number
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx).replace(/\r$/, '')
        buf = buf.slice(idx + 1)
        this.handleLine(line)
      }
    })
    // stderr for debug
    this.proc.stderr?.on('data', () => {})
    this.proc.on('exit', () => {
      this.infoState.healthy = false
      this.emit({ type: 'server.disconnected' })
    })
  }

  async stop(): Promise<void> {
    if (!this.proc) return
    this.proc.kill()
    this.proc = null
  }

  setProject(path: string): Promise<void> {
    this.projectPath = path
    // pi rpc is per-process; new process should be spawned with cwd=project
    // For now restart:
    return this.stop().then(() => this.start())
  }

  info() {
    return {
      id: this.id as const,
      engine: 'pi',
      version: this.infoState.version,
      healthy: this.infoState.healthy,
      projectPath: this.projectPath,
    }
  }

  onEvent(cb: (ev: EventMessage) => void): () => void {
    this.eventCb = cb
    return () => { this.eventCb = undefined }
  }

  private emit(ev: EventMessage) {
    this.eventCb?.(ev)
  }

  private send(req: RpcRequest): Promise<unknown> {
    if (!this.proc?.stdin) throw new Error('pi not running')
    const id = String(this.nextId++)
    const payload = { id, ...req }
    this.proc.stdin.write(JSON.stringify(payload) + '\n')
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      // timeout
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error('pi request timeout'))
        }
      }, 15000)
    })
  }

  private handleLine(line: string) {
    if (!line.trim()) return
    let msg: unknown
    try { msg = JSON.parse(line) } catch { return }
    const obj = msg as RpcResponse
    if (obj.type === 'response') {
      const p = this.pending.get(obj.id ?? '')
      p?.resolve(obj)
      this.pending.delete(obj.id ?? '')
    } else {
      // event -> map to EventMessage
      this.mapEvent(obj as any)
    }
  }

  private mapEvent(e: any) {
    // Minimal mapping stubs; extend per rpc.md Events table
    switch (e.type) {
      case 'agent_start':
        this.emit({ type: 'session.status', sessionID: e.sessionId ?? '', status: { type: 'busy' } })
        break
      case 'agent_end':
        this.emit({ type: 'session.status', sessionID: e.sessionId ?? '', status: { type: 'idle' } })
        break
      case 'message_start':
      case 'message_update':
      case 'message_end':
        // map to message.part.updated / created via SessionInfo?
        break
      default:
        this.emit({ type: 'unknown', raw: JSON.stringify(e) })
    }
  }

  /* Sessions */
  async sessionsList(): Promise<SessionInfo[]> { return [] }
  async sessionCreate(title?: string): Promise<SessionInfo> {
    await this.send({ type: 'new_session' })
    // stub
    return { id: 'pi-' + Math.random().toString(36).slice(2) }
  }
  async sessionDelete(id: string): Promise<void> { /* stub */ }
  async sessionRename(id: string, title: string): Promise<SessionInfo> { return { id } }
  async sessionGet(id: string): Promise<SessionInfo> { return { id } }

  /* Messages */
  async messagesList(sessionId: string, limit?: number): Promise<MessageWithParts[]> {
    const res = await this.send({ type: 'get_messages' })
    // map to MessageWithParts
    return []
  }
  async sendMessage(sessionId: string, parts: unknown[], opts?: any): Promise<void> {
    // switch session then prompt
    await this.send({ type: 'prompt', message: parts.map(p => (p as any).text || '').join('\n') })
  }
  async abort(sessionId: string): Promise<void> { await this.send({ type: 'abort' }) }

  /* Models */
  async modelsList(): Promise<{id:string}[]> {
    const res = await this.send({ type: 'get_available_models' })
    return []
  }
  async modelSelect(providerId: string, modelId: string): Promise<void> {
    await this.send({ type: 'set_model', provider: providerId, modelId })
  }

  /* Thinking */
  async thinkingGet(): Promise<{level:string}> { return { level: 'medium' } }
  async thinkingSet(level: string): Promise<void> { await this.send({ type: 'set_thinking_level', level }) }

  /* Todos / Permissions */
  async todosGet(sessionId: string): Promise<Todo[]> { return [] }
  async permissionRespond(sessionId: string, permissionId: string, response: 'once'|'always'|'reject'): Promise<void> { /* pi has no direct mapping */ }

  /* Files / Diff */
  async diffGet(sessionId: string, messageId?: string): Promise<FileDiff[]> { return [] }
  async fileTree(path?: string): Promise<FileNode[]> { return [] }
  async fileContent(path: string): Promise<FileContent> { return { path, content: '' } }

  /* Fork / Revert */
  async fork(sessionId: string, messageId?: string): Promise<SessionInfo> {
    await this.send({ type: 'fork', entryId: messageId })
    return { id: sessionId }
  }
  async revert(sessionId: string, messageId: string): Promise<void> { /* stub */ }
  async unrevert(sessionId: string): Promise<void> { /* stub */ }
}
