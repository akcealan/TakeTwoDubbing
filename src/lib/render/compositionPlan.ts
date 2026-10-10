import type { RecordingManifest } from '../../../shared/types'

export interface SourceProbe {
  codecName: string
  pixelFormat: string
  durationMs: number
}

export interface CompositionPlan {
  audioInputPaths: string[]
  audioMixCommand: string[]
  videoCommand: string[]
  sourcePath: string
  outputPath: string
  mixedAudioPath: string
  copySourceVideo: boolean
}

const AUDIO_SAMPLE_RATE = 48_000
const BACKGROUND_VOLUME = 0.35
const VOICE_VOLUME = 0.9

function seconds(milliseconds: number): string {
  return (milliseconds / 1000).toFixed(3).replace(/\.?0+$/, '')
}

export function recordingExtension(mimeType: RecordingManifest['entries'][number]['mimeType']) {
  if (mimeType.startsWith('audio/ogg')) return 'ogg'
  if (mimeType === 'audio/mp4') return 'm4a'
  return 'webm'
}

export type SourceExtension = 'mp4' | 'webm'

export function sourceExtension(url: string, mimeType?: string): SourceExtension {
  if (mimeType?.toLowerCase().startsWith('video/mp4')) return 'mp4'
  if (mimeType?.toLowerCase().startsWith('video/webm')) return 'webm'
  return url.toLowerCase().endsWith('.mp4') ? 'mp4' : 'webm'
}

export function backgroundExtension(url: string) {
  if (/\/(?:render-background|background)$/.test(url)) return 'm4a'
  const match = /\.([a-z0-9]+)$/.exec(url.toLowerCase())
  return match?.[1] ?? 'audio'
}

export function buildCompositionPlan(
  manifest: RecordingManifest,
  sourceProbe: SourceProbe,
  sourceInputExtension: SourceExtension = sourceExtension(manifest.sourceVideoUrl),
): CompositionPlan {
  const duration = seconds(manifest.sceneDurationMs)
  const sourcePath = `/inputs/source.${sourceInputExtension}`
  const mixedAudioPath = '/dub-mix.m4a'
  const outputPath = '/dubbed-scene.mp4'
  const audioInputPaths: string[] = []
  const filters: string[] = []
  const labels: string[] = []

  if (manifest.backgroundAudioUrl) {
    audioInputPaths.push(`/inputs/background.${backgroundExtension(manifest.backgroundAudioUrl)}`)
    filters.push(
      `[0:a]aresample=${AUDIO_SAMPLE_RATE},aformat=sample_fmts=fltp:sample_rates=${AUDIO_SAMPLE_RATE}:channel_layouts=stereo,asetpts=PTS-STARTPTS,apad=whole_dur=${duration},atrim=duration=${duration},volume=${BACKGROUND_VOLUME}[background]`,
    )
    labels.push('[background]')
  }

  manifest.entries.forEach((entry, entryIndex) => {
    const inputIndex = audioInputPaths.length
    const label = `voice${entryIndex}`
    audioInputPaths.push(`/inputs/recording-${entryIndex}.${recordingExtension(entry.mimeType)}`)
    filters.push(
      `[${inputIndex}:a]aresample=${AUDIO_SAMPLE_RATE},aformat=sample_fmts=fltp:sample_rates=${AUDIO_SAMPLE_RATE}:channel_layouts=stereo,asetpts=PTS-STARTPTS,adelay=${entry.captureStartMs ?? entry.startMs}:all=1,atrim=duration=${duration},volume=${VOICE_VOLUME}[${label}]`,
    )
    labels.push(`[${label}]`)
  })

  filters.push(
    `${labels.join('')}amix=inputs=${labels.length}:duration=longest:dropout_transition=0:normalize=0,alimiter=limit=0.95:attack=5:release=50,apad=whole_dur=${duration},atrim=duration=${duration}[dub]`,
  )

  const audioMixCommand = [
    ...audioInputPaths.flatMap((path) => ['-i', path]),
    '-filter_complex',
    filters.join(';'),
    '-map',
    '[dub]',
    '-vn',
    '-c:a',
    'aac',
    '-b:a',
    '160k',
    '-ar',
    String(AUDIO_SAMPLE_RATE),
    '-ac',
    '2',
    '-t',
    duration,
    mixedAudioPath,
  ]

  const copySourceVideo =
    sourceProbe.codecName === 'h264' && ['yuv420p', 'yuvj420p'].includes(sourceProbe.pixelFormat)
  const videoCodec = copySourceVideo
    ? ['-c:v', 'copy']
    : ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23', '-pix_fmt', 'yuv420p']
  const videoCommand = [
    '-i',
    sourcePath,
    '-i',
    mixedAudioPath,
    '-map',
    '0:v:0',
    '-map',
    '1:a:0',
    ...videoCodec,
    '-c:a',
    'copy',
    '-map_metadata',
    '-1',
    '-map_chapters',
    '-1',
    '-sn',
    '-dn',
    '-t',
    duration,
    '-movflags',
    '+faststart',
    outputPath,
  ]

  return {
    audioInputPaths,
    audioMixCommand,
    videoCommand,
    sourcePath,
    outputPath,
    mixedAudioPath,
    copySourceVideo,
  }
}
