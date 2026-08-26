/**
 * Branded saved-memory id and its factory.
 * @module @deepseek-ai/dsh-user-memory/src/ids
 */

import { randomBytes } from 'node:crypto'
import type { Branded } from '@deepseek-ai/dsh-brand'

/** Opaque id of one durable saved memory. */
export type MemoryId = Branded<'MemoryId'>

/** Byte length of a newly allocated id (12 lowercase hex characters). */
export const MEMORY_ID_BYTE_LENGTH = 6

/** Attempts before allocation fails loud rather than looping. */
export const MEMORY_ID_ALLOCATE_ATTEMPTS = 16

/**
 * Brand a string as a {@link MemoryId}.
 * @param id - Raw memory id.
 * @returns the same string, branded at compile time.
 */
export function MemoryId(id: string): MemoryId {
  return id as MemoryId
}

/**
 * Allocate a unique 12-character hex id. Existing UUID keys stay valid; this
 * only mints new ids.
 * @param occupied - True when the candidate is already a table key.
 * @param entropy - Byte source; production uses `randomBytes`.
 * @returns a branded id that `occupied` rejected.
 */
export function allocateMemoryId(
  occupied: (id: MemoryId) => boolean,
  entropy: (size: number) => Uint8Array = size => randomBytes(size),
): MemoryId {
  for (let attempt = 0; attempt < MEMORY_ID_ALLOCATE_ATTEMPTS; attempt++) {
    const id = MemoryId(Buffer.from(entropy(MEMORY_ID_BYTE_LENGTH)).toString('hex'))
    if (!occupied(id)) return id
  }
  throw new Error(
    `user-memory: could not allocate a unique memory id after ${MEMORY_ID_ALLOCATE_ATTEMPTS} attempts`,
  )
}
