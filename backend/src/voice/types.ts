/**
 * The provider-agnostic speech-to-text contract.
 *
 * Same shape as `inference/types.ts`: one boundary, one implementation today.
 * Swapping the engine (whisper.cpp as a child process, or a hosted API in an
 * eventual Online mode) means writing one more file that satisfies this, not
 * touching the route or the UI.
 *
 * There is deliberately **no** synthesis counterpart here. Text-to-speech never
 * reaches the backend — see `frontend/src/voice/speech.ts` for why.
 */

export interface TranscribeInput {
  /** PCM WAV bytes. The browser resamples to 16 kHz mono before upload — see
   *  `frontend/src/voice/recorder.ts` for why that happens there and not here. */
  audio: Buffer
}

export interface TranscribeResult {
  text: string
  /** Length of the audio itself, so the UI can sanity-check a transcript that
   *  came back suspiciously short for how long the user spoke. */
  audioMs: number
  /** How long transcription took, for the log line that tells us whether
   *  `tiny.en` is still the right default on this machine. */
  elapsedMs: number
}

/** Audio that arrived but could not be read as PCM WAV. */
export class UnreadableAudioError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'UnreadableAudioError'
  }
}
