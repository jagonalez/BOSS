import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// @ts-expect-error Application code uses bundler resolution.
import { ProjectFiles, previewKind, FILE_SCHEME } from './project-files.ts'

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'boss-files-'))
  writeFileSync(join(root, 'index.ts'), 'export const a = 1\n')
  writeFileSync(join(root, 'README.md'), '# Title\n')
  writeFileSync(join(root, 'shot.png'), Buffer.from(PNG, 'base64'))
  mkdirSync(join(root, 'src'))
  writeFileSync(join(root, 'src', 'deep.ts'), 'export const b = 2\n')
  mkdirSync(join(root, 'node_modules'))
  writeFileSync(join(root, 'node_modules', 'junk.js'), 'x')
  return root
}

test('an image is previewed as an image, not decoded as text', () => {
  const files = new ProjectFiles()
  const root = project()
  const info = files.preview(root, 'shot.png')
  assert.ok(info)
  // The whole point of the change: this used to come back as mojibake text.
  assert.equal(info.kind, 'image')
  assert.equal(info.mime, 'image/png')
  assert.equal(info.content, undefined)
  assert.ok(info.url)
  assert.match(info.url, new RegExp(`^${FILE_SCHEME}://file/shot\\.png\\?root=`))
})

test('the bytes behind an image url read back intact', () => {
  const files = new ProjectFiles()
  const root = project()
  const info = files.preview(root, 'shot.png')
  assert.ok(info?.url)
  const read = files.read(info.url)
  assert.ok(read)
  assert.equal(read.mime, 'image/png')
  assert.deepEqual(read.data, Buffer.from(PNG, 'base64'))
})

test('markdown and code are distinguished so the viewer can render each', () => {
  const files = new ProjectFiles()
  const root = project()
  assert.equal(files.preview(root, 'README.md')?.render, 'markdown')
  assert.equal(files.preview(root, 'index.ts')?.render, 'code')
  assert.equal(files.preview(root, 'index.ts')?.content, 'export const a = 1\n')
})

test('a path climbing out of the project reads nothing', () => {
  const files = new ProjectFiles()
  const root = project()
  // The path arrives from the renderer, so escaping has to fail here.
  assert.equal(files.preview(root, '../../../etc/passwd'), undefined)
  assert.equal(files.preview(root, '/etc/passwd'), undefined)
  assert.deepEqual(files.list(root, '../..'), [])
})

test('a forged root in a url cannot reach outside the directory it names', () => {
  const files = new ProjectFiles()
  const root = project()
  const escaped = `${FILE_SCHEME}://file/${encodeURI('../../../etc/passwd')}?root=${encodeURIComponent(root)}`
  assert.equal(files.read(escaped), undefined)
})

test('a url for a non-previewable type is refused by the handler', () => {
  const files = new ProjectFiles()
  const root = project()
  // Only image and pdf bytes are ever served; source must not be fetchable
  // through the scheme, or the CSP-exempt channel becomes a general file read.
  const url = `${FILE_SCHEME}://file/index.ts?root=${encodeURIComponent(root)}`
  assert.equal(files.read(url), undefined)
})

test('listing is one level, sorted directories first, and skips noise', () => {
  const files = new ProjectFiles()
  const root = project()
  const nodes = files.list(root)
  const names = nodes.map((n) => n.name)
  assert.ok(!names.includes('node_modules'))
  assert.equal(names[0], 'src')
  // localeCompare, so case does not decide order: a file explorer that put
  // README.md before index.ts on the strength of ASCII capitals would read
  // as arbitrary.
  assert.deepEqual(names.slice(1), ['index.ts', 'README.md', 'shot.png'])
  // Shallow: the nested file is not in the root listing.
  assert.ok(!names.includes('deep.ts'))
  assert.deepEqual(
    files.list(root, 'src').map((n) => n.path),
    ['src/deep.ts']
  )
})

test('a file whose extension lies about being text is reported as binary', () => {
  const files = new ProjectFiles()
  const root = project()
  writeFileSync(join(root, 'fake.txt'), Buffer.from([0x00, 0x01, 0x02]))
  const info = files.preview(root, 'fake.txt')
  assert.ok(info)
  assert.equal(info.kind, 'binary')
  assert.ok(info.note)
  assert.match(info.note, /binary/)
})

test('svg is not served through the scheme, since it can carry script', () => {
  // An SVG rendered from a privileged scheme is an execution surface, so it is
  // classified for display but deliberately shown as source instead.
  assert.equal(previewKind('icon.svg').kind, 'text')
})
