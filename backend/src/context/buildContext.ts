/**
 * The single context-assembly boundary — seam 3 of `docs/rag-architecture.md`.
 *
 * Everything that decides *what the model sees* happens here and nowhere else.
 *
 * | Phase | Implementation |
 * |---|---|
 * | 2 | system prompt + budget-trimmed recent history |
 * | 4 (now) | ...plus attachment text, injected with a `<file>` delimiter |
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

export interface BuildContextInput {
  messages: ChatMessage[]
  tier: Tier
  /**
   * Documents attached anywhere in this conversation, newest first.
   *
   * Newest first matters: when the budget cannot hold everything, the file the
   * user is most likely asking about is the one they just attached.
   */
  attachments?: Attachment[]
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
  /** How many messages were dropped to fit the budget. Surfaced to the UI. */
  droppedMessages: number
  /** Token budget the history was trimmed to. Useful for the latency readout. */
  historyBudget: number
  /** Per-file result, so the UI can warn rather than silently sending less. */
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
 * Share of the working budget attachments may take.
 *
 * A file the user just attached is almost always the subject of the question,
 * so it outranks older conversation. Not all of it, though: starving history
 * makes follow-up questions incoherent, which reads as the model "forgetting"
 * the file it is looking straight at.
 *
 * The remaining budget is not wasted — history takes whatever attachments leave.
 */
const ATTACHMENT_SHARE = 0.6

/** Enough of a file to be worth sending at all; below this it is just noise. */
const MIN_USEFUL_CHARS = 400

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

export function buildContext({ messages, tier, attachments = [] }: BuildContextInput): BuiltContext {
  const { numCtx } = tierConfig(tier)
  const system = systemPrompt(tier)

  // The real limit is runtime `num_ctx`, read from the tier config rather than
  // hardcoded — tuning it in one place must not leave a stale copy here.
  const working = numCtx - OUTPUT_RESERVE[tier] - estimateTokens(system)

  /* ------------------------------------------------------------ attachments -- */

  const outcomes: AttachmentOutcome[] = []
  const blocks: string[] = []
  let attachmentTokens = 0

  const attachmentBudget = Math.floor(working * ATTACHMENT_SHARE)

  for (const file of attachments) {
    const remaining = attachmentBudget - attachmentTokens
    const cost = estimateTokens(file.text)
    // ~30 tokens covers the wrapper and the truncation note.
    const overhead = 30

    if (cost + overhead <= remaining) {
      blocks.push(wrap(file.filename, file.text))
      attachmentTokens += cost + overhead
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
    const keptChars = Math.max(0, (remaining - overhead) * 4)
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
    attachmentTokens += estimateTokens(kept) + overhead
    outcomes.push({
      id: file.id,
      filename: file.filename,
      state: 'truncated',
      keptChars: kept.length,
      totalChars: file.text.length,
    })
  }

  /* --------------------------------------------------------------- history -- */

  const historyBudget = working - attachmentTokens

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

  /* --------------------------------------------------------------- assembly -- */

  // File text is prepended to the newest user turn rather than pushed into the
  // system prompt or persisted into `messages.content`. It stays attached to the
  // question it belongs to, and the stored message stays clean — which is what
  // lets Phase 8 swap injection for retrieval without touching stored rows.
  if (blocks.length > 0) {
    const lastUser = kept.map((m) => m.role).lastIndexOf('user')
    if (lastUser !== -1) {
      kept[lastUser] = {
        role: 'user',
        content: `${blocks.join('\n\n')}\n\n${kept[lastUser]!.content}`,
      }
    }
  }

  return {
    system,
    messages: kept,
    droppedMessages: messages.length - kept.length,
    historyBudget,
    attachments: outcomes,
  }
}
