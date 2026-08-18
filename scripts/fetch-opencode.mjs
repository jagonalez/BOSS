import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, copyFileSync, chmodSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'

const repo = 'anomalyco/opencode'
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const destDir = join(root, 'resources', 'opencode')

const platformMap = {
  darwin: 'darwin',
  linux: 'linux',
  win32: 'windows'
}
const arch = process.arch === 'x64' ? 'x64' : process.arch === 'arm64' ? 'arm64' : process.arch

function findLocal() {
  const candidates = []
  if (process.env.OPENCODE_BIN) candidates.push(process.env.OPENCODE_BIN)
  candidates.push(join(process.env.HOME ?? '', '.opencode', 'bin', 'opencode'))
  candidates.push('/usr/local/bin/opencode')
  candidates.push('/opt/homebrew/bin/opencode')
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  try {
    const p = execFileSync('which', ['opencode']).toString().trim()
    if (p) return p
  } catch {
    /* ignore */
  }
  return null
}

async function latestRelease() {
  const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: { Accept: 'application/vnd.github+json' }
  })
  if (!res.ok) throw new Error(`failed to query releases: ${res.status}`)
  const release = await res.json()
  const platform = platformMap[process.platform] ?? process.platform
  const wanted = `opencode-${platform}-${arch}`
  const asset = (release.assets ?? []).find((a) => a.name.startsWith(wanted) && a.name.endsWith('.zip'))
  if (!asset) {
    throw new Error(`no asset matching ${wanted} in ${release.tag_name}`)
  }
  // The tag travels with the name: the download URL needs the release it
  // actually came from, and opencode publishes under a version tag.
  return { asset: asset.name, tag: release.tag_name }
}

async function downloadAndExtract(asset, tag) {
  const url = `https://github.com/${repo}/releases/download/${tag}/${asset}`
  const tmpZip = join(tmpdir(), `opencode-${asset}`)
  const tmpDir = join(tmpdir(), `opencode-x-${Date.now()}`)
  console.log(`downloading ${url}`)
  const res = await fetch(url)
  if (!res.ok || !res.body) throw new Error(`download failed: ${res.status}`)
  const reader = res.body.getReader()
  const { writeFile } = await import('node:fs/promises')
  const chunks = []
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
  }
  await writeFile(tmpZip, Buffer.concat(chunks))
  mkdirSync(tmpDir, { recursive: true })
  await new Promise((resolve, reject) => {
    execFile('unzip', ['-o', tmpZip, '-d', tmpDir], (err) => (err ? reject(err) : resolve()))
  })
  rmSync(tmpZip, { force: true })
  const exeName = process.platform === 'win32' ? 'opencode.exe' : 'opencode'
  const found = (function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name)
      if (entry.isDirectory()) {
        const hit = walk(p)
        if (hit) return hit
      } else if (entry.name === exeName || entry.name === 'opencode') {
        return p
      }
    }
    return null
  })(tmpDir)
  if (!found) throw new Error(`no ${exeName} found in archive`)
  mkdirSync(destDir, { recursive: true })
  copyFileSync(found, join(destDir, exeName))
  rmSync(tmpDir, { recursive: true, force: true })
}

async function main() {
  mkdirSync(destDir, { recursive: true })
  const exeName = process.platform === 'win32' ? 'opencode.exe' : 'opencode'
  const dest = join(destDir, exeName)
  const local = findLocal()
  if (local) {
    console.log(`copying local opencode (${local}) -> ${dest}`)
    copyFileSync(local, dest)
    chmodSync(dest, 0o755)
  } else {
    const { asset, tag } = await latestRelease()
    await downloadAndExtract(asset, tag)
  }
  try {
    const version = execFileSync(dest, ['--version']).toString().trim()
    console.log(`bundled opencode: ${version}`)
  } catch {
    console.log('bundled opencode: (version check failed)')
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
