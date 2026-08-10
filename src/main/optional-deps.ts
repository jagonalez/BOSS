import { spawn } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'
import type {
  OptionalComponentId,
  OptionalComponentInfo,
  OptionalDownloadEvent
} from '@shared/ipc'

interface ComponentDef {
  id: OptionalComponentId
  label: string
  optional: boolean
  sizeMb?: number
}

const COMPONENTS: ComponentDef[] = [
  { id: 'opencode', label: 'opencode engine', optional: true, sizeMb: 90 },
  { id: 'browser-core', label: 'Browser core', optional: true, sizeMb: 60 },
  { id: 'computer-use', label: 'Computer use', optional: true, sizeMb: 25 }
]

function optionalDir(): string {
  return join(app.getPath('userData'), 'optional')
}

function componentDir(id: string): string {
  return join(optionalDir(), id)
}

function componentMarker(id: string): string {
  return join(componentDir(id), '.installed')
}

function bundledOpenCodePath(): string {
  const exe = process.platform === 'win32' ? 'opencode.exe' : 'opencode'
  const candidate = join(app.getAppPath(), 'resources', 'opencode', exe)
  return existsSync(candidate) ? candidate : ''
}

export class OptionalDeps {
  constructor(private readonly baseUrl = process.env.RALF_OPTIONAL_CDN ?? '') {}

  list(): OptionalComponentInfo[] {
    return COMPONENTS.map((def) => {
      const installed =
        def.id === 'opencode'
          ? Boolean(bundledOpenCodePath()) || existsSync(componentDir(def.id))
          : existsSync(componentDir(def.id))
      let version: string | undefined
      if (installed) {
        version = safeRead(componentMarker(def.id)) || 'bundled'
      }
      return {
        id: def.id,
        installed,
        version,
        optional: def.optional,
        sizeMb: def.sizeMb
      }
    })
  }

  async download(
    id: OptionalComponentId,
    onProgress?: (evt: OptionalDownloadEvent) => void
  ): Promise<void> {
    const def = COMPONENTS.find((c) => c.id === id)
    if (!def) throw new Error(`unknown component: ${id}`)
    if (this.list().find((c) => c.id === id)?.installed) return
    if (!this.baseUrl) throw new Error('optional downloads not configured (set RALF_OPTIONAL_CDN)')

    const url = `${this.baseUrl}/${id}/artifact.tar.gz`
    const destDir = componentDir(id)
    const tmpFile = join(tmpdir(), `ralf-${id}-${Date.now()}.tar.gz`)
    mkdirSync(destDir, { recursive: true })

    const res = await fetch(url)
    if (!res.ok || !res.body) throw new Error(`download failed: ${res.status}`)
    const total = Number(res.headers.get('content-length') ?? 0)

    await new Promise<void>((resolve, reject) => {
      const writer = createWriteStream(tmpFile)
      const reader = res.body!.getReader()
      writer.on('error', reject)
      const pump = async (): Promise<void> => {
        try {
          const { done, value } = await reader.read()
          if (done) {
            writer.end()
            resolve()
            return
          }
          if (value) writer.write(Buffer.from(value))
          onProgress?.({ id, phase: 'downloading', received: writer.bytesWritten, total: total || undefined })
          void pump()
        } catch (err) {
          reject(err as Error)
        }
      }
      void pump()
    })

    onProgress?.({ id, phase: 'extracting' })
    await new Promise<void>((resolve, reject) => {
      const child = spawn('tar', ['-xzf', tmpFile, '-C', destDir], { stdio: 'ignore' })
      child.on('error', reject)
      child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`extract failed: ${code}`))))
    })
    rmSync(tmpFile, { force: true })

    const version = safeRead(join(destDir, '.installed')) || def.id
    await writeFile(componentMarker(id), version, 'utf8')
    onProgress?.({ id, phase: 'done' })
  }
}

function safeRead(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8').trim() || undefined
  } catch {
    return undefined
  }
}
