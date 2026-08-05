/**
 * Phase 5 voice flow, asserted against the rendered DOM.
 *
 * Two halves:
 *
 * 1. `speakableText` as a pure function — it decides what a voice actually
 *    says, and the interesting cases (a fenced code block, a link, a table)
 *    are exactly the ones that sound broken if it gets them wrong.
 * 2. The mic button end to end, with the browser audio APIs jsdom lacks
 *    (`MediaRecorder`, `AudioContext`, `OfflineAudioContext`) mocked at the
 *    boundary the recorder uses them — so the recorder's own state machine,
 *    the upload, and the transcript landing in the composer all really run.
 *
 * The point of (2) is the lesson from Session 8: a backend that streams
 * correctly proves nothing about whether the UI wired it up.
 *
 * Run:  npx tsx voice.test.tsx
 */

import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost:5178',
})

const g = globalThis as Record<string, unknown>
g.window = dom.window
g.document = dom.window.document
g.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window)
g.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window)
g.IS_REACT_ACT_ENVIRONMENT = true
dom.window.Element.prototype.scrollIntoView = function () {}

const failures: string[] = []
const check = (ok: boolean, message: string) => {
  if (!ok) failures.push(message)
}

/* -- 1. What the voice actually says ---------------------------------------- */

const { speakableText } = await import('./src/voice/speech')

const withCode = speakableText('Run this:\n\n```python\nprint("hi")\n```\n\nThen restart.')
check(
  !withCode.includes('print') && !withCode.includes('```') && !withCode.includes('python'),
  `a fenced code block must not be read out character by character: ${JSON.stringify(withCode)}`,
)
check(
  withCode.includes('code block') && withCode.includes('Then restart'),
  `code should be announced and the surrounding prose kept: ${JSON.stringify(withCode)}`,
)

const withLink = speakableText('See [the runbook](https://example.com/very/long/url) for details.')
check(
  withLink.includes('the runbook') && !withLink.includes('example.com'),
  `a link should read its label, not its URL: ${JSON.stringify(withLink)}`,
)

const withEmphasis = speakableText('This is **very** important and _urgent_.')
check(
  withEmphasis === 'This is very important and urgent.',
  `emphasis markers should not be spoken: ${JSON.stringify(withEmphasis)}`,
)

const withHeading = speakableText('## Summary\n\nRotation is Thursday.')
check(
  withHeading.startsWith('Summary') && !withHeading.includes('#'),
  `heading hashes should not be spoken: ${JSON.stringify(withHeading)}`,
)

const withInlineCode = speakableText('Set `num_ctx` to 8192.')
check(
  withInlineCode === 'Set num_ctx to 8192.',
  `inline code should be read without its backticks: ${JSON.stringify(withInlineCode)}`,
)

/* -- 2. Mock the browser audio stack jsdom has no implementation of ---------- */

let micOpened = false
let tracksStopped = 0

// The *real* jsdom navigator is kept and `mediaDevices` defined onto it —
// jsdom has no such property, and React reads `navigator.userAgent` through a
// getter that rejects anything which is not a genuine Navigator instance, so
// a cloned or proxied stand-in crashes the renderer.
Object.defineProperty(dom.window.navigator, 'mediaDevices', {
  value: {
    getUserMedia: async () => {
      micOpened = true
      return { getTracks: () => [{ stop: () => void tracksStopped++ }] }
    },
  },
  configurable: true,
})

Object.defineProperty(globalThis, 'navigator', {
  value: dom.window.navigator,
  configurable: true,
})

g.Blob = dom.window.Blob
g.File = dom.window.File
// Overridden outright, not defaulted: Node 22 *has* a real `URL.createObjectURL`,
// and it rejects a jsdom `Blob` — two separate Blob classes are in play here, so
// it fails with the memorable "must be an instance of Blob. Received an instance
// of Blob". A real browser has only one Blob, so this is a test artefact; the
// worklet's blob URL is never fetched here anyway.
g.URL.createObjectURL = () => 'blob:worklet'
g.URL.revokeObjectURL = () => {}

/**
 * A stand-in for the Web Audio graph.
 *
 * `emitSamples` is the handle the test uses to *play audio into* the recorder:
 * whatever the worklet would have posted from a real microphone is pushed
 * through here instead, so the segmenter, the queue and the transcription round
 * trip all run for real. Only the device is fake.
 */
let emitSamples: ((chunk: Float32Array) => void) | undefined
let contextClosed = false

class FakeAudioWorkletNode {
  port = { onmessage: null as ((e: { data: Float32Array }) => void) | null }
  constructor() {
    emitSamples = (chunk) => this.port.onmessage?.({ data: chunk })
  }
  connect() {}
  disconnect() {}
}

class FakeAudioContext {
  sampleRate = 16_000
  destination = {}
  audioWorklet = { addModule: async () => {} }
  createMediaStreamSource() {
    return { connect() {}, disconnect() {} }
  }
  createGain() {
    return { gain: { value: 1 }, connect() {}, disconnect() {} }
  }
  async close() {
    contextClosed = true
  }
}

g.AudioContext = FakeAudioContext
g.AudioWorkletNode = FakeAudioWorkletNode

// No speech synthesis in jsdom — leaving it undefined also asserts something
// real: SpeakButton must render nothing rather than throwing when the browser
// has no voices.
delete g.speechSynthesis

/* -- Mock backend ----------------------------------------------------------- */

// One reply per phrase, in order — so the test can tell live, incremental
// transcription apart from a single transcript arriving at the end.
const PHRASES = ['What is the rotation window', 'and who owns it']
const uploads: Blob[] = []
let warmed = false

g.fetch = async (input: string, init?: { method?: string; body?: unknown }) => {
  const url = String(input)
  const json = (o: unknown, status = 200) =>
    new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } })

  if (url.endsWith('/api/health')) return json({ running: true, installed: [] })
  if (url.endsWith('/api/conversations') && (init?.method ?? 'GET') === 'GET') return json([])
  if (url.endsWith('/api/transcribe/warm')) {
    warmed = true
    return new Response(null, { status: 202 })
  }
  if (url.endsWith('/api/transcribe')) {
    const body = init?.body as Blob
    uploads.push(body)
    return json({ text: PHRASES[uploads.length - 1] ?? '', audioMs: 1500, elapsedMs: 400 })
  }

  throw new Error(`unexpected fetch: ${url}`)
}

/* -- Render ----------------------------------------------------------------- */

const { act, createElement } = await import('react')
const { createRoot } = await import('react-dom/client')
const App = (await import('./src/App')).default

const root = createRoot(document.getElementById('root')!)
await act(async () => {
  root.render(createElement(App))
})

const micButton = () =>
  [...document.querySelectorAll('button')].find((b) =>
    b.getAttribute('aria-label')?.toLowerCase().includes('dictat'),
  ) as HTMLButtonElement | undefined

const composer = () => document.querySelector('textarea') as HTMLTextAreaElement | null

check(micButton() !== undefined, 'no mic button rendered — voice input is not wired up')
check(micButton()?.disabled === false, 'the mic button is still disabled')

/* -- Press to start dictating ------------------------------------------------ */

await act(async () => {
  micButton()!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
})

check(micOpened, 'pressing the mic button did not open the microphone')
check(
  micButton()?.getAttribute('aria-pressed') === 'true',
  'the mic button does not report itself as recording',
)
check(
  composer()?.getAttribute('placeholder')?.startsWith('Listening'),
  `the composer does not show that it is listening: ${composer()?.getAttribute('placeholder')}`,
)
check(warmed, 'the speech model was never warmed — the first phrase would pay the load')

/* -- Speak: text must appear WHILE recording, not only after stopping -------- */

const RATE = 16_000
const CHUNK = 1024
const chunksFor = (ms: number) => Math.ceil(ms / ((CHUNK / RATE) * 1000))
const speech = () => {
  const out = new Float32Array(CHUNK)
  for (let i = 0; i < CHUNK; i++) out[i] = Math.sin(i / 6) * 0.14
  return out
}
const silence = () => new Float32Array(CHUNK)

const play = async (make: () => Float32Array, ms: number) => {
  await act(async () => {
    for (let i = 0; i < chunksFor(ms); i++) emitSamples!(make())
    // Let the queued transcription promise resolve.
    await new Promise((r) => setTimeout(r, 20))
  })
}

// One phrase, then a pause long enough to end it.
await play(speech, 1500)
check(
  composer()?.value === '',
  'text appeared before the speaker had paused — the phrase was cut mid-sentence',
)

await play(silence, 700)

check(uploads.length === 1, `a pause should have sent exactly one phrase, got ${uploads.length}`)
check(uploads[0]?.type === 'audio/wav', `the backend should receive WAV, got ${uploads[0]?.type}`)

// THE POINT OF THIS FEATURE: the words are on screen while the mic is still open.
check(
  composer()?.value === PHRASES[0],
  `the first phrase did not appear during recording: ${JSON.stringify(composer()?.value)}`,
)
check(
  micButton()?.getAttribute('aria-pressed') === 'true',
  'recording stopped by itself after the first phrase',
)

/* -- Keep talking: the second phrase appends to the first -------------------- */

await play(speech, 1500)
await play(silence, 700)

check(uploads.length === 2, `expected a second phrase to be sent, got ${uploads.length}`)
check(
  composer()?.value === `${PHRASES[0]} ${PHRASES[1]}`,
  `phrases should accumulate in order with a space between them: ${JSON.stringify(composer()?.value)}`,
)

/* -- Press again to stop ----------------------------------------------------- */

await act(async () => {
  micButton()!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  await new Promise((r) => setTimeout(r, 30))
})

check(tracksStopped > 0, 'the microphone track was never stopped — Chrome keeps the mic indicator on')
check(contextClosed, 'the AudioContext was left open after recording finished')
check(
  micButton()?.getAttribute('aria-pressed') === 'false',
  'the mic button is still showing as recording after stopping',
)

/* -- The text is left editable, never auto-sent ------------------------------ */

const finalText = composer()?.value ?? ''
check(
  finalText === `${PHRASES[0]} ${PHRASES[1]}`,
  `stopping should leave the dictated text alone: ${JSON.stringify(finalText)}`,
)
check(finalText.length > 0, 'the dictation was sent immediately instead of being left editable')

/* -- Report ------------------------------------------------------------------ */

console.log('\n--- composer after dictation ---------------------------------')
console.log(`  phrases sent: ${uploads.length}`)
console.log(`  value: ${JSON.stringify(finalText)}`)
console.log('---------------------------------------------------------------\n')

if (failures.length > 0) {
  console.error('FAIL')
  for (const f of failures) console.error('  - ' + f)
  process.exit(1)
}

console.log(
  'PASS  words appear while recording, phrase by phrase, in order; mic released on stop; text left editable',
)
process.exit(0)
