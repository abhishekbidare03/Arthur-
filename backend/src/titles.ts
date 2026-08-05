/**
 * Conversation titles, derived from the first user message.
 *
 * ## Why not ask a model to write the title
 *
 * `phases.md` allows either "a small local prompt, or just first N chars". The
 * model route is the wrong trade on this hardware:
 *
 * - Only one model fits in 4 GB of VRAM at a time. Titling with a *smaller*
 *   model evicts the chat model, so the user's next message pays a 1–10 s
 *   reload — a cost paid on every new conversation.
 * - Titling with the *same* model avoids the reload but costs a second
 *   generation. On the High tier that means reasoning, which measured 20–100 s
 *   for a one-line answer.
 *
 * Either way the user waits seconds for a sidebar label. Text extraction is
 * instant, deterministic, offline, and costs no VRAM. Phase 7 can revisit this
 * if titles ever feel poor in practice.
 */

const MAX_LENGTH = 48

/** Strips the markdown a model might open with, so titles read as plain text. */
function stripMarkdown(text: string): string {
  return text
    // Fenced code first — its contents should never become a title.
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/\*\*([^*]*)\*\*/g, '$1')
    .replace(/\*([^*]*)\*/g, '$1')
    .replace(/_{1,2}([^_]*)_{1,2}/g, '$1')
    .replace(/~~([^~]*)~~/g, '$1')
}

export function deriveTitle(firstMessage: string): string {
  const cleaned = stripMarkdown(firstMessage).replace(/\s+/g, ' ').trim()

  if (!cleaned) return 'New chat'

  // Prefer a natural sentence boundary when one falls within the budget —
  // "How do I reverse a string?" reads better than a hard character cut.
  const sentence = /^(.{10,}?[.!?])(?:\s|$)/.exec(cleaned)
  if (sentence?.[1] && sentence[1].length <= MAX_LENGTH) {
    return capitalise(sentence[1].replace(/[.]$/, ''))
  }

  if (cleaned.length <= MAX_LENGTH) return capitalise(cleaned)

  // Otherwise cut at the last word boundary inside the budget, so a title never
  // ends mid-word.
  const clipped = cleaned.slice(0, MAX_LENGTH)
  const lastSpace = clipped.lastIndexOf(' ')
  const base = lastSpace > MAX_LENGTH * 0.6 ? clipped.slice(0, lastSpace) : clipped

  return `${capitalise(base.trimEnd().replace(/[,;:.\-–—]$/, ''))}…`
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}
