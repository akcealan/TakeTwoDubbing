export const PRE_RECORD_GRACE_MS = 500
export const POST_RECORD_GRACE_MS = 500

export interface CanonicalRecordingWindow {
  startMs: number
  endMs: number
}

export interface RecordingCaptureWindow {
  captureStartMs: number
  captureEndMs: number
}

export function getRecordingCaptureWindow(
  line: CanonicalRecordingWindow,
  sceneDurationMs: number,
): RecordingCaptureWindow {
  return {
    captureStartMs: Math.max(0, line.startMs - PRE_RECORD_GRACE_MS),
    captureEndMs: Math.min(sceneDurationMs, line.endMs + POST_RECORD_GRACE_MS),
  }
}
