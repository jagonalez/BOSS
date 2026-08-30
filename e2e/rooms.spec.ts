import { backendCalls, expect, lastBackendCall, test } from './fixtures'

/** A thread is a room: several named agents share one message list, and every
 *  message says who it is for. These scenarios cover what the user actually
 *  does with that — aim a message, change who it goes to, and see who spoke. */

test('the composer always names who a message goes to', async ({ appPage }) => {
  // A room never allows an unaddressed message. A thread that has never grown
  // past one agent still addresses BOSS, so the chip is never empty and a
  // message can never be sent into nowhere.
  await appPage.locator('.session-row').filter({ hasText: 'Source thread' }).click()
  await expect(appPage.locator('.recipient-chip')).toHaveText(/BOSS/)
})

test('picking a participant aims the next message at it', async ({ appPage }) => {
  await appPage.locator('.session-row').filter({ hasText: 'Source thread' }).click()
  await appPage.locator('.recipient-chip').click()

  // BOSS and a broadcast are always offered; a room with no participants yet
  // can still be talked to.
  await expect(appPage.locator('.recipient-option')).toHaveCount(2)
  await appPage.locator('.recipient-option').filter({ hasText: 'Everyone' }).click()

  await expect(appPage.locator('.recipient-chip')).toHaveText(/Everyone/)
  expect((await lastBackendCall(appPage, 'room.recipient.set')).request).toMatchObject({
    threadId: 'thread-source',
    recipient: 'everyone'
  })
})

test('the chip stays where the user left it, so a run of messages needs no retyping', async ({ appPage }) => {
  await appPage.locator('.session-row').filter({ hasText: 'Source thread' }).click()
  await appPage.locator('.recipient-chip').click()
  await appPage.locator('.recipient-option').filter({ hasText: 'Everyone' }).click()

  const composer = appPage.getByPlaceholder(/^Ask /)
  await composer.fill('First one.')
  await composer.press('Enter')

  await expect(appPage.locator('.recipient-chip')).toHaveText(/Everyone/)
})

test('typing a name aims the message and drops the name from the text', async ({ appPage }) => {
  // The chip already carries the recipient, so repeating it in the body is
  // noise the agent would have to read past.
  await appPage.locator('.session-row').filter({ hasText: 'Source thread' }).click()
  const composer = appPage.getByPlaceholder(/^Ask /)
  await composer.fill('@boss what happened here')

  await expect(appPage.locator('.recipient-chip')).toHaveText(/BOSS/)
  await expect(composer).toHaveValue('what happened here')
})

test('an unrecognised name is left alone, because a wrong aim is worse than none', async ({ appPage }) => {
  await appPage.locator('.session-row').filter({ hasText: 'Source thread' }).click()
  const composer = appPage.getByPlaceholder(/^Ask /)
  await composer.fill('@nobody do the thing')

  await expect(composer).toHaveValue('@nobody do the thing')
  await expect(appPage.locator('.recipient-chip')).toHaveText(/BOSS/)
})

test('a sent message records who it was addressed to', async ({ appPage }) => {
  await appPage.locator('.session-row').filter({ hasText: 'Source thread' }).click()
  const composer = appPage.getByPlaceholder(/^Ask /)
  await composer.fill('Status please.')
  await composer.press('Enter')

  const send = (await backendCalls(appPage, 'thread.send')).at(-1)
  expect(send?.request).toMatchObject({ options: { recipient: 'boss' } })
})

test('the sidebar leads with the assistant, not with a list of subsystems', async ({ appPage }) => {
  // Workflows was a top-level destination that left the user with no idea what
  // to do. It is machinery now, reachable through the conversation that runs
  // it. Automations, reports, and sites are real but rare, so they sit below
  // the work rather than level with it.
  await expect(appPage.locator('.sidebar-boss')).toHaveText(/@BOSS/)
  await expect(appPage.locator('.sidebar-primary .sidebar-primary-item')).toHaveCount(1)
  await expect(appPage.locator('.sidebar-secondary .sidebar-primary-item')).toHaveCount(3)
  await expect(appPage.locator('nav', { hasText: 'Workflows' })).toHaveCount(0)
})

test('a point can be taken aside without leaving the thread', async ({ appPage }) => {
  // Distinct from forking a whole new thread. The same room, the same
  // participants, the same addressing — going through five review findings in
  // one stream is what tangles them.
  await appPage.locator('.session-row').filter({ hasText: 'Source thread' }).click()
  await appPage.locator('.msg.assistant').first().click({ button: 'right' })
  await appPage.locator('.ctx-item').filter({ hasText: 'Take this point aside' }).click()

  await expect(appPage.locator('.composer-branch')).toContainText('Replying under one point')
})

test('leaving a branch returns the composer to the main stream', async ({ appPage }) => {
  await appPage.locator('.session-row').filter({ hasText: 'Source thread' }).click()
  await appPage.locator('.msg.assistant').first().click({ button: 'right' })
  await appPage.locator('.ctx-item').filter({ hasText: 'Take this point aside' }).click()
  await appPage.locator('.composer-branch button').click()

  await expect(appPage.locator('.composer-branch')).toHaveCount(0)
})

test('a reply sent inside a branch says which point it answers', async ({ appPage }) => {
  await appPage.locator('.session-row').filter({ hasText: 'Source thread' }).click()
  await appPage.locator('.msg.assistant').first().click({ button: 'right' })
  await appPage.locator('.ctx-item').filter({ hasText: 'Take this point aside' }).click()

  const composer = appPage.getByPlaceholder(/^Ask /)
  await composer.fill('Why did you touch storage?')
  await composer.press('Enter')

  const send = (await backendCalls(appPage, 'thread.send')).at(-1)
  expect(send?.request).toMatchObject({ options: { branchOf: expect.any(String) } })
})

test('a user message shows who it was addressed to', async ({ appPage }) => {
  // Visible later, so a reader can see why an agent did or did not act on it.
  await appPage.locator('.session-row').filter({ hasText: 'Source thread' }).click()
  const composer = appPage.getByPlaceholder(/^Ask /)
  await composer.fill('Status please.')
  await composer.press('Enter')

  await expect(appPage.locator('.msg.user .msg-role .to').last()).toContainText('boss')
})

test('the setup buttons show their words', async ({ appPage }) => {
  // A theme name that does not exist makes the whole declaration do nothing, so
  // the main button painted its label the same colour as its background. Only a
  // person looking at it could tell.
  const start = appPage.locator('.team-setup-actions button.primary')
  if (await start.count() === 0) return

  await expect(start).not.toBeEmpty()
  const painted = await start.evaluate((node) => {
    const style = getComputedStyle(node)
    return { text: style.color, behind: style.backgroundColor }
  })
  expect(painted.text).not.toBe(painted.behind)
})
