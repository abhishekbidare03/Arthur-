/**
 * Core domain types.
 *
 * These deliberately mirror the Phase 3 SQLite schema in `docs/rag-architecture.md`
 * so that swapping mock data for real DB rows is a straight substitution.
 */

import type { ErrorCode, GenerationStats } from './api'

export type Role = 'user' | 'assistant'

/**
 * Effort tiers. Each is a *different local model*, not a thinking budget on one
 * model — see `docs/model-notes.md`. Only `high` produces a `thinking` field.
 */
export type Tier = 'low' | 'medium' | 'high'

export interface TierInfo {
  id: Tier
  label: string
  model: string
  /** Short description shown in the tier dropdown. */
  blurb: string
  /**
   * Measured throughput at the settings Arthur actually ships: `num_ctx` 8192
   * with a `q8_0` KV cache. Re-measured 2026-08-05 — the original Phase 0
   * figures were taken at 4096 with an f16 cache and no longer describe this
   * build. Mean of 3 warm runs; see `docs/model-notes.md`.
   */
  tokensPerSecond: number
  /** Whether this model emits a separate `thinking` field. */
  thinks: boolean
}

export const TIERS: readonly TierInfo[] = [
  {
    id: 'low',
    label: 'Low',
    model: 'qwen2.5:1.5b',
    blurb: 'Fastest. Fits entirely on the GPU.',
    tokensPerSecond: 106,
    thinks: false,
  },
  {
    id: 'medium',
    label: 'Medium',
    model: 'llama3.2:3b',
    blurb: 'Balanced. The everyday default.',
    tokensPerSecond: 40,
    thinks: false,
  },
  {
    id: 'high',
    label: 'High',
    model: 'qwen3:4b',
    blurb: 'Reasons before answering. Slowest.',
    tokensPerSecond: 15,
    thinks: true,
  },
] as const

export const DEFAULT_TIER: Tier = 'medium'

export function tierInfo(tier: Tier): TierInfo {
  const found = TIERS.find((t) => t.id === tier)
  if (!found) throw new Error(`Unknown tier: ${tier}`)
  return found
}

export interface Message {
  id: string
  conversationId: string
  role: Role
  content: string
  /**
   * Reasoning text, returned by Ollama as a field separate from `content`.
   * Only ever populated for the `high` tier. Rendered in a collapsible panel.
   */
  thinking?: string
  /** Which model produced this message. Null for user messages. */
  model?: string
  createdAt: string
  /**
   * Timing and token counts from the generation that produced this message.
   * Phase 7's latency indicator reads this; Phase 2 only uses it to decide
   * whether the next turn needs a model-reload hint.
   */
  stats?: GenerationStats
  /** Set when generation failed. The bubble renders as an error instead. */
  error?: { code: ErrorCode; message: string; detail?: string }
  /** True while this message is still being streamed into. */
  streaming?: boolean
  /** True when the user stopped generation part-way. */
  stopped?: boolean
}

export interface Conversation {
  id: string
  title: string
  tier: Tier
  createdAt: string
  updatedAt: string
}
