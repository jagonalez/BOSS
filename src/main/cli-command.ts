import { app } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { CliStatus } from '@shared/ipc'
import { CLI_LINK, installAt, statusFor, uninstallAt } from './cli-install'

/** The shim inside this build, or '' when there is none to install.
 *
 *  Packaged, it lives beside the other extraResources. A dev run has one in the
 *  checkout, which is enough to report the command's state honestly but not to
 *  install: `available` below refuses that, since the path would rot. */
function shimPath(): string {
  const candidate = app.isPackaged
    ? join(process.resourcesPath ?? '', 'cli', 'boss')
    : join(app.getAppPath(), 'resources', 'cli', 'boss')
  return existsSync(candidate) ? candidate : ''
}

/** Only a packaged app has a location stable enough to point PATH at. */
function available(): boolean {
  return app.isPackaged
}

export function cliStatus(): CliStatus {
  return statusFor(CLI_LINK, shimPath(), available())
}

export function installCli(): CliStatus {
  return installAt(CLI_LINK, shimPath(), available())
}

export function uninstallCli(): CliStatus {
  return uninstallAt(CLI_LINK, shimPath(), available())
}
