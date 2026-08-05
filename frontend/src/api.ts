/**
 * Client for the local backend.
 *
 * Uses `fetch` + `ReadableStream` rather than `EventSource`, because the chat
 * request is a POST with a JSON body and `EventSource` can only issue GETs.
 */

import type { Attachment, AttachmentOutcome, Conversation, Message, Tier } from './types'

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
  /**
   * Always the first event. Carries the row ids the database assigned, so the
   * client can reconcile its optimistic state with what was actually stored —
   * and learn the id of a conversation the backend created for it.
   */
  | {
      type: 'start'
      conversationId: string
      title: string
      userMessageId: string
      assistantMessageId: string
      createdAt: string
    }
  /** What context assembly did with the attachments. Arrives before any token. */
  | { type: 'context'; attachments: AttachmentOutcome[] }
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

/* ------------------------------------------------------------ persistence -- */

async function json<T>(input: string, init?: RequestInit): Promise<T> {
  const res = await fetch(input, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  })
  if (!res.ok) throw new Error(`${init?.method ?? 'GET'} ${input} → HTTP ${res.status}`)
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T)
}

export function fetchConversations(): Promise<Conversation[]> {
  return json<Conversation[]>('/api/conversations')
}

export function fetchMessages(conversationId: string): Promise<Message[]> {
  return json<Message[]>(`/api/conversations/${conversationId}/messages`)
}

export function renameConversation(id: string, title: string): Promise<Conversation> {
  return json<Conversation>(`/api/conversations/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ title }),
  })
}

export function deleteConversation(id: string): Promise<void> {
  return json<void>(`/api/conversations/${id}`, { method: 'DELETE' })
}

/* -------------------------------------------------------------- documents -- */

/** Thrown when the backend refuses a file, carrying its explanation verbatim. */
export class UploadError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'UploadError'
  }
}

/**
 * Sends a file's bytes to the backend, which stores and extracts it.
 *
 * Raw body rather than `FormData`: the backend needs no multipart parser, and
 * the bytes stay untouched for the PDFs Phase 8 will accept. The name travels
 * in a header — percent-encoded, since headers are ASCII-only.
 */
export async function uploadDocument(
  file: File,
  conversationId: string | null,
  signal?: AbortSignal,
): Promise<Attachment> {
  const query = conversationId ? `?conversationId=${encodeURIComponent(conversationId)}` : ''

  const res = await fetch(`/api/documents${query}`, {
    method: 'POST',
    headers: {
      'Content-Type': file.type || 'application/octet-stream',
      'X-Arthur-Filename': encodeURIComponent(file.name),
    },
    body: file,
    signal,
  })

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    throw new UploadError(body.error ?? `Upload failed (HTTP ${res.status}).`, res.status)
  }

  return (await res.json()) as Attachment
}

/* ------------------------------------------------------------------ voice -- */

export class TranscribeError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'TranscribeError'
  }
}

/**
 * Sends a recording for transcription.
 *
 * The blob is already 16 kHz mono PCM WAV — `voice/recorder.ts` decodes and
 * resamples in the browser, since Chrome has the codec and the backend does not.
 */
export async function transcribeAudio(wav: Blob, signal?: AbortSignal): Promise<string> {
  const res = await fetch('/api/transcribe', {
    method: 'POST',
    headers: { 'Content-Type': 'audio/wav' },
    body: wav,
    signal,
  })

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    throw new TranscribeError(body.error ?? `Transcription failed (HTTP ${res.status}).`, res.status)
  }

  const { text } = (await res.json()) as { text: string }
  return text
}

/**
 * Asks the backend to load the speech model early.
 *
 * Fire-and-forget: the recording still works if this never lands, it just pays
 * the model load on the first transcription instead.
 */
export function warmTranscription(): void {
  void fetch('/api/transcribe/warm', { method: 'POST' }).catch(() => {})
}

/* ------------------------------------------------------------------- chat -- */

export interface StreamChatInput {
  /** Omitted for a new chat — the backend creates the conversation and
   *  reports its id in the `start` event. */
  conversationId?: string
  content: string
  tier: Tier
  /** Documents uploaded for this turn. */
  documentIds?: string[]
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
