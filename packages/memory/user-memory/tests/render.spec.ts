import { describe, expect, it } from 'vitest'
import { MemoryId } from '../src/ids.ts'
import {
  renderSavedMemories,
  renderSessionOverrides,
  selectSavedMemories,
  selectSessionOverrides,
} from '../src/render.ts'
import type { SavedMemoryRecord } from '../src/spec.ts'

const fact = (
  id: string,
  text: string,
  lastUpdateDate: string,
  createdAt: string,
): readonly [MemoryId, SavedMemoryRecord] => [
  MemoryId(id),
  { text, lastUpdateDate, createdAt },
]

describe('user-memory render helpers', () => {
  it('renders nothing for empty lists', () => {
    expect(renderSavedMemories([])).toBe('')
    expect(renderSessionOverrides([])).toBe('')
  })

  it('renders each durable fact with its id prefix', () => {
    expect(renderSavedMemories([
      fact('aabbccddeeff', 'User is vegetarian.', '2026-02-01', '2026-02-01T00:00:00.000Z'),
    ])).toBe('Durable user facts (most recent first):\n- [aabbccddeeff] User is vegetarian.')
  })

  it('sorts saved memories by date then createdAt and caps them', () => {
    const selected = selectSavedMemories([
      fact('old', 'old', '2026-01-01', '2026-01-01T00:00:00.000Z'),
      fact('newer-created', 'newer-created', '2026-02-01', '2026-02-01T02:00:00.000Z'),
      fact('newer-earlier', 'newer-earlier', '2026-02-01', '2026-02-01T01:00:00.000Z'),
    ], 2)
    expect(selected.map(([, record]) => record.text)).toEqual(['newer-created', 'newer-earlier'])
    expect(selected.map(([id]) => id)).toEqual(['newer-created', 'newer-earlier'])
  })

  it('keeps the trailing session overrides up to the cap', () => {
    expect(selectSessionOverrides([{ text: 'a' }, { text: 'b' }], 0)).toEqual([])
    expect(selectSessionOverrides([{ text: 'a' }, { text: 'b' }], 8).map(item => item.text))
      .toEqual(['a', 'b'])
    expect(selectSessionOverrides(
      [{ text: 'a' }, { text: 'b' }, { text: 'c' }],
      2,
    ).map(item => item.text)).toEqual(['b', 'c'])
  })
})
