/**
 * The single context-assembly boundary — seam 3 of `docs/rag-architecture.md`.
 *
 * Everything that decides *what the model sees* happens here and nowhere else.
 *
 * | Phase | Implementation |
 * |---|---|
 * | 2 (now) | system prompt + budget-trimmed recent history |
 * | 4 | ...plus attachment text, injected with a `<file>` delimiter |
 * | 8 | ...attachments replaced by top-k retrieved chunks + citations |
 *
 * `phases.md` lists this file under Phase 4, but Phase 2 has to assemble
 * `{ system, messages }` regardless. Writing it here in its final shape is
 * strictly cheaper than writing a throwaway assembler now and replacing it
 * later, and nothing above this boundary changes when Phase 4 or 8 lands.
 */

import { estimateTokens, systemPrompt } from '../prompt.ts'
import { tierConfig, type Tier } from '../tiers.ts'

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface BuildContextInput {
  messages: ChatMessage[]
  tier: Tier
  /** Phase 4. Present in the signature now so callers never change shape. */
  attachments?: never[]
}

export interface BuiltContext {
  system: string
  messages: ChatMessage[]
  /** How many messages were dropped to fit the budget. Surfaced to the UI. */
  droppedMessages: number
  /** Token budget the history was trimmed to. Useful for the latency readout. */
  historyBudget: number
}

/**
 * Tokens held back from the context window for the model's own output.
 *
 * The High tier needs far more: qwen3 routinely burns ~1,000 tokens thinking
 * before emitting a single content token (measured — 147 of 150 stream chunks
 * were `thinking` for a two-word answer). Reserving too little is what produced
 * the empty-`content` failure recorded in `docs/model-notes.md`.
 */
const OUTPUT_RESERVE: Record<Tier, number> = {
  low: 1_024,
  medium: 1_024,
  high: 2_560,
}

export function buildContext({ messages, tier }: BuildContextInput): BuiltContext {
  const { numCtx } = tierConfig(tier)
  const system = systemPrompt(tier)

  const historyBudget = numCtx - OUTPUT_RESERVE[tier] - estimateTokens(system)

  // Walk backwards from the newest message, keeping whatever fits. Recency
  // matters more than completeness, and the newest turn is the one being
  // answered — so it is kept even if it alone exceeds the budget (the model
  // truncates, rather than us silently answering a different question).
  const kept: ChatMessage[] = []
  let used = 0

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!
    const cost = estimateTokens(message.content) + 4 // ~4 tokens of chat framing
    if (used + cost > historyBudget && kept.length > 0) break
    kept.unshift(message)
    used += cost
  }

  return {
    system,
    messages: kept,
    droppedMessages: messages.length - kept.length,
    historyBudget,
  }
}
