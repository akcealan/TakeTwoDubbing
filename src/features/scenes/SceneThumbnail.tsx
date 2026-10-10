import { useEffect, useState, type ReactNode } from 'react'
import type { Scene } from '../../../shared/types'
import { fetchPrivateSceneThumbnail } from '../../lib/api/studio'

export function SceneThumbnail({
  scene,
  alt,
  className,
  width,
  height,
  fallback,
}: {
  scene: Scene
  alt: string
  className?: string
  width: number
  height: number
  fallback: ReactNode
}) {
  const [privateSource, setPrivateSource] = useState<{ sceneId: string; url: string } | null>(null)
  const [failedSceneId, setFailedSceneId] = useState<string | null>(null)

  useEffect(() => {
    if (scene.origin.kind !== 'private' || !scene.thumbnailUrl) return
    const controller = new AbortController()
    let objectUrl: string | null = null
    void fetchPrivateSceneThumbnail(scene.id, controller.signal)
      .then((blob) => {
        objectUrl = URL.createObjectURL(blob)
        setPrivateSource({ sceneId: scene.id, url: objectUrl })
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailedSceneId(scene.id)
      })
    return () => {
      controller.abort()
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [scene.id, scene.origin.kind, scene.thumbnailUrl])

  const src =
    scene.origin.kind === 'private' && privateSource?.sceneId === scene.id
      ? privateSource.url
      : scene.origin.kind === 'built-in'
        ? scene.thumbnailUrl
        : null
  if (!src || failedSceneId === scene.id) return fallback
  return (
    <img src={src} alt={alt} className={className} loading="lazy" width={width} height={height} />
  )
}
