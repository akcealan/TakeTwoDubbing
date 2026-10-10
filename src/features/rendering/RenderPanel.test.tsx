import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { recordingManifestSchema } from '../../../shared/schemas/recording'
import { getSceneById } from '../../../shared/scenes/catalog'
import type { RoomSession } from '../../../shared/schemas/protocol'
import { DubRenderError } from '../../lib/render/BrowserDubRenderer'
import { RenderPanel } from './RenderPanel'
import { safeRenderFilename } from './filename'

const session: RoomSession = {
  code: '012345',
  roomId: '00000000-0000-4000-8000-000000000001',
  playerId: '00000000-0000-4000-8000-000000000002',
  token: 'a'.repeat(64),
}
const manifest = recordingManifestSchema.parse({
  version: 1,
  manifestId: '00000000-0000-4000-8000-000000000010',
  roomId: session.roomId,
  sceneId: 'a-small-step',
  sourceVideoUrl: '/scenes/a-small-step/video.webm',
  sceneDurationMs: 30_000,
  createdAt: 1,
  entries: [
    {
      lineId: 'step-1',
      characterId: 'nova',
      playerId: session.playerId,
      startMs: 1_000,
      endMs: 4_500,
      recordingId: '00000000-0000-4000-8000-000000000100',
      mimeType: 'audio/webm;codecs=opus',
      byteSize: 4,
      durationMs: 100,
    },
  ],
})
const diagnostics = {
  sourceDurationMs: 30_000,
  recordingInputCount: 1,
  outputBytes: 2_048,
  renderDurationMs: 4_000,
  sourceVideoMode: 'h264-transcode' as const,
}

describe('render panel', () => {
  it('retries, replaces/revokes result URLs and exposes a local MP4 download', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const headers = new Headers(init?.headers)
      const resultId = headers.get('X-Result-Id')!
      return Response.json({
        result: {
          resultId,
          manifestId: manifest.manifestId,
          roomId: session.roomId,
          mimeType: 'video/mp4',
          byteSize: 5,
          completedAt: 1,
          filename: 'take-two-012345.mp4',
        },
      })
    })
    const urls = ['blob:first', 'blob:second']
    const createUrl = vi.spyOn(URL, 'createObjectURL').mockImplementation(() => urls.shift()!)
    const revokeUrl = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
    const renderer = {
      render: vi
        .fn()
        .mockRejectedValueOnce(new DubRenderError('ENGINE_FAILED', 'Motor yüklenemedi.'))
        .mockResolvedValueOnce({ blob: new Blob(['first']), diagnostics })
        .mockResolvedValueOnce({ blob: new Blob(['second']), diagnostics }),
      cancel: vi.fn(),
      dispose: vi.fn(),
    }
    const view = render(
      <RenderPanel
        manifest={manifest}
        session={session}
        scene={getSceneById('a-small-step')!}
        createRenderer={() => renderer}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: "Yerel MP4'ü Hazırla" }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Motor yüklenemedi.')
    fireEvent.click(screen.getByRole('button', { name: 'Yeniden Dene' }))
    const download = await screen.findByRole('link', { name: "Yerel MP4'ü İndir" })
    expect(download).toHaveAttribute('href', 'blob:first')
    expect(download).toHaveAttribute('download', 'take-two-kucuk-bir-adim-012345.mp4')
    expect(screen.getByText('Paylaşılan sonuç hazır')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Yeniden Hazırla' }))
    await waitFor(() =>
      expect(screen.getByRole('link', { name: "Yerel MP4'ü İndir" })).toHaveAttribute(
        'href',
        'blob:second',
      ),
    )
    expect(revokeUrl).toHaveBeenCalledWith('blob:first')
    view.unmount()
    expect(renderer.dispose).toHaveBeenCalledOnce()
    expect(revokeUrl).toHaveBeenCalledWith('blob:second')
    createUrl.mockRestore()
    revokeUrl.mockRestore()
    fetchMock.mockRestore()
  })

  it('creates a filesystem-safe Turkish filename', () => {
    expect(safeRenderFilename('Şaşırtıcı: Bir Öykü!', '000007')).toBe(
      'take-two-sasirtici-bir-oyku-000007.mp4',
    )
  })
})
