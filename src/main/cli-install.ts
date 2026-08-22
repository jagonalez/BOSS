import { lstatSync, mkdirSync, readlinkSync, realpathSync, symlinkSync, unlinkSync } from 'node:fs'
import { dirname } from 'node:path'
import type { CliStatus } from '@shared/ipc'

/** Where the command goes.
 *
 *  A symlink rather than a copy: it keeps pointing into the bundle, so an
 *  update that replaces BOSS.app leaves a working `boss` behind and nobody has
 *  to reinstall. The directory is the conventional one for user-installed
 *  commands and is already on PATH in a default shell. */
export const CLI_LINK = '/usr/local/bin/boss'

/** What `boss` on PATH currently is.
 *
 *  'ours' covers a link into any BOSS bundle, including one whose bundle has
 *  since moved or been deleted — that is a link we may repoint. 'foreign' is
 *  anything else holding the name, which is not ours to take. */
export type LinkKind = 'absent' | 'ours' | 'foreign'

export function linkKind(link: string, target: string): LinkKind {
  let stat
  try {
    stat = lstatSync(link)
  } catch {
    return 'absent'
  }
  if (!stat.isSymbolicLink()) return 'foreign'
  let points: string
  try {
    points = readlinkSync(link)
  } catch {
    return 'foreign'
  }
  if (target && samePath(points, target)) return 'ours'
  return /BOSS\.app\/|[/\\]resources[/\\]cli[/\\]boss$/.test(points) ? 'ours' : 'foreign'
}

function samePath(a: string, b: string): boolean {
  if (a === b) return true
  try {
    return realpathSync(a) === realpathSync(b)
  } catch {
    return false
  }
}

/** Where `boss` points, given the shim this build can offer.
 *
 *  `target` is '' when the build has no shim to point at, which is what a dev
 *  run reports: better to call the command unavailable than to install a link
 *  that rots on the next build. */
export function statusFor(link: string, target: string, available: boolean): CliStatus {
  const kind = linkKind(link, target)
  return {
    installed: kind === 'ours' && Boolean(target),
    path: link,
    target,
    conflict: kind === 'foreign',
    available: Boolean(target) && available
  }
}

/** Point the command at this bundle's shim.
 *
 *  Replaces a link of our own — that is how an install repairs one left by a
 *  bundle that has since moved — but never anything else. */
export function installAt(link: string, target: string, available: boolean): CliStatus {
  if (!target) {
    return { ...statusFor(link, target, available), error: 'This build of BOSS has no command to install.' }
  }
  const kind = linkKind(link, target)
  if (kind === 'foreign') {
    return {
      ...statusFor(link, target, available),
      error: `${link} already exists and is not BOSS's. Remove it first.`
    }
  }
  try {
    mkdirSync(dirname(link), { recursive: true })
    if (kind !== 'absent') unlinkSync(link)
    symlinkSync(target, link)
    return statusFor(link, target, available)
  } catch (error) {
    return { ...statusFor(link, target, available), error: installError(error, link) }
  }
}

/** Remove the command, but only when it is the link we made. */
export function uninstallAt(link: string, target: string, available: boolean): CliStatus {
  try {
    if (linkKind(link, target) === 'ours') unlinkSync(link)
    return statusFor(link, target, available)
  } catch (error) {
    return { ...statusFor(link, target, available), error: installError(error, link) }
  }
}

function installError(error: unknown, link: string): string {
  const text = error instanceof Error ? error.message : String(error)
  if (/EACCES|EPERM/.test(text)) {
    const dir = dirname(link)
    return `BOSS cannot write to ${dir}. Run this once in a terminal, then try again:\n\n  sudo mkdir -p ${dir} && sudo chown "$(whoami)" ${dir}`
  }
  return text
}
