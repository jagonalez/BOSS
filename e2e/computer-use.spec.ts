import { expect, test } from './fixtures'

test('restores Computer Use after BOSS restarts', async ({ restartableApp }) => {
  let page = restartableApp.page()
  await page.getByRole('button', { name: 'Settings' }).click()
  await page.getByRole('button', { name: 'Agent defaults' }).click()
  let row = page.locator('.settings-row').filter({ hasText: 'Computer use' })
  await row.getByRole('checkbox').check()
  await expect(row.getByRole('checkbox')).toBeChecked()
  await expect(row.getByText('Ready')).toBeVisible()
  await expect.poll(() => page.evaluate(() => (
    window as unknown as { boss: { computerUseStatus(): Promise<{ enabled: boolean; running: boolean }> } }
  ).boss.computerUseStatus())).toMatchObject({ enabled: true, running: true })

  page = await restartableApp.restart()
  await page.getByRole('button', { name: 'Settings' }).click()
  await page.getByRole('button', { name: 'Agent defaults' }).click()
  row = page.locator('.settings-row').filter({ hasText: 'Computer use' })
  await expect(row.getByRole('checkbox')).toBeChecked()
  await expect(row.getByText('Ready')).toBeVisible()
  await expect.poll(() => page.evaluate(() => (
    window as unknown as { boss: { computerUseStatus(): Promise<{ enabled: boolean; running: boolean }> } }
  ).boss.computerUseStatus())).toMatchObject({ enabled: true, running: true })
})
