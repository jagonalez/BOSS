import { expect, test } from './fixtures'

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
