/**
 * The provider-agnostic inference contract.
 *
 * Per the architecture note in `phases.md`: all inference goes through one
 * boundary, with Ollama as its only implementation today. When Online mode is
 * added later, an Anthropic implementation satisfies this same interface and
 * maps the same three tiers onto hosted models — the SSE route, the streaming
 * renderer, the DB schema and the UI are all untouched.
 */

import type { Tier } from '../tiers.ts'
import type { Attachment, AttachmentOutcome, ChatMessage } from '../context/buildContext.ts'

export interface SendMessageInput {
  messages: ChatMessage[]
  tier: Tier
  /** Documents to put in context. Phase 8 replaces these with retrieved chunks. */
  attachments?: Attachment[]
}

export interface GenerationStats {
  model: string
  /** Milliseconds until the first token of *any* kind (thinking counts). */
  timeToFirstTokenMs: number
  totalMs: number
  promptTokens: number
  outputTokens: number
  tokensPerSecond: number
  /** How many output tokens went to reasoning rather than the answer. */
  thinkingTokens: number
  doneReason: string
  droppedMessages: number
}

export type StreamEvent =
  /**
   * What context assembly did with the attachments, emitted before generation.
   *
   * Sent up front rather than folded into `done` because a truncated file
   * changes how the answer should be read, and the user should know that while
   * it streams rather than afterwards.
   */
  | { type: 'context'; attachments: AttachmentOutcome[] }
  /** A reasoning delta. Only the High tier emits these. */
  | { type: 'thinking'; delta: string }
  /** An answer delta. */
  | { type: 'content'; delta: string }
  /** Terminal success event. */
  | { type: 'done'; stats: GenerationStats }

/** Machine-readable failure codes, so the UI can react rather than just print. */
export type InferenceErrorCode =
  /** Nothing is listening on the Ollama port — show the "Start Ollama" prompt. */
  | 'ollama_unreachable'
  /** Ollama is up but does not have this tier's model pulled. */
  | 'model_missing'
  /** The stream produced no answer text at all. */
  | 'empty_response'
  /** Reasoning consumed the whole output allowance before any answer began. */
  | 'thinking_truncated'
  | 'aborted'
  | 'unknown'

export class InferenceError extends Error {
  constructor(
    readonly code: InferenceErrorCode,
    message: string,
    /** Extra context for the UI, e.g. which model was missing. */
    readonly detail?: string,
  ) {
    super(message)
    this.name = 'InferenceError'
  }
}
