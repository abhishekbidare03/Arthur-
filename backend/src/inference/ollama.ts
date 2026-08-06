/**
 * Ollama implementation of the inference boundary.
 *
 * Talks to the tray app's server on 11434. **Never spawns `ollama serve`** — a
 * competing server holds the port and crash-loops the tray app silently (see
 * `logs.md`, Session 1).
 */

import { FIRST_TOKEN_TIMEOUT_MS, HEALTH_TIMEOUT_MS, OLLAMA_URL } from '../config.ts'
import { buildContext } from '../context/buildContext.ts'
import { tierConfig } from '../tiers.ts'
import { InferenceError, type SendMessageInput, type StreamEvent } from './types.ts'

/** One line of Ollama's NDJSON stream. */
interface OllamaChunk {
  model?: string
  message?: { role?: string; content?: string; thinking?: string }
  done?: boolean
  done_reason?: string
  error?: string
  total_duration?: number
  prompt_eval_count?: number
  eval_count?: number
  eval_duration?: number
}

export interface OllamaStatus {
  running: boolean
  version?: string
  /** Models actually pulled, so the UI can flag a tier before it is selected. */
  installed?: string[]
  error?: string
}

/** Is the tray app's server up, and what does it have pulled? */
export async function checkOllama(): Promise<OllamaStatus> {
  try {
    const [versionRes, tagsRes] = await Promise.all([
      fetch(`${OLLAMA_URL}/api/version`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) }),
      fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) }),
    ])

    if (!versionRes.ok) return { running: false, error: `HTTP ${versionRes.status}` }

    const { version } = (await versionRes.json()) as { version?: string }
    const { models } = (await tagsRes.json()) as { models?: { name: string }[] }

    return { running: true, version, installed: (models ?? []).map((m) => m.name) }
  } catch (error) {
    // ECONNREFUSED, DNS failure or timeout all mean the same thing to the user.
    return { running: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** Progress on one `ollama pull`, forwarded to the UI. */
export interface PullProgress {
  status: string
  /** Bytes fetched so far, when Ollama is reporting a layer download. */
  completed?: number
  /** Total bytes of the layer being fetched. */
  total?: number
}

/**
 * Pull a model, streaming progress.
 *
 * This is the one place in Arthur that genuinely needs the internet, and it is
 * setup rather than runtime — the same category as installing Ollama itself.
 * It exists so a fresh machine never has to be told to open a terminal and type
 * `ollama pull qwen2.5:1.5b` three times; nothing in the chat loop calls it.
 *
 * Ollama does the downloading. Arthur only asks and relays the progress, which
 * keeps this well clear of fetching and executing anything itself.
 */
export async function* pullModel(model: string, signal?: AbortSignal): AsyncGenerator<PullProgress> {
  let response: Response
  try {
    response = await fetch(`${OLLAMA_URL}/api/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal,
      body: JSON.stringify({ model, stream: true }),
    })
  } catch (error) {
    throw new InferenceError(
      'ollama_unreachable',
      'Could not reach Ollama.',
      error instanceof Error ? error.message : String(error),
    )
  }

  if (!response.ok || !response.body) {
    const body = await response.text().catch(() => '')
    throw new InferenceError('unknown', `Ollama returned HTTP ${response.status}.`, body.slice(0, 400))
  }

  const decoder = new TextDecoder()
  let buffer = ''

  for await (const bytes of response.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(bytes, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue

      let chunk: { status?: string; error?: string; completed?: number; total?: number }
      try {
        chunk = JSON.parse(trimmed) as typeof chunk
      } catch {
        continue
      }

      // A pull can fail *mid-stream* with HTTP 200 already sent — no such model,
      // or the network dropped. Reported as an error rather than a stream that
      // simply stops, which would read as a silent success.
      if (chunk.error) throw new InferenceError('unknown', chunk.error)
      if (chunk.status) {
        yield { status: chunk.status, completed: chunk.completed, total: chunk.total }
      }
    }
  }
}

/**
 * Stream one assistant turn.
 *
 * Yields `thinking` and `content` deltas as they arrive, then exactly one
 * `done` event carrying the timing stats.
 */
export async function* sendMessage(
  input: SendMessageInput,
  signal?: AbortSignal,
): AsyncGenerator<StreamEvent> {
  const { model, numCtx, temperature, numPredict } = tierConfig(input.tier)
  const context = await buildContext({ messages: input.messages, tier: input.tier })

  // Reported before the request goes out, so a truncated or dropped file is
  // visible while the answer streams rather than only after it finishes, and
  // so the citations are on screen with the answer rather than arriving after
  // it has already been read.
  if (context.attachments.length > 0 || context.sources.length > 0) {
    yield { type: 'context', attachments: context.attachments, sources: context.sources }
  }

  const startedAt = performance.now()

  let response: Response
  try {
    response = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: signal ?? AbortSignal.timeout(FIRST_TOKEN_TIMEOUT_MS),
      body: JSON.stringify({
        model,
        stream: true,
        messages: [
          { role: 'system', content: context.system },
          ...context.messages,
        ],
        options: {
          // Explicit, always. Ollama otherwise auto-selects 4096 on this card —
          // its coarse VRAM ladder, not a measured fit. See `docs/model-notes.md`.
          num_ctx: numCtx,
          temperature,
          // A runaway guard set high enough to almost never fire — a *low* cap
          // makes qwen3 spend the whole allowance thinking and return empty
          // `content`. Truncation is detected below rather than shown as blank.
          num_predict: numPredict,
        },
        // `think` is deliberately NOT passed. Setting it false dumps raw
        // chain-of-thought plus a stray `</think>` into `content`; the default
        // splits `thinking` and `content` cleanly. See `docs/model-notes.md`.
      }),
    })
  } catch (error) {
    if (signal?.aborted) throw new InferenceError('aborted', 'Generation was stopped.')
    throw new InferenceError(
      'ollama_unreachable',
      'Could not reach Ollama.',
      error instanceof Error ? error.message : String(error),
    )
  }

  if (!response.ok || !response.body) {
    const body = await response.text().catch(() => '')

    // Ollama reports an un-pulled model as a 404 mentioning it by name.
    if (response.status === 404) {
      throw new InferenceError('model_missing', `The model "${model}" is not installed.`, model)
    }
    throw new InferenceError('unknown', `Ollama returned HTTP ${response.status}.`, body.slice(0, 400))
  }

  const decoder = new TextDecoder()
  let buffer = ''
  let firstTokenAt: number | null = null
  let thinkingChars = 0
  let contentChars = 0
  let emittedDone = false

  try {
    for await (const bytes of response.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(bytes, { stream: true })

      // NDJSON: one JSON object per line, and a chunk boundary can land
      // mid-line — so the trailing partial is always carried forward.
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue

        let chunk: OllamaChunk
        try {
          chunk = JSON.parse(trimmed) as OllamaChunk
        } catch {
          continue // A malformed line is not worth killing a live stream over.
        }

        if (chunk.error) throw new InferenceError('unknown', chunk.error)

        const thinking = chunk.message?.thinking
        const content = chunk.message?.content

        if (thinking) {
          firstTokenAt ??= performance.now()
          thinkingChars += thinking.length
          yield { type: 'thinking', delta: thinking }
        }

        if (content) {
          firstTokenAt ??= performance.now()
          contentChars += content.length
          yield { type: 'content', delta: content }
        }

        if (chunk.done) {
          // The model used its entire allowance reasoning and never reached an
          // answer. Reported explicitly — an empty assistant bubble looks like
          // a bug, and the user needs to know a retry is worthwhile.
          if (chunk.done_reason === 'length' && contentChars === 0) {
            throw new InferenceError(
              'thinking_truncated',
              'The model ran out of room while reasoning and never reached an answer.',
              model,
            )
          }

          const totalMs = performance.now() - startedAt
          const outputTokens = chunk.eval_count ?? 0
          const evalSeconds = (chunk.eval_duration ?? 0) / 1e9

          // Ollama reports one `eval_count` covering thinking *and* answer, so
          // the split is apportioned by character share.
          const totalChars = thinkingChars + contentChars

          emittedDone = true
          yield {
            type: 'done',
            stats: {
              model: chunk.model ?? model,
              timeToFirstTokenMs: Math.round((firstTokenAt ?? performance.now()) - startedAt),
              totalMs: Math.round(totalMs),
              promptTokens: chunk.prompt_eval_count ?? 0,
              outputTokens,
              tokensPerSecond: evalSeconds > 0 ? Number((outputTokens / evalSeconds).toFixed(1)) : 0,
              thinkingTokens:
                totalChars > 0 ? Math.round(outputTokens * (thinkingChars / totalChars)) : 0,
              doneReason: chunk.done_reason ?? 'stop',
              droppedMessages: context.droppedMessages,
            },
          }
        }
      }
    }
  } catch (error) {
    if (error instanceof InferenceError) throw error
    if (signal?.aborted) throw new InferenceError('aborted', 'Generation was stopped.')
    throw new InferenceError(
      'unknown',
      'The response stream failed.',
      error instanceof Error ? error.message : String(error),
    )
  }

  // A stream that ended without `done` and without any answer text means the
  // model produced nothing usable — surfaced explicitly rather than leaving an
  // empty bubble on screen.
  if (!emittedDone && contentChars === 0) {
    throw new InferenceError('empty_response', 'The model returned an empty response.')
  }
}
