/**
 * Two-user TutorBoard flow: a tutor creates a session, a student cannot see
 * it until they redeem the join code, and after joining both see the session.
 *
 * Deliberately avoids the AI actions so the suite costs nothing to run.
 */
import { test, expect, loadAllTestAccounts } from 'deepspace/testing'

const usableTestAccounts = loadAllTestAccounts().length
test.skip(
  usableTestAccounts < 2,
  `Needs 2 usable test accounts, found ${usableTestAccounts}. Create them with ` +
    '`npx deepspace test accounts create --email <name>@deepspace.test --name "<name>" --password-stdin`.',
)

test('student joins a tutor session with its code', async ({ users }) => {
  const [tutor, student] = await users(2)
  const title = `Algebra ${Date.now()}`

  await tutor.page.goto('/sessions')
  await tutor.page.getByTestId('session-title').fill(title)
  await tutor.page.getByTestId('session-topic').fill('linear equations')
  await tutor.page.getByTestId('session-create').click()

  const codeEl = tutor.page.getByTestId('session-join-code')
  await expect(codeEl).toHaveText(/^[A-Z0-9]{6}$/, { timeout: 15_000 })
  const code = (await codeEl.textContent())!.trim()

  // Before joining, the student's list must not include the tutor's session:
  // the 'collaborator' read rule scopes it out server-side.
  await student.page.goto('/sessions')
  await expect(student.page.getByText('Your sessions')).toBeVisible({ timeout: 15_000 })
  await expect(student.page.getByText(title)).toHaveCount(0)

  await student.page.getByTestId('join-code').fill(code)
  await student.page.getByTestId('join-submit').click()
  await expect(student.page.getByRole('heading', { name: title })).toBeVisible({ timeout: 15_000 })

  // The tutor's header now lists a student.
  await expect(tutor.page.getByText(/Students: (?!none yet)/)).toBeVisible({ timeout: 15_000 })
})

test('a wrong join code is rejected', async ({ users }) => {
  const [, student] = await users(2)
  await student.page.goto('/sessions')
  await student.page.getByTestId('join-code').fill('ZZZZZ9')
  await student.page.getByTestId('join-submit').click()
  await expect(student.page.getByText('No session with that code')).toBeVisible({ timeout: 15_000 })
})
