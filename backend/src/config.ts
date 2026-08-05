/**
 * Runtime configuration.
 *
 * Deliberately plain constants rather than a config file — this is a personal,
 * single-user app and an unnecessary layer of indirection would be gold-plating
 * (see "production ready" in `docs/rag-architecture.md`).
 */

/** Backend port. 5178 is the frontend (`chrome --app=` target), so this is 5179. */
export const PORT = Number(process.env.ARTHUR_PORT ?? 5179)

/**
 * The tray app's server. We *connect* to it and never spawn our own — a second
 * `ollama serve` holds port 11434 and puts the tray app into a silent crash
 * loop (see `logs.md`, Session 1).
 */
export const OLLAMA_URL = process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434'

/** How long to wait for Ollama to accept a connection before declaring it down. */
export const HEALTH_TIMEOUT_MS = 2_000

/**
 * A cold model load can take ~10 s, and the *first* generation after an Ollama
 * restart is roughly 2× slower while the quantized-attention CUDA kernels
 * compile (see `docs/model-notes.md`). Generous, so a slow first token is never
 * mistaken for a hang.
 */
export const FIRST_TOKEN_TIMEOUT_MS = 120_000
