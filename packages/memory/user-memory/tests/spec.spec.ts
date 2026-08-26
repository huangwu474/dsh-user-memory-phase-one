import { describe, expect, it } from 'vitest'
import { savedMemoryRecord } from '../src/spec.ts'

describe('savedMemoryRecord', () => {
  it('strips unknown keys such as source and keywords', () => {
    expect(savedMemoryRecord.parse({
      text: 'User is vegetarian.',
      lastUpdateDate: '2026-01-01',
      keywords: ['diet'],
      source: 'model',
      createdAt: '2026-01-01T00:00:00.000Z',
      extra: true,
    })).toEqual({
      text: 'User is vegetarian.',
      lastUpdateDate: '2026-01-01',
      createdAt: '2026-01-01T00:00:00.000Z',
    })
  })
})
