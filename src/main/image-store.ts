import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { join, resolve, extname } from 'node:path'
import { randomUUID } from 'node:crypto'

/** The scheme the renderer loads a stored image through.
 *
 *  A file path cannot be used directly: the window runs with webSecurity on, so
 *  file:// is refused. A scheme of our own is also what keeps the reach narrow —
 *  the handler only ever answers with a file inside the image directory. */
export const IMAGE_SCHEME = 'boss-image'

/** Deliberately no import: this module is loaded by a test runner that does not
 *  resolve the @shared alias, so the list is repeated rather than shared.
 *  DISPLAYABLE_IMAGE_MIMES in shared/qa.ts must match it, and a test asserts
 *  the two agree so the copy cannot drift unnoticed. */
const EXTENSIONS: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif'
}

/** Images kept beside the transcript rather than inside it.
 *
 *  A screenshot is a megabyte or more as base64. Transcripts are SQLite rows
 *  read in full every time a thread is opened, so putting the bytes there makes
 *  every later read pay for them. On disk they are read only when one is
 *  actually shown. */
export class ImageStore {
  private readonly root: string

  constructor(root: string) {
    this.root = root
  }

  /** Store an image and return the URL that displays it. */
  write(threadId: string, mimeType: string, base64: string): { url: string; mime: string } | undefined {
    const extension = EXTENSIONS[mimeType]
    if (!extension) return undefined
    const name = `${randomUUID()}${extension}`
    const directory = join(this.root, threadId)
    try {
      mkdirSync(directory, { recursive: true })
      writeFileSync(join(directory, name), Buffer.from(base64, 'base64'))
    } catch {
      // A screenshot that cannot be saved is not worth failing a run over; the
      // tool result still reaches the model either way.
      return undefined
    }
    return { url: `${IMAGE_SCHEME}://${threadId}/${name}`, mime: mimeType }
  }

  /** The bytes behind a boss-image:// URL, or undefined if it points outside
   *  the store. Resolved and re-checked rather than trusted: the host and path
   *  arrive from the renderer, so `..` has to fail here rather than escape. */
  read(url: string): { data: Buffer; mime: string } | undefined {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return undefined
    }
    if (parsed.protocol !== `${IMAGE_SCHEME}:`) return undefined
    const threadId = decodeURIComponent(parsed.hostname)
    const name = decodeURIComponent(parsed.pathname).replace(/^\//, '')
    if (!threadId || !name) return undefined
    const file = resolve(this.root, threadId, name)
    if (!file.startsWith(resolve(this.root) + '/')) return undefined
    if (!existsSync(file)) return undefined
    const mime = Object.entries(EXTENSIONS).find(([, ext]) => ext === extname(file))?.[0]
    if (!mime) return undefined
    try {
      return { data: readFileSync(file), mime }
    } catch {
      return undefined
    }
  }

  /** Drop every image a thread owns, once the thread itself is gone. */
  forget(threadId: string): void {
    if (!threadId) return
    const directory = resolve(this.root, threadId)
    if (!directory.startsWith(resolve(this.root) + '/')) return
    try {
      rmSync(directory, { recursive: true, force: true })
    } catch {
      /* An image left behind costs disk, not correctness. */
    }
  }
}
