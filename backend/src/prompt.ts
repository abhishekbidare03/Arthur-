import type { Tier } from './tiers.ts'
import { tierConfig } from './tiers.ts'

/**
 * Arthur's system prompt — deliberately tier-dependent.
 *
 * Some persona text is not optional: without it every tier introduces itself by
 * its base-model name ("I'm Qwen, created by Alibaba Cloud"), which breaks the
 * illusion immediately.
 *
 * ## Why the thinking tier gets a *shorter* prompt
 *
 * On `qwen3:4b` (a reasoning model), system-prompt length drives reasoning
 * length almost linearly. Measured on "how are you?", 4 runs each at
 * temperature 0.3 — the case where this model spirals worst:
 *
 * | System prompt        | Mean  | Thinking |
 * |----------------------|-------|----------|
 * | 1 line               |  32 s |  1,899 c |
 * | 7 lines              |  51 s |  3,140 c |
 * | 11 lines             |  44 s |  2,873 c |
 * | 12 lines w/ meta-rule| 102 s |  6,129 c |
 *
 * The worst entry is the instructive one. It differed from the row above it by
 * a single added line — *"Greetings and simple questions need no reasoning —
 * answer them immediately"* — and that line **more than doubled** deliberation.
 * Telling a reasoning model not to reason gives it something new to reason
 * about. Do not add "be brief" instructions here; they backfire.
 *
 * So: the thinking tier gets identity only. The non-thinking tiers get the full
 * formatting guidance, which costs them nothing because they do not deliberate
 * over it — and they need the steering more, being smaller models.
 */

const IDENTITY = [
  "You are Arthur, a helpful assistant running entirely on the user's own computer.",
  'No internet, no cloud, no API key — everything stays on this machine.',
].join('\n')

/** Only sent to non-thinking tiers. Every line here would cost the High tier. */
const GUIDANCE = [
  '',
  'Be direct and concise. Answer the question that was asked without restating it.',
  'Use markdown for structure when it genuinely helps; skip it for short answers.',
  'Always put code in a fenced block tagged with its language, e.g. ```python.',
  'Use fenced blocks for terminal commands and file contents too, never bare indentation.',
  'If you do not know something, say so plainly rather than guessing.',
  'Never claim to browse the web, open links, or access files you were not given.',
].join('\n')

export function systemPrompt(tier: Tier): string {
  return tierConfig(tier).thinks ? IDENTITY : IDENTITY + GUIDANCE
}

/** Rough token estimate. ~4 characters per token is close enough for budgeting. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}
