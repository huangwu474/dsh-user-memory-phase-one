import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { Inbox, assembleContextFor, type Agent } from '@deepseek-ai/dsh-agent'
import { CallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, type JsonValue } from '@deepseek-ai/dsh-session'
import * as UserMemory from '../src/index.ts'
import type { Config } from '../src/index.ts'
import { userMemoryDomainSpec, type SavedMemoryRecord } from '../src/spec.ts'
import { MemoryId } from '../src/ids.ts'

const signal = new AbortController().signal
let call = 0

/** Build a stub agent that owns a real session. */
export function stubAgent(id = 'memory-agent'): Agent {
  const session = Session.create(SessionId(id))
  const scope = { ctx: new Context() } as unknown as Agent['ctx']
  return {
    id: SessionId(id),
    options: {},
    session,
    inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
    status: 'idle',
    ctx: scope,
    followup: () => {},
    steer: () => {},
    inject: () => {},
    send: () => {},
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
}

/** Open the live saved-memories table on a booted context. */
export function savedTable(ctx: Context) {
  const domain = ctx.storageDomain.get(userMemoryDomainSpec.name)
  if (domain === undefined) throw new Error('user_memory domain is not open')
  return domain.table('saved_memories')
}

/** Read a saved-memory record by id. */
export function readSaved(ctx: Context, id: string): SavedMemoryRecord | undefined {
  return savedTable(ctx).get(MemoryId(id)) as SavedMemoryRecord | undefined
}

/**
 * Boot storage, prompt, tools, and user-memory over a temporary JSON root.
 * @param config - Optional injection caps.
 * @returns context, root, and dispose.
 */
export async function boot(config?: Partial<Config> & { root?: string }): Promise<{
  ctx: Context
  root: string
  memoryFiber: Fiber
  dispose: (options?: { keepRoot?: boolean }) => Promise<void>
}> {
  const root = config?.root ?? await mkdtemp(join(tmpdir(), 'dsh-user-memory-'))
  const ctx = new Context()
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root: join(root, 'storages') })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const memoryFiber = await ctx.plugin(UserMemory, {
    maxSavedMemories: config?.maxSavedMemories ?? 50,
    maxSessionOverrides: config?.maxSessionOverrides ?? 8,
  })
  return {
    ctx,
    root,
    memoryFiber,
    dispose: async (options) => {
      await ctx.fiber.dispose()
      if (options?.keepRoot !== true) await rm(root, { recursive: true, force: true })
    },
  }
}

/** Execute a registered memory tool. */
export function exec(
  ctx: Context,
  name: string,
  args: Record<string, unknown>,
  agent?: Agent,
) {
  return ctx.tools.execute({
    signal,
    callId: CallId(`mem-${++call}`),
    name,
    arguments: args,
    ...agent === undefined ? {} : { agent },
  })
}

/** Assemble the prompt for one agent. */
export function assemble(ctx: Context, agent?: Agent) {
  return agent === undefined
    ? ctx.systemPrompt.assemble({})
    : ctx.systemPrompt.assemble(assembleContextFor(agent))
}

/** Concatenate text blocks from a tool result. */
export function resultText(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

/**
 * Read a durable-fact id from a rendered snapshot line, not from a tool result.
 * @param body - `user-memory:saved` context text.
 * @param text - Exact fact sentence.
 * @returns the `[<id>]` value on that line.
 */
export function snapshotMemoryId(body: string, text: string): string {
  const prefix = '- ['
  const suffix = `] ${text}`
  for (const line of body.split('\n')) {
    if (line.startsWith(prefix) && line.endsWith(suffix)) {
      return line.slice(prefix.length, line.length - suffix.length)
    }
  }
  throw new Error(`no snapshot id for ${JSON.stringify(text)}`)
}

/**
 * Read a string field from a successful object-valued tool result.
 * @param result - Tool execution outcome.
 * @param key - Canonical object key.
 * @returns the string field.
 */
export function stringField(result: { isError: boolean; value?: JsonValue }, key: string): string {
  if (result.isError) throw new Error('expected a successful tool result')
  const value = result.value
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('expected an object canonical value')
  }
  const field = value[key]
  if (typeof field !== 'string') throw new Error(`expected string field ${key}`)
  return field
}

/**
 * Read a boolean field from a successful object-valued tool result.
 * @param result - Tool execution outcome.
 * @param key - Canonical object key.
 * @returns the boolean field.
 */
export function booleanField(result: { isError: boolean; value?: JsonValue }, key: string): boolean {
  if (result.isError) throw new Error('expected a successful tool result')
  const value = result.value
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('expected an object canonical value')
  }
  const field = value[key]
  if (typeof field !== 'boolean') throw new Error(`expected boolean field ${key}`)
  return field
}
