#!/usr/bin/env node
/** Test driver that sends two turns through one Headless Loader composition. */

import { boot, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import { runFixtureTurn } from '@deepseek-ai/dsh-loader-smoke'

const configPath = process.argv[2]
if (configPath === undefined) throw new Error('user-memory driver requires a config path')

const ctx = await boot('user-memory-snapshot', resolveConfigPath(configPath, undefined))
try {
  await runFixtureTurn(ctx, { task: 'Remember that I am vegetarian.' })
  await runFixtureTurn(ctx, { task: 'What dietary constraint should you honor?' })
} finally {
  await ctx.fiber.dispose()
}
