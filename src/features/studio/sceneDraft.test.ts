import { describe, expect, it } from 'vitest'
import type { UploadedMedia } from '../../../shared/types'
import {
  buildPrivateScene,
  canonicalLineOrder,
  deleteDialogueLine,
  editableFromAiDraft,
  mergeWithNextDialogueLine,
  nudgeDialogueBoundary,
  removeCharacterSafely,
  sceneValidationMessages,
  splitDialogueLine,
} from './sceneDraft'
import { captureVideoTimeMs, matchesVideoSignature } from '../../lib/studio/media'

const media: UploadedMedia = {
  sceneId: 'private-abcdef123456',
  filename: 'bizim-klip.webm',
  mimeType: 'video/webm',
  byteSize: 100,
  durationMs: 10_000,
  width: 640,
  height: 360,
  uploadedAt: 1,
}

describe('Scene Studio preparation domain', () => {
  it('allows overlaps and orders equal-time dialogue deterministically', () => {
    const lines = [
      { id: 'line-b', characterId: 'b', text: 'B', startMs: 1000, endMs: 3000 },
      { id: 'line-a', characterId: 'a', text: 'A', startMs: 1000, endMs: 2500 },
    ]
    expect(canonicalLineOrder(lines).map((line) => line.id)).toEqual(['line-a', 'line-b'])
    expect(
      buildPrivateScene(media, {
        title: 'Üst Üste',
        description: '',
        characters: [
          { id: 'a', name: 'Ada' },
          { id: 'b', name: 'Bora' },
        ],
        lines,
      }).success,
    ).toBe(true)
  })

  it('reports missing text, character and invalid bounds', () => {
    const messages = sceneValidationMessages(media, {
      title: '',
      characters: [{ id: 'a', name: 'Ada' }],
      description: '',
      lines: [{ id: 'line-1', characterId: 'missing', text: ' ', startMs: 9000, endMs: 11_000 }],
    })
    expect(messages).toContain('Sahne başlığı boş bırakılamaz.')
    expect(messages).toContain('Her replik var olan bir karaktere bağlı olmalı.')
    expect(messages).toContain('Replik metni boş bırakılamaz.')
    expect(messages).toContain('Replik video süresini aşamaz.')
  })

  it('captures and clamps the video playhead in integer milliseconds', () => {
    expect(captureVideoTimeMs(1.2346, 10_000)).toBe(1235)
    expect(captureVideoTimeMs(99, 10_000)).toBe(10_000)
  })

  it('blocks character deletion while lines refer to it and deletes lines explicitly', () => {
    const editable = {
      title: 'Test',
      description: '',
      characters: [{ id: 'a', name: 'Ada' }],
      lines: [{ id: 'line-1', characterId: 'a', text: 'Merhaba', startMs: 0, endMs: 1000 }],
    }
    expect(removeCharacterSafely(editable, 'a').error).toContain('bağlı replikler')
    const withoutLine = deleteDialogueLine(editable, 'line-1')
    const removed = removeCharacterSafely(withoutLine, 'a')
    expect(removed.error).toBeNull()
    expect(removed.editable.characters).toHaveLength(0)
  })

  it('checks container signatures instead of trusting extensions', () => {
    expect(matchesVideoSignature(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]), 'video/webm')).toBe(true)
    expect(matchesVideoSignature(new Uint8Array(16), 'video/webm')).toBe(false)
    const mp4 = new Uint8Array(12)
    mp4.set(new TextEncoder().encode('ftyp'), 4)
    expect(matchesVideoSignature(mp4, 'video/mp4')).toBe(true)
  })

  it('opens AI output in the same editable draft and keeps manual fields editable', () => {
    const result = editableFromAiDraft(
      { title: 'Korunan başlık', description: '', characters: [], lines: [] },
      {
        characters: [{ id: 'speaker-00', name: 'Konuşmacı 1' }],
        lines: [
          {
            id: 'ai-replik-0001',
            characterId: 'speaker-00',
            text: 'Taslak metin',
            startMs: 100,
            endMs: 900,
          },
        ],
        analysis: {
          source: 'local-ai',
          transcriptionModel: 'small',
          diarizationModel: 'community-1',
          device: 'cpu',
          detectedLanguage: 'tr',
          languageProbability: 0.9,
          lineAnalysis: [],
          warnings: [],
        },
      },
    )
    const corrected = {
      ...result,
      lines: result.lines.map((line) => ({ ...line, text: 'İnsan düzeltmesi' })),
    }
    expect(corrected.title).toBe('Korunan başlık')
    expect(corrected.characters[0]?.id).toBe('speaker-00')
    expect(corrected.lines[0]?.text).toBe('İnsan düzeltmesi')
    expect(buildPrivateScene(media, corrected).success).toBe(true)
  })

  it('splits at the playhead without losing text and keeps overlapping lines valid', () => {
    const editable = {
      title: 'Test',
      description: '',
      characters: [{ id: 'a', name: 'Ada' }],
      lines: [
        { id: 'line-1', characterId: 'a', text: 'Birinci İkinci', startMs: 100, endMs: 900 },
        { id: 'overlap', characterId: 'a', text: 'Üst üste', startMs: 450, endMs: 700 },
      ],
    }
    const result = splitDialogueLine(editable, 'line-1', 500, 7)
    expect(result.error).toBeNull()
    expect(result.editable.lines.find((line) => line.id === 'line-1')?.text).toBe('Birinci')
    expect(result.editable.lines.find((line) => line.id === result.newLineId)?.text).toBe('İkinci')
    expect(buildPrivateScene(media, result.editable).success).toBe(true)
  })

  it('merges only the next canonical line and preserves deterministic bounds', () => {
    const editable = {
      title: 'Test',
      description: '',
      characters: [{ id: 'a', name: 'Ada' }],
      lines: [
        { id: 'two', characterId: 'a', text: 'iki', startMs: 500, endMs: 900 },
        { id: 'one', characterId: 'a', text: 'bir', startMs: 100, endMs: 450 },
      ],
    }
    const result = mergeWithNextDialogueLine(editable, 'one')
    expect(result.removedLineId).toBe('two')
    expect(result.editable.lines).toEqual([
      { id: 'one', characterId: 'a', text: 'bir iki', startMs: 100, endMs: 900 },
    ])
  })

  it('nudges boundaries within the neighboring boundary and scene duration', () => {
    const editable = {
      title: 'Test',
      description: '',
      characters: [{ id: 'a', name: 'Ada' }],
      lines: [{ id: 'one', characterId: 'a', text: 'bir', startMs: 100, endMs: 900 }],
    }
    const start = nudgeDialogueBoundary(editable, 'one', 'startMs', 5_000, 10_000)
    expect(start.lines[0]?.startMs).toBe(899)
    const end = nudgeDialogueBoundary(editable, 'one', 'endMs', 20_000, 10_000)
    expect(end.lines[0]?.endMs).toBe(10_000)
  })
})
