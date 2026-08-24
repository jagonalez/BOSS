import { control, expect, lastBackendCall, test } from './fixtures'

test('Command Center surfaces and records a Lab Assistant merge-order decision', async ({ appPage }) => {
  await control(appPage).then((item) => item.resetCalls())
  const assistant = appPage.getByRole('region', { name: 'Lab Assistant' })
  await expect(assistant).toBeVisible()
  await expect(assistant).toContainText('Which should merge first?')

  await control(appPage).then((item) => item.failNextBackendRequest('assistant.answer', 'Decision store unavailable'))
  await assistant.getByRole('button', { name: '#21 · Mobile polish' }).click()
  await expect(assistant.getByRole('alert')).toContainText('Decision store unavailable')
  await expect(assistant).toContainText('Which should merge first?')

  await assistant.getByRole('button', { name: '#22 · Eval foundation' }).click()

  expect((await lastBackendCall(appPage, 'assistant.answer')).request).toEqual({
    type: 'assistant.answer',
    questionId: 'assistant-question-order',
    answerId: 'octo/hello#22'
  })
  await expect(assistant).toContainText('Nothing needs a decision.')
})
