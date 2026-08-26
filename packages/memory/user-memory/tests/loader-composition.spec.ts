import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { CallId } from '@deepseek-ai/dsh-llm'
import * as UserMemory from '../src/index.ts'
import { stubAgent } from './harness.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function bootLoader(configLines: readonly string[]): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-user-memory-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-storage'",
    "- name: '@deepseek-ai/dsh-storage-json'",
    '  config:',
    `    root: ${JSON.stringify(join(root, 'storages'))}`,
    "- name: '@deepseek-ai/dsh-storage-domain'",
    '  config:',
    '    backend: json',
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-user-memory'",
    ...configLines.length > 0 ? ['  config:', ...configLines] : [],
    '',
  ].join('\n'))
  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-storage', Storage],
    ['@deepseek-ai/dsh-storage-json', StorageJson],
    ['@deepseek-ai/dsh-storage-domain', StorageDomain],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-user-memory', UserMemory],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  return ctx
}

describe('user-memory real Loader composition through cordis.yml', () => {
  it('registers tools under default config', async () => {
    const ctx = await bootLoader([])
    const names = ctx.tools.schemas().map(item => item.name)
    expect(names).toEqual(expect.arrayContaining([
      'save_memory',
      'update_memory',
      'delete_memory',
      'save_session_override',
    ]))
  }, 30_000)

  it('honors maxSavedMemories from cordis.yml', async () => {
    const ctx = await bootLoader(['    maxSavedMemories: 1', '    maxSessionOverrides: 8'])
    const owner = stubAgent()
    await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('one'),
      name: 'save_memory',
      arguments: { text: 'First fact.' },
      agent: owner,
    })
    await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('two'),
      name: 'save_memory',
      arguments: { text: 'Second fact.' },
      agent: owner,
    })
    const assembly = await ctx.systemPrompt.assemble({})
    const body = assembly.contexts.find(item => item.name === 'user-memory:saved')?.text ?? ''
    expect(body).toContain('Second fact.')
    expect(body).not.toContain('First fact.')
  }, 30_000)
})
