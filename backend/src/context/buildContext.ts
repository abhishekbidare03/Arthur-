/**
 * The single context-assembly boundary — seam 3 of `docs/rag-architecture.md`.
 *
 * Everything that decides *what the model sees* happens here and nowhere else.
 *
 * | Phase | Implementation |
 * |---|---|
 * | 2 | system prompt + budget-trimmed recent history |
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

/** A document's extracted text, ready to inject. Phase 8 replaces this with chunks. */
export interface Attachment {
  id: string
  filename: string
  text: string
}

/**
 * One turn of history, carrying the files (if any) attached *at that turn*.
 *
 * Files are anchored to the message they were sent with, not collected into a
 * separate list and re-glued onto whichever message is newest. Re-gluing was
 * the original Phase 4 design, and it produced a real bug: attach file A, ask
 * about it, then attach a *different* file B and ask "what is this" — the
 * model saw both files pasted onto the newest question with no way to tell
 * which one "this" meant, and sometimes answered about A. Positioning each
 * file next to its own question is what a real conversation actually looks
 * like, and it is what makes "this" unambiguous.
 */
export interface HistoryMessage extends ChatMessage {
  attachments?: Attachment[]
}

export interface BuildContextInput {
  /** Oldest first. The last entry is the turn being answered. */
  messages: HistoryMessage[]
  tier: Tier
}

/** What happened to one attachment once the budget was applied. */
export interface AttachmentOutcome {
  id: string
  filename: string
  /** `full` and `truncated` reached the model; `dropped` did not. */
  state: 'full' | 'truncated' | 'dropped'
  keptChars: number
  totalChars: number
}

export interface BuiltContext {
  system: string
  messages: ChatMessage[]
  /** How many earlier turns were dropped to fit the budget. Surfaced to the UI. */
  droppedMessages: number
  /** Token budget left for history after the newest turn's own cost. */
  historyBudget: number
  /** Per-file result for the turn just sent, so the UI can warn rather than silently send less. */
  attachments: AttachmentOutcome[]
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

/**
 * Share of the working budget the *newest* turn's own attachments may take.
 *
 * Not all of it: a question with a huge attached file should still leave a
 * little room for the turn before it, or a two-word "yes, that one" reads as
 * the model forgetting what was just said.
 */
const ATTACHMENT_SHARE = 0.6

/** Enough of a file to be worth sending at all; below this it is just noise. */
const MIN_USEFUL_CHARS = 400

/** ~30 tokens covers the wrapper tag and the truncation note. */
const WRAP_OVERHEAD = 30

/**
 * Wraps file text so the model can tell document from question.
 *
 * An XML-ish delimiter rather than a markdown fence: file contents frequently
 * *contain* fences, and a delimiter a file can close by accident is worse than
 * none at all.
 */
function wrap(filename: string, text: string, note?: string): string {
  const open = `<file name="${filename.replace(/"/g, '&quot;')}">`
  return note ? `${open}\n${text}\n${note}\n</file>` : `${open}\n${text}\n</file>`
}

/** Cost of a message on its own, files included in full, no truncation. */
function fullCost(message: HistoryMessage): number {
  const fileTokens = (message.attachments ?? []).reduce(
    (sum, f) => sum + estimateTokens(f.text) + WRAP_OVERHEAD,
    0,
  )
  return estimateTokens(message.content) + 4 + fileTokens // ~4 tokens of chat framing
}

/** Inlines a message's attachments into its content, untouched — for history
 *  turns, which either fit whole or get dropped; there is no live UI to report
 *  a truncation warning to once a turn is no longer the one being answered. */
function inline(message: HistoryMessage): ChatMessage {
  const files = message.attachments ?? []
  if (files.length === 0) return { role: message.role, content: message.content }
  const blocks = files.map((f) => wrap(f.filename, f.text)).join('\n\n')
  return { role: message.role, content: `${blocks}\n\n${message.content}` }
}

/**
 * Fits the newest turn's own attachments into its share of the budget,
 * truncating and reporting per file. This is the one turn that can never be
 * dropped outright — it is the question being answered — so a file that does
 * not fit is truncated with a visible note rather than the whole turn
 * vanishing.
 */
function fitNewest(
  message: HistoryMessage,
  working: number,
): { content: string; cost: number; outcomes: AttachmentOutcome[] } {
  const attachments = message.attachments ?? []
  if (attachments.length === 0) {
    return { content: message.content, cost: estimateTokens(message.content) + 4, outcomes: [] }
  }

  const budget = Math.floor(working * ATTACHMENT_SHARE)
  const outcomes: AttachmentOutcome[] = []
  const blocks: string[] = []
  let used = 0

  for (const file of attachments) {
    const remaining = budget - used
    const cost = estimateTokens(file.text)

    if (cost + WRAP_OVERHEAD <= remaining) {
      blocks.push(wrap(file.filename, file.text))
      used += cost + WRAP_OVERHEAD
      outcomes.push({
        id: file.id,
        filename: file.filename,
        state: 'full',
        keptChars: file.text.length,
        totalChars: file.text.length,
      })
      continue
    }

    // Doesn't fit whole. Keep a useful prefix if there is room for one.
    const keptChars = Math.max(0, (remaining - WRAP_OVERHEAD) * 4)
    if (keptChars < MIN_USEFUL_CHARS) {
      outcomes.push({
        id: file.id,
        filename: file.filename,
        state: 'dropped',
        keptChars: 0,
        totalChars: file.text.length,
      })
      continue
    }

    const kept = file.text.slice(0, keptChars)
    // The model is told about the truncation too. Without this it will answer
    // about the end of a file it never saw, confidently.
    const note = `[... truncated: ${kept.length} of ${file.text.length} characters shown ...]`
    blocks.push(wrap(file.filename, kept, note))
    used += estimateTokens(kept) + WRAP_OVERHEAD
    outcomes.push({
      id: file.id,
      filename: file.filename,
      state: 'truncated',
      keptChars: kept.length,
      totalChars: file.text.length,
    })
  }

  const content = blocks.length > 0 ? `${blocks.join('\n\n')}\n\n${message.content}` : message.content
  return { content, cost: estimateTokens(content) + 4, outcomes }
}

export function buildContext({ messages, tier }: BuildContextInput): BuiltContext {
  const { numCtx } = tierConfig(tier)
  const system = systemPrompt(tier)

  // The real limit is runtime `num_ctx`, read from the tier config rather than
  // hardcoded — tuning it in one place must not leave a stale copy here.
  const working = numCtx - OUTPUT_RESERVE[tier] - estimateTokens(system)

  if (messages.length === 0) {
    return { system, messages: [], droppedMessages: 0, historyBudget: working, attachments: [] }
  }

  const newest = messages[messages.length - 1]!
  const older = messages.slice(0, -1)

  const { content: newestContent, cost: newestCost, outcomes } = fitNewest(newest, working)

  /* --------------------------------------------------------------- history -- */

  // Whatever the newest turn leaves goes to earlier history, richest (most
  // recent) turn first. Each older turn's attachments travel with it, in
  // full — they either fit as part of that turn or the turn is dropped
  // whole; a truncation warning would have nowhere to display once a turn is
  // no longer the one being answered.
  const historyBudget = Math.max(0, working - newestCost)
  const kept: ChatMessage[] = []
  let used = 0

  for (let i = older.length - 1; i >= 0; i--) {
    const message = older[i]!
    const cost = fullCost(message)
    if (used + cost > historyBudget) break
    kept.unshift(inline(message))
    used += cost
  }

  return {
    system,
    messages: [...kept, { role: newest.role, content: newestContent }],
    droppedMessages: older.length - kept.length,
    historyBudget,
    attachments: outcomes,
  }
}
