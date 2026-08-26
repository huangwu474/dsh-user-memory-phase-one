/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-user-memory`.
 * @module @deepseek-ai/dsh-user-memory/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { DomainChanged } from '@deepseek-ai/dsh-storage-domain'

const PACKAGE_NAME = '@deepseek-ai/dsh-user-memory'
const DOMAIN = 'user_memory'
const TABLE = 'saved_memories'

function savedText(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  if (!('text' in value) || typeof value.text !== 'string') return undefined
  return value.text
}

/** Cordis companion plugin name. */
export const name = 'user-memory-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * Owned relationship: every durable write to `user_memory.saved_memories` is
 * visible on the live domain table at event emission, and no two rows share
 * `text`. A put whose key the table cannot read, a put that duplicates another
 * row's text, or a delete whose key is still present means a write path
 * bypassed `save_memory` / `update_memory` / `delete_memory`.
 */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  ctx.on('domain/changed', (change: DomainChanged) => {
    if (change.domain !== DOMAIN || change.table !== TABLE) return
    const domain = ctx.storageDomain.get(DOMAIN)
    if (domain === undefined) {
      return fail(`user-memory domain changed while domain '${DOMAIN}' is not open`)
    }
    const table = domain.table(TABLE)
    const record = table.get(change.key)
    switch (change.operation) {
      case 'deleted':
        if (record !== undefined) {
          return fail(`saved memory '${change.key}' was deleted while the live table still holds it`)
        }
        return
      case 'put': {
        const recordText = savedText(record)
        if (recordText === undefined) {
          return fail(`saved memory '${change.key}' landed durably but the live table has no record for it`)
        }
        for (const [key, other] of table.entries()) {
          if (key !== change.key && savedText(other) === recordText) {
            return fail(`saved memory text is duplicated under '${key}' and '${change.key}'`)
          }
        }
        return
      }
      default:
        change satisfies never
    }
  }, { global: true })
}, { inject: ['storageDomain'] })

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
