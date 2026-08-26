import type { Context } from '@deepseek-ai/cordis'
import { CallId, LlmAdapter, type StreamChunk } from '@deepseek-ai/dsh-llm'

/** Deterministic adapter: first request saves a fact, later requests stop. */
class UserMemoryMockAdapter extends LlmAdapter {
  private calls = 0

  async * stream(): AsyncIterable<StreamChunk> {
    this.calls += 1
    if (this.calls === 1) {
      const argumentsDelta = JSON.stringify({ text: 'User is vegetarian.' })
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id: CallId('mem-save-1'), name: 'save_memory', argumentsDelta }
      yield {
        type: 'block-end',
        index: 0,
        block: { type: 'tool-call', id: CallId('mem-save-1'), name: 'save_memory', arguments: argumentsDelta },
      }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    const text = 'Noted the durable fact.'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

export const name = 'user-memory-mock-llm'
export const inject = ['llm']

/** Register the test-only `user-memory-mock` adapter. */
export function apply(ctx: Context): void {
  ctx.llm.registerAdapter(['user-memory-mock'], new UserMemoryMockAdapter())
}
