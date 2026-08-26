import { describe, expect, it } from 'vitest'
import {
  allocateMemoryId,
  MEMORY_ID_ALLOCATE_ATTEMPTS,
  MEMORY_ID_BYTE_LENGTH,
  MemoryId,
} from '../src/ids.ts'

describe('allocateMemoryId', () => {
  it('mints a 12-character hex id when the table is empty', () => {
    const id = allocateMemoryId(() => false, (size) => {
      expect(size).toBe(MEMORY_ID_BYTE_LENGTH)
      return Buffer.from('aabbccddeeff', 'hex')
    })
    expect(id).toBe(MemoryId('aabbccddeeff'))
    expect(id).toMatch(/^[0-9a-f]{12}$/)
  })

  it('retries when the candidate is already occupied', () => {
    const taken = new Set(['aaaaaaaaaaaa'])
    let calls = 0
    const id = allocateMemoryId(candidate => taken.has(candidate), (size) => {
      calls += 1
      expect(size).toBe(MEMORY_ID_BYTE_LENGTH)
      return calls === 1 ? Buffer.from('aaaaaaaaaaaa', 'hex') : Buffer.from('bbbbbbbbbbbb', 'hex')
    })
    expect(id).toBe('bbbbbbbbbbbb')
    expect(calls).toBe(2)
  })

  it('fails loud after a bounded number of collisions', () => {
    let calls = 0
    expect(() => allocateMemoryId(() => true, () => {
      calls += 1
      return new Uint8Array(MEMORY_ID_BYTE_LENGTH)
    })).toThrow(/could not allocate a unique memory id/)
    expect(calls).toBe(MEMORY_ID_ALLOCATE_ATTEMPTS)
  })
})
