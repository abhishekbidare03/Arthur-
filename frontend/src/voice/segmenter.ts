/**
 * Splitting a live microphone stream into transcribable phrases.
 *
 * ## Why this exists
 *
 * Whisper is not a streaming model — it transcribes a finished clip, not a
 * running feed. To make words appear *while* you talk, the audio has to be cut
 * into pieces small enough to transcribe quickly, and cut in places where the
 * cut does not damage the words.
 *
 * The natural place is a pause. People pause between phrases anyway, so
 * segmenting on silence produces clips that are both short *and* linguistically
 * whole — which matters, because whisper uses surrounding context to decide
 * what it heard. Cutting mid-word costs accuracy in a way cutting mid-pause
 * does not.
 *
 * ## Why not just re-transcribe everything, repeatedly
 *
 * The obvious alternative — every second, transcribe all audio so far — gets
 * slower exactly as the recording gets longer. `whisper-tiny.en` runs ~3.7×
 * realtime here, so a 20-second dictation would take ~5.4 s per refresh by the
 * end, and the text would lag further behind the longer you spoke. Segmenting
 * keeps every transcription roughly one phrase long, so the lag stays flat no
 * matter how long the recording runs.
 *
 * This class is deliberately pure — samples in, segments out, no Web Audio, no
 * network. That is what makes the interesting behaviour testable without a
 * microphone.
 */

export interface SegmenterOptions {
  sampleRate: number
  /**
   * Amplitude below which a chunk counts as silence.
   *
   * Higher than the backend's `SILENCE_RMS` (0.003) on purpose: that one only
   * has to tell "someone spoke" from "digital silence", while this one has to
   * find *pauses between phrases* against live room noise. Measured speech sits
   * around 0.10, so this still has an order of magnitude of headroom.
   */
  silenceRms?: number
  /** How long quiet must persist before a phrase is considered finished. */
  silenceHoldMs?: number
  /** Cut here even mid-sentence, so a long unbroken run still shows progress. */
  maxSegmentMs?: number
  /** Shorter than this is a cough or a click, not a phrase. */
  minSegmentMs?: number
}

const DEFAULTS = {
  silenceRms: 0.008,
  // Long enough not to fire on the gap between words, short enough that the
  // text does not visibly trail the speaker. Sentence-final pauses run well
  // past this; inter-word gaps rarely reach it.
  silenceHoldMs: 550,
  // A forced cut hurts accuracy, so this is generous — it exists to bound the
  // worst case (someone reading a list without breathing), not to be routine.
  maxSegmentMs: 9_000,
  minSegmentMs: 400,
}

export class Segmenter {
  private readonly options: Required<SegmenterOptions>
  private buffer: Float32Array[] = []
  private bufferedSamples = 0
  private silentSamples = 0
  private sawSpeech = false
  /** Samples that were *actually speech*, as opposed to buffered silence.
   *  `minSegmentMs` is measured against this: a 130 ms cough followed by a
   *  700 ms pause fills the buffer past any sane floor while containing
   *  almost nothing to transcribe. */
  private speechSamples = 0

  constructor(options: SegmenterOptions) {
    this.options = { ...DEFAULTS, ...options }
  }

  private ms(samples: number): number {
    return (samples / this.options.sampleRate) * 1000
  }

  /**
   * Feeds one chunk of captured audio.
   *
   * Returns a finished phrase when one is ready, otherwise `undefined`.
   */
  push(chunk: Float32Array): Float32Array | undefined {
    const level = rms(chunk)
    const speaking = level >= this.options.silenceRms

    this.buffer.push(chunk)
    this.bufferedSamples += chunk.length

    if (speaking) {
      this.sawSpeech = true
      this.silentSamples = 0
      this.speechSamples += chunk.length
    } else {
      this.silentSamples += chunk.length
    }

    // Nothing has been said yet — this is the pause *before* speech, and
    // letting it accumulate would prepend a minute of room tone to the first
    // phrase. Keep only a short lead-in so the first syllable is not clipped.
    if (!this.sawSpeech) {
      const keep = Math.floor((this.options.sampleRate * 200) / 1000)
      if (this.bufferedSamples > keep * 2) this.trimToLast(keep)
      return undefined
    }

    const heldLongEnough = this.ms(this.silentSamples) >= this.options.silenceHoldMs
    const tooLong = this.ms(this.bufferedSamples) >= this.options.maxSegmentMs

    if (heldLongEnough || tooLong) return this.take()
    return undefined
  }

  /** Ends the recording, returning whatever is left if it is worth sending. */
  flush(): Float32Array | undefined {
    if (!this.sawSpeech) return undefined
    return this.take()
  }

  /** True when audio is buffered that has not been transcribed yet. */
  get pending(): boolean {
    return this.sawSpeech && this.bufferedSamples > 0
  }

  private take(): Float32Array | undefined {
    const samples = this.drain()
    const spoken = this.speechSamples
    this.sawSpeech = false
    this.silentSamples = 0
    this.speechSamples = 0
    // Measured against speech, not buffer length — see `speechSamples`.
    if (this.ms(spoken) < this.options.minSegmentMs) return undefined
    return samples
  }

  private drain(): Float32Array {
    const out = new Float32Array(this.bufferedSamples)
    let offset = 0
    for (const chunk of this.buffer) {
      out.set(chunk, offset)
      offset += chunk.length
    }
    this.buffer = []
    this.bufferedSamples = 0
    return out
  }

  /** Drops all but the last `keep` samples — used to stop pre-speech silence
   *  growing without bound. */
  private trimToLast(keep: number): void {
    const all = this.drain()
    const tail = all.length > keep ? all.subarray(all.length - keep) : all
    this.buffer = [new Float32Array(tail)]
    this.bufferedSamples = tail.length
  }
}

export function rms(samples: Float32Array): number {
  if (samples.length === 0) return 0
  let sum = 0
  for (const sample of samples) sum += sample * sample
  return Math.sqrt(sum / samples.length)
}
