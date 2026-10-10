import { expect, test } from '@playwright/test'
import { resolve } from 'node:path'

test('real private film clip produces an authorized library thumbnail', async ({ page }) => {
  test.skip(
    process.env.PRIVATE_THUMBNAIL_REAL !== '1',
    'Run explicitly with the local authorized private clip.',
  )
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto('/studio')
  await page
    .locator('input[type=file]')
    .setInputFiles(resolve('local-test-media/clip1-speaker-regression.mp4'))
  await expect(page.getByText('video/mp4')).toBeVisible()
  await expect(page.getByText(/karesinden özel küçük resim hazırlandı/i)).toBeVisible()
  await page.getByRole('button', { name: 'Videoyu özel alana yükle' }).click()
  await expect(page).toHaveURL(/\/studio\/private-[a-f0-9]{12}$/)
  const studioUrl = page.url()

  await page.getByLabel('Sahne başlığı').fill('Gerçek Klip Thumbnail Smoke')
  await page.getByRole('button', { name: 'Karakter ekle' }).click()
  await page.getByLabel('Karakter adı').fill('Smoke Karakteri')
  await page.getByRole('button', { name: 'Replik ekle' }).click()
  await page.getByLabel('Replik metni').fill('Yerel thumbnail doğrulaması.')
  await page.getByLabel('Başlangıç (sn)').fill('1.000')
  await page.getByLabel('Bitiş (sn)').fill('2.000')
  await page.getByRole('button', { name: 'Oynanabilir özel sahne olarak kaydet' }).click()
  await expect(
    page.getByRole('heading', { level: 1, name: 'Gerçek Klip Thumbnail Smoke' }),
  ).toBeVisible()

  const thumbnailResponse = page.waitForResponse(
    (response) => response.url().endsWith('/thumbnail') && response.status() === 200,
  )
  await page.goto('/')
  const response = await thumbnailResponse
  expect(response.headers()['content-type']).toBe('image/webp')
  await expect(page.getByText('Küçük Bir Adım')).toHaveCount(0)
  const card = page.getByRole('article').filter({ hasText: 'Gerçek Klip Thumbnail Smoke' })
  const image = card.getByRole('img', { name: 'Gerçek Klip Thumbnail Smoke afişi' })
  await expect(image).toBeVisible()
  const dimensions = await image.evaluate((element: HTMLImageElement) => ({
    width: element.naturalWidth,
    height: element.naturalHeight,
    objectFit: getComputedStyle(element).objectFit,
  }))
  expect(dimensions.width).toBeGreaterThan(0)
  expect(dimensions.width).toBeLessThanOrEqual(640)
  expect(dimensions.height).toBeLessThanOrEqual(640)
  expect(dimensions.objectFit).toBe('cover')
  await card.getByRole('link', { name: 'İncele: Gerçek Klip Thumbnail Smoke' }).click()
  await expect(
    page.getByRole('heading', { level: 1, name: 'Gerçek Klip Thumbnail Smoke' }),
  ).toBeVisible()

  page.on('dialog', (dialog) => dialog.accept())
  await page.goto(studioUrl)
  await page.getByRole('button', { name: 'Sahneyi sil' }).click()
  await expect(page).toHaveURL('/')
  expect(errors).toEqual([])
})
