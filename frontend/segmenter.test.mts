/**
 * `Segmenter` — the logic that makes dictation feel live.
 *
 * This is where "words appear while you talk" is actually decided: cut too
 * eagerly and every pause between words starts a new transcription (slow, and
 * whisper loses the context it needs to hear correctly); cut too late and the
 * text visibly lags the speaker.
 *
 * Pure in, pure out — no Web Audio, no microphone, no network — which is the
 * whole reason it was split out of the recorder. The Web Audio plumbing around
 * it cannot be tested without a real device; this can.
 *
 * Run:  npx tsx segmenter.test.mts
 */

import { Segmenter } from './src/voice/segmenter'

const RATE = 16_000
const failures: string[] = []
const check = (ok: boolean, message: string) => {
  if (!ok) failures.push(message)
}

/** One chunk as the worklet delivers them: 1024 samples, ~64 ms at 16 kHz. */
const CHUNK = 1024
const CHUNK_MS = (CHUNK / RATE) * 1000

function speech(): Float32Array {
  // ~0.10 RMS, matching what real speech measured at.
  const out = new Float32Array(CHUNK)
  for (let i = 0; i < CHUNK; i++) out[i] = Math.sin(i / 6) * 0.14
  return out
}

function silence(): Float32Array {
  return new Float32Array(CHUNK)
}

/** Feeds `count` chunks, collecting any segments emitted along the way. */
function feed(seg: Segmenter, make: () => Float32Array, count: number): Float32Array[] {
  const out: Float32Array[] = []
  for (let i = 0; i < count; i++) {
    const segment = seg.push(make())
    if (segment) out.push(segment)
  }
  return out
}

const chunksFor = (ms: number) => Math.ceil(ms / CHUNK_MS)

/* -- A pause ends a phrase --------------------------------------------------- */

{
  const seg = new Segmenter({ sampleRate: RATE })
  const duringSpeech = feed(seg, speech, chunksFor(1500))
  check(duringSpeech.length === 0, 'a phrase was cut while the speaker was still talking')

  // 550 ms of silence is the default hold.
  const afterPause = feed(seg, silence, chunksFor(700))
  check(afterPause.length === 1, `a pause should end exactly one phrase, got ${afterPause.length}`)

  const phrase = afterPause[0]!
  const phraseMs = (phrase.length / RATE) * 1000
  check(
    phraseMs > 1400,
    `the emitted phrase should contain the speech that preceded the pause, got ${Math.round(phraseMs)} ms`,
  )
}

/* -- A gap between words does NOT end a phrase ------------------------------- */

{
  const seg = new Segmenter({ sampleRate: RATE })
  feed(seg, speech, chunksFor(800))
  // ~190 ms — a normal inter-word gap, well under the 550 ms hold.
  const cut = feed(seg, silence, chunksFor(190))
  check(
    cut.length === 0,
    'a short gap between words was mistaken for the end of a phrase — dictation would fragment',
  )

  // Speech resumes and the phrase continues as one.
  feed(seg, speech, chunksFor(800))
  const finished = feed(seg, silence, chunksFor(700))
  check(finished.length === 1, 'the resumed phrase did not finish as a single segment')
  const ms = (finished[0]!.length / RATE) * 1000
  check(ms > 1700, `both halves should be in one phrase, got only ${Math.round(ms)} ms`)
}

/* -- Silence before anything is said does not accumulate --------------------- */

{
  const seg = new Segmenter({ sampleRate: RATE })
  // Thirty seconds of an open mic before the user starts talking.
  const nothing = feed(seg, silence, chunksFor(30_000))
  check(nothing.length === 0, 'silence alone produced a phrase to transcribe')

  feed(seg, speech, chunksFor(900))
  const phrase = feed(seg, silence, chunksFor(700))
  check(phrase.length === 1, 'speech after a long silence did not produce a phrase')

  // The phrase must contain the speech and a short lead-in — not the half
  // minute of room tone that preceded it.
  const ms = (phrase[0]!.length / RATE) * 1000
  check(
    ms < 2500,
    `pre-speech silence was prepended to the phrase (${Math.round(ms)} ms) — it would be slow to transcribe and confuse the model`,
  )
}

/* -- A long unbroken run is still cut, so text keeps appearing --------------- */

{
  const seg = new Segmenter({ sampleRate: RATE })
  // Someone reading a list without pausing for breath.
  const emitted = feed(seg, speech, chunksFor(25_000))
  check(
    emitted.length >= 2,
    `a 25 s unbroken run should be cut into pieces so text keeps appearing, got ${emitted.length}`,
  )
  for (const piece of emitted) {
    const ms = (piece.length / RATE) * 1000
    check(ms <= 9_500, `a forced cut ran to ${Math.round(ms)} ms — the text would lag badly`)
  }
}

/* -- Stopping flushes what is left ------------------------------------------- */

{
  const seg = new Segmenter({ sampleRate: RATE })
  feed(seg, speech, chunksFor(1200))
  check(seg.pending, 'buffered speech was not reported as pending')

  const tail = seg.flush()
  check(tail !== undefined, 'pressing stop mid-phrase discarded what had been said')
  check(!seg.pending, 'the segmenter still reports pending audio after flushing')
}

/* -- Stopping with nothing said sends nothing -------------------------------- */

{
  const seg = new Segmenter({ sampleRate: RATE })
  feed(seg, silence, chunksFor(2000))
  check(seg.flush() === undefined, 'silence was sent for transcription on stop')
}

/* -- A blip is not a phrase --------------------------------------------------- */

{
  const seg = new Segmenter({ sampleRate: RATE })
  // ~130 ms — a cough or a chair creak, under the 400 ms floor.
  feed(seg, speech, chunksFor(130))
  const emitted = feed(seg, silence, chunksFor(700))
  check(emitted.length === 0, 'a sub-400 ms blip was sent for transcription as if it were speech')
}

/* -- Report -------------------------------------------------------------------- */

if (failures.length > 0) {
  console.error('FAIL')
  for (const f of failures) console.error('  - ' + f)
  process.exit(1)
}

console.log('PASS  phrases split on real pauses, not word gaps; long runs still cut; silence never sent')
process.exit(0)
