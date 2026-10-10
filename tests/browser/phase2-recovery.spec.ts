import { expect, test } from '@playwright/test'

test('clears a saved session when its room no longer exists', async ({ page }) => {
  const code = '987650'
  const key = `take-two:room:${code}`
  await page.goto('/')
  await page.evaluate(
    ({ key, code }) => {
      sessionStorage.setItem(
        key,
        JSON.stringify({
          code,
          roomId: crypto.randomUUID(),
          playerId: crypto.randomUUID(),
          token: 'a'.repeat(64),
        }),
      )
    },
    { key, code },
  )
  await page.goto(`/room/${code}`)
  await expect(page.getByRole('heading', { name: 'Oda oturumun sona erdi.' })).toBeVisible()
  await expect(page.getByRole('alert')).toContainText('süresi doldu')
  await expect.poll(() => page.evaluate((key) => sessionStorage.getItem(key), key)).toBeNull()
})

test('keeps the live lobby usable in memory when session storage is blocked', async ({ page }) => {
  await page.addInitScript(() => {
    Storage.prototype.setItem = () => {
      throw new DOMException('blocked', 'SecurityError')
    }
    Storage.prototype.getItem = () => {
      throw new DOMException('blocked', 'SecurityError')
    }
    Storage.prototype.removeItem = () => {
      throw new DOMException('blocked', 'SecurityError')
    }
  })
  await page.goto('/scenes/a-small-step/create')
  await page.getByLabel('Takma adın').fill('Bellek')
  await page.getByRole('button', { name: 'Oda oluştur' }).click()
  await expect(page.getByRole('heading', { name: 'Sahne arkası.' })).toBeVisible()
  await expect(page.getByText(/Tarayıcı oturumunu kaydedemiyor/)).toBeVisible()
  await page.getByRole('button', { name: 'Hazırım' }).click()
  await expect(page.getByTestId('player-Bellek').getByText('Hazır', { exact: true })).toBeVisible()
})

test('retries a server-completed join without creating a duplicate player', async ({ page }) => {
  const created = await page.request.post('/api/rooms', {
    data: { sceneId: 'a-small-step', nickname: 'Yanıt Kaybı Kurucu' },
  })
  expect(created.status()).toBe(201)
  const host = (await created.json()) as { code: string }

  let completedJoinStatus = 0
  await page.route(
    `**/api/rooms/${host.code}/join`,
    async (route) => {
      const response = await route.fetch()
      completedJoinStatus = response.status()
      await route.abort('failed')
    },
    { times: 1 },
  )
  await page.goto(`/room/${host.code}`)
  await page.getByLabel('Takma adın').fill('Yanıt Kaybı')
  await page.getByRole('button', { name: 'Odaya katıl' }).click()
  await expect(page.getByRole('alert')).toContainText('Oda servisine ulaşılamadı')
  expect(completedJoinStatus).toBe(201)

  await page.getByRole('button', { name: 'Odaya katıl' }).click()
  await expect(page.getByRole('heading', { name: 'Sahne arkası.' })).toBeVisible()
  await expect(page.getByTestId('player-Yanıt Kaybı')).toHaveCount(1)
  await expect(page.locator('.lobby-players > li')).toHaveCount(2)
})
