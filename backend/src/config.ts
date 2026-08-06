/**
 * Runtime configuration.
 *
 * Deliberately plain constants rather than a config file — this is a personal,
 * single-user app and an unnecessary layer of indirection would be gold-plating
 * (see "production ready" in `docs/rag-architecture.md`).
 */

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Project root, resolved from this file rather than `process.cwd()` — the
 *  launcher starts the backend from an arbitrary directory. */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * App mode: serve the built UI from this process instead of relying on Vite.
 *
 * A CLI flag rather than an environment variable, because the launcher, `cmd`,
 * PowerShell and npm scripts all disagree about how to set one and an argument
 * means the same thing everywhere. `npm run serve` passes it; `npm run dev`
 * does not.
 */
export const APP_MODE = process.argv.includes('--app')

/**
 * Where the app listens.
 *
 * One URL — `http://localhost:5178` — in both modes, so the launcher shortcut,
 * the README and every note in this repo can name a single address. In dev
 * that port is Vite, which proxies `/api` here on 5179; in app mode there is no
 * Vite, so this process takes 5178 and serves both halves. Same origin either
 * way, which is why the backend needs no CORS middleware.
 */
export const PORT = Number(process.env.ARTHUR_PORT ?? (APP_MODE ? 5178 : 5179))

/** The frontend's production build, served in app mode. */
export const WEB_DIR = join(ROOT, 'frontend', 'dist')

/**
 * Conversation history.
 *
 * Lives beside the models on E: — `data/` is gitignored, and this file plus
 * `data/documents/` is the entire backup story.
 */
export const DB_PATH = process.env.ARTHUR_DB ?? join(ROOT, 'data', 'arthur.db')

/**
 * Uploaded files, stored content-addressed by sha256.
 *
 * Beside the database deliberately: `arthur.db` plus this directory is the
 * whole of Arthur's state, which is what keeps the backup story one line long.
 */
export const DOCUMENTS_DIR = join(dirname(DB_PATH), 'documents')

/**
 * Hard ceiling on an upload, well above anything that could fit in context.
 *
 * The real limit is the per-tier token budget in `buildContext`, which truncates
 * with a visible warning. This exists only to stop something absurd being read
 * into memory.
 *
 * 25 MB rather than something tighter because a PDF's size says almost nothing
 * about its text: a 7 MB scanned-figure paper measured here holds ~22k tokens,
 * while a 20 kB text PDF holds ~3.7k. Rejecting on bytes would refuse documents
 * that fit comfortably.
 */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024

/**
 * Hard ceiling on one voice recording.
 *
 * 16 kHz mono 16-bit PCM is 32 kB per second, so this is roughly four minutes
 * — comfortably past the two-minute limit `voice/transcribe.ts` enforces on
 * the audio itself, since this only exists to stop something absurd being read
 * into memory before that check can run.
 */
export const MAX_AUDIO_BYTES = 8 * 1024 * 1024

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
