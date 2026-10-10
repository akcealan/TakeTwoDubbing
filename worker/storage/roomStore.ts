import type { Room } from '../../shared/types'

export interface StoredRoom {
  version: 1
  room: Room
  sceneSourceAssetId?: string
  sceneBackgroundAssetId?: string
  recordingAssetIds?: Record<string, string>
  resultAssetId?: string
  tokenHashes: Record<string, string>
  joinRequests?: Record<string, { playerId: string; nickname: string }>
}

export class RoomStore {
  constructor(private readonly storage: DurableObjectStorage) {}
  async load(): Promise<StoredRoom | null> {
    return (await this.storage.get<StoredRoom>('room')) ?? null
  }
  async save(state: StoredRoom): Promise<void> {
    await this.storage.put('room', state)
  }
  async clear(): Promise<void> {
    await this.storage.deleteAll()
    await this.storage.deleteAlarm()
  }
}
