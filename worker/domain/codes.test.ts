import { describe, expect, it, vi } from 'vitest'
import { generateRoomCode, reserveRoomCode } from './codes'

describe('six-digit room allocation', () => {
  it.each([
    [0, '000000'],
    [12, '000012'],
    [999999, '999999'],
    [1000000, '000000'],
  ])('formats %s as %s', (input, output) => {
    expect(generateRoomCode(() => input as number)).toBe(output)
  })
  it('rejects biased random tail values', () => {
    const random = vi
      .fn()
      .mockReturnValueOnce(2 ** 32 - 1)
      .mockReturnValueOnce(123456)
    expect(generateRoomCode(random)).toBe('123456')
    expect(random).toHaveBeenCalledTimes(2)
  })
  it('retries an occupied code without overwriting its room', async () => {
    const reserve = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce('created')
    const random = vi.fn().mockReturnValueOnce('111111').mockReturnValueOnce('222222')
    expect(await reserveRoomCode(reserve, random)).toBe('created')
    expect(reserve.mock.calls).toEqual([['111111'], ['222222']])
  })
  it('bounds allocation attempts under collisions', async () => {
    const reserve = vi.fn().mockResolvedValue(null)
    await expect(reserveRoomCode(reserve, () => '111111')).rejects.toThrow('allocate')
    expect(reserve).toHaveBeenCalledTimes(12)
  })
})
