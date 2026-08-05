/**
 * Effort tiers — the backend's copy of the mapping in `frontend/src/types.ts`.
 *
 * Duplicated rather than shared because the two halves have different concerns:
 * the frontend needs labels and blurbs, the backend needs models and context
 * sizes. The `Tier` ids are the contract between them.
 */

export type Tier = 'low' | 'medium' | 'high'

export interface TierConfig {
  model: string
  /**
   * Explicit context window.
   *
   * This must be sent on every request. Ollama's own default follows a coarse
   * `4k/32k/256k based on VRAM` ladder (`ollama serve --help`) and picks 4096 on
   * this 4 GB card — which is a default, not a measured fit.
   *
   * 8192 was measured as near-free with the `q8_0` KV cache now enabled:
   * 15.7 tok/s vs 16.3 at 4096 on the High tier. See `docs/model-notes.md`.
   */
  numCtx: number
  /** Whether this model emits a separate `thinking` field. Only High does. */
  thinks: boolean
  /**
   * Sampling temperature.
   *
   * High runs at 0.3 rather than qwen3's default 0.6. Measured on the
   * pathological case ("how are you?", which is where this model spirals):
   * mean 42.3 s → 31.6 s, worst case 65 s → 48 s, with no empty responses
   * across the runs. Lower temperature makes the reasoning commit sooner
   * instead of wandering between phrasings.
   */
  temperature: number
  /**
   * Runaway guard, *not* a latency control.
   *
   * `num_predict` covers thinking and answer together, so a tight cap makes the
   * model spend its whole allowance reasoning and return empty `content` — at
   * 512 that happened in 1 of 3 runs (`done_reason: "length"`). This bound is
   * set high enough to almost never fire, purely to stop a true runaway; when
   * it does fire the backend reports it rather than showing an empty bubble.
   */
  numPredict: number
}

export const TIER_CONFIG: Record<Tier, TierConfig> = {
  // Both smaller tiers are still unmeasured under q8_0 and have more headroom
  // than this — 8192 is the conservative value shared with High, not a ceiling.
  low: { model: 'qwen2.5:1.5b', numCtx: 8192, thinks: false, temperature: 0.7, numPredict: 2048 },
  medium: { model: 'llama3.2:3b', numCtx: 8192, thinks: false, temperature: 0.7, numPredict: 2048 },
  high: { model: 'qwen3:4b', numCtx: 8192, thinks: true, temperature: 0.3, numPredict: 2560 },
}

export const DEFAULT_TIER: Tier = 'medium'

export function isTier(value: unknown): value is Tier {
  return value === 'low' || value === 'medium' || value === 'high'
}

export function tierConfig(tier: Tier): TierConfig {
  return TIER_CONFIG[tier]
}
