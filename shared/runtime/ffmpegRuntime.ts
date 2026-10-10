import manifest from './ffmpeg-manifest.json' with { type: 'json' }

export const ffmpegRuntimeManifest = manifest

export const ffmpegRuntimePaths = new Set([
  `${manifest.basePath}/${manifest.javascript.fileName}`,
  `${manifest.basePath}/manifest.json`,
  ...manifest.wasmParts.map((part) => `${manifest.basePath}/${part.fileName}`),
])

export function isFfmpegRuntimePath(pathname: string): boolean {
  return ffmpegRuntimePaths.has(pathname)
}

export function isFfmpegRuntimeNamespace(pathname: string): boolean {
  return pathname.startsWith('/runtime/ffmpeg/')
}
