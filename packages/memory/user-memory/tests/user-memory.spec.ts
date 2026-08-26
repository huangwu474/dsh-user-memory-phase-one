import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import {
  assemble,
  booleanField,
  boot,
  exec,
  readSaved,
  resultText,
  savedTable,
  snapshotMemoryId,
  stringField,
  stubAgent,
} from './harness.ts'
import * as plugin from '../src/index.ts'
import { MEMORY_POLICY } from '../src/render.ts'

let dispose: (() => Promise<void>) | undefined

afterEach(async () => {
  await dispose?.()
  dispose = undefined
})

async function savedSnapshot(ctx: Parameters<typeof assemble>[0]): Promise<string> {
  return (await assemble(ctx)).contexts.find(item => item.name === 'user-memory:saved')?.text ?? ''
}

describe('dsh-user-memory', () => {
  it('has the namespace-plugin export shape (no stray default)', () => {
    expect('default' in plugin).toBe(false)
    expect(plugin.name).toBe('user-memory')
    expect(plugin.inject).toEqual(['tools', 'systemPrompt', 'storageDomain'])
    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(plugin) as Record<string, unknown>
    expect(unwrapped).toBe(plugin)
    expect(typeof unwrapped.apply).toBe('function')
  })

  it('saves two different facts without overlaying either', async () => {
    const harness = await boot()
    dispose = harness.dispose
    const first = await exec(harness.ctx, 'save_memory', { text: 'User is vegetarian.' })
    const second = await exec(harness.ctx, 'save_memory', { text: 'User lives in Beijing.' })
    expect(first.isError).toBe(false)
    expect(second.isError).toBe(false)
    const firstId = stringField(first, 'id')
    const secondId = stringField(second, 'id')
    expect(firstId).toMatch(/^[0-9a-f]{12}$/)
    expect(resultText(first)).toContain(`Saved durable fact ${firstId}`)
    expect(firstId).not.toBe(secondId)
    expect(savedTable(harness.ctx).size).toBe(2)
  })

  it('deduplicates identical text instead of inserting a second row', async () => {
    const harness = await boot()
    dispose = harness.dispose
    const first = await exec(harness.ctx, 'save_memory', { text: 'User is vegetarian.' })
    const second = await exec(harness.ctx, 'save_memory', { text: 'User is vegetarian.' })
    expect(first.isError).toBe(false)
    expect(second.isError).toBe(false)
    const firstId = stringField(first, 'id')
    expect(booleanField(second, 'updated')).toBe(true)
    expect(resultText(second)).toContain(`Updated durable fact ${stringField(second, 'id')}`)
    expect(stringField(second, 'id')).toBe(firstId)
    expect(savedTable(harness.ctx).size).toBe(1)
  })

  it('updates a fact by id and reports not_found for an unknown id', async () => {
    const harness = await boot()
    dispose = harness.dispose
    const saved = await exec(harness.ctx, 'save_memory', { text: 'Prefers aisle seats.' })
    const id = stringField(saved, 'id')
    const updated = await exec(harness.ctx, 'update_memory', {
      memory_id: id,
      text: 'Prefers window seats.',
    })
    expect(updated.isError).toBe(false)
    expect(updated.value).toEqual({ ok: true, id })
    expect(readSaved(harness.ctx, id)?.text).toBe('Prefers window seats.')
    const missing = await exec(harness.ctx, 'update_memory', {
      memory_id: 'mem_missing',
      text: 'gone',
    })
    expect(missing.isError).toBe(false)
    expect(missing.value).toEqual({ ok: false, error: 'not_found' })
    expect(resultText(missing)).toContain('not found')
    const same = await exec(harness.ctx, 'update_memory', {
      memory_id: id,
      text: 'Prefers window seats.',
    })
    expect(same.isError).toBe(false)
    expect(same.value).toEqual({ ok: true, id })
  })

  it('rejects an update that would duplicate another fact\'s text', async () => {
    const harness = await boot()
    dispose = harness.dispose
    const first = await exec(harness.ctx, 'save_memory', { text: 'x' })
    const second = await exec(harness.ctx, 'save_memory', { text: 'y' })
    const yId = stringField(second, 'id')
    const conflict = await exec(harness.ctx, 'update_memory', { memory_id: yId, text: 'x' })
    expect(conflict.isError).toBe(false)
    expect(conflict.value).toEqual({ ok: false, error: 'duplicate_text' })
    expect(resultText(conflict)).toContain('already has that text')
    expect(readSaved(harness.ctx, yId)?.text).toBe('y')
    expect(readSaved(harness.ctx, stringField(first, 'id'))?.text).toBe('x')
  })

  it('deletes a fact using the id from the injected snapshot', async () => {
    const harness = await boot()
    dispose = harness.dispose
    const saved = await exec(harness.ctx, 'save_memory', { text: 'User is vegetarian.' })
    expect(saved.isError).toBe(false)
    const body = await savedSnapshot(harness.ctx)
    const id = snapshotMemoryId(body, 'User is vegetarian.')
    expect(id).toMatch(/^[0-9a-f]{12}$/)
    const missing = await exec(harness.ctx, 'delete_memory', { memory_id: 'mem_missing' })
    expect(missing.isError).toBe(false)
    expect(missing.value).toEqual({ ok: false, error: 'not_found' })
    const deleted = await exec(harness.ctx, 'delete_memory', { memory_id: id })
    expect(deleted.isError).toBe(false)
    expect(await savedSnapshot(harness.ctx)).not.toContain('User is vegetarian.')
  })

  it('keeps session overrides out of the domain table and injects them for that agent', async () => {
    const harness = await boot()
    dispose = harness.dispose
    const agent = stubAgent()
    const result = await exec(
      harness.ctx,
      'save_session_override',
      { text: 'Window seat this trip.' },
      agent,
    )
    expect(result.isError).toBe(false)
    expect(savedTable(harness.ctx).size).toBe(0)
    const own = await assemble(harness.ctx, agent)
    expect(own.contexts.find(item => item.name === 'user-memory:session')?.text).toContain('Window seat this trip.')
    const other = await assemble(harness.ctx, stubAgent('other'))
    expect(other.contexts.find(item => item.name === 'user-memory:session')?.text ?? '').toBe('')
    const later = await assemble(harness.ctx, agent)
    expect(later.contexts.find(item => item.name === 'user-memory:session')?.text).toContain('Window seat this trip.')
  })

  it('rejects a session override without an owning agent', async () => {
    const harness = await boot()
    dispose = harness.dispose
    const result = await exec(harness.ctx, 'save_session_override', { text: 'this trip window' })
    expect(result.isError).toBe(true)
    expect(resultText(result)).toContain('owning agent')
  })

  it('caps injected saved memories from Config', async () => {
    const harness = await boot({ maxSavedMemories: 1 })
    dispose = harness.dispose
    await exec(harness.ctx, 'save_memory', { text: 'Older fact.' })
    await exec(harness.ctx, 'save_memory', { text: 'Newer fact.' })
    const body = await savedSnapshot(harness.ctx)
    expect(body).toContain('Newer fact.')
    expect(body).not.toContain('Older fact.')
  })

  it('caps injected session overrides from Config', async () => {
    const harness = await boot({ maxSessionOverrides: 1 })
    dispose = harness.dispose
    const agent = stubAgent()
    await exec(harness.ctx, 'save_session_override', { text: 'First override.' }, agent)
    await exec(harness.ctx, 'save_session_override', { text: 'Second override.' }, agent)
    const body = (await assemble(harness.ctx, agent)).contexts
      .find(item => item.name === 'user-memory:session')?.text ?? ''
    expect(body).toContain('Second override.')
    expect(body).not.toContain('First override.')
  })

  it('registers the memory policy before the persona slot', async () => {
    const harness = await boot()
    dispose = harness.dispose
    const assembly = await assemble(harness.ctx)
    const policy = assembly.sections.find(item => item.name === 'user-memory:policy')
    expect(policy?.text).toBe(MEMORY_POLICY)
    expect(policy?.text).toContain('this-session overrides')
    expect(policy?.text).toContain('Copy <id> into update_memory and delete_memory')
  })

  it('unregisters tools and prompt contributions when the fiber is disposed (HMR-safety)', async () => {
    const harness = await boot()
    dispose = harness.dispose
    expect(harness.ctx.tools.schemas().some(item => item.name === 'save_memory')).toBe(true)
    expect((await assemble(harness.ctx)).sections.some(item => item.name === 'user-memory:policy')).toBe(true)
    await harness.memoryFiber.dispose()
    expect(harness.ctx.tools.schemas().some(item => item.name === 'save_memory')).toBe(false)
    const after = await assemble(harness.ctx)
    expect(after.sections.some(item => item.name === 'user-memory:policy')).toBe(false)
    expect(after.contexts.some(item => item.name === 'user-memory:saved')).toBe(false)
    expect(after.contexts.some(item => item.name === 'user-memory:session')).toBe(false)
  })

  it('reloads saved memories from storage after a process restart and deletes by snapshot id', async () => {
    const first = await boot()
    const saved = await exec(first.ctx, 'save_memory', { text: 'User is vegetarian.' })
    expect(saved.isError).toBe(false)
    await first.dispose({ keepRoot: true })
    const second = await boot({ root: first.root })
    dispose = second.dispose
    const body = await savedSnapshot(second.ctx)
    expect(body).toContain('User is vegetarian.')
    expect(savedTable(second.ctx).size).toBe(1)
    const id = snapshotMemoryId(body, 'User is vegetarian.')
    const deleted = await exec(second.ctx, 'delete_memory', { memory_id: id })
    expect(deleted.isError).toBe(false)
    expect(await savedSnapshot(second.ctx)).not.toContain('User is vegetarian.')
  })

  it('loads a UUID-keyed row with extra fields, updates it, and deletes it from the snapshot id', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-user-memory-uuid-'))
    const uuid = '550e8400-e29b-41d4-a716-446655440000'
    await mkdir(join(root, 'storages'), { recursive: true })
    await writeFile(join(root, 'storages', 'user_memory.json'), `${JSON.stringify({
      unit: { name: 'user_memory', version: 1 },
      global: null,
      tables: {
        saved_memories: {
          [uuid]: {
            text: 'User is vegetarian.',
            lastUpdateDate: '2026-01-01',
            keywords: ['diet'],
            source: 'model',
            createdAt: '2026-01-01T00:00:00.000Z',
          },
        },
      },
    }, null, 2)}\n`)
    const harness = await boot({ root })
    dispose = harness.dispose
    const record = readSaved(harness.ctx, uuid)
    expect(record).toEqual({
      text: 'User is vegetarian.',
      lastUpdateDate: '2026-01-01',
      createdAt: '2026-01-01T00:00:00.000Z',
    })
    const body = await savedSnapshot(harness.ctx)
    expect(snapshotMemoryId(body, 'User is vegetarian.')).toBe(uuid)
    const updated = await exec(harness.ctx, 'update_memory', {
      memory_id: uuid,
      text: 'User prefers window seats.',
    })
    expect(updated.isError).toBe(false)
    expect(updated.value).toEqual({ ok: true, id: uuid })
    const afterUpdate = readSaved(harness.ctx, uuid)
    expect(afterUpdate?.text).toBe('User prefers window seats.')
    expect(afterUpdate?.createdAt).toBe('2026-01-01T00:00:00.000Z')
    expect(afterUpdate).toEqual({
      text: 'User prefers window seats.',
      lastUpdateDate: afterUpdate?.lastUpdateDate,
      createdAt: '2026-01-01T00:00:00.000Z',
    })
    const updatedBody = await savedSnapshot(harness.ctx)
    expect(updatedBody).toContain('User prefers window seats.')
    expect(updatedBody).not.toContain('User is vegetarian.')
    const deleted = await exec(harness.ctx, 'delete_memory', { memory_id: uuid })
    expect(deleted.isError).toBe(false)
    expect(await savedSnapshot(harness.ctx)).not.toContain('User prefers window seats.')
  })

  it('does not persist session overrides across restart', async () => {
    const first = await boot()
    const agent = stubAgent()
    await exec(first.ctx, 'save_session_override', { text: 'Window this trip.' }, agent)
    await first.dispose({ keepRoot: true })
    const second = await boot({ root: first.root })
    dispose = second.dispose
    expect(savedTable(second.ctx).size).toBe(0)
    const body = (await assemble(second.ctx, stubAgent())).contexts
      .find(item => item.name === 'user-memory:session')?.text ?? ''
    expect(body).toBe('')
  })

  it('rejects empty text', async () => {
    const harness = await boot()
    dispose = harness.dispose
    const empty = await exec(harness.ctx, 'save_memory', { text: '   ' })
    expect(empty.isError).toBe(true)
    expect(resultText(empty)).toContain('non-empty')
  })

  it('fails loud when a cap is not an integer or is below one', async () => {
    await expect(boot({ maxSavedMemories: 1.5 })).rejects.toThrow()
    await expect(boot({ maxSessionOverrides: 0 })).rejects.toThrow()
  })

  it('presents calls as generic cards from args only', async () => {
    const harness = await boot()
    dispose = harness.dispose
    const save = harness.ctx.tools.get('save_memory')
    expect(save?.presentCall?.({ text: 'User is vegetarian.' })).toEqual({
      card: 'generic',
      title: 'Save memory',
      kind: 'other',
      rawInput: 'User is vegetarian.',
    })
    expect(harness.ctx.tools.get('update_memory')?.presentCall?.({
      memory_id: 'mem_1',
      text: 'x',
    })).toEqual({
      card: 'generic',
      title: 'Update memory',
      kind: 'other',
      rawInput: 'mem_1',
    })
    expect(harness.ctx.tools.get('delete_memory')?.presentCall?.({ memory_id: 'mem_1' })).toEqual({
      card: 'generic',
      title: 'Forget memory',
      kind: 'delete',
      rawInput: 'mem_1',
    })
    expect(harness.ctx.tools.get('save_session_override')?.presentCall?.({
      text: 'window this trip',
    })).toEqual({
      card: 'generic',
      title: 'Session override',
      kind: 'other',
      rawInput: 'window this trip',
    })
  })
})
