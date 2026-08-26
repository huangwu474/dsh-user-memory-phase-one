/**
 * Keyless assembled-app snapshot: save_memory becomes a runtime-context fact.
 * @module user-memory-snapshot
 */

import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { type SessionEvent } from '@deepseek-ai/dsh-session'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'

const driver = fileURLToPath(new URL('./fixtures/memory/user-memory/driver.ts', import.meta.url))
const configPath = fileURLToPath(new URL('./fixtures/memory/user-memory/cordis.yml', import.meta.url))
const repoTsconfig = fileURLToPath(new URL('../../../tsconfig.json', import.meta.url))

async function jsonlFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return jsonlFiles(path)
    return entry.isFile() && entry.name.endsWith('.jsonl') ? [path] : []
  }))
  return nested.flat()
}

describe('user-memory', () => {
  it('logs save_memory and injects the fact through the runtime-context snapshot', async () => {
    let events: SessionEvent[] = []
    const { stderr } = await runLoaderSmoke({
      label: 'user-memory headless snapshot',
      tempDirPrefix: 'user-memory-snapshot-',
      binScript: driver,
      libBinScript: driver,
      configPath,
      tsconfigPath: repoTsconfig,
      inspect: async (cwd) => {
        const logs = await jsonlFiles(join(cwd, '.sessions'))
        expect(logs).toHaveLength(1)
        const lines = (await readFile(logs[0] as string, 'utf8')).trimEnd().split('\n')
        events = lines.slice(1).map(line => JSON.parse(line) as SessionEvent)
      },
    })
    expect(stderr).not.toContain('UNHANDLED')
    expect(events.some(event => event.type === 'tool/call' && event.data.name === 'save_memory')).toBe(true)
    const snapshots = events.filter((event): event is SessionEvent<'user/message'> =>
      event.type === 'user/message'
      && event.data.source.kind === 'plugin'
      && event.data.source.plugin === '@deepseek-ai/dsh-system-prompt')
    const withFact = snapshots.filter(event => event.data.content
      .some(block => block.type === 'text' && block.text.includes('User is vegetarian.')))
    expect(withFact.length).toBeGreaterThan(0)
    expect(withFact[0]?.data.source).toMatchObject({
      kind: 'plugin',
      plugin: '@deepseek-ai/dsh-system-prompt',
      form: 'snapshot',
    })
    const factLine = withFact[0]?.data.content
      .flatMap(block => block.type === 'text' ? block.text.split('\n') : [])
      .find(line => line.includes('User is vegetarian.'))
    expect(factLine).toMatch(
      /^- \[([0-9a-f]{12}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\] User is vegetarian\.$/,
    )
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)
})
