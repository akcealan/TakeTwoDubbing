import { afterEach, describe, expect, it, vi } from 'vitest'
import { createLocalAiJob, getLocalAiHealth } from './companion'

afterEach(() => vi.unstubAllGlobals())

describe('local AI companion client', () => {
  it('distinguishes an unavailable local service from a generic network error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')))
    await expect(getLocalAiHealth()).rejects.toMatchObject({
      kind: 'unavailable',
      message: expect.stringContaining('npm run ai:dev'),
    })
  })

  it('reports missing local model setup separately', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            service: 'take-two-local-ai',
            version: '0.1.0',
            status: 'setup_required',
            device: 'cpu',
            transcriptionModel: 'small',
            diarizationModel: 'community-1',
            issues: [{ code: 'models_missing', message: 'Model dosyaları eksik.' }],
          }),
        ),
      ),
    )
    await expect(getLocalAiHealth()).rejects.toMatchObject({
      kind: 'setup',
      message: 'Model dosyaları eksik.',
    })
  })

  it('sends an exact optional speaker count only for the AI job', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          job: {
            id: 'b48e35b0-1f16-4f23-8626-53f17b7f8101',
            status: 'queued',
            stage: 'queued',
            result: null,
            error: null,
          },
        }),
      ),
    )
    vi.stubGlobal('fetch', fetchMock)
    await createLocalAiJob(
      new Blob(['video'], { type: 'video/webm' }),
      {
        sceneId: 'private-abcdef123456',
        filename: 'sample.webm',
        mimeType: 'video/webm',
        byteSize: 5,
        durationMs: 1_000,
        width: 640,
        height: 360,
        uploadedAt: 1,
      },
      3,
    )
    const body = fetchMock.mock.calls[0]?.[1]?.body as FormData
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit & { targetAddressSpace?: string }
    expect(body.get('expectedSpeakerCount')).toBe('3')
    expect(body.get('durationMs')).toBe('1000')
    expect(new Headers(init.headers).get('X-Take-Two-Companion')).toBe('1')
    expect(init.targetAddressSpace).toBe('loopback')
  })

  it('distinguishes a denied loopback permission from a stopped service', async () => {
    vi.stubGlobal('fetch', vi.fn())
    vi.stubGlobal('navigator', {
      permissions: { query: vi.fn().mockResolvedValue({ state: 'denied' }) },
    })
    await expect(getLocalAiHealth()).rejects.toMatchObject({
      kind: 'permission-denied',
      message: expect.stringContaining('izin vermedi'),
    })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('classifies an explicit companion origin rejection', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ detail: 'origin denied' }), {
          status: 403,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    )
    await expect(getLocalAiHealth()).rejects.toMatchObject({
      kind: 'origin-denied',
      message: expect.stringContaining('izin listesinde'),
    })
  })
})
