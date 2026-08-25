import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test as base, expect, type Page } from '@playwright/test'
import { _electron as electron, type ElectronApplication } from 'playwright'

const CUA_DRIVER_FIXTURE = join(process.cwd(), 'e2e', 'cua-driver-fixture.mjs')

function appEnv(profile: string): Record<string, string> {
  const env = {
    ...process.env,
    BOSS_E2E: '1',
    BOSS_E2E_USER_DATA: profile,
    BOSS_DEBUG: '1',
    CUA_DRIVER_BIN: CUA_DRIVER_FIXTURE,
    ELECTRON_DISABLE_SECURITY_WARNINGS: 'true'
  }
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  )
}

async function launchApp(profile: string, stderr: string[]): Promise<ElectronApplication> {
  const app = await electron.launch({ args: ['.'], cwd: process.cwd(), env: appEnv(profile) })
  app.process().stderr?.on('data', (chunk) => stderr.push(String(chunk)))
  return app
}

export interface E2ECall {
  channel: 'api' | 'backend' | 'git' | 'export'
  request?: Record<string, unknown>
  args?: string[]
}

interface E2EControl {
  calls(): Promise<E2ECall[]>
  sessions(): Promise<Array<Record<string, unknown>>>
  defaults(): Promise<Record<string, Record<string, unknown>>>
  contextHandoff(): Promise<string>
  clipboardWrites(): Promise<string[]>
  resetCalls(): Promise<void>
  failNextExport(message: string): Promise<void>
  holdNextPin(): Promise<void>
  releasePin(): Promise<void>
  holdGit(command: string): Promise<void>
  releaseGit(command: string): Promise<void>
  failNextBackendRequest(type: string, message: string): Promise<void>
  emit(event: Record<string, unknown>): Promise<void>
  spawnThread(backendId: string, title: string): Promise<Record<string, unknown>>
  installLongThread(turnCount?: number): Promise<Record<string, unknown>>
}

export async function control(page: Page): Promise<E2EControl> {
  await page.waitForFunction(() => Boolean((window as unknown as { bossE2E?: unknown }).bossE2E))
  return {
    calls: () => page.evaluate(() => (window as unknown as { bossE2E: E2EControl }).bossE2E.calls()),
    sessions: () => page.evaluate(() => (window as unknown as { bossE2E: E2EControl }).bossE2E.sessions()),
    defaults: () => page.evaluate(() => (window as unknown as { bossE2E: E2EControl }).bossE2E.defaults()),
    contextHandoff: () => page.evaluate(() => (window as unknown as { bossE2E: E2EControl }).bossE2E.contextHandoff()),
    clipboardWrites: () => page.evaluate(() => (window as unknown as { bossE2E: E2EControl }).bossE2E.clipboardWrites()),
    resetCalls: () => page.evaluate(() => (window as unknown as { bossE2E: E2EControl }).bossE2E.resetCalls()),
    failNextExport: (message) => page.evaluate(
      (value) => (window as unknown as { bossE2E: E2EControl }).bossE2E.failNextExport(value),
      message
    ),
    holdNextPin: () => page.evaluate(() => (window as unknown as { bossE2E: E2EControl }).bossE2E.holdNextPin()),
    releasePin: () => page.evaluate(() => (window as unknown as { bossE2E: E2EControl }).bossE2E.releasePin()),
    holdGit: (command) => page.evaluate((value) => (window as unknown as { bossE2E: E2EControl }).bossE2E.holdGit(value), command),
    releaseGit: (command) => page.evaluate((value) => (window as unknown as { bossE2E: E2EControl }).bossE2E.releaseGit(value), command),
    failNextBackendRequest: (type, message) => page.evaluate(
      (value) => (window as unknown as { bossE2E: E2EControl }).bossE2E.failNextBackendRequest(value.type, value.message),
      { type, message }
    ),
    emit: (event) => page.evaluate((value) => (window as unknown as { bossE2E: E2EControl }).bossE2E.emit(value), event),
    spawnThread: (backendId, title) => page.evaluate(
      (value) => (window as unknown as { bossE2E: E2EControl }).bossE2E.spawnThread(value.backendId, value.title),
      { backendId, title }
    ),
    installLongThread: (turnCount) => page.evaluate(
      (value) => (window as unknown as { bossE2E: E2EControl }).bossE2E.installLongThread(value),
      turnCount
    )
  }
}

interface Fixtures {
  electronApp: ElectronApplication
  appPage: Page
  restartableApp: {
    page(): Page
    restart(): Promise<Page>
  }
}

export const test = base.extend<Fixtures>({
  electronApp: async ({}, use, testInfo) => {
    const profile = await mkdtemp(join(tmpdir(), 'boss-e2e-'))
    const stderr: string[] = []
    const app = await launchApp(profile, stderr)
    try {
      await use(app)
    } finally {
      if (stderr.length > 0) {
        await testInfo.attach('electron-stderr', {
          body: Buffer.from(stderr.join('')),
          contentType: 'text/plain'
        })
      }
      await app.close().catch(() => {})
      await rm(profile, { recursive: true, force: true })
    }
  },
  appPage: async ({ electronApp }, use, testInfo) => {
    const page = await electronApp.firstWindow()
    const rendererErrors: string[] = []
    page.on('console', (message) => {
      if (message.type() === 'error') rendererErrors.push(message.text())
    })
    page.on('pageerror', (error) => rendererErrors.push(error.stack || error.message))
    await control(page)
    await expect(page).toHaveTitle('BOSS')
    await use(page)
    if (rendererErrors.length > 0) {
      await testInfo.attach('renderer-errors', {
        body: Buffer.from(rendererErrors.join('\n\n')),
        contentType: 'text/plain'
      })
    }
    expect(rendererErrors, 'renderer console and page errors').toEqual([])
  },
  restartableApp: async ({}, use, testInfo) => {
    const profile = await mkdtemp(join(tmpdir(), 'boss-e2e-restart-'))
    const stderr: string[] = []
    const rendererErrors: string[] = []
    let app = await launchApp(profile, stderr)
    let page = await app.firstWindow()

    const preparePage = async (candidate: Page): Promise<Page> => {
      candidate.on('console', (message) => {
        if (message.type() === 'error') rendererErrors.push(message.text())
      })
      candidate.on('pageerror', (error) => rendererErrors.push(error.stack || error.message))
      await control(candidate)
      await expect(candidate).toHaveTitle('BOSS')
      return candidate
    }
    page = await preparePage(page)

    try {
      await use({
        page: () => page,
        restart: async () => {
          await app.close()
          app = await launchApp(profile, stderr)
          page = await preparePage(await app.firstWindow())
          return page
        }
      })
    } finally {
      await app.close().catch(() => {})
      if (stderr.length > 0) {
        await testInfo.attach('electron-stderr', {
          body: Buffer.from(stderr.join('')),
          contentType: 'text/plain'
        })
      }
      if (rendererErrors.length > 0) {
        await testInfo.attach('renderer-errors', {
          body: Buffer.from(rendererErrors.join('\n\n')),
          contentType: 'text/plain'
        })
      }
      await rm(profile, { recursive: true, force: true })
    }
    expect(rendererErrors, 'renderer console and page errors').toEqual([])
  }
})

export { expect }

type BackendCall = E2ECall & { request: Record<string, unknown> }

export async function backendCalls(page: Page, type?: string): Promise<BackendCall[]> {
  const calls = (await control(page).then((item) => item.calls())).filter(
    (call): call is BackendCall => call.channel === 'backend' && Boolean(call.request)
  )
  return type ? calls.filter((call) => call.request.type === type) : calls
}

export async function lastBackendCall(page: Page, type: string): Promise<BackendCall> {
  await expect.poll(async () => (await backendCalls(page, type)).length).toBeGreaterThan(0)
  return (await backendCalls(page, type)).at(-1)!
}

/** Every git command the renderer ran, in order. */
export async function gitCalls(page: Page): Promise<string[][]> {
  const calls = (await control(page).then((item) => item.calls())).filter((call) => call.channel === 'git')
  return calls.map((call) => call.args ?? [])
}
