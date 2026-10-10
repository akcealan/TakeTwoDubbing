import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Scene } from '../shared/types'
import { App } from './App'

const studio = vi.hoisted(() => ({
  listPrivateScenes: vi.fn(),
  getPrivateScene: vi.fn(),
  fetchPrivateSceneThumbnail: vi.fn(),
}))

vi.mock('./lib/api/studio', async (loadOriginal) => ({
  ...(await loadOriginal<typeof import('./lib/api/studio')>()),
  listPrivateScenes: studio.listPrivateScenes,
  getPrivateScene: studio.getPrivateScene,
  fetchPrivateSceneThumbnail: studio.fetchPrivateSceneThumbnail,
}))

const privateScene: Scene = {
  id: 'private-abcdef123456',
  title: 'Bizim Gerçek Sahnemiz',
  description: 'Arkadaş grubunun hazırladığı özel sahne.',
  durationMs: 42_121,
  videoUrl: '/api/private-scenes/private-abcdef123456/source',
  thumbnailUrl: '/api/private-scenes/private-abcdef123456/thumbnail',
  genre: 'Custom',
  difficulty: 'Prepared',
  accent: 'violet',
  mediaStatus: 'available',
  sourceAudioStatus: 'present',
  contentCredit: 'Özel kullanım için izinli içerik.',
  origin: { kind: 'private', version: 1, sourceFileName: 'clip.mp4' },
  characters: [{ id: 'ada', name: 'Ada' }],
  lines: [{ id: 'line-1', characterId: 'ada', startMs: 1_000, endMs: 2_000, text: 'Merhaba' }],
}

function renderApp(path = '/') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  )
}

describe('production-facing scene browsing', () => {
  beforeEach(() => {
    studio.listPrivateScenes.mockResolvedValue({ scenes: [privateScene] })
    studio.getPrivateScene.mockResolvedValue({
      draft: {
        media: {
          sceneId: privateScene.id,
          filename: 'clip.mp4',
          mimeType: 'video/mp4',
          byteSize: 100,
          durationMs: privateScene.durationMs,
          width: 640,
          height: 360,
          uploadedAt: 1,
        },
        scene: privateScene,
        status: 'prepared',
        warnings: [],
      },
    })
    studio.fetchPrivateSceneThumbnail.mockResolvedValue(
      new Blob(['thumbnail'], { type: 'image/webp' }),
    )
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:private-thumbnail')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
  })

  it('shows private scenes and never advertises development demos', async () => {
    renderApp()
    expect(await screen.findByRole('heading', { level: 3, name: privateScene.title })).toBeVisible()
    expect(screen.queryByText('Küçük Bir Adım')).not.toBeInTheDocument()
    expect(screen.queryByText('Son Masa')).not.toBeInTheDocument()
    expect(screen.queryByText(/demo/i)).not.toBeInTheDocument()
    const card = screen.getByRole('article')
    expect(within(card).getByText('0:42')).toBeVisible()
    await waitFor(() =>
      expect(
        within(card).getByRole('img', { name: `${privateScene.title} afişi` }),
      ).toHaveAttribute('src', 'blob:private-thumbnail'),
    )
  })

  it('renders a useful Turkish empty state for an empty private library', async () => {
    studio.listPrivateScenes.mockResolvedValueOnce({ scenes: [] })
    renderApp()
    expect(
      await screen.findByRole('heading', { name: 'Henüz hazırlanmış sahnen yok.' }),
    ).toBeVisible()
    expect(screen.getByText("Sahne Stüdyosu'ndan yeni bir sahne hazırlayabilirsin.")).toBeVisible()
    expect(screen.getByRole('link', { name: "Sahne Stüdyosu'nu aç" })).toHaveAttribute(
      'href',
      '/studio',
    )
  })

  it('keeps a clean legacy fallback when thumbnail metadata is absent', async () => {
    studio.listPrivateScenes.mockResolvedValueOnce({
      scenes: [{ ...privateScene, thumbnailUrl: undefined }],
    })
    renderApp()
    expect(
      await screen.findByRole('img', { name: 'Bu sahne için küçük resim hazırlanmadı' }),
    ).toHaveClass('scene-poster', 'neutral-poster')
    expect(studio.fetchPrivateSceneThumbnail).not.toHaveBeenCalled()
  })

  it('searches prepared scenes and preserves the no-results reset', async () => {
    const user = userEvent.setup()
    renderApp()
    await screen.findByRole('heading', { level: 3, name: privateScene.title })
    await user.type(screen.getByRole('searchbox'), 'bulunmayan')
    expect(screen.getByRole('heading', { name: 'Sahne bulunamadı' })).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Filtreleri temizle' }))
    expect(screen.getByRole('heading', { level: 3, name: privateScene.title })).toBeVisible()
  })

  it('supports direct private-scene navigation', async () => {
    renderApp(`/scenes/${privateScene.id}`)
    expect(await screen.findByRole('heading', { level: 1, name: privateScene.title })).toBeVisible()
    expect(screen.getByRole('link', { name: 'Oda oluştur' })).toHaveAttribute(
      'href',
      `/scenes/${privateScene.id}/create`,
    )
    expect(studio.getPrivateScene).toHaveBeenCalledWith(privateScene.id, expect.any(AbortSignal))
  })

  it('retains built-in fixtures for internal direct-route tests without listing them', () => {
    renderApp('/scenes/a-small-step')
    expect(screen.getByRole('heading', { level: 1, name: 'Küçük Bir Adım' })).toBeVisible()
  })

  it.each(['/scenes/missing', '/missing'])('provides recovery for unknown URL %s', (path) => {
    renderApp(path)
    expect(screen.getByRole('link', { name: 'Sahnelere dön' })).toHaveAttribute('href', '/')
  })
})
