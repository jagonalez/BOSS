import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, copyFileSync, chmodSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'

const repo = 'anomalyco/opencode'
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const destDir = join(root, 'resources', 'opencode')

// The bundled binary is pinned, not tracked from `releases/latest`. Following
// latest meant a beta shipped whatever upstream had published that morning,
// and nothing downstream ever exercised it — `npm test` runs before this
// script. It also broke outright once: upstream published a release whose
// tag_name was the literal string "latest", so the download URL 404'd until
// the real tag appeared minutes later. Bump this deliberately.
const pinnedVersion = JSON.parse(
  await readFile(join(root, 'package.json'), 'utf8')
).opencodeVersion

if (!pinnedVersion) {
  throw new Error('package.json is missing "opencodeVersion"')
}

const platformMap = {
  darwin: 'darwin',
  linux: 'linux',
  win32: 'windows'
}
const arch = process.arch === 'x64' ? 'x64' : process.arch === 'arm64' ? 'arm64' : process.arch

// Strip a leading v so a tag and a --version string compare equal.
const normalize = (v) => String(v).trim().replace(/^v/, '')

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

function versionOf(bin) {
  try {
    return normalize(execFileSync(bin, ['--version']).toString())
  } catch {
    return null
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Retry transient failures. Anything tagged `permanent` (a 404 on a pinned
 * tag, a missing asset) fails on the first try — re-requesting a URL that
 * cannot exist just burns minutes before failing anyway.
 */
async function withRetry(label, fn, attempts = 4) {
  let lastErr
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      if (err?.permanent || i === attempts) break
      const delay = 2000 * 2 ** (i - 1)
      console.log(`${label} failed (attempt ${i}/${attempts}): ${err.message} — retrying in ${delay / 1000}s`)
      await sleep(delay)
    }
  }
  throw lastErr
}

async function resolveAsset() {
  const url = `https://api.github.com/repos/${repo}/releases/tags/${pinnedVersion}`
  const headers = { Accept: 'application/vnd.github+json' }
  // A token lifts the 60/hr unauthenticated quota, which is shared per-IP
  // across everything else running on a GitHub-hosted runner.
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN
  if (token) headers.Authorization = `Bearer ${token}`

  const res = await fetch(url, { headers })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    const err = new Error(
      `failed to query release ${pinnedVersion}: ${res.status} ` +
        `(ratelimit-remaining: ${res.headers.get('x-ratelimit-remaining') ?? 'n/a'}) ${body.slice(0, 200)}`
    )
    // A pinned tag that 404s is a bad pin, not a blip.
    if (res.status === 404) err.permanent = true
    throw err
  }
  const release = await res.json()
  const platform = platformMap[process.platform] ?? process.platform
  const wanted = `opencode-${platform}-${arch}`
  // Exact match: `opencode-darwin-x64` must not match `-x64-baseline`.
  const asset = (release.assets ?? []).find((a) => a.name === `${wanted}.zip`)
  if (!asset) {
    const err = new Error(`no asset named ${wanted}.zip in ${release.tag_name}`)
    err.permanent = true
    throw err
  }
  return asset.name
}

async function downloadAndExtract(asset) {
  const url = `https://github.com/${repo}/releases/download/${pinnedVersion}/${asset}`
  const tmpZip = join(tmpdir(), `opencode-${asset}`)
  const tmpDir = join(tmpdir(), `opencode-x-${process.pid}`)
  console.log(`downloading ${url}`)
  const res = await fetch(url)
  if (!res.ok || !res.body) {
    const err = new Error(`download failed: ${res.status}`)
    if (res.status === 404) err.permanent = true
    throw err
  }
  const { writeFile } = await import('node:fs/promises')
  await writeFile(tmpZip, Buffer.from(await res.arrayBuffer()))
  rmSync(tmpDir, { recursive: true, force: true })
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
  chmodSync(join(destDir, exeName), 0o755)
  rmSync(tmpDir, { recursive: true, force: true })
}

async function main() {
  mkdirSync(destDir, { recursive: true })
  const exeName = process.platform === 'win32' ? 'opencode.exe' : 'opencode'
  const dest = join(destDir, exeName)
  const want = normalize(pinnedVersion)

  // Already correct — from a warm cache, or a previous run.
  if (existsSync(dest) && versionOf(dest) === want) {
    console.log(`bundled opencode: ${want} (already present)`)
    return
  }

  // A local install is only usable if it is the pinned version. Copying a
  // mismatched one is how a dev build ends up bundling something CI never does.
  const local = findLocal()
  if (local) {
    const localVersion = versionOf(local)
    if (localVersion === want) {
      console.log(`copying local opencode ${localVersion} (${local}) -> ${dest}`)
      copyFileSync(local, dest)
      chmodSync(dest, 0o755)
    } else {
      console.log(
        `local opencode is ${localVersion ?? 'unknown'}, want ${want} — downloading the pinned build instead`
      )
    }
  }

  if (!existsSync(dest) || versionOf(dest) !== want) {
    const asset = await withRetry('resolve release', () => resolveAsset())
    await withRetry('download', () => downloadAndExtract(asset))
  }

  const got = versionOf(dest)
  if (got !== want) {
    throw new Error(`bundled opencode is ${got ?? 'unreadable'}, expected ${want}`)
  }
  console.log(`bundled opencode: ${got}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
