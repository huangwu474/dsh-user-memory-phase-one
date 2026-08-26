/**
 * Opt-in user-memory plugin: durable saved facts plus this-session overrides.
 * Namespace plugin (named exports, no default).
 * @module @deepseek-ai/dsh-user-memory
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { allocateMemoryId, MemoryId } from './ids.ts'
import {
  MEMORY_POLICY,
  renderSavedMemories,
  renderSessionOverrides,
  selectSavedMemories,
  selectSessionOverrides,
  type SavedMemoryEntry,
  type SessionOverride,
} from './render.ts'
import { userMemoryDomainSpec, type SavedMemoryRecord } from './spec.ts'

export { allocateMemoryId, MemoryId } from './ids.ts'
export { userMemoryDomainSpec, savedMemoryRecord } from './spec.ts'
export type { SavedMemoryRecord } from './spec.ts'
export { MEMORY_POLICY, renderSavedMemories, renderSessionOverrides } from './render.ts'
export type { SavedMemoryEntry } from './render.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'user-memory'

/** Services required before this plugin can register tools, prompts, and its domain. */
export const inject = ['tools', 'systemPrompt', 'storageDomain']

/** Deployment-authored injection caps. */
export interface Config {
  /** Maximum durable facts injected into one runtime-context snapshot. */
  maxSavedMemories: number
  /** Maximum this-session overrides injected into one runtime-context snapshot. */
  maxSessionOverrides: number
}

/** Schemastery configuration. Non-integers fail at load. */
export const Config: z<Config> = z.object({
  maxSavedMemories: z.number().step(1).min(1).default(50),
  maxSessionOverrides: z.number().step(1).min(1).default(8),
})

function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}

function nowIso(): string {
  return new Date().toISOString()
}

function normalizeText(text: string): string {
  const trimmed = text.trim()
  if (trimmed.length === 0) throw new Error('text must be a non-empty string')
  return trimmed
}

function listRecords(table: KvTable<MemoryId, SavedMemoryRecord>): SavedMemoryEntry[] {
  return [...table.entries()]
}

function findByText(
  table: KvTable<MemoryId, SavedMemoryRecord>,
  text: string,
  except?: MemoryId,
): MemoryId | undefined {
  for (const [key, record] of table.entries()) {
    if (except !== undefined && key === except) continue
    if (record.text === text) return key
  }
  return undefined
}

/**
 * Open the domain, register tools and prompt contributions, and bind close to this fiber.
 * @param ctx - Plugin context.
 * @param config - Validated injection caps.
 * @returns resolution after the domain is open and contributions are registered.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const maxSaved = config.maxSavedMemories
  const maxOverrides = config.maxSessionOverrides
  const domain = await ctx.storageDomain.open(userMemoryDomainSpec)
  ctx.effect(() => () => domain.close(), 'user-memory.domainClose')
  const table = domain.table('saved_memories')
  const overrides = new WeakMap<Agent, SessionOverride[]>()

  const overridesOf = (agent: Agent | undefined): SessionOverride[] => {
    if (agent === undefined) return []
    const current = overrides.get(agent)
    if (current !== undefined) return current
    const created: SessionOverride[] = []
    overrides.set(agent, created)
    return created
  }

  ctx.systemPrompt.section({
    name: 'user-memory:policy',
    order: -20,
    text: MEMORY_POLICY,
  })
  ctx.systemPrompt.context({
    name: 'user-memory:saved',
    order: 50,
    text: () => renderSavedMemories(selectSavedMemories(listRecords(table), maxSaved)),
  })
  ctx.systemPrompt.context({
    name: 'user-memory:session',
    order: 40,
    text: context => renderSessionOverrides(
      selectSessionOverrides(overridesOf(context.agent), maxOverrides),
    ),
  })

  ctx.tools.register(defineTool({
    name: 'save_memory',
    description:
      'Save a durable user fact for future conversations. Use for lasting preferences or constraints the user asked to remember. Do not use for this-trip or this-time requests.',
    parameters: {
      text: {
        type: 'string',
        required: true,
        description: 'One durable sentence. Do not write "User said…".',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          id: { type: 'string' },
          updated: { type: 'boolean' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.updated === true ? `Updated durable fact ${value.id}.` : `Saved durable fact ${value.id}.`,
      }],
    },
    async execute(args) {
      const text = normalizeText(args.text)
      const existing = findByText(table, text)
      const id = existing ?? allocateMemoryId(candidate => table.get(candidate) !== undefined)
      const previous = existing === undefined ? undefined : table.get(existing)
      const record: SavedMemoryRecord = {
        text,
        lastUpdateDate: todayIso(),
        createdAt: previous?.createdAt ?? nowIso(),
      }
      await table.put(id, record)
      return { ok: true, id, updated: existing !== undefined }
    },
    presentCall: args => ({ card: 'generic', title: 'Save memory', kind: 'other', rawInput: args.text }),
  }))

  ctx.tools.register(defineTool({
    name: 'update_memory',
    description:
      'Correct an existing durable fact by id. Copy the id from the "[id]" prefix on a durable-facts snapshot line.',
    parameters: {
      memory_id: {
        type: 'string',
        required: true,
        description: 'Id of the durable fact to correct, copied from the snapshot "[id]" prefix.',
      },
      text: {
        type: 'string',
        required: true,
        description: 'Replacement durable sentence.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          id: { type: 'string' },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.ok
          ? `Updated durable fact ${value.id}.`
          : value.error === 'duplicate_text'
            ? 'Another durable fact already has that text.'
            : `Durable fact not found: ${value.error}.`,
      }],
    },
    async execute(args) {
      const id = MemoryId(args.memory_id.trim())
      const current = table.get(id)
      if (current === undefined) return { ok: false, error: 'not_found' }
      const text = normalizeText(args.text)
      if (findByText(table, text, id) !== undefined) return { ok: false, error: 'duplicate_text' }
      await table.put(id, {
        ...current,
        text,
        lastUpdateDate: todayIso(),
      })
      return { ok: true, id }
    },
    presentCall: args => ({ card: 'generic', title: 'Update memory', kind: 'other', rawInput: args.memory_id }),
  }))

  ctx.tools.register(defineTool({
    name: 'delete_memory',
    description:
      'Forget a durable fact by id. Copy the id from the "[id]" prefix on a durable-facts snapshot line.',
    parameters: {
      memory_id: {
        type: 'string',
        required: true,
        description: 'Id of the durable fact to forget, copied from the snapshot "[id]" prefix.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          id: { type: 'string' },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.ok ? `Forgot durable fact ${value.id}.` : `Durable fact not found: ${value.error}.`,
      }],
    },
    async execute(args) {
      const id = MemoryId(args.memory_id.trim())
      const deleted = await table.delete(id)
      return deleted ? { ok: true, id } : { ok: false, error: 'not_found' }
    },
    presentCall: args => ({ card: 'generic', title: 'Forget memory', kind: 'delete', rawInput: args.memory_id }),
  }))

  ctx.tools.register(defineTool({
    name: 'save_session_override',
    description:
      'Store a this-chat-only override such as a this-trip or this-time request. It is not a durable fact and does not persist after this conversation.',
    parameters: {
      text: {
        type: 'string',
        required: true,
        description: 'One this-session sentence.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          session: { type: 'boolean' },
        },
      },
      render: () => [{ type: 'text', text: 'Saved this-session override.' }],
    },
    execute(args, exec) {
      if (exec.agent === undefined) throw new Error('save_session_override requires an owning agent')
      const text = normalizeText(args.text)
      const list = overridesOf(exec.agent)
      list.push({ text })
      if (list.length > maxOverrides) list.splice(0, list.length - maxOverrides)
      return Promise.resolve({ ok: true, session: true })
    },
    presentCall: args => ({ card: 'generic', title: 'Session override', kind: 'other', rawInput: args.text }),
  }))
}
