/**
 * Embeddings on CPU via `transformers.js` — seam 5 of `docs/rag-architecture.md`.
 *
 * `bge-small-en-v1.5`, 384 dimensions, runs as ONNX on CPU. This must never go
 * through Ollama: an embedding model sharing the 4 GB VRAM ceiling with the
 * chat model would thrash, unloading and reloading one to make room for the
 * other on every message that touches a document.
 *
 * Model files are cached under `E:\Arthur\models\embeddings\`, beside the chat
 * models rather than under the OS user profile on C: — same reasoning as the
 * Ollama model junction: nothing this app needs should live off E:.
 */

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const MODEL_ID = 'Xenova/bge-small-en-v1.5'
export const EMBEDDING_DIMS = 384

// `@xenova/transformers` reads `env` at call time, so this must run before the
// first `pipeline()` call — done here, at module load, before anything else
// in this file can run.
let envReady: Promise<void> | undefined

async function configureEnv(): Promise<void> {
  const { env } = await import('@xenova/transformers')
  env.cacheDir = join(ROOT, 'models', 'embeddings')
  // The model is fetched once (or reused if already cached) and never again —
  // this is the one deliberate exception to "no network at runtime", covering
  // the same one-time-setup category as `ollama pull`. Once cached, every
  // later embed call is 100% local.
  env.allowRemoteModels = true
  env.allowLocalModels = true
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let extractorPromise: Promise<any> | undefined

/** Lazily loads the pipeline once and reuses it — a fresh load costs ~300 ms
 *  even warm from disk cache, which is not worth paying per request. */
function getExtractor() {
  envReady ??= configureEnv()
  extractorPromise ??= envReady.then(async () => {
    const { pipeline } = await import('@xenova/transformers')
    return pipeline('feature-extraction', MODEL_ID)
  })
  return extractorPromise
}

/** Embeds a batch of chunk texts. Batching amortizes the tokenizer/model call
 *  instead of paying its overhead once per chunk during ingestion. */
export async function embedTexts(texts: string[]): Promise<Float32Array[]> {
  if (texts.length === 0) return []
  const extractor = await getExtractor()
  const output = await extractor(texts, { pooling: 'mean', normalize: true })

  const [count, dims] = output.dims as [number, number]
  const vectors: Float32Array[] = []
  for (let i = 0; i < count; i++) {
    vectors.push(output.data.slice(i * dims, (i + 1) * dims) as Float32Array)
  }
  return vectors
}

/** Embeds a single query string — the same model, so query and chunk vectors
 *  live in the same space. bge models expect a short instruction prefix on
 *  the *query* side only; this is what actually improves retrieval quality
 *  for this family, not a stylistic choice. */
export async function embedQuery(text: string): Promise<Float32Array> {
  const prefixed = `Represent this sentence for searching relevant passages: ${text}`
  const [vector] = await embedTexts([prefixed])
  return vector!
}

/** Warms the pipeline in the background so the first real request is not the
 *  one paying the ~14 s cold-start cost of a first-ever model download, or
 *  even the ~300 ms warm-cache load. Failures are swallowed — ingestion and
 *  retrieval retry the load themselves and surface a real error there. */
export function warmEmbeddings(): void {
  getExtractor().catch(() => {})
}
