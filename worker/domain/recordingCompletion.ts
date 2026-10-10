import { recordingManifestSchema } from '../../shared/schemas/recording'
import type {
  RecordingManifest,
  Room,
  RoomRecordingProgress,
  Scene,
  StoredRecording,
} from '../../shared/types'
import { RoomError } from './errors'

interface RequiredLine {
  line: Scene['lines'][number]
  playerId: string
}

function requiredLines(room: Room, scene: Scene): RequiredLine[] {
  const ownerByCharacter = new Map<string, string>()
  for (const player of room.players)
    for (const characterId of player.characterIds)
      if (!ownerByCharacter.has(characterId)) ownerByCharacter.set(characterId, player.id)
  return scene.lines.flatMap((line) => {
    const playerId = ownerByCharacter.get(line.characterId)
    return playerId ? [{ line, playerId }] : []
  })
}

function validRecording(
  recordings: readonly StoredRecording[],
  requirement: RequiredLine,
): StoredRecording | undefined {
  return recordings.find(
    (recording) =>
      recording.lineId === requirement.line.id && recording.playerId === requirement.playerId,
  )
}

export function deriveRecordingProgress(room: Room, scene: Scene): RoomRecordingProgress {
  const requirements = requiredLines(room, scene)
  const recordings = room.recordings ?? []
  const players = room.players.map((player) => {
    const owned = requirements.filter((requirement) => requirement.playerId === player.id)
    const uploaded = owned.filter((requirement) => validRecording(recordings, requirement)).length
    const remaining = owned.length - uploaded
    return {
      playerId: player.id,
      required: owned.length,
      uploaded,
      remaining,
      complete: remaining === 0,
      spectator: owned.length === 0,
    }
  })
  const totalUploaded = requirements.filter((requirement) =>
    validRecording(recordings, requirement),
  ).length
  const remaining = requirements.length - totalUploaded
  return {
    totalRequired: requirements.length,
    totalUploaded,
    remaining,
    readyForFinalization: requirements.length > 0 && remaining === 0,
    players,
  }
}

export function buildRecordingManifest(
  room: Room,
  scene: Scene,
  manifestId: string,
  createdAt: number,
): RecordingManifest {
  const progress = deriveRecordingProgress(room, scene)
  if (!progress.readyForFinalization)
    throw new RoomError(
      'RECORDINGS_INCOMPLETE',
      'Every required dialogue line needs an uploaded recording.',
      409,
    )
  const recordings = room.recordings ?? []
  const entries = requiredLines(room, scene).map((requirement) => {
    const recording = validRecording(recordings, requirement)
    if (!recording)
      throw new RoomError('RECORDINGS_INCOMPLETE', 'A required dialogue recording is missing.', 409)
    return {
      lineId: requirement.line.id,
      characterId: requirement.line.characterId,
      playerId: requirement.playerId,
      startMs: requirement.line.startMs,
      endMs: requirement.line.endMs,
      captureStartMs: recording.captureStartMs ?? requirement.line.startMs,
      captureEndMs: recording.captureEndMs ?? requirement.line.endMs,
      recordingId: recording.recordingId,
      mimeType: recording.mimeType,
      byteSize: recording.byteSize,
      durationMs: recording.durationMs,
    }
  })
  return recordingManifestSchema.parse({
    version: 1,
    manifestId,
    roomId: room.id,
    sceneId: scene.id,
    sourceVideoUrl: scene.videoUrl,
    backgroundAudioUrl: scene.backgroundAudioUrl,
    sceneDurationMs: scene.durationMs,
    createdAt,
    entries,
  })
}

export function finalizeRecordings(
  room: Room,
  requesterId: string,
  scene: Scene,
  manifestId: string,
  createdAt: number,
): RecordingManifest {
  if (room.status === 'processing' || room.recordingManifest)
    throw new RoomError('FINALIZATION_STARTED', 'Recording finalization has already begun.', 409)
  if (room.status !== 'playing' || room.startedAt === null)
    throw new RoomError('ROOM_UNAVAILABLE', 'This room cannot begin finalization.', 409)
  if (room.hostId !== requesterId)
    throw new RoomError('FORBIDDEN', 'Only the current host can begin finalization.', 403)
  const manifest = buildRecordingManifest(room, scene, manifestId, createdAt)
  room.recordingProgress = deriveRecordingProgress(room, scene)
  room.recordingManifest = manifest
  room.status = 'processing'
  return manifest
}
