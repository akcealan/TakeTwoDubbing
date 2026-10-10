import { describe, expect, it } from 'vitest'
import { MAX_FINAL_RESULT_BYTES } from '../../shared/schemas/result'
import { RoomError } from '../domain/errors'
import { requireContentLength } from './http'

function requestWithLength(length?: number) {
  return new Request('https://worker/upload', {
    method: 'POST',
    headers: length === undefined ? undefined : { 'Content-Length': String(length) },
  })
}

describe('streamed upload content-length policy', () => {
  it('accepts the current real result size and the byte below 64 MiB', () => {
    expect(requireContentLength(requestWithLength(22_167_310), MAX_FINAL_RESULT_BYTES)).toBe(
      22_167_310,
    )
    expect(
      requireContentLength(requestWithLength(MAX_FINAL_RESULT_BYTES - 1), MAX_FINAL_RESULT_BYTES),
    ).toBe(MAX_FINAL_RESULT_BYTES - 1)
  })

  it('rejects just-over, empty and indeterminate bodies before streaming', () => {
    for (const length of [MAX_FINAL_RESULT_BYTES + 1, 0, undefined]) {
      try {
        requireContentLength(requestWithLength(length), MAX_FINAL_RESULT_BYTES)
        throw new Error('expected upload rejection')
      } catch (error) {
        expect(error).toBeInstanceOf(RoomError)
        expect((error as RoomError).status).toBe(
          length === MAX_FINAL_RESULT_BYTES + 1 ? 413 : length === 0 ? 400 : 411,
        )
      }
    }
  })
})
