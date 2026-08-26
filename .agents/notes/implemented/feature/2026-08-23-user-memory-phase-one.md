# Agent Note: User memory phase one — durable notepad and this-session overrides

Status: implemented

English | [中文](2026-08-23-user-memory-phase-one.zh.md)

## Problem

The harness had no first-party way for a model to remember durable user facts across turns and processes, or to honor this-trip overrides without writing them into long-term storage. Product memory therefore could not follow the ChatGPT split of notepad versus this-chat overrides without an extra plugin.

## Decision

`@deepseek-ai/dsh-user-memory` is a single function plugin at `packages/memory/user-memory/`. It is opt-in and is not in shipped defaults. A composition that loads it must already provide `ctx.storageDomain`.

The plugin opens domain `user_memory` version 1 with one table, `saved_memories`. Records are `{ text, lastUpdateDate, createdAt }` keyed by a branded `MemoryId`. Newly minted ids are 12 lowercase hex characters; `allocateMemoryId` retries on `table.get` occupancy and throws after a bounded number of collisions. UUID keys already on disk remain valid and addressable. Identical `text` updates the existing row. `update_memory` returns `{ ok: false, error: 'duplicate_text' }` when another id already holds that text. This-session overrides live in a `WeakMap` keyed by `Agent` and are never written to the domain. `maxSessionOverrides` is an integer ≥ 1.

Four tools (`save_memory`, `update_memory`, `delete_memory`, `save_session_override`) register on `ctx.tools`. Durable facts inject as `- [<id>] <text>` so `update_memory` and `delete_memory` can copy the id from the snapshot; the policy section states that. `user-memory:policy` is a system-prompt section at order `-20`. `user-memory:session` and `user-memory:saved` register as global `systemPrompt.context()` contributions. Session-override text reads `AssembleContext.agent` (the same pattern as `dsh-user-approval`) and looks up a `WeakMap` keyed by that `Agent`. Empty lists contribute nothing.

Session overrides are not registered on `agent.ctx`. Subagent scoped `systemPrompt.context()` works because the child plugin owns that fiber; this plugin does not create agents, and a contribution registered onto `agent.ctx` would survive this plugin's fiber dispose, breaking the HMR-safety rule. Global registration plus `context.agent` unwinds with the plugin fiber.

No `SessionEventMap` member is added. Agent-loop `preStep` already materializes `systemPrompt.context()` as a sourced `user/message` (`plugin` `@deepseek-ai/dsh-system-prompt`, `form: 'snapshot'`) when the joined snapshot text changes, and tool execution already logs `tool/call` plus `tool/result`. Evidence: `joinContextSections` in `packages/core/system-prompt/src/index.ts` prefixes `Current runtime context. This snapshot supersedes earlier runtime-context snapshots.`; `RuntimeContextProjection.project` in `packages/core/agent-loop/src/runtime-context.ts` returns a sourced user message only when that text changed; `preStep` in `packages/core/agent-loop/src/agent.ts` appends it after claimed inbox items via `session.append('user/message', ...)`.

There is no user-knowledge table and no recent-conversation archive. The harness has no session-end hook that could own an offline consolidation pass, and unused tables would have no current consumer.

## Alternatives considered

**Split Service Definition / Provider / Consumer.** Rejected because there is one implementation and one consumption path. The same cut is recorded for [`dsh-mcp-client`](2026-07-07-mcp-client-plugin.md). A second memory backend would justify a seam later.

**Register `user-memory:session` on each `agent.ctx` so scoped contributions shadow the global.** Rejected because this plugin does not own agent fibers. A registration on `agent.ctx` would outlive this plugin's dispose and fail the HMR-safety test. `AssembleContext.agent` plus a `WeakMap` matches `dsh-user-approval`.

**New session events for injected facts.** Rejected because runtime-context projection already appends the snapshot as a sourced user message, so a second event would duplicate model-visible input.

**Placeholders for synthesized knowledge and chat-history archive.** Rejected because `packages/AGENTS.md` requires a current owner and need for every abstraction.

**Keep `keywords` or `source` on the durable record without a reader or writer.** Rejected for the same owner-and-need rule. `z.object()` strips unknown keys, so earlier rows that stored those fields load without a domain-version bump.

**Mint UUIDs as snapshot ids.** Rejected because fifty facts would spend about 1800 characters on ids alone. Collision-checked 12-hex ids keep the snapshot copyable.

**Treat `maxSessionOverrides: 0` as a silent disable that still returns `ok` from `save_session_override`.** Rejected: a successful tool result that never injects is not enforcement. The cap is an integer ≥ 1 and fails at load when it is 0.

**Bare XML blocks copied from ChatGPT Memory (`<model_set_context>`).** Rejected because this runtime wraps context in `Current runtime context. This snapshot supersedes earlier runtime-context snapshots.` and attributes named sections on the snapshot source.

**Auto-route "this trip" text from `save_memory` into session overrides.** Rejected: the four tools are the enforcement point; the policy section tells the model which tool to call.

## Consequences

Compositions that want memory must list storage hub, a KV backend, storage-domain, and this plugin. Headless and CLI shipped patches do not include them; the web-app patch already has the storage stack and can add this plugin later as its own overlay. Phase two, if it happens, needs a real session-end or maintenance hook before it can add tables.

## Testing

Package tests cover tool identity, text dedup, `duplicate_text`, snapshot-id delete after restart, and UUID-key update and delete with extra stored fields stripped. They also cover id collision retry, caps, HMR disposal, and JSON-backend restart. Loader composition boots a real `cordis.yml`. The keyless `user-memory` snapshot in `examples/headless-agent/tests/user-memory.snapshot.ts` checks that `save_memory` lands in the session log and that the later runtime-context snapshot contains the fact on a `- [id] text` line.
