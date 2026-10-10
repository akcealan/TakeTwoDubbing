import { describe, expect, it } from 'vitest'
import { getSceneById } from '../../shared/scenes/catalog'
import type { Room, StoredRecording } from '../../shared/types'
import {
  buildRecordingManifest,
  deriveRecordingProgress,
  finalizeRecordings,
} from './recordingCompletion'

const scene = getSceneById('a-small-step')!
const playerOne = '00000000-0000-4000-8000-000000000001'
const playerTwo = '00000000-0000-4000-8000-000000000002'

function room(assignments: string[][], connected = assignments.map(() => true)): Room {
  return {
    id: '00000000-0000-4000-8000-000000000010',
    code: '012345',
    sceneId: scene.id,
    hostId: playerOne,
    status: 'playing',
    startedAt: 1000,
    players: assignments.map((characterIds, index) => ({
      id: index === 0 ? playerOne : playerTwo,
      nickname: `Player ${index + 1}`,
      connected: connected[index] ?? true,
      ready: true,
      characterIds,
    })),
    recordings: [],
    recordingManifest: null,
    expiresAt: 999_999,
    revision: 1,
  }
}

function recording(lineId: string, playerId: string, index = 1): StoredRecording {
  const recordingId = `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`
  return {
    recordingId,
    lineId,
    playerId,
    mimeType: 'audio/webm;codecs=opus',
    byteSize: 100 + index,
    durationMs: 1000 + index,
    uploadedAt: 2000 + index,
  }
}

describe('authoritative recording progress', () => {
  it('counts one character and becomes ready only after its final required upload', () => {
    const state = room([['nova']])
    state.recordings = [recording('step-1', playerOne)]
    expect(deriveRecordingProgress(state, scene)).toMatchObject({
      totalRequired: 2,
      totalUploaded: 1,
      remaining: 1,
      readyForFinalization: false,
      players: [{ playerId: playerOne, required: 2, uploaded: 1, remaining: 1, complete: false }],
    })
    state.recordings.push(recording('step-4', playerOne, 2))
    expect(deriveRecordingProgress(state, scene)).toMatchObject({
      totalRequired: 2,
      totalUploaded: 2,
      remaining: 0,
      readyForFinalization: true,
    })
  })

  it('combines multiple characters and represents spectators without requirements', () => {
    const state = room([['nova', 'echo'], []])
    state.recordings = [recording('step-1', playerOne), recording('step-3', playerOne, 2)]
    expect(deriveRecordingProgress(state, scene)).toMatchObject({
      totalRequired: 4,
      totalUploaded: 2,
      remaining: 2,
      players: [
        {
          playerId: playerOne,
          required: 4,
          uploaded: 2,
          remaining: 2,
          spectator: false,
        },
        {
          playerId: playerTwo,
          required: 0,
          uploaded: 0,
          remaining: 0,
          complete: true,
          spectator: true,
        },
      ],
    })
  })

  it('keeps a disconnected assigned player’s required lines', () => {
    const state = room([['nova'], ['pip']], [true, false])
    const progress = deriveRecordingProgress(state, scene)
    expect(progress.totalRequired).toBe(4)
    expect(progress.players[1]).toMatchObject({
      playerId: playerTwo,
      required: 2,
      remaining: 2,
      spectator: false,
    })
  })

  it('ignores uploaded metadata that does not match the authoritative owner', () => {
    const state = room([['nova'], ['pip']])
    state.recordings = [recording('step-1', playerTwo)]
    expect(deriveRecordingProgress(state, scene).totalUploaded).toBe(0)
  })
})

describe('frozen recording manifest', () => {
  function completeRoom() {
    const state = room([['nova', 'pip', 'echo']])
    state.recordings = scene.lines.map((line, index) => recording(line.id, playerOne, index + 1))
    return state
  }

  it('rejects missing coverage and non-host finalization', () => {
    const incomplete = room([['nova']])
    expect(() =>
      buildRecordingManifest(incomplete, scene, '00000000-0000-4000-8000-000000000020', 3000),
    ).toThrow('Every required dialogue line')
    expect(() =>
      finalizeRecordings(
        completeRoom(),
        playerTwo,
        scene,
        '00000000-0000-4000-8000-000000000020',
        3000,
      ),
    ).toThrow('Only the current host')
  })

  it('freezes every required canonical line exactly once with its authoritative recording', () => {
    const state = completeRoom()
    state.recordings![0] = {
      ...state.recordings![0]!,
      captureStartMs: 500,
      captureEndMs: 5000,
      durationMs: 4500,
    }
    const manifest = finalizeRecordings(
      state,
      playerOne,
      scene,
      '00000000-0000-4000-8000-000000000020',
      3000,
    )
    expect(state.status).toBe('processing')
    expect(state.recordingManifest).toEqual(manifest)
    expect(manifest.entries.map((entry) => entry.lineId)).toEqual(
      scene.lines.map((line) => line.id),
    )
    expect(new Set(manifest.entries.map((entry) => entry.lineId)).size).toBe(scene.lines.length)
    expect(manifest.entries[0]).toMatchObject({
      lineId: 'step-1',
      characterId: 'nova',
      playerId: playerOne,
      startMs: 1000,
      endMs: 4500,
      captureStartMs: 500,
      captureEndMs: 5000,
      recordingId: state.recordings?.[0]?.recordingId,
    })
    expect(() =>
      finalizeRecordings(state, playerOne, scene, '00000000-0000-4000-8000-000000000021', 4000),
    ).toThrow('already begun')
    expect(state.recordingManifest).toEqual(manifest)
  })

  it('resolves legacy recording timing to canonical bounds in the frozen manifest', () => {
    const manifest = buildRecordingManifest(
      completeRoom(),
      scene,
      '00000000-0000-4000-8000-000000000022',
      3000,
    )
    expect(manifest.entries[0]).toMatchObject({
      startMs: 1000,
      endMs: 4500,
      captureStartMs: 1000,
      captureEndMs: 4500,
    })
  })

  it('freezes the room-private background reference without changing canonical timing', () => {
    const backgroundScene = {
      ...scene,
      backgroundAudioUrl: '/api/rooms/012345/render-background',
    }
    const manifest = buildRecordingManifest(
      completeRoom(),
      backgroundScene,
      '00000000-0000-4000-8000-000000000023',
      3000,
    )
    expect(manifest.backgroundAudioUrl).toBe('/api/rooms/012345/render-background')
    expect(manifest.entries.map(({ startMs, endMs }) => ({ startMs, endMs }))).toEqual(
      scene.lines.map(({ startMs, endMs }) => ({ startMs, endMs })),
    )
  })
})
