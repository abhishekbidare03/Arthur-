/**
 * Speech to text — `whisper-tiny.en` on CPU via `transformers.js`.
 *
 * ## Why not whisper.cpp, as `docs/voice-architecture.md` specified
 *
 * That document called for a prebuilt whisper.cpp binary spawned per request.
 * `transformers.js` was already a proven dependency here (Phase 8 runs the
 * embedding model through it), and using it for speech too means:
 *
 * - no binary to fetch from a GitHub release, verify, and keep current
 * - the same model-cache mechanism, pointed at `E:\Arthur\models\voice\`
 * - no child process, no temp files, no platform-specific paths
 *
 * The per-request-spawn design in that document existed to avoid a resident
 * service; not spawning anything at all satisfies that concern more directly.
 *
 * ## Why `tiny.en` and not `base.en`
 *
 * Measured, not assumed — the architecture doc left this open pending a real
 * test. Both models transcribed a deliberately awkward sentence (technical
 * nouns, an acronym with a digit) and `tiny.en` was *better*:
 *
 * | Model | "Kubernetes" | "FTS5" | Transcribe | On disk |
 * |---|---|---|---|---|
 * | `tiny.en` | ✅ Kubernetes | FT-S5 | 1.48 s | 42 MB |
 * | `base.en` | ❌ Kibernets | FTS 5 | 2.36 s | 76 MB |
 *
 * (9.15 s of speech, CPU, this machine.) Neither nails a rare acronym, and
 * that is fine: the transcript lands in the composer *editable*, so a wrong
 * token is a one-word fix rather than a re-record. Given that, the smaller and
 * faster model wins outright.
 *
 * One caveat worth recording: the test audio was synthesized rather than
 * spoken into a microphone, so it has no background noise or accent variation.
 * `base.en` may pull ahead on real speech — the switch is one constant here if
 * that turns out to be true in use.
 */

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TARGET_SAMPLE_RATE, decodeWav } from './wav.ts'
import type { TranscribeInput, TranscribeResult } from './types.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const MODEL_ID = 'Xenova/whisper-tiny.en'

/** Beyond this, transcription starts to feel like a hang rather than a pause.
 *  Whisper itself processes in 30 s windows and has no inherent ceiling. */
export const MAX_AUDIO_SECONDS = 120

/**
 * Below this RMS, audio is treated as silence and never reaches the model.
 *
 * Not an optimization — a correctness fix. Whisper *hallucinates* on silence
 * rather than returning nothing: two seconds of digital silence posted to this
 * route came back as `"you"`, which would then be pasted into the composer as
 * if the user had said it. Checking for an empty transcript does not catch
 * that, because the transcript is not empty.
 *
 * Measured on this machine: synthesized speech sits at RMS ~0.10 and true
 * silence at 0.0. 0.003 is ~30× below real speech, so quiet talking still
 * passes comfortably while an accidental mic tap does not.
 */
const SILENCE_RMS = 0.003

function rms(samples: Float32Array): number {
  let sum = 0
  for (const sample of samples) sum += sample * sample
  return Math.sqrt(sum / Math.max(samples.length, 1))
}

let envReady: Promise<void> | undefined

async function configureEnv(): Promise<void> {
  const { env } = await import('@xenova/transformers')
  // Beside the chat and embedding models on E:, never under the OS profile on
  // C: — the same rule the Ollama junction exists to enforce.
  env.cacheDir = join(ROOT, 'models', 'voice')
  // Fetched once on first use, then never again. Same one-time-setup category
  // as `ollama pull` — after this the feature is fully offline.
  env.allowRemoteModels = true
  env.allowLocalModels = true
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let pipelinePromise: Promise<any> | undefined

function getPipeline() {
  envReady ??= configureEnv()
  pipelinePromise ??= envReady.then(async () => {
    const { pipeline } = await import('@xenova/transformers')
    return pipeline('automatic-speech-recognition', MODEL_ID)
  })
  return pipelinePromise
}

/** Transcribes PCM WAV audio. Throws `UnreadableAudioError` for audio that
 *  cannot be decoded — the route turns that into an honest message. */
export async function transcribe({ audio }: TranscribeInput): Promise<TranscribeResult> {
  const samples = decodeWav(audio)
  const audioMs = Math.round((samples.length / TARGET_SAMPLE_RATE) * 1000)

  // Silence never reaches the model — see `SILENCE_RMS`. Returning an empty
  // transcript here is what the route turns into "no speech detected".
  if (rms(samples) < SILENCE_RMS) {
    return { text: '', audioMs, elapsedMs: 0 }
  }

  const startedAt = performance.now()
  const asr = await getPipeline()
  const output = (await asr(samples)) as { text?: string }
  const elapsedMs = Math.round(performance.now() - startedAt)

  return {
    // Whisper prefixes a leading space on essentially every transcript.
    text: (output.text ?? '').trim(),
    audioMs,
    elapsedMs,
  }
}

/**
 * Loads the model in the background.
 *
 * Deliberately *not* called at startup, unlike the embedding model's
 * `warmEmbeddings()`. This one is ~42 MB of ONNX that most sessions never
 * touch, and paying for it on every boot to save ~900 ms on the rare first
 * mic press is the wrong trade. The frontend calls this when the mic button is
 * first hovered or the permission prompt appears, so the load overlaps with
 * the user actually speaking.
 */
export function warmTranscription(): void {
  getPipeline().catch(() => {})
}
