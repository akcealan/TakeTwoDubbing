import type { ErrorCode } from '../../shared/schemas/protocol'

export class RoomError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly status = 400,
  ) {
    super(message)
  }
}
