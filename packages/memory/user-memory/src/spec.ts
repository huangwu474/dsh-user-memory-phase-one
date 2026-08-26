/**
 * User-memory domain declaration: one table of durable saved memories.
 * @module @deepseek-ai/dsh-user-memory/src/spec
 */

import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { MemoryId } from './ids.ts'

/** Durable shape of one saved-memory record. */
export const savedMemoryRecord = z.object({
  text: z.string().min(1),
  lastUpdateDate: z.string(),
  createdAt: z.string(),
})

/** One stored saved-memory record. */
export type SavedMemoryRecord = z.infer<typeof savedMemoryRecord>

/**
 * Domain spec: table `saved_memories` keyed by {@link MemoryId}.
 * Version 1: phase-one notepad only; no synthesized knowledge table.
 */
export const userMemoryDomainSpec = defineDomain({
  name: 'user_memory',
  version: 1,
  tables: {
    saved_memories: domainTable<MemoryId, SavedMemoryRecord>(savedMemoryRecord),
  },
})
