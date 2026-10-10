import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SceneStudio } from './SceneStudio'

const mocks = vi.hoisted(() => ({
  getPrivateScene: vi.fn(),
  fetchPrivateSceneSource: vi.fn(),
  fetchPrivateSceneBackground: vi.fn(),
  uploadPrivateSceneBackground: vi.fn(),
  uploadPrivateSceneThumbnail: vi.fn(),
  generateVideoThumbnail: vi.fn(),
  savePrivateScene: vi.fn(),
  getLocalAiHealth: vi.fn(),
  createLocalAiJob: vi.fn(),
  getLocalSeparationHealth: vi.fn(),
  createLocalSeparationJob: vi.fn(),
  fetchLocalSeparationBackground: vi.fn(),
  cancelLocalSeparationJob: vi.fn(),
}))

vi.mock('../../lib/api/studio', () => ({
  getPrivateScene: mocks.getPrivateScene,
  fetchPrivateSceneSource: mocks.fetchPrivateSceneSource,
  fetchPrivateSceneBackground: mocks.fetchPrivateSceneBackground,
  uploadPrivateSceneBackground: mocks.uploadPrivateSceneBackground,
  uploadPrivateSceneThumbnail: mocks.uploadPrivateSceneThumbnail,
  savePrivateScene: mocks.savePrivateScene,
  deletePrivateScene: vi.fn(),
  uploadPrivateVideo: vi.fn(),
}))

vi.mock('../../lib/studio/thumbnail', () => ({
  generateVideoThumbnail: mocks.generateVideoThumbnail,
}))

vi.mock('../../lib/ai/companion', () => ({
  getLocalAiHealth: mocks.getLocalAiHealth,
  createLocalAiJob: mocks.createLocalAiJob,
  getLocalAiJob: vi.fn(),
  cancelLocalAiJob: vi.fn(),
  getLocalSeparationHealth: mocks.getLocalSeparationHealth,
  createLocalSeparationJob: mocks.createLocalSeparationJob,
  getLocalSeparationJob: vi.fn(),
  fetchLocalSeparationBackground: mocks.fetchLocalSeparationBackground,
  cancelLocalSeparationJob: mocks.cancelLocalSeparationJob,
}))

const media = {
  sceneId: 'private-abcdef123456',
  filename: 'ornek.webm',
  mimeType: 'video/webm' as const,
  byteSize: 100,
  durationMs: 5_000,
  width: 640,
  height: 360,
  uploadedAt: 1,
}

const aiResult = {
  characters: [
    { id: 'speaker-00', name: 'Konuşmacı 1' },
    { id: 'speaker-01', name: 'Konuşmacı 2' },
  ],
  lines: [
    {
      id: 'ai-replik-0001',
      characterId: 'speaker-00',
      text: 'AI taslak metni',
      startMs: 100,
      endMs: 900,
    },
    {
      id: 'ai-replik-0002',
      characterId: 'speaker-01',
      text: 'İkinci konuşmacı',
      startMs: 1_000,
      endMs: 1_800,
    },
  ],
  analysis: {
    source: 'local-ai' as const,
    transcriptionModel: 'small',
    diarizationModel: 'community-1',
    device: 'cpu' as const,
    detectedLanguage: 'tr',
    languageProbability: 0.9,
    lineAnalysis: [
      {
        lineId: 'ai-replik-0001',
        detectedSpeakerId: 'SPEAKER_00',
        transcriptLogProbability: null,
        diarizationConfidence: null,
        warningCodes: [],
      },
      {
        lineId: 'ai-replik-0002',
        detectedSpeakerId: 'SPEAKER_01',
        transcriptLogProbability: -1.2,
        diarizationConfidence: null,
        warningCodes: ['low_transcription_confidence' as const],
      },
    ],
    warnings: [
      {
        code: 'low_transcription_confidence' as const,
        message: 'Düşük transkripsiyon güveni; metni dinleyerek kontrol et.',
        severity: 'warning' as const,
        lineId: 'ai-replik-0002',
        startMs: 1_000,
        endMs: 1_800,
      },
    ],
  },
}

describe('Scene Studio local AI integration', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'confirm',
      vi.fn(() => true),
    )
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
    mocks.getPrivateScene.mockResolvedValue({
      draft: { media, scene: null, status: 'draft', warnings: [] },
    })
    mocks.fetchPrivateSceneSource.mockResolvedValue(new Blob(['video'], { type: 'video/webm' }))
    mocks.getLocalAiHealth.mockResolvedValue({ status: 'ready' })
    mocks.getLocalSeparationHealth.mockResolvedValue({ status: 'ready', issues: [] })
    mocks.savePrivateScene.mockResolvedValue({
      draft: { media, scene: null, status: 'draft', warnings: [] },
    })
    mocks.generateVideoThumbnail.mockResolvedValue({
      blob: new Blob(['thumbnail'], { type: 'image/webp' }),
      mimeType: 'image/webp',
      width: 640,
      height: 360,
      capturedAtMs: 1_000,
    })
    mocks.uploadPrivateSceneThumbnail.mockResolvedValue({
      draft: {
        media,
        scene: null,
        status: 'draft',
        warnings: [],
        thumbnail: {
          id: '00000000-0000-4000-8000-000000000088',
          mimeType: 'image/webp',
          byteSize: 9,
          width: 640,
          height: 360,
          capturedAtMs: 1_000,
          createdAt: 1,
        },
      },
    })
    mocks.createLocalAiJob.mockResolvedValue({
      id: 'b48e35b0-1f16-4f23-8626-53f17b7f8101',
      status: 'succeeded',
      stage: 'building_draft',
      result: aiResult,
      error: null,
    })
    mocks.createLocalSeparationJob.mockResolvedValue({
      id: 'c48e35b0-1f16-4f23-8626-53f17b7f8102',
      status: 'succeeded',
      stage: 'encoding',
      result: {
        mimeType: 'audio/mp4',
        byteSize: 12,
        durationMs: 5_000,
        sampleRate: 44_100,
        channels: 2,
        provider: 'local-cinematic-separator',
        providerVersion: '1',
        model: 'fixture',
        device: 'cpu',
        inferenceSeconds: 0.1,
        warnings: [],
      },
      error: null,
    })
    mocks.fetchLocalSeparationBackground.mockResolvedValue(
      new Blob([new Uint8Array([0, 0, 0, 12, 102, 116, 121, 112])], { type: 'audio/mp4' }),
    )
    mocks.cancelLocalSeparationJob.mockResolvedValue({ status: 'cancelled' })
    mocks.uploadPrivateSceneBackground.mockImplementation(async (_sceneId, _blob, metadata) => ({
      draft: {
        media,
        scene: null,
        status: 'draft',
        warnings: [],
        backgroundAudio: {
          id: '00000000-0000-4000-8000-000000000099',
          mimeType: 'audio/mp4',
          byteSize: metadata.byteSize,
          durationMs: metadata.durationMs,
          sampleRate: metadata.sampleRate,
          channels: 2,
          createdAt: 1,
          preparation: {
            provider: metadata.provider,
            providerVersion: metadata.providerVersion,
            model: metadata.model,
            device: metadata.device,
          },
        },
      },
    }))
  })

  it('previews a local dialogue-free candidate and saves it only after explicit acceptance', async () => {
    const user = userEvent.setup()
    render(
      <MemoryRouter initialEntries={['/studio/private-abcdef123456']}>
        <Routes>
          <Route path="/studio/:sceneId" element={<SceneStudio />} />
        </Routes>
      </MemoryRouter>,
    )

    await user.click(await screen.findByRole('button', { name: 'Konuşmaları Ayır' }))
    expect(await screen.findByLabelText('Konuşmasız arka plan ön izlemesi')).toBeInTheDocument()
    expect(mocks.uploadPrivateSceneBackground).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Arka Planı Kullan' }))

    await waitFor(() => expect(mocks.uploadPrivateSceneBackground).toHaveBeenCalledOnce())
    expect(screen.getByText(/özel olarak kaydedildi/i)).toBeVisible()
    expect(mocks.createLocalSeparationJob.mock.calls[0]?.[0]).toBeInstanceOf(Blob)
  })

  it('keeps manual scene preparation available when the local separator is unavailable', async () => {
    const user = userEvent.setup()
    mocks.getLocalSeparationHealth.mockRejectedValueOnce(
      new Error('Yerel AI servisi bu bilgisayarda çalışmıyor.'),
    )
    render(
      <MemoryRouter initialEntries={['/studio/private-abcdef123456']}>
        <Routes>
          <Route path="/studio/:sceneId" element={<SceneStudio />} />
        </Routes>
      </MemoryRouter>,
    )
    await user.click(await screen.findByRole('button', { name: 'Konuşmaları Ayır' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Yerel AI servisi')
    expect(screen.getByRole('button', { name: 'Karakter ekle' })).toBeEnabled()
  })

  it('populates the existing editor and still permits human corrections', async () => {
    const user = userEvent.setup()
    render(
      <MemoryRouter initialEntries={['/studio/private-abcdef123456']}>
        <Routes>
          <Route path="/studio/:sceneId" element={<SceneStudio />} />
        </Routes>
      </MemoryRouter>,
    )
    await user.click(await screen.findByRole('button', { name: 'AI ile Taslak Oluştur' }))
    const transcript = await screen.findByLabelText('Replik metni')
    expect(transcript).toHaveValue('AI taslak metni')
    expect(screen.getAllByLabelText('Karakter adı')[0]).toHaveValue('Konuşmacı 1')
    expect(screen.getByText('İnsan incelemesi gerekli')).toBeInTheDocument()
    await user.clear(transcript)
    await user.type(transcript, 'İnsan tarafından düzeltildi')
    expect(transcript).toHaveValue('İnsan tarafından düzeltildi')
    await waitFor(() => expect(screen.getByText('Sahne başlığı boş bırakılamaz.')).toBeVisible())
    expect(mocks.savePrivateScene).not.toHaveBeenCalled()
  })

  it('passes an optional speaker count and supports fast transcript corrections', async () => {
    const user = userEvent.setup()
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue()
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined)
    render(
      <MemoryRouter initialEntries={['/studio/private-abcdef123456']}>
        <Routes>
          <Route path="/studio/:sceneId" element={<SceneStudio />} />
        </Routes>
      </MemoryRouter>,
    )

    await user.selectOptions(await screen.findByLabelText('Beklenen konuşmacı sayısı'), '3')
    await user.click(screen.getByRole('button', { name: 'AI ile Taslak Oluştur' }))
    await screen.findByDisplayValue('AI taslak metni')
    expect(mocks.createLocalAiJob.mock.calls[0]?.[2]).toBe(3)

    await user.click(screen.getByRole('button', { name: 'Sonraki →' }))
    expect(screen.getByLabelText('Replik metni')).toHaveValue('İkinci konuşmacı')
    await user.click(screen.getByRole('button', { name: '← Önceki' }))
    expect(screen.getByLabelText('Replik metni')).toHaveValue('AI taslak metni')
    await user.click(screen.getByRole('button', { name: 'Sonraki uyarı →' }))
    await user.click(screen.getByRole('button', { name: 'Konuşmacı 2: İkinci konuşmacı' }))
    expect(screen.getByLabelText('Replik metni')).toHaveValue('İkinci konuşmacı')
    await user.click(screen.getByLabelText('Yalnızca kontrol edilmesi gerekenler'))
    expect(
      within(screen.getByLabelText('Kompakt replik listesi')).queryByRole('button', {
        name: 'Konuşmacı 1: AI taslak metni',
      }),
    ).toBeNull()

    await user.click(screen.getByLabelText('Yalnızca kontrol edilmesi gerekenler'))
    await user.click(screen.getByRole('button', { name: 'Konuşmacı 1: AI taslak metni' }))
    const video = document.querySelector('video')!
    video.currentTime = 0.5
    fireEvent.timeUpdate(video)
    const transcript = screen.getByLabelText('Replik metni') as HTMLTextAreaElement
    transcript.focus()
    transcript.setSelectionRange(9, 9)
    await user.click(screen.getByRole('button', { name: 'Repliği burada böl' }))
    expect(screen.getByLabelText('Replik metni')).toHaveValue('metni')
    await user.click(screen.getByRole('button', { name: 'Konuşmacı 2' }))
    expect(screen.getByRole('button', { name: 'Konuşmacı 2' })).toHaveClass('active')
    await user.click(screen.getByRole('button', { name: 'Repliği oynat' }))
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalled()

    const endNudges = within(screen.getByLabelText('Bitiş zamanını düzelt'))
    await user.click(endNudges.getByRole('button', { name: '+50 ms' }))
    expect(screen.getByLabelText('Bitiş (sn)')).toHaveValue(0.95)
    await user.click(screen.getByRole('button', { name: 'Sonraki replikle birleştir' }))
    expect(screen.getByLabelText('Replik metni')).toHaveValue('metni İkinci konuşmacı')
    await user.click(screen.getByRole('button', { name: '+ Yeni konuşmacı oluştur ve ata' }))
    expect(screen.getAllByLabelText('Karakter adı')).toHaveLength(3)
  })

  it('reassigns a timeline block by vertical pointer drag without changing canonical line data', async () => {
    const user = userEvent.setup()
    render(
      <MemoryRouter initialEntries={['/studio/private-abcdef123456']}>
        <Routes>
          <Route path="/studio/:sceneId" element={<SceneStudio />} />
        </Routes>
      </MemoryRouter>,
    )
    await user.click(await screen.findByRole('button', { name: 'AI ile Taslak Oluştur' }))
    const block = screen.getByRole('button', { name: 'Konuşmacı 1: AI taslak metni' })
    fireEvent.click(block)
    expect(screen.getByLabelText('Replik metni')).toHaveValue('AI taslak metni')
    const timeline = screen.getByLabelText('Replik zaman çizelgesi')
    vi.spyOn(timeline, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      right: 500,
      bottom: 112,
      width: 500,
      height: 112,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    })

    fireEvent.pointerDown(block, { button: 0, pointerId: 7, clientX: 50, clientY: 18 })
    fireEvent.pointerMove(block, { pointerId: 7, clientX: 240, clientY: 42 })
    expect(timeline.querySelector('[data-character-id="speaker-01"]')).toHaveClass('is-drop-target')
    fireEvent.pointerUp(block, { pointerId: 7, clientX: 240, clientY: 42 })

    expect(screen.getByRole('button', { name: 'Konuşmacı 2: AI taslak metni' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Konuşmacı 2' })).toHaveClass('active')
    expect(screen.getByLabelText('Replik metni')).toHaveValue('AI taslak metni')
    expect(screen.getByLabelText('Başlangıç (sn)')).toHaveValue(0.1)
    expect(screen.getByLabelText('Bitiş (sn)')).toHaveValue(0.9)
    const characterRows = screen
      .getAllByLabelText('Karakter adı')
      .map((input) => input.closest('.character-row'))
    expect(characterRows[0]).toHaveTextContent('0 replik')
    expect(characterRows[1]).toHaveTextContent('2 replik')

    await user.type(screen.getByLabelText('Sahne başlığı'), 'Sürükleyip düzeltme')
    await user.click(screen.getByRole('button', { name: 'Oynanabilir özel sahne olarak kaydet' }))
    await waitFor(() => expect(mocks.savePrivateScene).toHaveBeenCalledOnce())
    const saved = mocks.savePrivateScene.mock.calls[0]?.[0]
    expect(saved.lines).toEqual([
      {
        id: 'ai-replik-0001',
        characterId: 'speaker-01',
        text: 'AI taslak metni',
        startMs: 100,
        endMs: 900,
      },
      aiResult.lines[1],
    ])
  })

  it('cancels a timeline reassignment when the block is dropped outside every lane', async () => {
    const user = userEvent.setup()
    render(
      <MemoryRouter initialEntries={['/studio/private-abcdef123456']}>
        <Routes>
          <Route path="/studio/:sceneId" element={<SceneStudio />} />
        </Routes>
      </MemoryRouter>,
    )
    await user.click(await screen.findByRole('button', { name: 'AI ile Taslak Oluştur' }))
    const block = screen.getByRole('button', { name: 'Konuşmacı 1: AI taslak metni' })
    const timeline = screen.getByLabelText('Replik zaman çizelgesi')
    vi.spyOn(timeline, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      right: 500,
      bottom: 112,
      width: 500,
      height: 112,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    })
    fireEvent.pointerDown(block, { button: 0, pointerId: 8, clientX: 50, clientY: 18 })
    fireEvent.pointerMove(block, { pointerId: 8, clientX: 520, clientY: 42 })
    fireEvent.pointerUp(block, { pointerId: 8, clientX: 520, clientY: 42 })
    expect(screen.getByRole('button', { name: 'Konuşmacı 1: AI taslak metni' })).toBeInTheDocument()
    expect(screen.getByLabelText('Replik metni')).toHaveValue('AI taslak metni')
  })
})
