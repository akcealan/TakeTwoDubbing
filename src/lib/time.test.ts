import { describe, expect, it } from 'vitest'
import { formatTimestamp } from './time'

describe('formatTimestamp', () => {
  it.each([
    [0, '0:00'],
    [999, '0:00'],
    [12400, '0:12'],
    [60000, '1:00'],
    [125999, '2:05'],
  ])('formats %i milliseconds as %s', (input, output) => {
    expect(formatTimestamp(input as number)).toBe(output)
  })
  it.each([-1, 1.2, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid internal time %s',
    (input) => {
      expect(() => formatTimestamp(input)).toThrow(RangeError)
    },
  )
})
