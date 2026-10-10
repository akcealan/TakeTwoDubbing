export function formatTimestamp(milliseconds: number): string {
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
    throw new RangeError('Time must be a non-negative safe integer in milliseconds.')
  }
  const totalSeconds = Math.floor(milliseconds / 1000)
  return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, '0')}`
}
