import { readFileSync, readdirSync, statSync, existsSync, type Dirent } from 'node:fs'
import { join, resolve, extname, basename, relative, sep } from 'node:path'

/** The scheme the renderer loads a project file through.
 *
 *  Mirrors boss-image:// and exists for the same reason: the window runs with
 *  webSecurity on, so file:// is refused, and a scheme of our own keeps the
 *  reach to one directory rather than the whole disk. The difference is that
 *  the root here is not fixed at construction — it is whichever project the
 *  user has open — so every read re-checks containment against the root it was
 *  given rather than a root baked in at startup. */
export const FILE_SCHEME = 'boss-file'

/** What the viewer should do with a file, decided by extension.
 *
 *  `text` is the existing path: read as UTF-8 and syntax-highlight. The other
 *  three are the ones that were previously mangled — a PNG read as UTF-8 is
 *  the mojibake this module exists to stop. */
export type PreviewKind = 'text' | 'image' | 'pdf' | 'binary'

/** Image types the renderer can display. Deliberately the same four as
 *  image-store.ts: widening this without widening that one would let a file
 *  preview render something a tool result could not.
 *
 *  SVG is pointedly absent. It is an image everywhere else in the app, but it
 *  is also a document that can carry script, and this scheme is privileged and
 *  CSP-exempt for its own bytes. Rendering a repository's .svg here would turn
 *  "preview a file" into an execution surface, so SVG falls through to the text
 *  path and is shown as source. */
const IMAGE_MIMES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif'
}

/** Extensions rendered as markdown rather than highlighted source. */
const MARKDOWN = new Set(['.md', '.markdown', '.mdx'])

/** Extensions rendered as a live page rather than source. */
const HTML = new Set(['.html', '.htm'])

/** Extensions that are known binary and have no preview. Listing them beats
 *  sniffing bytes: a file that is merely unusual should still open as text. */
const BINARY = new Set([
  '.zip', '.gz', '.tar', '.tgz', '.bz2', '.xz', '.7z', '.rar',
  '.exe', '.dll', '.so', '.dylib', '.bin', '.o', '.a', '.class', '.wasm',
  '.mp3', '.mp4', '.wav', '.mov', '.avi', '.mkv', '.flac', '.ogg', '.webm',
  '.ttf', '.otf', '.woff', '.woff2', '.eot',
  '.sqlite', '.db', '.pdf.lock', '.ico', '.icns', '.bmp', '.tiff', '.psd'
])

/** Files past this size are not read as text. Highlighting a hundred-megabyte
 *  log locks the renderer for long enough to look like a hang, and nobody is
 *  reading it in a preview pane anyway. */
const MAX_TEXT_BYTES = 2 * 1024 * 1024

export interface PreviewInfo {
  path: string
  /** The path on disk. "Open in editor" hands this to the OS, which has no
   *  idea what the project root is, so the relative path alone would fail. */
  absolute: string
  kind: PreviewKind
  /** Set for `image` and `pdf`: the URL the renderer loads the bytes from. */
  url?: string
  mime?: string
  /** Set for `text`: the decoded contents. */
  content?: string
  /** How the text should be presented. Absent for non-text files. */
  render?: 'code' | 'markdown' | 'html'
  size: number
  /** Set when the file was too large or could not be decoded, so the viewer can
   *  say why instead of showing an empty pane. */
  note?: string
}

/** Decide how a file should be shown, from its extension alone. */
export function previewKind(path: string): { kind: PreviewKind; mime?: string; render?: 'code' | 'markdown' | 'html' } {
  const ext = extname(path).toLowerCase()
  const image = IMAGE_MIMES[ext]
  if (image) return { kind: 'image', mime: image }
  if (ext === '.pdf') return { kind: 'pdf', mime: 'application/pdf' }
  if (BINARY.has(ext)) return { kind: 'binary' }
  if (MARKDOWN.has(ext)) return { kind: 'text', render: 'markdown' }
  if (HTML.has(ext)) return { kind: 'text', render: 'html' }
  return { kind: 'text', render: 'code' }
}

/** Names never worth walking into. Kept small on purpose: this is about not
 *  hanging on directories with a million entries, not about hiding files. */
const SKIP_DIRS = new Set(['.git', 'node_modules', '.DS_Store'])

export interface TreeNode {
  name: string
  path: string
  type: 'file' | 'directory'
  ignored?: boolean
}

/** Reads a project's files straight from disk.
 *
 *  The Files tab used to reach opencode's HTTP server for this, which made a
 *  local directory listing depend on an optional 90 MB download and on which
 *  backend the thread happened to use. Nothing about reading a file needs an
 *  agent, so this does it directly and works the same on every backend. */
export class ProjectFiles {
  /** One level of a directory, sorted directories-first then by name.
   *
   *  Shallow by design: the tree lazy-loads as the user expands, so walking
   *  the whole project up front would cost far more than it saves. */
  list(root: string, path = ''): TreeNode[] {
    const dir = this.contain(root, path)
    if (!dir) return []
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return []
    }
    const nodes: TreeNode[] = []
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue
      const absolute = join(dir, entry.name)
      const rel = relative(resolve(root), absolute).split(sep).join('/')
      const isDir = entry.isDirectory()
      // A symlink reports neither file nor directory on some platforms; stat it
      // rather than dropping it, so a linked source folder still opens.
      if (!isDir && !entry.isFile()) {
        try {
          if (!statSync(absolute).isDirectory()) nodes.push({ name: entry.name, path: rel, type: 'file' })
          else nodes.push({ name: entry.name, path: rel, type: 'directory' })
        } catch {
          /* a broken link is not worth failing the listing over */
        }
        continue
      }
      nodes.push({ name: entry.name, path: rel, type: isDir ? 'directory' : 'file' })
    }
    nodes.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    return nodes
  }

  /** Everything the viewer needs to show one file.
   *
   *  Text is decoded here; image and PDF bytes are not, because handing a
   *  megabyte of base64 through IPC to build a data: URL costs more than
   *  letting the renderer fetch it through the scheme. */
  preview(root: string, path: string): PreviewInfo | undefined {
    const file = this.contain(root, path)
    if (!file) return undefined
    let size: number
    try {
      const stat = statSync(file)
      if (stat.isDirectory()) return undefined
      size = stat.size
    } catch {
      return undefined
    }
    const { kind, mime, render } = previewKind(path)
    const url = `${FILE_SCHEME}://file/${encodeURI(path.split(sep).join('/'))}?root=${encodeURIComponent(root)}`

    if (kind === 'image' || kind === 'pdf') {
      return { path, absolute: file, kind, mime, url, size }
    }
    if (kind === 'binary') {
      return { path, absolute: file, kind, size, note: `${basename(path)} is a binary file.` }
    }
    if (size > MAX_TEXT_BYTES) {
      return {
        path,
        absolute: file,
        kind: 'text',
        render,
        size,
        content: '',
        note: `${basename(path)} is ${Math.round(size / 1024 / 1024)} MB — too large to preview.`
      }
    }
    let content: string
    try {
      content = readFileSync(file, 'utf8')
    } catch {
      return { path, absolute: file, kind: 'binary', size, note: `${basename(path)} could not be read as text.` }
    }
    // A NUL byte means this was never text, whatever the extension claimed.
    // Showing the mojibake is worse than saying so.
    if (content.includes('\0')) {
      return { path, absolute: file, kind: 'binary', size, note: `${basename(path)} is a binary file.` }
    }
    return { path, absolute: file, kind: 'text', render, content, size }
  }

  /** The bytes behind a boss-file:// URL, for the protocol handler.
   *
   *  The root travels in the query rather than being remembered here, because
   *  BOSS has several projects and worktrees open at once and the handler must
   *  answer for whichever one the URL names. It is re-contained on the way in,
   *  so a forged root still cannot reach outside the directory it names. */
  read(url: string): { data: Buffer; mime: string } | undefined {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return undefined
    }
    if (parsed.protocol !== `${FILE_SCHEME}:`) return undefined
    const root = parsed.searchParams.get('root')
    if (!root) return undefined
    const path = decodeURIComponent(parsed.pathname).replace(/^\//, '')
    if (!path) return undefined
    const file = this.contain(root, path)
    if (!file) return undefined
    const { kind, mime } = previewKind(path)
    if ((kind !== 'image' && kind !== 'pdf') || !mime) return undefined
    try {
      const stat = statSync(file)
      if (!stat.isFile()) return undefined
      return { data: readFileSync(file), mime }
    } catch {
      return undefined
    }
  }

  /** Resolve `path` under `root` and prove it stayed there.
   *
   *  The path arrives from the renderer, so `..` has to fail here rather than
   *  escape. Returns undefined rather than throwing: every caller wants to
   *  answer "nothing" and not crash a listing. */
  private contain(root: string, path: string): string | undefined {
    if (!root) return undefined
    const base = resolve(root)
    if (!existsSync(base)) return undefined
    const target = resolve(base, path)
    if (target !== base && !target.startsWith(base + sep)) return undefined
    return target
  }
}
