/**
 * Reading answers aloud.
 *
 * ## Why this never reaches the backend, and why Piper is not here
 *
 * `docs/voice-architecture.md` specified bundling Piper and a `POST /api/speak`
 * route. Chrome already exposes the speech voices Windows ships with, through
 * `speechSynthesis` — so the whole feature is a browser API call: no model to
 * download, no binary to bundle, no route, no audio streaming to get right.
 * Measured on this machine: two offline voices (Microsoft David and Zira),
 * both instant, both local.
 *
 * Piper would sound better. It would also be ~60 MB of model plus a binary,
 * to improve a feature whose job is reading an answer you can already see.
 * That trade can be revisited; starting there would have been gold-plating.
 *
 * ## The offline rule
 *
 * `speechSynthesis` mixes local and *network* voices in one list — Chrome's
 * "Google …" voices synthesize server-side. Arthur is offline-first, so this
 * module refuses any voice whose `localService` is false. On a machine with
 * only network voices installed, read-aloud reports itself unavailable rather
 * than silently making a network call.
 */

export interface SpeechVoice {
  name: string
  lang: string
}

/**
 * Voices safe to use offline.
 *
 * `getVoices()` is famously empty on first call in Chrome — the list populates
 * asynchronously and fires `voiceschanged`. Callers should treat an empty
 * result as "not ready yet" rather than "unsupported"; `whenVoicesReady`
 * exists for that.
 */
export function localVoices(): SpeechSynthesisVoice[] {
  if (typeof speechSynthesis === 'undefined') return []
  return speechSynthesis.getVoices().filter((voice) => voice.localService)
}

/** Resolves once the voice list is populated (or immediately if it already is). */
export function whenVoicesReady(): Promise<SpeechSynthesisVoice[]> {
  return new Promise((resolve) => {
    if (typeof speechSynthesis === 'undefined') {
      resolve([])
      return
    }
    const existing = localVoices()
    if (existing.length > 0) {
      resolve(existing)
      return
    }
    // Chrome fires this once the list loads. The timeout is a backstop for
    // browsers that populate synchronously and therefore never fire it.
    const done = () => {
      speechSynthesis.removeEventListener('voiceschanged', done)
      clearTimeout(timer)
      resolve(localVoices())
    }
    const timer = setTimeout(done, 1_000)
    speechSynthesis.addEventListener('voiceschanged', done)
  })
}

/** Picks the best available offline voice: prefer the UI language, else any. */
function pickVoice(voices: SpeechSynthesisVoice[]): SpeechSynthesisVoice | undefined {
  const preferred = navigator.language.toLowerCase()
  return (
    voices.find((v) => v.lang.toLowerCase() === preferred) ??
    voices.find((v) => v.lang.toLowerCase().startsWith(preferred.slice(0, 2))) ??
    voices[0]
  )
}

/**
 * Strips markdown so the voice reads prose rather than punctuation.
 *
 * Without this, a fenced code block is read character by character — backticks,
 * language tag and all — which is unlistenable and usually the longest part of
 * an answer. Code is announced and skipped instead, the way a person reading an
 * answer aloud would say "then there's a code block".
 */
export function speakableText(markdown: string): string {
  return markdown
    // Fenced code: announce, do not read.
    .replace(/```[\s\S]*?```/g, ' (code block) ')
    .replace(/`([^`]+)`/g, '$1')
    // Images before links — an image is alt text, a link is its label.
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(.*?)\1/g, '$2')
    .replace(/^\s*>\s?/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\|.*\|\s*$/gm, ' (table) ')
    .replace(/\n{2,}/g, '. ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** True when at least one offline voice exists. */
export function speechAvailable(): boolean {
  return typeof speechSynthesis !== 'undefined' && localVoices().length > 0
}

/**
 * Speaks text, replacing anything already speaking.
 *
 * `onend` fires for both a natural finish and a `cancel()`, which is what the
 * caller wants: either way, this utterance is no longer playing and the button
 * should stop showing it as active.
 */
export function speak(text: string, onend?: () => void): void {
  if (typeof speechSynthesis === 'undefined') return

  const spoken = speakableText(text)
  if (spoken.length === 0) {
    onend?.()
    return
  }

  // Chrome queues rather than replaces, so a second press without this would
  // read both answers back to back.
  speechSynthesis.cancel()

  const utterance = new SpeechSynthesisUtterance(spoken)
  const voice = pickVoice(localVoices())
  if (voice) {
    utterance.voice = voice
    // Setting `lang` to match avoids Chrome occasionally overriding the chosen
    // voice with a default for the document language.
    utterance.lang = voice.lang
  }
  utterance.onend = () => onend?.()
  utterance.onerror = () => onend?.()

  speechSynthesis.speak(utterance)
}

/** Stops any current playback. */
export function stopSpeaking(): void {
  if (typeof speechSynthesis === 'undefined') return
  speechSynthesis.cancel()
}
