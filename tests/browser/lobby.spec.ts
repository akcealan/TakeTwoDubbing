import { expect, test } from '@playwright/test'

test('friends join a real lobby, synchronize ready state, reconnect, transfer host and leave', async ({
  page,
  browser,
}, testInfo) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto('/scenes/a-small-step')
  await page.getByRole('link', { name: 'Oda oluştur' }).click()
  await page.getByLabel('Takma adın').fill('Nova')
  await page.getByRole('button', { name: 'Oda oluştur' }).click()
  await expect(page.getByRole('heading', { name: 'Sahne arkası.' })).toBeVisible()
  const roomUrl = page.url()
  const code = new URL(roomUrl).pathname.split('/').pop()!
  expect(code).toMatch(/^\d{6}$/)
  await expect(page.getByTestId('player-Nova').getByText('Kurucu', { exact: true })).toBeVisible()
  const savedBefore = await page.evaluate(
    (code) => sessionStorage.getItem(`take-two:room:${code}`),
    code,
  )

  const guestContext = await browser.newContext({ viewport: testInfo.project.use.viewport })
  const guest = await guestContext.newPage()
  guest.on('pageerror', (error) => errors.push(error.message))
  try {
    await guest.goto(roomUrl)
    await expect(guest.getByLabel('Takma adın')).toBeVisible()
    await guest.getByLabel('Takma adın').fill('nova')
    await guest.getByRole('button', { name: 'Odaya katıl' }).click()
    await expect(guest.getByRole('alert')).toContainText('takma ad odada zaten')
    await guest.getByLabel('Takma adın').fill('Pip')
    await guest.getByRole('button', { name: 'Odaya katıl' }).click()
    await expect(guest.getByRole('heading', { name: 'Sahne arkası.' })).toBeVisible()
    await expect(page.getByTestId('player-Pip')).toContainText('Lobide')
    await guest.getByRole('button', { name: 'Hazırım' }).click()
    await expect(page.getByTestId('player-Pip').getByText('Hazır', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Hazırım' }).click()
    await expect(guest.getByTestId('player-Nova').getByText('Hazır', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Oyunu Başlat' })).toBeEnabled()
    await expect(guest.getByRole('button', { name: 'Oyunu Başlat' })).toHaveCount(0)
    await page.getByRole('button', { name: 'Oyunu Başlat' }).click()
    await expect(page.getByRole('heading', { level: 1, name: 'Küçük Bir Adım' })).toBeVisible()
    await expect(guest.getByRole('heading', { level: 1, name: 'Küçük Bir Adım' })).toBeVisible()
    await expect(page.getByRole('list', { name: 'Atanan karakterlerin' })).toContainText(
      'Kaptan Nova',
    )
    await expect(page.getByRole('list', { name: 'Atanan karakterlerin' })).toContainText('ECHO')
    await expect(guest.getByRole('list', { name: 'Atanan karakterlerin' })).toContainText('Pip')
    await expect(page.locator('video')).toBeVisible()
    if (testInfo.project.name === 'webkit') {
      expect(
        await page.locator('video').evaluate((element) => (element as HTMLVideoElement).duration),
      ).toBeNaN()
      await expect(page.getByText('Tarayıcın video oynatmayı desteklemiyor.')).toBeVisible()
    } else {
      await expect
        .poll(() =>
          page.locator('video').evaluate((element) => (element as HTMLVideoElement).duration),
        )
        .toBeGreaterThan(29)
      await page.locator('video').evaluate((element) => (element as HTMLVideoElement).play())
      await expect
        .poll(() =>
          page.locator('video').evaluate((element) => (element as HTMLVideoElement).currentTime),
        )
        .toBeGreaterThan(0.2)
      await page.locator('video').evaluate((element) => (element as HTMLVideoElement).pause())
      await guest.locator('video').evaluate((element) => {
        ;(element as HTMLVideoElement).currentTime = 5.5
      })
      await expect
        .poll(() =>
          page.locator('video').evaluate((element) => (element as HTMLVideoElement).currentTime),
        )
        .toBeLessThan(2)
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath('lobby.png'), fullPage: true })

    await page.reload()
    await expect(page.getByRole('heading', { level: 1, name: 'Küçük Bir Adım' })).toBeVisible()
    expect(
      await page.evaluate((code) => sessionStorage.getItem(`take-two:room:${code}`), code),
    ).toBe(savedBefore)
    await expect(guest.getByTestId('player-Nova')).toHaveCount(1)
    await page.goto('/')
    await expect(guest.getByTestId('player-Nova')).toContainText('Çevrimdışı')
    await expect(guest.getByTestId('player-Pip').getByText('Kurucu', { exact: true })).toBeVisible()
    await page.goto(roomUrl)
    await expect(page.getByTestId('player-Nova')).toContainText('Oyunda')
    await expect(page.getByRole('heading', { level: 1, name: 'Küçük Bir Adım' })).toBeVisible()
    await expect(page.getByTestId('player-Pip').getByText('Kurucu', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Odadan ayrıl' }).click()
    await expect(page).toHaveURL('http://127.0.0.1:4173/')
    await expect(guest.getByTestId('player-Nova')).toHaveCount(0)
    await guest.getByRole('button', { name: 'Odadan ayrıl' }).click()
    await expect(guest).toHaveURL('http://127.0.0.1:4173/')
    await guest.goto(roomUrl)
    await guest.getByLabel('Takma adın').fill('Pip')
    await guest.getByRole('button', { name: 'Odaya katıl' }).click()
    await expect(guest.getByRole('alert')).toContainText('Oda bulunamadı veya süresi doldu')
    expect(errors).toEqual([])
  } finally {
    await guestContext.close()
  }
})
