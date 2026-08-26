import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import type { DomainChanged } from '@deepseek-ai/dsh-storage-domain'
import * as companion from '../src/invariant.ts'
import type { SavedMemoryRecord } from '../src/spec.ts'

const sample: SavedMemoryRecord = {
  text: 'User is vegetarian.',
  lastUpdateDate: '2026-08-23',
  createdAt: '2026-08-23T00:00:00.000Z',
}

interface TableStub {
  get(id: string): unknown
  entries(): IterableIterator<[string, unknown]>
}

async function setup(table: TableStub | undefined): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(InvariantRegistry)
  ctx.provide('storageDomain', {
    get: (name: string) => {
      if (name !== 'user_memory' || table === undefined) return undefined
      return { table: () => table }
    },
  })
  await ctx.plugin(companion)
  return ctx
}

function fromRecords(records: Map<string, unknown>): TableStub {
  return {
    get: id => records.get(id),
    entries: () => records.entries(),
  }
}

const put = (key: string, value: SavedMemoryRecord = sample): DomainChanged => ({
  domain: 'user_memory',
  table: 'saved_memories',
  key,
  operation: 'put',
  value,
})

const deleted = (key: string): DomainChanged => ({
  domain: 'user_memory',
  table: 'saved_memories',
  key,
  operation: 'deleted',
})

describe('user-memory invariant', () => {
  it('exports the companion namespace without a default', () => {
    expect('default' in companion).toBe(false)
    expect(companion.name).toBe('user-memory-invariant')
    expect(companion.inject).toEqual(['invariants'])
  })

  it('accepts a put whose row is live and unique, and ignores foreign events', async () => {
    const ctx = await setup(fromRecords(new Map([['m1', sample]])))
    expect(() => { ctx.emit('domain/changed', put('m1')) }).not.toThrow()
    expect(() => {
      ctx.emit('domain/changed', { ...put('missing'), domain: 'other' })
    }).not.toThrow()
    expect(() => {
      ctx.emit('domain/changed', { ...put('missing'), table: 'other' })
    }).not.toThrow()
  })

  it('fails a put while the domain is not open', async () => {
    const ctx = await setup(undefined)
    expect(() => { ctx.emit('domain/changed', put('m1')) }).toThrow(/is not open/)
  })

  it('fails a put whose key the live table cannot read', async () => {
    const ctx = await setup(fromRecords(new Map()))
    expect(() => { ctx.emit('domain/changed', put('m1')) }).toThrow(/has no record/)
  })

  it('fails a put whose live row has no string text', async () => {
    const ctxNull = await setup(fromRecords(new Map([['m1', null]])))
    expect(() => { ctxNull.emit('domain/changed', put('m1')) }).toThrow(/has no record/)
    const ctxEmpty = await setup(fromRecords(new Map([['m1', {}]])))
    expect(() => { ctxEmpty.emit('domain/changed', put('m1')) }).toThrow(/has no record/)
    const ctxNumber = await setup(fromRecords(new Map([['m1', { text: 1 }]])))
    expect(() => { ctxNumber.emit('domain/changed', put('m1')) }).toThrow(/has no record/)
    const ctxString = await setup(fromRecords(new Map([['m1', 'nope']])))
    expect(() => { ctxString.emit('domain/changed', put('m1')) }).toThrow(/has no record/)
  })

  it('fails a put that duplicates another row\'s text', async () => {
    const ctx = await setup(fromRecords(new Map([
      ['m1', sample],
      ['m2', sample],
    ])))
    expect(() => { ctx.emit('domain/changed', put('m2')) }).toThrow(/duplicated/)
  })

  it('ignores a sibling row that is not a saved-memory record when checking uniqueness', async () => {
    const ctx = await setup(fromRecords(new Map<string, unknown>([
      ['m1', sample],
      ['junk', 1],
    ])))
    expect(() => { ctx.emit('domain/changed', put('m1')) }).not.toThrow()
  })

  it('accepts a delete after the live table dropped the key', async () => {
    const ctx = await setup(fromRecords(new Map()))
    expect(() => { ctx.emit('domain/changed', deleted('m1')) }).not.toThrow()
  })

  it('fails a delete whose key the live table still holds', async () => {
    const ctx = await setup(fromRecords(new Map([['m1', sample]])))
    expect(() => { ctx.emit('domain/changed', deleted('m1')) }).toThrow(/still holds/)
  })

  it('tolerates operations outside the closed union without failing falsely', async () => {
    const ctx = await setup(fromRecords(new Map([['m1', sample]])))
    expect(() => {
      ctx.emit('domain/changed', {
        domain: 'user_memory',
        table: 'saved_memories',
        key: 'm1',
        operation: 'exotic',
      } as unknown as DomainChanged)
    }).not.toThrow()
  })
})
