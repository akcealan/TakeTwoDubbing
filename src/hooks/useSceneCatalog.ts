import { useEffect, useState } from 'react'
import { getSceneById } from '../../shared/scenes/catalog'
import type { Scene } from '../../shared/types'
import { getPrivateScene, listPrivateScenes } from '../lib/api/studio'

export function useSceneCatalog() {
  const [scenes, setScenes] = useState<Scene[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    const controller = new AbortController()
    void listPrivateScenes(controller.signal)
      .then(({ scenes: privateScenes }) => setScenes(privateScenes))
      .catch((failure: unknown) => {
        if (!controller.signal.aborted)
          setError(failure instanceof Error ? failure.message : 'Özel sahneler alınamadı.')
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [])
  return { scenes, error, loading }
}

export function useScene(sceneId: string | undefined) {
  const builtIn = getSceneById(sceneId)
  const privateId = Boolean(sceneId && /^private-[a-f0-9]{12}$/.test(sceneId))
  const [scene, setScene] = useState<Scene | undefined>(builtIn)
  const [loading, setLoading] = useState(!builtIn && privateId)
  useEffect(() => {
    if (builtIn || !sceneId || !privateId) return
    const controller = new AbortController()
    void getPrivateScene(sceneId, controller.signal)
      .then(({ draft }) =>
        setScene(draft.status === 'prepared' ? (draft.scene ?? undefined) : undefined),
      )
      .catch(() => {
        if (!controller.signal.aborted) setScene(undefined)
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [builtIn, sceneId, privateId])
  return { scene, loading }
}
