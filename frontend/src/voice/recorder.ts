/**
 * Live microphone capture — transcribes while you speak, not after you stop.
 *
 * ## Shape
 *
 * Raw PCM is pulled off the mic continuously through an `AudioWorklet`,
 * chopped into phrases at natural pauses by `Segmenter`, and each phrase is
 * posted for transcription as soon as it finishes. Text lands in the composer
 * a phrase at a time, roughly a second behind the speaker.
 *
 * ## Why raw PCM rather than `MediaRecorder`
 *
 * `MediaRecorder` produces WebM/Opus, and only a *complete* recording is
 * decodable — a partial blob has no usable trailer, so there is no way to
 * transcribe the first half of a recording that is still running. Stopping and
 * restarting it per phrase would work, but it would mean re-decoding a
 * container on every segment just to get samples back. Taking PCM directly
 * gives exactly the Float32 samples the segmenter and the WAV encoder both
 * want, with nothing to decode.
 *
 * The `AudioContext` is opened at 16 kHz, so the browser resamples the mic on
 * the way in and there is no resampling step here at all.
 *
 * ## Ordering
 *
 * Transcriptions are queued rather than fired in parallel. Two phrases in
 * flight at once can come back out of order, and a dictated sentence with its
 * clauses swapped is worse than one that arrives slightly later.
 */

import { Segmenter } from './segmenter'

/** What whisper wants, and what the AudioContext is asked to deliver. */
const TARGET_SAMPLE_RATE = 16_000

export class MicrophoneDeniedError extends Error {
  constructor() {
    super('Arthur needs microphone access to hear you. Allow it in Chrome and try again.')
    this.name = 'MicrophoneDeniedError'
  }
}

export class NoMicrophoneError extends Error {
  constructor() {
    super('No microphone was found.')
    this.name = 'NoMicrophoneError'
  }
}

export interface LiveRecorderHandlers {
  /** A finished phrase, already transcribed. Append it to what is there. */
  onText: (text: string) => void
  /** Transcription failed for one phrase. Recording continues regardless —
   *  losing a phrase should not end the dictation. */
  onError?: (message: string) => void
  /** True while at least one phrase is still being transcribed. */
  onPendingChange?: (pending: boolean) => void
}

/**
 * The worklet: buffers ~64 ms of PCM and posts it to the main thread.
 *
 * Buffering matters — a render quantum is 128 samples, which at 16 kHz would
 * mean ~125 `postMessage` calls a second carrying 8 ms of audio each. Batching
 * to 1024 keeps the traffic sane without adding meaningful latency.
 *
 * Inlined as a string and loaded from a blob URL rather than shipped as a
 * separate file, so it needs no bundler configuration and cannot go missing in
 * a build.
 */
const WORKLET_SOURCE = `
class PcmCollector extends AudioWorkletProcessor {
  constructor() {
    super()
    this.buffer = new Float32Array(1024)
    this.filled = 0
  }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0]
    if (!channel) return true
    for (let i = 0; i < channel.length; i++) {
      this.buffer[this.filled++] = channel[i]
      if (this.filled === this.buffer.length) {
        this.port.postMessage(this.buffer.slice(0))
        this.filled = 0
      }
    }
    return true
  }
}
registerProcessor('pcm-collector', PcmCollector)
`

export class LiveRecorder {
  private stream: MediaStream | undefined
  private context: AudioContext | undefined
  private node: AudioWorkletNode | undefined
  private source: MediaStreamAudioSourceNode | undefined
  private mute: GainNode | undefined
  private segmenter: Segmenter | undefined
  private handlers: LiveRecorderHandlers | undefined

  /** Serializes transcription requests so phrases arrive in the order spoken. */
  private queue: Promise<void> = Promise.resolve()
  private inFlight = 0
  private active = false

  private readonly transcribe: (wav: Blob) => Promise<string>

  constructor(transcribe: (wav: Blob) => Promise<string>) {
    this.transcribe = transcribe
  }

  get recording(): boolean {
    return this.active
  }

  async start(handlers: LiveRecorderHandlers): Promise<void> {
    if (this.active) return
    this.handlers = handlers

    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
      })
    } catch (error) {
      const name = error instanceof DOMException ? error.name : ''
      if (name === 'NotAllowedError' || name === 'SecurityError') throw new MicrophoneDeniedError()
      if (name === 'NotFoundError' || name === 'OverconstrainedError') throw new NoMicrophoneError()
      throw error
    }

    this.stream = stream

    try {
      // Asking for 16 kHz here is what removes the resampling step entirely —
      // the browser converts from the mic's native rate on the way in.
      const context = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE })
      this.context = context

      const blobUrl = URL.createObjectURL(
        new Blob([WORKLET_SOURCE], { type: 'application/javascript' }),
      )
      try {
        await context.audioWorklet.addModule(blobUrl)
      } finally {
        URL.revokeObjectURL(blobUrl)
      }

      // The context's actual rate is what the segmenter must time against — if
      // the browser ever refuses 16 kHz and picks its own, timing computed from
      // an assumed rate would silently mis-detect every pause.
      this.segmenter = new Segmenter({ sampleRate: context.sampleRate })

      this.source = context.createMediaStreamSource(stream)
      this.node = new AudioWorkletNode(context, 'pcm-collector')
      this.node.port.onmessage = (event) => this.onSamples(event.data as Float32Array)

      this.source.connect(this.node)

      // A worklet with nothing downstream is not guaranteed to be pulled. A
      // muted gain keeps it running without routing the mic to the speakers,
      // which would feed back.
      this.mute = context.createGain()
      this.mute.gain.value = 0
      this.node.connect(this.mute)
      this.mute.connect(context.destination)

      this.active = true
    } catch (error) {
      // Never leave the mic open on a failed start — the browser would keep
      // showing a recording indicator for a session that never began.
      this.release()
      throw error
    }
  }

  private onSamples(chunk: Float32Array): void {
    const segment = this.segmenter?.push(chunk)
    if (segment) this.enqueue(segment)
  }

  /** Queues one phrase for transcription, preserving order. */
  private enqueue(samples: Float32Array): void {
    this.inFlight++
    this.handlers?.onPendingChange?.(true)

    this.queue = this.queue
      .then(async () => {
        try {
          const text = await this.transcribe(encodeWav(samples, TARGET_SAMPLE_RATE))
          if (text) this.handlers?.onText(text)
        } catch (error) {
          // A phrase that fails to transcribe is a lost phrase, not a lost
          // recording — the user keeps talking and the rest still lands.
          this.handlers?.onError?.(
            error instanceof Error ? error.message : 'A phrase could not be transcribed.',
          )
        }
      })
      .finally(() => {
        this.inFlight--
        if (this.inFlight === 0) this.handlers?.onPendingChange?.(false)
      })
  }

  /**
   * Stops capture, transcribes whatever is left, and resolves once every
   * queued phrase has landed — so the caller knows the text is complete.
   */
  async stop(): Promise<void> {
    if (!this.active) return
    this.active = false

    const tail = this.segmenter?.flush()
    if (tail) this.enqueue(tail)

    this.release()
    await this.queue
  }

  /** Abandons the recording, dropping anything not yet transcribed. */
  cancel(): void {
    this.active = false
    this.segmenter = undefined
    this.handlers = undefined
    this.release()
  }

  /** Drops the mic and tears down the audio graph. Without this Chrome keeps
   *  showing the recording indicator and holds the device open. */
  private release(): void {
    if (this.node) {
      this.node.port.onmessage = null
      this.node.disconnect()
    }
    this.source?.disconnect()
    this.mute?.disconnect()
    this.stream?.getTracks().forEach((track) => track.stop())
    void this.context?.close()

    this.node = undefined
    this.source = undefined
    this.mute = undefined
    this.stream = undefined
    this.context = undefined
  }
}

/** Float samples → 16-bit PCM WAV, the one format the backend decodes. */
export function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2)
  const view = new DataView(buffer)

  const writeAscii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i))
  }

  writeAscii(0, 'RIFF')
  view.setUint32(4, 36 + samples.length * 2, true)
  writeAscii(8, 'WAVE')
  writeAscii(12, 'fmt ')
  view.setUint32(16, 16, true) // PCM fmt chunk size
  view.setUint16(20, 1, true) // format: PCM
  view.setUint16(22, 1, true) // channels: mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true) // byte rate
  view.setUint16(32, 2, true) // block align
  view.setUint16(34, 16, true) // bits per sample
  writeAscii(36, 'data')
  view.setUint32(40, samples.length * 2, true)

  for (let i = 0; i < samples.length; i++) {
    // Clamp before scaling: capture can overshoot [-1, 1] slightly, and letting
    // that wrap turns a loud syllable into a burst of noise.
    const clamped = Math.max(-1, Math.min(1, samples[i]!))
    view.setInt16(44 + i * 2, clamped * 0x7fff, true)
  }

  return new Blob([buffer], { type: 'audio/wav' })
}
