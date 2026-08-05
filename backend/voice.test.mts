/**
 * Voice tests — the WAV decoder against every shape it will really meet, and
 * a real end-to-end transcription through the actual whisper model.
 *
 * The speech fixture is *synthesized at test time* by the Windows speech
 * synthesizer rather than committed as a binary. Same principle as
 * `extractors.test.mts` building a real PDF in memory: no fixture to go stale,
 * and the audio is genuinely decoded rather than trusted. It does mean the
 * transcription assertion is skipped on a machine without SAPI — the decoder
 * tests, which are the ones with real edge cases in them, always run.
 *
 * Run:  npx tsx voice.test.mts
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decodeWav, TARGET_SAMPLE_RATE } from './src/voice/wav.ts'
import { transcribe } from './src/voice/transcribe.ts'
import { UnreadableAudioError } from './src/voice/types.ts'

const failures: string[] = []
const check = (ok: boolean, message: string) => {
  if (!ok) failures.push(message)
}

const scratch = mkdtempSync(join(tmpdir(), 'arthur-voice-test-'))

/* -- A WAV builder, so each decoder case is a real file, not a hand-waved one - */

function buildWav(options: {
  sampleRate: number
  channels: number
  bitsPerSample: number
  /** Per-channel sample values in [-1, 1]. */
  frames: number[][]
  /** Windows writes 18; plain PCM writes 16. Both must decode. */
  fmtSize?: number
  /** An extra chunk before `data`, which a naive fixed-offset reader trips on. */
  withListChunk?: boolean
}): Buffer {
  const { sampleRate, channels, bitsPerSample, frames, fmtSize = 16, withListChunk = false } = options
  const bytesPerSample = bitsPerSample / 8
  const dataSize = frames.length * channels * bytesPerSample

  const data = Buffer.alloc(dataSize)
  let offset = 0
  for (const frame of frames) {
    for (const value of frame) {
      if (bitsPerSample === 8) data.writeUInt8(Math.round(value * 127) + 128, offset)
      else if (bitsPerSample === 16) data.writeInt16LE(Math.round(value * 32_767), offset)
      else if (bitsPerSample === 32) data.writeInt32LE(Math.round(value * 2_147_483_000), offset)
      offset += bytesPerSample
    }
  }

  const fmt = Buffer.alloc(8 + fmtSize)
  fmt.write('fmt ', 0, 'ascii')
  fmt.writeUInt32LE(fmtSize, 4)
  fmt.writeUInt16LE(1, 8) // PCM
  fmt.writeUInt16LE(channels, 10)
  fmt.writeUInt32LE(sampleRate, 12)
  fmt.writeUInt32LE(sampleRate * channels * bytesPerSample, 16)
  fmt.writeUInt16LE(channels * bytesPerSample, 20)
  fmt.writeUInt16LE(bitsPerSample, 22)

  const list = withListChunk ? Buffer.concat([Buffer.from('LIST'), int32(4), Buffer.from('INFO')]) : Buffer.alloc(0)
  const dataChunk = Buffer.concat([Buffer.from('data'), int32(dataSize), data])
  const body = Buffer.concat([Buffer.from('WAVE'), fmt, list, dataChunk])

  return Buffer.concat([Buffer.from('RIFF'), int32(body.length), body])
}

function int32(value: number): Buffer {
  const b = Buffer.alloc(4)
  b.writeUInt32LE(value, 0)
  return b
}

/* -- Decoder: the cases that actually differ -------------------------------- */

// Already at target rate, mono: samples must survive untouched.
const passthrough = decodeWav(
  buildWav({ sampleRate: TARGET_SAMPLE_RATE, channels: 1, bitsPerSample: 16, frames: [[0], [0.5], [-0.5], [1]] }),
)
check(passthrough.length === 4, `expected 4 samples through unchanged, got ${passthrough.length}`)
check(Math.abs(passthrough[1]! - 0.5) < 0.001, `16-bit sample decoded wrong: ${passthrough[1]}`)

// An 18-byte fmt chunk — what Windows writes, and what a fixed-offset reader
// lands mid-`data` on.
const windowsStyle = decodeWav(
  buildWav({ sampleRate: TARGET_SAMPLE_RATE, channels: 1, bitsPerSample: 16, frames: [[0.25], [0.75]], fmtSize: 18 }),
)
check(windowsStyle.length === 2, `an 18-byte fmt header broke chunk walking: got ${windowsStyle.length} samples`)
check(Math.abs(windowsStyle[0]! - 0.25) < 0.001, 'an 18-byte fmt header shifted the data offset')

// An unexpected chunk between `fmt ` and `data`.
const withList = decodeWav(
  buildWav({ sampleRate: TARGET_SAMPLE_RATE, channels: 1, bitsPerSample: 16, frames: [[0.5]], withListChunk: true }),
)
check(withList.length === 1 && Math.abs(withList[0]! - 0.5) < 0.001, 'a LIST chunk before data broke decoding')

// Stereo downmix: two channels averaged to one.
const stereo = decodeWav(
  buildWav({ sampleRate: TARGET_SAMPLE_RATE, channels: 2, bitsPerSample: 16, frames: [[1, -1], [0.5, 0.5]] }),
)
check(stereo.length === 2, `stereo should downmix to 2 mono frames, got ${stereo.length}`)
check(Math.abs(stereo[0]!) < 0.001, `opposed channels should average to silence, got ${stereo[0]}`)
check(Math.abs(stereo[1]! - 0.5) < 0.001, `equal channels should average to themselves, got ${stereo[1]}`)

// 8-bit is unsigned and centred on 128 — the one depth that is not signed.
const eightBit = decodeWav(
  buildWav({ sampleRate: TARGET_SAMPLE_RATE, channels: 1, bitsPerSample: 8, frames: [[0], [1], [-1]] }),
)
check(Math.abs(eightBit[0]!) < 0.02, `8-bit silence should decode near zero, got ${eightBit[0]}`)
check(eightBit[1]! > 0.9, `8-bit positive peak decoded wrong: ${eightBit[1]}`)
check(eightBit[2]! < -0.9, `8-bit negative peak decoded wrong: ${eightBit[2]}`)

// Resampling: 32 kHz in, 16 kHz out, so half the samples.
const resampled = decodeWav(
  buildWav({
    sampleRate: 32_000,
    channels: 1,
    bitsPerSample: 16,
    frames: Array.from({ length: 100 }, () => [0.5]),
  }),
)
check(
  Math.abs(resampled.length - 50) <= 1,
  `32 kHz should halve to ~50 samples at 16 kHz, got ${resampled.length}`,
)

/* -- Decoder: refusals ------------------------------------------------------- */

const refuses = (bytes: Buffer, what: string) => {
  try {
    decodeWav(bytes)
    failures.push(`${what} should have been refused, but decoded`)
  } catch (error) {
    check(error instanceof UnreadableAudioError, `${what} threw the wrong error type: ${error}`)
  }
}

refuses(Buffer.from('this is not audio at all'), 'a non-WAV file')
refuses(Buffer.concat([Buffer.from('RIFF'), int32(4), Buffer.from('WAVE')]), 'a WAV with no fmt chunk')
refuses(
  buildWav({ sampleRate: TARGET_SAMPLE_RATE, channels: 1, bitsPerSample: 16, frames: [] }),
  'a WAV with an empty data chunk',
)

/* -- Silence must not hallucinate ------------------------------------------- */

// Whisper does not return an empty string for silence — it invents plausible
// filler. Two seconds of digital silence posted to the real route came back as
// "you", which would then be pasted into the composer as if it had been said.
// This is why the silence gate checks the *audio*, not the transcript.
const silence = buildWav({
  sampleRate: TARGET_SAMPLE_RATE,
  channels: 1,
  bitsPerSample: 16,
  frames: Array.from({ length: TARGET_SAMPLE_RATE * 2 }, () => [0]),
})
const silentResult = await transcribe({ audio: silence })
check(
  silentResult.text === '',
  `silence must transcribe to nothing, not a hallucinated word: ${JSON.stringify(silentResult.text)}`,
)

// Very quiet speech must still get through — a gate that rejects real talking
// is worse than the hallucination it prevents.
const quiet = buildWav({
  sampleRate: TARGET_SAMPLE_RATE,
  channels: 1,
  bitsPerSample: 16,
  // RMS ~0.02: far below the ~0.10 of normal speech, well above the gate.
  frames: Array.from({ length: TARGET_SAMPLE_RATE }, (_, i) => [Math.sin(i / 8) * 0.03]),
})
const quietResult = await transcribe({ audio: quiet })
check(
  quietResult.elapsedMs > 0,
  'quiet audio was rejected as silence — the gate is set too high for real speech',
)

/* -- End to end: real speech through the real model -------------------------- */

let spoken: Buffer | undefined
const spokenPath = join(scratch, 'spoken.wav')
const SENTENCE = 'The rotation window is Thursday at three in the morning.'

try {
  execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Add-Type -AssemblyName System.Speech; ` +
        `$s = New-Object System.Speech.Synthesis.SpeechSynthesizer; ` +
        `$s.SetOutputToWaveFile('${spokenPath}'); ` +
        `$s.Speak('${SENTENCE}'); $s.Dispose()`,
    ],
    { stdio: 'ignore', timeout: 30_000 },
  )
  spoken = readFileSync(spokenPath)
} catch {
  // No SAPI (not Windows, or speech unavailable) — the decoder tests above
  // still ran, and they hold the edge cases worth regressing on.
}

if (spoken) {
  const decoded = decodeWav(spoken)
  check(decoded.length > TARGET_SAMPLE_RATE, 'synthesized speech decoded to under a second of audio')

  const result = await transcribe({ audio: spoken })
  console.log(`transcribed: ${JSON.stringify(result.text)}`)
  console.log(
    `             ${result.audioMs} ms audio in ${result.elapsedMs} ms ` +
      `(${(result.audioMs / Math.max(result.elapsedMs, 1)).toFixed(1)}× realtime)`,
  )

  // Assert on content words rather than an exact string: whisper is entitled
  // to write "3" for "three", and pinning punctuation would make this test
  // fail for reasons that do not matter.
  const heard = result.text.toLowerCase()
  for (const word of ['rotation', 'window', 'thursday', 'morning']) {
    check(heard.includes(word), `transcript lost the word "${word}": ${JSON.stringify(result.text)}`)
  }
  check(!result.text.startsWith(' '), 'whisper\'s leading space was not trimmed')
} else {
  console.log('(skipped end-to-end transcription — no Windows speech synthesizer available)')
}

/* -- Report ------------------------------------------------------------------- */

rmSync(scratch, { recursive: true, force: true })

if (failures.length > 0) {
  console.error('FAIL')
  for (const f of failures) console.error('  - ' + f)
  process.exit(1)
}

console.log('PASS  wav decoding handles real-world headers, channels and rates; speech transcribes end to end')
process.exit(0)
