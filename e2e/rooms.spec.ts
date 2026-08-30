import { backendCalls, expect, lastBackendCall, test } from './fixtures'

/** A thread is a room: several named agents share one message list, and every
 *  message says who it is for. These scenarios cover what the user actually
 *  does with that — aim a message, change who it goes to, and see who spoke. */

test('the composer names the agent the thread runs on', async ({ appPage }) => {
  // A room never allows an unaddressed message, and a thread that never grew
  // past one agent addresses that agent. Defaulting to BOSS made every ordinary
  // conversation look like a BOSS chat.
  await appPage.locator('.session-row').filter({ hasText: 'Source thread' }).click()
  await expect(appPage.locator('.recipient-chip')).not.toHaveText(/BOSS/)
  await expect(appPage.locator('.recipient-chip')).not.toBeEmpty()
})

test('picking a participant aims the next message at it', async ({ appPage }) => {
  await appPage.locator('.session-row').filter({ hasText: 'Source thread' }).click()
  await appPage.locator('.recipient-chip').click()

  // The thread's own agent, BOSS, and a broadcast. A thread with no roles yet
  // can still be talked to, and BOSS is always reachable.
  await expect(appPage.locator('.recipient-option')).toHaveCount(3)
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
  await expect(appPage.locator('.recipient-chip')).not.toHaveText(/BOSS/)
})

test('a sent message records who it was addressed to', async ({ appPage }) => {
  await appPage.locator('.session-row').filter({ hasText: 'Source thread' }).click()
  const composer = appPage.getByPlaceholder(/^Ask /)
  await composer.fill('Status please.')
  await composer.press('Enter')

  const send = (await backendCalls(appPage, 'thread.send')).at(-1)
  expect(send?.request).toMatchObject({ options: { recipient: 'agent' } })
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

  await expect(appPage.locator('.msg.user .msg-role .to').last()).toContainText('agent')
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

test('the assistant page is the conversation, not a control panel', async ({ appPage }) => {
  // It used to wrap a chat in an attention list, a running-work strip, a build
  // list, a role editor, and a task queue. The user never used it: chatting
  // already felt natural, and the rest read as a panel to administer.
  await appPage.locator('.sidebar-boss').click()

  await expect(appPage.locator('.boss-page')).toBeVisible()
  await expect(appPage.locator('.lab-assistant-layout')).toHaveCount(0)
  await expect(appPage.locator('.product-section')).toHaveCount(0)
})

test('the sidebar shows one list at a time, so each gets the whole height', async ({ appPage }) => {
  // Stacked, the three fought for one column: what needed the user took the
  // top, the projects were squeezed into a sliver, and on a short screen the
  // projects fell off the bottom entirely.
  await expect(appPage.locator('.sidebar-tab')).toHaveCount(3)
  await expect(appPage.locator('.sidebar-section.projects')).toBeVisible()
  await expect(appPage.locator('.sidebar-section.attention')).toHaveCount(0)
  await expect(appPage.locator('.sidebar-section.chats')).toHaveCount(0)
})

test('the projects list fills the panel rather than a share of it', async ({ appPage }) => {
  // The complaint that started this: on a smaller screen barely one project was
  // reachable, because two other lists were taking the column above it.
  const panel = appPage.locator('.sidebar')
  const projects = appPage.locator('.sidebar-section.projects')
  const panelBox = await panel.boundingBox()
  const projectsBox = await projects.boundingBox()
  expect(projectsBox && panelBox).toBeTruthy()
  expect(projectsBox!.height).toBeGreaterThan(panelBox!.height * 0.4)
})

test('switching tab swaps the list', async ({ appPage }) => {
  await appPage.locator('.sidebar-tab', { hasText: 'Chats' }).click()
  await expect(appPage.locator('.sidebar-section.projects')).toBeHidden()

  await appPage.locator('.sidebar-tab', { hasText: 'Work' }).click()
  await expect(appPage.locator('.sidebar-section.projects')).toBeVisible()
})

test('the start button matches the list it is under', async ({ appPage }) => {
  // One button, for what this tab holds. Two side by side meant the one that
  // did nothing for the list on screen was always half of the row.
  await expect(appPage.locator('.sidebar-start')).toHaveText(['Add project'])

  await appPage.locator('.sidebar-tab', { hasText: 'Chats' }).click()
  await expect(appPage.locator('.sidebar-start')).toHaveText(['New chat'])
})

test('an empty list says so rather than showing nothing', async ({ appPage }) => {
  // A blank panel reads as a bug. It is also the common case for what needs
  // you, which is the answer the user most wants to be sure of.
  await appPage.locator('.sidebar-tab', { hasText: 'Needs you' }).click()
  await expect(appPage.locator('.sidebar-empty')).toBeVisible()
})

test('the tab a user left in is the one they come back to', async ({ appPage }) => {
  await appPage.locator('.sidebar-tab', { hasText: 'Chats' }).click()
  const stored = await appPage.evaluate(() => localStorage.getItem('boss.sidebarTab'))
  expect(stored).toBe('chats')
})

test('the team can be changed after setup', async ({ appPage }) => {
  // Setup runs once and never appears again. Without this a user who deleted a
  // role, or wanted a different agent reviewing, was stuck with the first
  // launch's answer forever.
  await appPage.getByRole('button', { name: 'Settings' }).click()
  await appPage.locator('.settings-nav-group button', { hasText: 'Your team' }).click()

  await expect(appPage.locator('.team-setup-rows .role-name').first()).toBeVisible()
  await expect(appPage.locator('.team-setup-rows .role-reach').first()).toBeVisible()
})

test('the room shows who else is in it, beside the chip', async ({ appPage }) => {
  // The user looks here before sending anyway, and a participant that is
  // working or was dropped is exactly what changes who they address.
  await appPage.locator('.session-row').filter({ hasText: 'Source thread' }).click()
  const others = appPage.locator('.room-who-one')
  if (await others.count() === 0) return
  await expect(others.first()).toBeVisible()
})

test('what a fresh agent will be told can be read by the user', async ({ appPage }) => {
  // A reviewer reads the job notes and nothing else, so anything missing there
  // is missing from the review. What it will be told must never be a surprise.
  await appPage.locator('.session-row').filter({ hasText: 'Source thread' }).click()
  const notes = appPage.locator('.room-notes')
  if (await notes.count() === 0) return
  await expect(notes.locator('summary')).toContainText('What this job agreed')
})

test('the side panel has its own way to add files or a terminal', async ({ appPage }) => {
  // The + that adds a resource lives on a thread's tab, and one-thread mode does
  // not draw the conversation's tab strip. So the panel had no way in at all,
  // and the thread's context menu in the sidebar was the only route.
  await appPage.locator('.session-row').filter({ hasText: 'Source thread' }).click()
  const add = appPage.locator('.workspace-group-add')
  if (await add.count() === 0) return

  await add.first().click()
  await expect(appPage.locator('.workspace-add-menu')).toBeVisible()
})

test('an empty pane does not offer to split itself', async ({ appPage }) => {
  // An empty panel takes no width, so splitting it produced two halves of
  // nothing and the buttons read as broken.
  await appPage.locator('.session-row').filter({ hasText: 'Source thread' }).click()
  const empty = appPage.locator('.workspace-group').filter({ has: appPage.locator('.workspace-empty-group') })
  if (await empty.count() === 0) return

  await expect(empty.first().locator('.workspace-group-actions button[title*="Split"]')).toHaveCount(0)
})

test('a chat with no project is not squeezed thinner than its own text', async ({ appPage }) => {
  // Sharing the projects list's rule made a short list stretch to fill the
  // sidebar, and its rows — which could shrink below their content — were
  // crushed until the title sat on top of its own detail line.
  const rows = appPage.locator('.sidebar-section.chats .session-row')
  if (await rows.count() === 0) return

  const height = await rows.first().evaluate((node) => node.getBoundingClientRect().height)
  expect(height).toBeGreaterThan(28)
})

test('what needs you never swallows the projects list', async ({ appPage }) => {
  // Unbounded, seven things waiting took the whole sidebar and left the projects
  // a sliver the user could not scroll through.
  const attention = appPage.locator('.sidebar-section.attention')
  if (await attention.count() === 0) return

  const sizes = await appPage.evaluate(() => {
    const list = document.querySelector('.sidebar-section.attention')
    const bar = document.querySelector('.sidebar')
    return {
      list: list?.getBoundingClientRect().height ?? 0,
      bar: bar?.getBoundingClientRect().height ?? 1
    }
  })
  expect(sizes.list / sizes.bar).toBeLessThan(0.5)
})

test('the team says which agent BOSS runs on', async ({ appPage }) => {
  // It used to borrow whichever role happened to read rather than write, so the
  // user had no way to see the answer or change it.
  await appPage.getByRole('button', { name: 'Settings' }).click()
  await appPage.locator('.settings-nav-group button', { hasText: 'Your team' }).click()

  const boss = appPage.locator('.team-setup-row').filter({ has: appPage.locator('input[value="BOSS"]') })
  if (await boss.count() === 0) return

  await expect(boss.locator('.role-agent')).toBeVisible()
  await expect(boss.locator('.role-fixed')).toHaveText('always')
  await expect(boss.locator('.role-remove')).toHaveCount(0)
})

test('choosing how a job runs brings in the agent that starts it', async ({ appPage }) => {
  // The shape was recorded and then nothing happened: every room stayed empty
  // and read as an ordinary chat.
  await appPage.locator('.session-row').filter({ hasText: 'Source thread' }).click()
  const shape = appPage.locator('.composer-shape')
  if (await shape.count() === 0) return

  await shape.locator('button', { hasText: 'Build and review' }).click()

  // The chooser is gone, because the choice has been made.
  await expect(shape).toHaveCount(0)
  await expect(appPage.locator('.recipient-chip')).toHaveText(/Builder/)
})

test('a room reads as a room, with a speaker beside each message', async ({ appPage }) => {
  // A name stacked above a block reads as a transcript. The point of a room is
  // seeing who is talking.
  await appPage.locator('.session-row').filter({ hasText: 'Source thread' }).click()
  const spoken = appPage.locator('.msg.spoken')
  if (await spoken.count() === 0) return

  await expect(spoken.first().locator('.msg-avatar')).toBeVisible()
})

test('a card sets a decision apart from the prose', async ({ appPage }) => {
  // These are the moments the user acts on, so they are not another paragraph.
  await appPage.locator('.session-row').filter({ hasText: 'Source thread' }).click()
  const card = appPage.locator('.room-card')
  if (await card.count() === 0) return

  await expect(card.first().locator('.room-card-head')).not.toBeEmpty()
  // At most two: one way forward and one way out. More is a form.
  const actions = card.first().locator('.room-card-actions button:not(.room-card-link)')
  expect(await actions.count()).toBeLessThanOrEqual(2)
})

test('the composer names who the message is going to, not which model runs it', async ({ appPage }) => {
  // It named the backend, so a message aimed at the reviewer invited the user
  // to "Ask Claude" — the one name in the room that nobody is called.
  await appPage.locator('.session-row').filter({ hasText: 'Source thread' }).click()
  await appPage.locator('.recipient-chip').click()
  await appPage.locator('.recipient-option').filter({ hasText: 'BOSS' }).click()

  await expect(appPage.getByPlaceholder('Ask BOSS…')).toBeVisible()
})

test('the composer follows the chip when the recipient changes', async ({ appPage }) => {
  await appPage.locator('.session-row').filter({ hasText: 'Source thread' }).click()
  await appPage.locator('.recipient-chip').click()
  await appPage.locator('.recipient-option').filter({ hasText: 'Everyone' }).click()

  await expect(appPage.getByPlaceholder('Ask Everyone…')).toBeVisible()
})
