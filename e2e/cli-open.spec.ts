import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'
import type { BossApi } from '../src/shared/api'
import type { ElectronApplication } from 'playwright'

/** A temp folder BOSS will agree it is, once it canonicalises the path.
 *
 *  On macOS the temp directory is reached through a symlink (/var ->
 *  /private/var), and main records the resolved path — so a test comparing
 *  against the unresolved one would be asserting the wrong string. */
async function tempFolder(prefix: string): Promise<string> {
  return realpathSync(await mkdtemp(join(tmpdir(), prefix)))
}

/** Do what `boss <folder>` does to a BOSS that is already running.
 *
 *  The command launches the app again; that launch loses the single-instance
 *  lock and Electron hands its argv to the running instance as
 *  'second-instance'. Emitting the event directly is the same entry point with
 *  the process spawn taken out — the argv here is exactly what the shim builds. */
async function runBossCommand(app: ElectronApplication, folder: string, cwd = '/'): Promise<void> {
  await app.evaluate(({ app: electronApp }, value) => {
    electronApp.emit(
      'second-instance',
      {},
      ['/Applications/BOSS.app/Contents/MacOS/BOSS', '--boss-open', value.folder],
      value.cwd
    )
  }, { folder, cwd })
}

/** BOSS's own record of which folders are projects. */
async function projectList(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { boss: BossApi }).boss.projectList())
}

test('`boss <folder>` opens a folder BOSS has never seen, creating the project', async ({ appPage, electronApp }) => {
  const folder = await tempFolder('boss-cli-newproject-')
  await writeFile(join(folder, 'README.md'), '# new project\n')

  expect(await projectList(appPage)).not.toContain(folder)

  await runBossCommand(electronApp, folder)

  // The project list is BOSS's own record of what a project is. A folder
  // landing in it is precisely "a project was created for it".
  await expect.poll(() => projectList(appPage)).toContain(folder)
  await expect(appPage.locator('.project-header')).toBeVisible()
})

test('`boss <folder>` on an existing project opens it without adding a duplicate', async ({ appPage, electronApp }) => {
  const folder = await tempFolder('boss-cli-existing-')
  await runBossCommand(electronApp, folder)
  await expect.poll(() => projectList(appPage)).toContain(folder)

  await runBossCommand(electronApp, folder)

  await expect
    .poll(async () => (await projectList(appPage)).filter((path) => path === folder).length)
    .toBe(1)
})

test('`boss .` resolves the folder against the terminal, not the app', async ({ appPage, electronApp }) => {
  const folder = await tempFolder('boss-cli-relative-')

  // What the shim sends for `boss .` is the already-absolute path, but a
  // relative one must still resolve against the shell's cwd rather than the
  // app's, which is what the workingDirectory argument carries.
  await electronApp.evaluate(({ app }, value) => {
    app.emit('second-instance', {}, ['/BOSS', '--boss-open', '.'], value)
  }, folder)

  await expect.poll(() => projectList(appPage)).toContain(folder)
})

test('a folder that does not exist is reported rather than silently ignored', async ({ appPage, electronApp }) => {
  const missing = join(tmpdir(), 'boss-cli-does-not-exist-ever')

  await runBossCommand(electronApp, missing)

  await expect(appPage.getByText('Could not open that folder')).toBeVisible()
  await expect(appPage.getByText(missing, { exact: false })).toBeVisible()
  expect(await projectList(appPage)).not.toContain(missing)
})

test('a file rather than a folder is refused with a reason', async ({ appPage, electronApp }) => {
  const dir = await tempFolder('boss-cli-file-')
  const file = join(dir, 'notes.md')
  await writeFile(file, '# not a folder\n')

  await runBossCommand(electronApp, file)

  await expect(appPage.getByText('Could not open that folder')).toBeVisible()
  await expect(appPage.getByText(/is a file, not a folder/)).toBeVisible()
  expect(await projectList(appPage)).not.toContain(file)
})

test('a result that arrives before the renderer listens is not lost', async ({ appPage, electronApp }) => {
  const folder = await tempFolder('boss-cli-pending-')

  // `boss <folder>` that starts the app resolves before React mounts, so main
  // holds the result for the renderer to collect. Simulated here by opening
  // while the page is still loading, which is the state a cold start is in.
  await electronApp.evaluate(({ app, BrowserWindow }, value) => {
    const window = BrowserWindow.getAllWindows()[0]
    // Reloading puts webContents back into isLoading, the condition main uses
    // to decide the push cannot have been heard.
    window.webContents.reload()
    app.emit('second-instance', {}, ['/BOSS', '--boss-open', value], '/')
  }, folder)

  // Collected on mount rather than pushed, so it still lands.
  await expect.poll(() => projectList(appPage), { timeout: 15_000 }).toContain(folder)
})

test('`boss <worktree>` opens the repository, not a second project', async ({ appPage, electronApp }) => {
  const root = await tempFolder('boss-cli-worktree-')
  const repo = join(root, 'repo')
  const checkout = join(root, 'feature')
  await mkdir(repo, { recursive: true })
  const git = (args: string[], cwd: string): void => {
    execFileSync('git', args, {
      cwd,
      stdio: 'ignore',
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' }
    })
  }
  git(['init', '-b', 'main'], repo)
  git(['config', 'user.email', 'e2e@boss.test'], repo)
  git(['config', 'user.name', 'BOSS E2E'], repo)
  await writeFile(join(repo, 'README.md'), '# repo\n')
  git(['add', '.'], repo)
  git(['commit', '-m', 'first'], repo)
  git(['worktree', 'add', checkout, '-b', 'feature'], repo)

  await runBossCommand(electronApp, checkout)

  // The worktree is a checkout of the repository, so the project recorded is
  // the repository. Opening a worktree must not fork a second project that
  // shares its history.
  await expect.poll(() => projectList(appPage)).toContain(repo)
  expect(await projectList(appPage)).not.toContain(checkout)
})
