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

class FakeMediaRecorder {
  state: 'inactive' | 'recording' = 'inactive'
  mimeType = 'audio/webm'
  ondataavailable: ((e: { data: Blob }) => void) | null = null
  onstop: (() => void) | null = null

  start() {
    this.state = 'recording'
  }
  stop() {
    this.state = 'inactive'
    // A real recorder emits its buffered audio before `onstop`.
    this.ondataavailable?.({ data: new dom.window.Blob([new Uint8Array(2048)], { type: 'audio/webm' }) })
    this.onstop?.()
  }
}

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

g.MediaRecorder = FakeMediaRecorder
g.Blob = dom.window.Blob
g.File = dom.window.File

// Decoding and resampling are the browser's job; here they only have to be
// *shaped* right, so the recorder's own logic downstream of them is exercised.
const fakeAudioBuffer = {
  duration: 1.5,
  length: 24_000,
  sampleRate: 16_000,
  numberOfChannels: 1,
  getChannelData: () => new Float32Array(24_000).fill(0.1),
}

class FakeAudioContext {
  async decodeAudioData() {
    return fakeAudioBuffer
  }
  async close() {}
}

class FakeOfflineAudioContext {
  destination = {}
  createBufferSource() {
    return { buffer: null, connect() {}, start() {} }
  }
  async startRendering() {
    return fakeAudioBuffer
  }
}

g.AudioContext = FakeAudioContext
g.OfflineAudioContext = FakeOfflineAudioContext

// No speech synthesis in jsdom — leaving it undefined also asserts something
// real: SpeakButton must render nothing rather than throwing when the browser
// has no voices.
delete g.speechSynthesis

/* -- Mock backend ----------------------------------------------------------- */

const TRANSCRIPT = 'What is the rotation window'
let uploadedAudio: Blob | null = null
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
    uploadedAudio = init?.body as Blob
    return json({ text: TRANSCRIPT, audioMs: 1500, elapsedMs: 800 })
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
  [...document.querySelectorAll('button')].find(
    (b) => b.getAttribute('aria-label')?.toLowerCase().includes('dictate') || b.getAttribute('aria-label') === 'Stop recording',
  ) as HTMLButtonElement | undefined

check(micButton() !== undefined, 'no mic button rendered — voice input is not wired up')
check(micButton()?.disabled === false, 'the mic button is still disabled')

/* -- Press to record -------------------------------------------------------- */

await act(async () => {
  micButton()!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
})

check(micOpened, 'pressing the mic button did not open the microphone')
check(
  micButton()?.getAttribute('aria-pressed') === 'true',
  'the mic button does not report itself as recording',
)
check(
  document.querySelector('textarea')?.getAttribute('placeholder') === 'Listening…',
  'the composer does not show that it is listening',
)

// The recorder discards anything under 350 ms as a mis-click, so this waits
// past that — the real guard is being exercised, not bypassed.
await new Promise((r) => setTimeout(r, 420))

/* -- Press again to stop and transcribe ------------------------------------- */

await act(async () => {
  micButton()!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
})
await act(async () => {
  await new Promise((r) => setTimeout(r, 50))
})

check(warmed, 'the speech model was never warmed — the first transcription pays the load')
check(uploadedAudio !== null, 'no audio was uploaded for transcription')
check(
  (uploadedAudio as Blob | null)?.type === 'audio/wav',
  `the backend should receive WAV, got ${(uploadedAudio as Blob | null)?.type}`,
)
check(tracksStopped > 0, 'the microphone track was never stopped — Chrome keeps the mic indicator on')

const textarea = document.querySelector('textarea') as HTMLTextAreaElement | null
check(
  textarea?.value === TRANSCRIPT,
  `the transcript did not land in the composer: ${JSON.stringify(textarea?.value)}`,
)
check(
  micButton()?.getAttribute('aria-pressed') === 'false',
  'the mic button is still showing as recording after transcription finished',
)

/* -- Transcription is editable, not auto-sent -------------------------------- */

check(
  document.body.textContent?.includes(TRANSCRIPT) === true,
  'the transcript is not visible anywhere on screen',
)
// If it had been auto-sent, the composer would have been cleared and a user
// bubble rendered. Neither should have happened.
check(
  textarea?.value.length! > 0,
  'the transcript was sent immediately instead of being left editable',
)

/* -- Report ------------------------------------------------------------------ */

console.log('\n--- composer after dictation ---------------------------------')
console.log(`  value: ${JSON.stringify(textarea?.value)}`)
console.log('---------------------------------------------------------------\n')

if (failures.length > 0) {
  console.error('FAIL')
  for (const f of failures) console.error('  - ' + f)
  process.exit(1)
}

console.log('PASS  mic records, uploads WAV, transcript lands editable in the composer; markdown is spoken as prose')
process.exit(0)
