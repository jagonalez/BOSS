import { backendCalls, control, expect, gitCalls, lastBackendCall, test } from './fixtures'
import type { BossApi } from '../src/shared/api'

async function openSettings(page: Parameters<typeof control>[0]): Promise<void> {
  await page.getByRole('button', { name: 'Settings' }).click()
  await expect(page.locator('.settings-page-title strong')).toHaveText('Settings')
}

async function configureClaudeDefaults(page: Parameters<typeof control>[0]): Promise<void> {
  await openSettings(page)
  await page.getByRole('button', { name: 'Agent defaults' }).click()
  await page.locator('.settings-backend').filter({ hasText: 'Claude Code' }).click()
  await page.getByRole('button', { name: 'Models & connections' }).click()

  const row = page.locator('.settings-connection-row').filter({ hasText: 'Claude Code' })
  await row.locator('.settings-model-picker-trigger').click()
  await row.getByRole('button', { name: /Claude Opus 5/ }).click()

  const permission = row.locator('label').filter({ hasText: 'Permissions' }).getByRole('combobox')
  await permission.selectOption('auto')
  await expect(page.getByRole('heading', { name: /Start every Claude Code thread/ })).toBeVisible()
  await page.getByRole('button', { name: 'Use auto by default' }).click()
  await row.locator('label').filter({ hasText: 'Thinking' }).getByRole('combobox').selectOption('high')
}

test('boots the real Electron renderer without covering it with a modal', async ({ appPage, electronApp }) => {
  await expect(appPage.getByRole('heading', { name: 'Here’s what’s happening.' })).toBeVisible()
  await expect(appPage.locator('.settings-page')).toHaveCount(0)
  await expect(appPage.locator('.modal-backdrop')).toHaveCount(0)
  expect(await electronApp.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    return { count: BrowserWindow.getAllWindows().length, visible: window?.isVisible() }
  })).toEqual({ count: 1, visible: false })
})

test('a deleted checkout returns a review snapshot without rejecting the IPC handler', async ({ appPage }) => {
  const checkout = '/tmp/boss-e2e/deleted-worktree'
  const snapshot = await appPage.evaluate(
    (path) => (window as unknown as { boss: BossApi }).boss.reviewSnapshot(path),
    checkout
  )
  expect(snapshot).toMatchObject({ repositoryRoot: checkout, branch: '', localComments: [] })
  expect(snapshot.syncError).toMatch(/git rev-parse/i)
})

test('Ctrl+F searches the active thread and moves between its matches', async ({ appPage }) => {
  await appPage.locator('.session-row').filter({ hasText: 'Source thread' }).click()
  await expect(appPage.getByText('Search marker: first result.')).toBeVisible()

  await appPage.keyboard.press('Control+f')
  const search = appPage.getByRole('search', { name: 'Search this thread' })
  await expect(search).toBeVisible()
  const input = search.getByRole('searchbox', { name: 'Find in thread' })
  await expect(input).toBeFocused()
  await input.fill('search marker')

  await expect(search).toContainText('1 of 2')
  await expect(appPage.locator('.msg.thread-search-current')).toContainText('first result')
  await appPage.keyboard.press('Enter')
  await expect(search).toContainText('2 of 2')
  await expect(appPage.locator('.msg.thread-search-current')).toContainText('second result')
  await appPage.keyboard.press('Shift+Enter')
  await expect(search).toContainText('1 of 2')

  await appPage.keyboard.press('Escape')
  await expect(search).toHaveCount(0)
})

test('persists backend, model, permission, and thinking defaults through the UI', async ({ appPage }) => {
  await configureClaudeDefaults(appPage)

  await expect.poll(async () => (await control(appPage)).defaults()).toMatchObject({
    claude: { providerID: 'anthropic', modelID: 'claude-opus-5', mode: 'auto', variant: 'high' }
  })
  const call = await lastBackendCall(appPage, 'backend.defaults.set')
  expect(call.request.defaults).toMatchObject({
    claude: { providerID: 'anthropic', modelID: 'claude-opus-5', mode: 'auto', variant: 'high' }
  })

  await appPage.getByRole('button', { name: 'Done' }).click()
  await expect(appPage.locator('.settings-page')).toHaveCount(0)
  await appPage.reload()
  await openSettings(appPage)
  const row = appPage.locator('.settings-connection-row').filter({ hasText: 'Claude Code' })
  await expect(row.locator('.settings-model-picker-trigger')).toContainText('Claude Opus 5')
  await expect(row.locator('label').filter({ hasText: 'Permissions' }).getByRole('combobox')).toHaveValue('auto')
  await expect(row.locator('label').filter({ hasText: 'Thinking' }).getByRole('combobox')).toHaveValue('high')
})

test('keeps local thread auto-naming opt-in through settings', async ({ appPage }) => {
  await openSettings(appPage)
  await appPage.getByRole('button', { name: 'Agent defaults' }).click()
  const autoName = appPage.getByRole('checkbox', { name: 'Auto-name threads' })
  await expect(autoName).not.toBeChecked()
  await autoName.check()
  expect((await lastBackendCall(appPage, 'thread.title.settings.set')).request).toEqual({
    type: 'thread.title.settings.set',
    autoNameFromFirstPrompt: true
  })

  await appPage.getByRole('button', { name: 'Done' }).click()
  await appPage.reload()
  await openSettings(appPage)
  await appPage.getByRole('button', { name: 'Agent defaults' }).click()
  await expect(appPage.getByRole('checkbox', { name: 'Auto-name threads' })).toBeChecked()
})

test('a backend server can be restarted from settings', async ({ appPage }) => {
  // A server reads its credentials once, at startup. Signing in to another
  // account leaves it using the account that signed out, and this is the way
  // out of that without quitting BOSS.
  await openSettings(appPage)
  await appPage.getByRole('button', { name: 'Models & connections' }).click()
  const row = appPage.locator('.settings-connection-row').filter({ hasText: 'Codex' })

  await row.getByRole('button', { name: 'Restart server' }).click()

  expect((await lastBackendCall(appPage, 'backend.restart')).request).toMatchObject({ backendId: 'codex' })
  await expect(row.getByRole('button', { name: 'Restarted' })).toBeVisible()
})

test('shows provider subscription windows on their own Usage page', async ({ appPage }) => {
  await openSettings(appPage)
  await expect(appPage.getByRole('button', { name: 'Refresh usage' })).toHaveCount(0)
  await appPage.getByRole('button', { name: 'Usage', exact: true }).click()
  await appPage.getByRole('button', { name: 'Refresh usage' }).click()
  expect((await lastBackendCall(appPage, 'backend.subscription-usage')).request).toEqual({ type: 'backend.subscription-usage' })
  const openCode = appPage.getByRole('region', { name: 'OpenCode Go usage' })
  await expect(openCode).toContainText('12% used · 88% left')
  await expect(openCode).toContainText('Monthly limit')
  const codex = appPage.getByRole('region', { name: 'Codex usage' })
  await expect(codex).toContainText('35% used · 65% left')
  await expect(codex).toContainText('GPT-5.3-Codex-Spark')
  const claude = appPage.getByRole('region', { name: 'Claude Code usage' })
  await expect(claude).toContainText('8% used · 92% left')
  await expect(appPage.getByText('Pi has no subscription balance of its own.')).toBeVisible()
})

test('quick-create uses the configured backend and exposes its defaults on the new thread', async ({ appPage }) => {
  await configureClaudeDefaults(appPage)
  await appPage.getByRole('button', { name: 'Done' }).click()
  await control(appPage).then((item) => item.resetCalls())

  await appPage.getByRole('tab', { name: /Chats/ }).click()
  await appPage.getByRole('button', { name: 'New chat' }).click()
  const created = await lastBackendCall(appPage, 'thread.create')
  expect(created.request).toMatchObject({ backendId: 'claude', scope: 'global' })

  await expect(appPage.getByRole('tab', { name: /^New claude thread/ })).toBeVisible()
  await expect(appPage.locator('.model-picker-btn').filter({ hasText: 'Claude Opus 5' })).toBeVisible()
  await expect(appPage.locator('.model-picker-btn').filter({ hasText: 'Auto' })).toBeVisible()
  await expect(appPage.locator('.model-picker-btn').filter({ hasText: 'high' })).toBeVisible()
})

test('a thread an agent spawned shows the model it runs on, not the app default', async ({ appPage }) => {
  // The composer reported the app's model for a thread the renderer never
  // created, because only main knew what that thread had resolved. It also sent
  // that wrong model with the next message, so the display and the thread's
  // real model disagreed.
  await configureClaudeDefaults(appPage)
  await appPage.getByRole('button', { name: 'Done' }).click()

  const spawned = await control(appPage).then((item) => item.spawnThread('claude', 'Agent spawned thread'))
  expect(spawned).toMatchObject({ model: { id: 'claude-opus-5', provider: 'anthropic' } })

  await appPage.locator('.session-row').filter({ hasText: 'Agent spawned thread' }).click()
  await expect(appPage.locator('.model-picker-btn').filter({ hasText: 'Claude Opus 5' })).toBeVisible()
})

test('a Claude thread can submit a message without a transport error', async ({ appPage }) => {
  const title = 'Claude SDK executable test'
  await control(appPage).then((item) => item.spawnThread('claude', title))
  await appPage.locator('.session-row').filter({ hasText: title }).click()
  await control(appPage).then((item) => item.resetCalls())

  const composer = appPage.getByPlaceholder(/^Ask /)
  await composer.fill('Verify the Claude SDK transport.')
  await composer.press('Enter')

  const call = await lastBackendCall(appPage, 'thread.send')
  expect(call.request).toMatchObject({ threadId: 'thread-created-1' })
  await expect(appPage.locator('.chat-error')).toHaveCount(0)
})

async function configureLabDefaults(page: Parameters<typeof control>[0]): Promise<void> {
  await openSettings(page)
  await page.getByRole('button', { name: 'Agent defaults' }).click()
  await page.locator('.settings-backend').filter({ hasText: 'Lab' }).click()
  await page.getByRole('button', { name: 'Models & connections' }).click()

  const row = page.locator('.settings-connection-row').filter({ hasText: 'Lab' })
  await row.locator('.settings-model-picker-trigger').click()
  await row.getByRole('button', { name: /Lab E2E/ }).click()
}

test('adds a named Lab API, key, and model from Models & connections', async ({ appPage }) => {
  await openSettings(appPage)
  const row = appPage.locator('.settings-connection-row').filter({ hasText: 'Lab' })
  const connections = row.getByRole('region', { name: 'Lab API connections' })
  await expect(connections).toBeVisible()
  await connections.getByRole('button', { name: 'Add connection' }).click()

  const editor = connections.getByRole('region', { name: 'Add Lab connection' })
  await editor.getByLabel('Lab connection name').fill('Cloud test')
  await editor.getByLabel('Lab endpoint URL').fill('https://models.example.test/v1')
  await editor.getByLabel('Lab API key').fill('test-key')
  await editor.getByLabel('Lab manual models').fill('coding-model')
  await editor.getByRole('button', { name: 'Save & test' }).click()

  const call = await lastBackendCall(appPage, 'lab.connection.save')
  expect(call.request).toEqual({
    type: 'lab.connection.save',
    connection: {
      name: 'Cloud test',
      baseUrl: 'https://models.example.test/v1',
      manualModels: ['coding-model'],
      apiKey: 'test-key'
    }
  })
  const card = connections.getByRole('article', { name: 'Cloud test Lab connection' })
  await expect(card).toContainText('Ready')
  await expect(card).toContainText('Key saved')
  await expect(card).toContainText('coding-model')

  await row.locator('.settings-model-picker-trigger').click()
  await row.getByRole('button', { name: /coding-model/ }).click()
  await expect(row.locator('.settings-model-picker-trigger')).toContainText('Cloud test')
})

test('quick-create with Lab uses the drop-in backend and its default model', async ({ appPage }) => {
  await configureLabDefaults(appPage)
  await appPage.getByRole('button', { name: 'Done' }).click()
  await control(appPage).then((item) => item.resetCalls())

  await appPage.getByRole('tab', { name: /Chats/ }).click()
  await appPage.getByRole('button', { name: 'New chat' }).click()
  const created = await lastBackendCall(appPage, 'thread.create')
  expect(created.request).toMatchObject({ backendId: 'lab', scope: 'global' })

  await expect(appPage.getByRole('tab', { name: /^New lab thread/ })).toBeVisible()
  await expect(appPage.locator('.model-picker-btn').filter({ hasText: 'Lab E2E' })).toBeVisible()
})

test('delegation sends the chosen backend, worktree placement, and target defaults', async ({ appPage }) => {
  await configureClaudeDefaults(appPage)
  await appPage.getByRole('button', { name: 'Done' }).click()
  await control(appPage).then((item) => item.resetCalls())

  await appPage.locator('.session-row').filter({ hasText: 'Source thread' }).click({ button: 'right' })
  await appPage.getByRole('button', { name: 'Delegate…' }).click()
  await expect(appPage.getByRole('heading', { name: /Delegate from “Source thread”/ })).toBeVisible()
  await appPage.locator('.delegate-backends button').filter({ hasText: 'Claude' }).click()
  await appPage.getByLabel('New Git worktree').check()
  await appPage.getByPlaceholder('What should the worker accomplish?').fill('Audit the E2E workflow and report gaps.')
  await appPage.getByRole('button', { name: 'Start delegate' }).click()

  const delegated = await lastBackendCall(appPage, 'thread.delegate')
  expect(delegated.request).toMatchObject({
    threadId: 'thread-source',
    backendId: 'claude',
    instruction: 'Audit the E2E workflow and report gaps.',
    placement: 'new-worktree',
    options: {
      model: { providerID: 'anthropic', modelID: 'claude-opus-5', variant: 'high' },
      mode: 'auto'
    }
  })
  await expect(appPage.locator('.delegate-modal')).toHaveCount(0)
})

test('ask mode surfaces permission requests and replies from the card', async ({ appPage }) => {
  await appPage.locator('.session-row').filter({ hasText: 'Source thread' }).click()
  await control(appPage).then((item) => item.resetCalls())
  await control(appPage).then((item) => item.emit({
    type: 'permission.asked',
    properties: {
      id: 'permission-e2e',
      sessionID: 'thread-source',
      permission: 'shell',
      patterns: ['npm test'],
      metadata: { command: 'npm test' }
    }
  }))

  await expect(appPage.locator('.perm-card')).toContainText('npm test')
  await appPage.locator('.perm-card').getByRole('button', { name: /Allow once/i }).click()
  expect((await lastBackendCall(appPage, 'thread.permission')).request).toMatchObject({
    threadId: 'thread-source', permissionId: 'permission-e2e', response: 'once'
  })
  await expect(appPage.locator('.perm-card')).toHaveCount(0)
})

test('auto mode answers permission requests without leaving a blocking panel', async ({ appPage }) => {
  await appPage.locator('.session-row').filter({ hasText: 'Source thread' }).click()
  await appPage.locator('.model-picker-btn').filter({ hasText: 'Ask' }).click()
  await appPage.locator('.model-row').filter({ hasText: /^Auto/ }).click()
  await appPage.getByRole('button', { name: 'Enable Auto' }).click()
  await control(appPage).then((item) => item.resetCalls())

  await control(appPage).then((item) => item.emit({
    type: 'permission.asked',
    properties: { id: 'permission-auto', sessionID: 'thread-source', permission: 'shell' }
  }))
  await expect.poll(async () => (await backendCalls(appPage, 'thread.permission')).length).toBe(1)
  expect((await lastBackendCall(appPage, 'thread.permission')).request).toMatchObject({
    threadId: 'thread-source', permissionId: 'permission-auto', response: 'once'
  })
  await expect(appPage.locator('.perm-card')).toHaveCount(0)
  await expect(appPage.locator('.modal-backdrop')).toHaveCount(0)
})

test('a second message sent before the first is acknowledged is queued, not lost', async ({ appPage }) => {
  // The renderer decided between sending and queueing from its own copy of the
  // busy state. Two quick sends both read "idle", both started a run, and the
  // next transcript reload replaced one message with the other. Main refuses
  // the second run now, and the renderer queues what it refuses.
  await appPage.locator('.session-row').filter({ hasText: 'Source thread' }).click()
  const composer = appPage.getByPlaceholder(/^Ask /)
  await composer.fill('First message.')
  await composer.press('Enter')
  await composer.fill('Second message, sent immediately.')
  await composer.press('Enter')

  // Scoped: this thread is seeded with a queued follow-up of its own.
  await expect(
    appPage.locator('.followup-text').filter({ hasText: 'Second message, sent immediately.' })
  ).toHaveCount(1)
  // Both were attempted; only the first became a run.
  expect(await backendCalls(appPage, 'thread.send')).toHaveLength(2)
  expect((await lastBackendCall(appPage, 'thread.followups.add')).request).toMatchObject({
    threadId: 'thread-source', text: 'Second message, sent immediately.'
  })
})

test('an opencode Stop & redirect does not report the stop as a failure', async ({ appPage }) => {
  // Opencode answers the abort BOSS sends with MessageAbortedError. The
  // redirect works, so showing that to the user names a failure that did not
  // happen.
  await appPage.locator('.session-row').filter({ hasText: 'OpenCode stop thread' }).click()
  await control(appPage).then((item) => item.emit({
    type: 'session.status',
    properties: { sessionID: 'thread-opencode-stop', status: { type: 'busy' } }
  }))
  await expect(appPage.locator('.followup-text')).toHaveText('Redirect this opencode run instead.')

  await appPage.getByRole('button', { name: 'Stop & redirect' }).click()
  expect((await lastBackendCall(appPage, 'thread.followups.steer')).request).toMatchObject({
    threadId: 'thread-opencode-stop', followUpId: 'followup-source'
  })

  // What opencode answers the abort with. The user asked for this, so it must
  // not reach them as a failure.
  await control(appPage).then((item) => item.emit({
    type: 'session.error',
    properties: {
      sessionID: 'thread-opencode-stop',
      error: { name: 'MessageAbortedError', message: 'Aborted' }
    }
  }))

  await expect(appPage.locator('.followup-item')).toHaveCount(0)
  await expect(appPage.locator('.chat-error')).toHaveCount(0)
})

test('a real opencode failure still reaches the user after a stop', async ({ appPage }) => {
  // The counterpart to swallowing the abort: only the stop is hidden, so a
  // fault the thread genuinely hit is still shown.
  await appPage.locator('.session-row').filter({ hasText: 'OpenCode stop thread' }).click()
  await control(appPage).then((item) => item.emit({
    type: 'session.status',
    properties: { sessionID: 'thread-opencode-stop', status: { type: 'busy' } }
  }))
  await expect(appPage.locator('.followup-text')).toHaveText('Redirect this opencode run instead.')
  await appPage.getByRole('button', { name: 'Stop & redirect' }).click()

  await control(appPage).then((item) => item.emit({
    type: 'session.error',
    properties: { sessionID: 'thread-opencode-stop', error: { name: 'Error', message: 'Connection refused' } }
  }))

  await expect(appPage.locator('.chat-error')).toContainText('Connection refused')
})

test('Claude Stop & redirect accepts the queued instruction without showing a failure', async ({ appPage }) => {
  await appPage.locator('.session-row').filter({ hasText: 'Claude stop thread' }).click()
  await control(appPage).then((item) => item.emit({
    type: 'session.status',
    properties: { sessionID: 'thread-claude', status: { type: 'busy' } }
  }))
  await expect(appPage.locator('.followup-text')).toHaveText('Continue with the corrected instruction.')
  await control(appPage).then((item) => item.resetCalls())

  await appPage.getByRole('button', { name: 'Stop & redirect' }).click()

  expect((await lastBackendCall(appPage, 'thread.followups.steer')).request).toMatchObject({
    threadId: 'thread-claude', followUpId: 'followup-claude'
  })
  await expect(appPage.locator('.followup-item')).toHaveCount(0)
  await expect(appPage.locator('.chat-error')).toHaveCount(0)
})

/** Select a run of rendered text inside an assistant reply, the way a drag
 *  does, and let the popover's pointerup listener see it. Playwright has no
 *  API for a partial text selection, so the range is built in the page. */
async function selectInAssistantReply(
  page: Parameters<typeof control>[0],
  phrase: string
): Promise<void> {
  await page.evaluate((needle) => {
    const body = Array.from(document.querySelectorAll('.msg.assistant .msg-body'))
      .find((element) => element.textContent?.includes(needle))
    if (!body) throw new Error(`No assistant message containing ${needle}`)
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const index = node.textContent?.indexOf(needle) ?? -1
      if (index < 0) continue
      const range = document.createRange()
      range.setStart(node, index)
      range.setEnd(node, index + needle.length)
      const selection = window.getSelection()
      selection?.removeAllRanges()
      selection?.addRange(range)
      return
    }
    throw new Error(`No text node containing ${needle}`)
  }, phrase)
  await page.dispatchEvent('.messages', 'pointerup')
}

test('annotating a passage quotes it back to the model with the note', async ({ appPage }) => {
  await appPage.locator('.session-row').filter({ hasText: 'Source thread' }).click()
  await expect(appPage.locator('.msg.assistant')).toContainText('second result')

  await selectInAssistantReply(appPage, 'second result')
  await appPage.locator('.annotation-popover').getByRole('button', { name: 'Add to chat' }).click()
  await appPage.getByLabel('Annotation note').fill('Why this one?')
  await appPage.getByLabel('Annotation note').press('Enter')

  // The pill is the standing reminder that the next send carries a quote.
  await expect(appPage.locator('.annotation-pill')).toHaveCount(1)
  await expect(appPage.locator('.annotation-pill-quote')).toHaveText('second result')

  await control(appPage).then((item) => item.resetCalls())
  const composer = appPage.getByPlaceholder(/^Ask /)
  await composer.fill('Expand on that.')
  await composer.press('Enter')

  const call = await lastBackendCall(appPage, 'thread.send')
  const text = (call.request as { parts: { type: string; text?: string }[] }).parts
    .find((part) => part.type === 'text')?.text ?? ''
  expect(text).toContain('> second result')
  expect(text).toContain('Why this one?')
  expect(text).toContain('Expand on that.')
  expect(text.indexOf('> second result')).toBeLessThan(text.indexOf('Expand on that.'))

  // Cleared on send: an annotation phrases one prompt, it does not stay on the
  // thread and quote itself again on the next message.
  await expect(appPage.locator('.annotation-pill')).toHaveCount(0)
})

test('an annotation alone is a complete message', async ({ appPage }) => {
  await appPage.locator('.session-row').filter({ hasText: 'Source thread' }).click()
  await expect(appPage.locator('.msg.assistant')).toContainText('second result')

  await selectInAssistantReply(appPage, 'second result')
  await appPage.locator('.annotation-popover').getByRole('button', { name: 'Add to chat' }).click()
  await appPage.getByLabel('Annotation note').fill('Say more.')
  await appPage.getByLabel('Annotation note').press('Enter')
  await expect(appPage.locator('.annotation-pill')).toHaveCount(1)

  await control(appPage).then((item) => item.resetCalls())
  // Nothing typed: the empty composer must not veto the send.
  await appPage.getByPlaceholder(/^Ask /).press('Enter')

  const call = await lastBackendCall(appPage, 'thread.send')
  const text = (call.request as { parts: { type: string; text?: string }[] }).parts
    .find((part) => part.type === 'text')?.text ?? ''
  expect(text).toContain('> second result')
  expect(text).toContain('Say more.')
})

test('a removed annotation is not carried into the next prompt', async ({ appPage }) => {
  await appPage.locator('.session-row').filter({ hasText: 'Source thread' }).click()
  await expect(appPage.locator('.msg.assistant')).toContainText('second result')

  await selectInAssistantReply(appPage, 'second result')
  await appPage.locator('.annotation-popover').getByRole('button', { name: 'Add to chat' }).click()
  await appPage.getByLabel('Annotation note').fill('Never mind.')
  await appPage.getByLabel('Annotation note').press('Enter')
  await appPage.getByRole('button', { name: 'Remove annotation 1' }).click()
  await expect(appPage.locator('.annotation-pill')).toHaveCount(0)

  await control(appPage).then((item) => item.resetCalls())
  const composer = appPage.getByPlaceholder(/^Ask /)
  await composer.fill('Unrelated question.')
  await composer.press('Enter')

  const call = await lastBackendCall(appPage, 'thread.send')
  const text = (call.request as { parts: { type: string; text?: string }[] }).parts
    .find((part) => part.type === 'text')?.text ?? ''
  expect(text).toBe('Unrelated question.')
})

test('a side chat forks the thread and opens seeded with the passage', async ({ appPage }) => {
  await appPage.locator('.session-row').filter({ hasText: 'Source thread' }).click()
  await expect(appPage.locator('.msg.assistant')).toContainText('second result')
  await control(appPage).then((item) => item.resetCalls())

  await selectInAssistantReply(appPage, 'second result')
  await appPage.locator('.annotation-popover').getByRole('button', { name: 'Add to side chat' }).click()

  // Forked, not freshly created: the side chat inherits the conversation the
  // passage came from, so the seed only has to point at it.
  const fork = await lastBackendCall(appPage, 'thread.fork')
  expect(fork.request).toMatchObject({ threadId: 'thread-source' })

  // Two composers now, which is the point: the side chat opens alongside its
  // parent rather than replacing it. Both live in the same group, so neither
  // the placeholder nor the focused pane tells them apart — the draft does.
  const composers = appPage.getByPlaceholder(/^Ask /)
  await expect(composers).toHaveCount(2)

  // Exactly one carries the quote and the other is empty: the seed goes to the
  // side chat without disturbing the draft in the thread it came from. Counted
  // rather than positional, since which composer renders first is a layout
  // detail this contract does not depend on.
  await expect
    .poll(async () =>
      composers.evaluateAll((nodes) => {
        const values = nodes.map((node) => (node as HTMLTextAreaElement).value)
        return {
          seeded: values.filter((value) => value.includes('> second result')).length,
          empty: values.filter((value) => value === '').length
        }
      })
    )
    .toEqual({ seeded: 1, empty: 1 })

  // The passage went to the side chat, so nothing is left pending here.
  await expect(appPage.locator('.annotation-pill')).toHaveCount(0)
})

test('a placed annotation is editable from its marker in the transcript', async ({ appPage }) => {
  await appPage.locator('.session-row').filter({ hasText: 'Source thread' }).click()
  await expect(appPage.locator('.msg.assistant')).toContainText('second result')

  await selectInAssistantReply(appPage, 'second result')
  await appPage.locator('.annotation-popover').getByRole('button', { name: 'Add to chat' }).click()
  await appPage.getByLabel('Annotation note').fill('First thought.')
  await appPage.getByLabel('Annotation note').press('Enter')
  await expect(appPage.locator('.annotation-pill')).toHaveCount(1)

  // The marker is what makes a placed highlight reachable again: without it the
  // only way to revise a note is to remove the pill and re-select the words.
  const marker = appPage.locator('.annotation-marker')
  await expect(marker).toHaveCount(1)
  await expect(marker).toHaveText('1')
  await marker.click()

  // Reopens on the existing annotation rather than starting a new one, so the
  // note it already carries is there to edit.
  const note = appPage.getByLabel('Annotation note')
  await expect(note).toHaveValue('First thought.')
  await note.fill('Actually, why this one?')
  await note.press('Enter')

  // Revised in place: still one annotation, carrying the new note.
  await expect(appPage.locator('.annotation-pill')).toHaveCount(1)
  await expect(appPage.locator('.annotation-pill-note')).toHaveText('Actually, why this one?')

  await control(appPage).then((item) => item.resetCalls())
  await appPage.getByPlaceholder(/^Ask /).press('Enter')
  const call = await lastBackendCall(appPage, 'thread.send')
  const text = (call.request as { parts: { type: string; text?: string }[] }).parts
    .find((part) => part.type === 'text')?.text ?? ''
  expect(text).toContain('Actually, why this one?')
  expect(text).not.toContain('First thought.')
})

test('an annotation can be removed from its own editor', async ({ appPage }) => {
  await appPage.locator('.session-row').filter({ hasText: 'Source thread' }).click()
  await expect(appPage.locator('.msg.assistant')).toContainText('second result')

  await selectInAssistantReply(appPage, 'second result')
  await appPage.locator('.annotation-popover').getByRole('button', { name: 'Add to chat' }).click()
  await appPage.getByLabel('Annotation note').press('Enter')
  await expect(appPage.locator('.annotation-pill')).toHaveCount(1)

  await appPage.locator('.annotation-marker').click()
  // Scoped to the editor: the composer pill carries a remove button too, and
  // this is asserting the transcript can undo an annotation on its own.
  await appPage.locator('.annotation-editor').getByRole('button', { name: 'Remove annotation' }).click()

  // Gone from the transcript and the composer together: the highlight, its
  // marker, and the pending quote are one thing seen from three places.
  await expect(appPage.locator('.annotation-pill')).toHaveCount(0)
  await expect(appPage.locator('.annotation-marker')).toHaveCount(0)
})

test('a selection spanning two messages offers no annotation', async ({ appPage }) => {
  await appPage.locator('.session-row').filter({ hasText: 'Source thread' }).click()
  await expect(appPage.locator('.msg.assistant')).toContainText('second result')

  // Anchors are a single {messageId, start, end}; a range crossing a role
  // boundary cannot be described by one, so the affordance stays away rather
  // than silently annotating half of it.
  await appPage.evaluate(() => {
    const bodies = document.querySelectorAll('.msg .msg-body')
    const range = document.createRange()
    range.setStart(bodies[0], 0)
    range.setEnd(bodies[bodies.length - 1], 0)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
  })
  await appPage.dispatchEvent('.messages', 'pointerup')

  await expect(appPage.locator('.annotation-popover')).toHaveCount(0)
})

/** Open the review surface for the source thread's checkout. */
async function openReviewTab(page: Parameters<typeof control>[0]): Promise<void> {
  await page.locator('.session-row').filter({ hasText: 'Source thread' }).click()
  await page.locator('.workspace-tab-add-inline[title="Add a terminal, files or review to this thread"]').click()
  await page.locator('.workspace-add-menu-item').filter({ hasText: 'Review' }).click()
}

test('the diff view toggles between unified and split and remembers it', async ({ appPage }) => {
  await openReviewTab(appPage)

  // The fixture checkout holds one modified file whose middle line changed by
  // a single word — enough to see both layouts and word-level marking.
  const card = appPage.locator('.diff-card')
  await expect(card).toHaveCount(1)
  const view = card.locator('.diff-view')
  await expect(view).toHaveAttribute('data-mode', 'unified')

  await expect(view.locator('.word-del')).toContainText('total')
  await expect(view.locator('.word-add')).toContainText('sum')

  const toggle = appPage.getByRole('group', { name: 'Diff layout' })
  await toggle.getByRole('button', { name: 'Split' }).click()
  await expect(view).toHaveAttribute('data-mode', 'split')

  // Two gutters side by side inside the one file block.
  const row = view.locator('.diff-split-row').first()
  await expect(row.locator('.diff-line.half')).toHaveCount(2)
  await expect(row.locator('.diff-line.half.left')).toContainText('compute(a, b)')
  await expect(row.locator('.diff-line.half.right')).toContainText('compute(a, b)')
  await expect(card.locator('.diff-line.hunk.span')).toHaveCount(1)

  await expect.poll(() => appPage.evaluate(() => localStorage.getItem('boss.diffMode'))).toBe('split')

  // The choice survives a reload along with the tab that was showing it.
  await appPage.reload()
  await expect(appPage.locator('.diff-view.split').first()).toBeVisible()

  await appPage.getByRole('group', { name: 'Diff layout' }).getByRole('button', { name: 'Unified' }).click()
  await expect(appPage.locator('.diff-view[data-mode="unified"]').first()).toBeVisible()
})

test('the whitespace toggle is offered on the diff toolbar and persists', async ({ appPage }) => {
  await openReviewTab(appPage)
  await expect(appPage.locator('.diff-card')).toHaveCount(1)

  const whitespace = appPage.locator('.diff-whitespace-toggle')
  await expect(whitespace).toHaveText('Ignore whitespace')
  await whitespace.click()
  await expect(whitespace).toHaveText('Whitespace hidden')
  await expect.poll(() => appPage.evaluate(() => localStorage.getItem('boss.diffIgnoreWhitespace'))).toBe('1')

  await appPage.reload()
  await expect(appPage.locator('.diff-whitespace-toggle')).toHaveText('Whitespace hidden')
})

test('committing stages a chosen subset and commits only it', async ({ appPage }) => {
  const project = appPage.locator('.sidebar-section.projects .project-row').first()
  await expect(project).toContainText('/tmp/boss-e2e/project')
  await project.click({ button: 'right' })
  await appPage.getByRole('button', { name: 'Commit & push…' }).click()

  const dialog = appPage.locator('.modal')
  const staged = dialog.locator('.commit-section').filter({ hasText: 'Staged' })
  const unstaged = dialog.locator('.commit-section').filter({ hasText: 'Unstaged' })
  await expect(staged).toContainText('src/staged.ts')
  await expect(unstaged).toContainText('src/edited.ts')
  await expect(unstaged).toContainText('scratch.ts')

  // Nothing staged means nothing to commit: the buttons stand down.
  await dialog.getByRole('button', { name: 'Unstage src/staged.ts' }).click()
  await expect(dialog.getByRole('button', { name: /^Commit \(/ })).toBeDisabled()

  await dialog.getByRole('button', { name: 'Stage scratch.ts' }).click()
  await expect(dialog.getByRole('button', { name: 'Commit (1)', exact: true })).toBeEnabled()

  await control(appPage).then((item) => item.resetCalls())
  await dialog.locator('.commit-input').fill('Just the scratch file')
  await dialog.getByRole('button', { name: 'Commit (1)', exact: true }).click()

  await expect(dialog.locator('.commit-output')).toContainText('Committed ✓')
  await expect.poll(async () => gitCalls(appPage).then((calls) => calls.filter((args) => args[0] === 'add'))).toEqual([['add', '--', 'scratch.ts']])
  expect(await gitCalls(appPage)).toContainEqual(['commit', '-m', 'Just the scratch file'])
})
