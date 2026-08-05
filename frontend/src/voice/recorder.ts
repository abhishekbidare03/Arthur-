/**
 * Microphone capture, decoded and resampled to what whisper wants.
 *
 * ## Why the browser does the audio work, not the backend
 *
 * `MediaRecorder` hands back WebM/Opus, not WAV — Chrome has no WAV encoder.
 * Decoding Opus server-side would mean ffmpeg or a decoder library; the browser
 * already ships a complete one behind `decodeAudioData`, and `OfflineAudioContext`
 * resamples to any rate for free while doing it. So capture is decoded, resampled
 * to 16 kHz mono, and encoded as PCM WAV here.
 *
 * The upload gets *smaller* as a result despite WAV being uncompressed: 16 kHz
 * mono PCM is ~32 kB/s, against a 48 kHz stereo capture the backend would
 * otherwise have to decode itself.
 */

/** What whisper's feature extractor expects. Anything else gets resampled. */
const TARGET_SAMPLE_RATE = 16_000

export interface Recording {
  /** PCM WAV, 16 kHz mono — ready to POST straight to `/api/transcribe`. */
  wav: Blob
  durationMs: number
}

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

/**
 * A single recording session.
 *
 * Deliberately a small class rather than a hook: the same object is driven from
 * a pointer-down/pointer-up pair *and* from a click-to-toggle, and threading
 * that through React state was more code than holding a ref to this.
 */
export class Recorder {
  private recorder: MediaRecorder | undefined
  private stream: MediaStream | undefined
  private chunks: Blob[] = []
  private startedAt = 0

  get recording(): boolean {
    return this.recorder?.state === 'recording'
  }

  /** Opens the mic and starts capturing. Throws before any UI state changes if
   *  permission is refused, so the button never shows a recording that isn't. */
  async start(): Promise<void> {
    if (this.recording) return

    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          // Speech, not music: let the browser do the noise work it is good at.
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
    this.chunks = []
    this.recorder = new MediaRecorder(stream)
    this.recorder.ondataavailable = (event) => {
      if (event.data.size > 0) this.chunks.push(event.data)
    }
    this.startedAt = performance.now()
    this.recorder.start()
  }

  /**
   * Stops capture and returns the finished WAV.
   *
   * Returns `undefined` for a recording too short to contain speech — a
   * mis-click on the mic button should do nothing, not post 80 ms of room tone
   * and come back with an error.
   */
  async stop(): Promise<Recording | undefined> {
    const recorder = this.recorder
    if (!recorder || recorder.state === 'inactive') {
      this.release()
      return undefined
    }

    const durationMs = performance.now() - this.startedAt

    const captured = await new Promise<Blob>((resolve) => {
      recorder.onstop = () => resolve(new Blob(this.chunks, { type: recorder.mimeType }))
      recorder.stop()
    })

    this.release()

    if (durationMs < 350 || captured.size === 0) return undefined

    const wav = await toWav(captured)
    return { wav, durationMs }
  }

  /** Abandons a recording without transcribing it. */
  cancel(): void {
    if (this.recorder?.state === 'recording') this.recorder.stop()
    this.release()
  }

  /** Drops the mic. Without this the browser keeps showing a recording
   *  indicator, and on some machines holds the device open against other apps. */
  private release(): void {
    this.stream?.getTracks().forEach((track) => track.stop())
    this.stream = undefined
    this.recorder = undefined
    this.chunks = []
  }
}

/** Decodes captured audio and re-encodes it as 16 kHz mono PCM WAV. */
async function toWav(captured: Blob): Promise<Blob> {
  const bytes = await captured.arrayBuffer()

  // Decoding needs a context at *any* rate; resampling happens below. Safari
  // once refused contexts at 16 kHz, and decoding at the hardware rate first is
  // the portable order regardless.
  const decodeContext = new AudioContext()
  let decoded: AudioBuffer
  try {
    decoded = await decodeContext.decodeAudioData(bytes)
  } finally {
    void decodeContext.close()
  }

  // `OfflineAudioContext` resamples as it renders — one pass, no manual
  // interpolation, and better quality than a hand-rolled linear resampler.
  const frames = Math.max(1, Math.ceil(decoded.duration * TARGET_SAMPLE_RATE))
  const offline = new OfflineAudioContext(1, frames, TARGET_SAMPLE_RATE)
  const source = offline.createBufferSource()
  source.buffer = decoded
  source.connect(offline.destination)
  source.start()
  const rendered = await offline.startRendering()

  return encodeWav(rendered.getChannelData(0), TARGET_SAMPLE_RATE)
}

/** Float samples → 16-bit PCM WAV. */
function encodeWav(samples: Float32Array, sampleRate: number): Blob {
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
    // Clamp before scaling: rendering can overshoot [-1, 1] slightly, and
    // letting that wrap turns a loud syllable into a burst of noise.
    const clamped = Math.max(-1, Math.min(1, samples[i]!))
    view.setInt16(44 + i * 2, clamped * 0x7fff, true)
  }

  return new Blob([buffer], { type: 'audio/wav' })
}
