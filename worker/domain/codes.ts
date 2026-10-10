import { RoomError } from './errors'

export function generateRoomCode(
  nextUint32 = () => crypto.getRandomValues(new Uint32Array(1))[0]!,
): string {
  const ceiling = Math.floor(2 ** 32 / 1_000_000) * 1_000_000
  let value: number
  do {
    value = nextUint32()
  } while (value >= ceiling)
  return String(value % 1_000_000).padStart(6, '0')
}

export async function reserveRoomCode<T>(
  reserve: (code: string) => Promise<T | null>,
  generate = generateRoomCode,
): Promise<T> {
  for (let attempt = 0; attempt < 12; attempt++) {
    const result = await reserve(generate())
    if (result !== null) return result
  }
  throw new RoomError('ROOM_UNAVAILABLE', 'Could not allocate a room code. Please try again.', 503)
}
