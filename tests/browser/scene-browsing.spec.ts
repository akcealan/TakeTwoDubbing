import { expect, test } from '@playwright/test'

test('normal library hides development demos and handles the private-library empty state', async ({
  page,
}, testInfo) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  page.on('response', (response) => {
    if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`)
  })

  await page.goto('/')
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Harika sahneler.')
  await expect(page.getByText('Sahnelerin yükleniyor…')).toHaveCount(0)
  await expect(page.getByText('Küçük Bir Adım')).toHaveCount(0)
  await expect(page.getByText('Son Masa')).toHaveCount(0)
  if ((await page.getByRole('article').count()) === 0) {
    await expect(page.getByRole('heading', { name: 'Henüz hazırlanmış sahnen yok.' })).toBeVisible()
    await expect(page.getByRole('link', { name: "Sahne Stüdyosu'nu aç" })).toBeVisible()
  }
  const skipLink = page.getByRole('link', { name: 'İçeriğe geç' })
  if (testInfo.project.name === 'webkit') await skipLink.focus()
  else await page.keyboard.press('Tab')
  await expect(skipLink).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('main')).toBeFocused()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  )
  await page.screenshot({ path: testInfo.outputPath('library.png'), fullPage: true })

  await page.goto('/scenes/a-small-step')
  await expect(page).toHaveURL(/\/scenes\/a-small-step$/)
  await expect(page.getByRole('heading', { level: 1, name: 'Küçük Bir Adım' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Oda oluştur' })).toHaveAttribute(
    'href',
    '/scenes/a-small-step/create',
  )
  await expect(page.locator('video')).toHaveCount(0)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  )
  await page.screenshot({ path: testInfo.outputPath('details.png'), fullPage: true })

  await page.reload()
  await expect(page.getByRole('heading', { level: 1, name: 'Küçük Bir Adım' })).toBeVisible()
  await page.getByRole('link', { name: 'Sahne arşivine dön' }).click()
  await expect(page.getByText('Küçük Bir Adım')).toHaveCount(0)
  await page.goto('/scenes/not-in-the-catalog')
  await expect(page.getByRole('heading', { name: 'Sahne bulunamadı' })).toBeVisible()
  await page.getByRole('link', { name: 'Sahnelere dön' }).click()
  await expect(page.getByText('Küçük Bir Adım')).toHaveCount(0)
  expect(errors).toEqual([])
})
