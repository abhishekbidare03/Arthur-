/**
 * Client for the local backend.
 *
 * Uses `fetch` + `ReadableStream` rather than `EventSource`, because the chat
 * request is a POST with a JSON body and `EventSource` can only issue GETs.
 */

import type { Tier } from './types'

export interface GenerationStats {
  model: string
  timeToFirstTokenMs: number
  totalMs: number
  promptTokens: number
  outputTokens: number
  tokensPerSecond: number
  thinkingTokens: number
  doneReason: string
  /** Older turns dropped to fit the context budget. */
  droppedMessages: number
}

export type ErrorCode =
  | 'ollama_unreachable'
  | 'model_missing'
  | 'empty_response'
  | 'thinking_truncated'
  | 'aborted'
  | 'unknown'

export type ChatEvent =
  | { type: 'thinking'; delta: string }
  | { type: 'content'; delta: string }
  | { type: 'done'; stats: GenerationStats }
  | { type: 'error'; code: ErrorCode; message: string; detail?: string }

export interface HealthStatus {
  running: boolean
  version?: string
  installed?: string[]
  error?: string
}

export async function checkHealth(): Promise<HealthStatus> {
  try {
    const res = await fetch('/api/health')
    if (!res.ok) return { running: false, error: `HTTP ${res.status}` }
    return (await res.json()) as HealthStatus
  } catch (error) {
    // The *backend* is unreachable, which is a different failure from Ollama
    // being down, but the user-facing remedy is the same: start the app properly.
    return { running: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export interface StreamChatInput {
  messages: { role: 'user' | 'assistant'; content: string }[]
  tier: Tier
}

/** Yields events as the backend forwards them. */
export async function* streamChat(
  input: StreamChatInput,
  signal: AbortSignal,
): AsyncGenerator<ChatEvent> {
  let res: Response
  try {
    res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
      signal,
    })
  } catch (error) {
    if (signal.aborted) return
    yield {
      type: 'error',
      code: 'ollama_unreachable',
      message: 'Could not reach the Arthur backend.',
      detail: error instanceof Error ? error.message : String(error),
    }
    return
  }

  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => '')
    yield { type: 'error', code: 'unknown', message: `Backend returned HTTP ${res.status}.`, detail }
    return
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })

      // SSE frames are separated by a blank line; a network chunk can split one
      // in half, so the trailing partial frame is carried forward.
      const frames = buffer.split('\n\n')
      buffer = frames.pop() ?? ''

      for (const frame of frames) {
        const line = frame.split('\n').find((l) => l.startsWith('data: '))
        if (!line) continue
        try {
          yield JSON.parse(line.slice(6)) as ChatEvent
        } catch {
          // Ignore a malformed frame rather than killing a live stream.
        }
      }
    }
  } catch (error) {
    if (!signal.aborted) {
      yield {
        type: 'error',
        code: 'unknown',
        message: 'The connection dropped mid-response.',
        detail: error instanceof Error ? error.message : String(error),
      }
    }
  } finally {
    reader.cancel().catch(() => {})
  }
}
