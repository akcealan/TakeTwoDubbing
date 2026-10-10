import { useEffect, useMemo, useSyncExternalStore } from 'react'
import type { RoomSession } from '../../shared/schemas/protocol'
import { RoomConnection } from '../lib/websocket/RoomConnection'

export function useRoom(session: RoomSession) {
  const connection = useMemo(() => new RoomConnection(session), [session])
  const snapshot = useSyncExternalStore(connection.subscribe, connection.getSnapshot)
  useEffect(() => {
    connection.connect()
    return connection.dispose
  }, [connection])
  return { ...snapshot, send: connection.send, reconnect: connection.connect }
}
