import { control, expect, test } from './fixtures'

test('restores Computer Use after BOSS restarts', async ({ restartableApp }) => {
  let page = restartableApp.page()
  await page.getByRole('button', { name: 'Settings' }).click()
  await page.getByRole('button', { name: 'Agent defaults' }).click()
  let computerUse = page.getByRole('checkbox', { name: 'Computer use' })
  let row = page.locator('.ui-settings-row').filter({ has: computerUse })
  await computerUse.click()
  await expect(computerUse).toBeChecked()
  await expect(row.getByText('Ready')).toBeVisible()
  await expect.poll(() => page.evaluate(() => (
    window as unknown as { boss: { computerUseStatus(): Promise<{ enabled: boolean; running: boolean }> } }
  ).boss.computerUseStatus())).toMatchObject({ enabled: true, running: true })

  page = await restartableApp.restart()
  await page.getByRole('button', { name: 'Settings' }).click()
  await page.getByRole('button', { name: 'Agent defaults' }).click()
  computerUse = page.getByRole('checkbox', { name: 'Computer use' })
  row = page.locator('.ui-settings-row').filter({ has: computerUse })
  await expect(computerUse).toBeChecked()
  await expect(row.getByText('Ready')).toBeVisible()
  await expect.poll(() => page.evaluate(() => (
    window as unknown as { boss: { computerUseStatus(): Promise<{ enabled: boolean; running: boolean }> } }
  ).boss.computerUseStatus())).toMatchObject({ enabled: true, running: true })
})

test('canonicalizes advertised menu actions and preserves screenshot pixels at the driver boundary', async ({ appPage }) => {
  const fixture = await control(appPage)
  const menuResult = await fixture.computerUseCall('click', {
    pid: 4242,
    window_id: 73,
    element_token: 'snapshot:9',
    action: 'showmenu',
    delivery_mode: 'foreground'
  })

  expect(JSON.parse(menuResult.text)).toEqual({
    tool: 'click',
    arguments: {
      pid: 4242,
      window_id: 73,
      element_token: 'snapshot:9',
      action: 'show_menu',
      delivery_mode: 'foreground'
    }
  })

  const pixelResult = await fixture.computerUseCall('click', {
    pid: 4242,
    window_id: 73,
    x: 1234.5,
    y: 678.25
  })
  expect(JSON.parse(pixelResult.text)).toEqual({
    tool: 'click',
    arguments: {
      pid: 4242,
      window_id: 73,
      x: 1234.5,
      y: 678.25
    }
  })
})
