/**
 * Minimal PCM WAV decoder.
 *
 * Node has no Web Audio API, so there is no `decodeAudioData` here. A full
 * audio library would be a heavy dependency for one job — the browser has
 * already done the hard part (decoding Opus, resampling to 16 kHz, downmixing
 * to mono) before uploading, so all that is left is reading uncompressed PCM
 * out of a container that is barely more than a header.
 *
 * Chunks are *walked*, not read at fixed offsets: the `fmt ` chunk is 16 bytes
 * for plain PCM but 18 or 40 for the extended forms Windows produces, and
 * anything that assumes 16 lands mid-`data` on a real file. Found by probing a
 * WAV from the Windows speech synthesizer, which writes 18.
 */

import { UnreadableAudioError } from './types.ts'

/** What whisper expects. Anything else has to be resampled before it gets there. */
export const TARGET_SAMPLE_RATE = 16_000

interface WavFormat {
  channels: number
  sampleRate: number
  bitsPerSample: number
  /** 1 = PCM, 3 = IEEE float, 0xFFFE = extensible (real format is in the extension). */
  audioFormat: number
}

/**
 * Decodes PCM WAV to mono `Float32Array` at 16 kHz.
 *
 * Returns samples in [-1, 1], which is the range the ONNX whisper model's
 * feature extractor expects — not raw int16.
 */
export function decodeWav(buffer: Buffer): Float32Array {
  if (buffer.length < 12 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new UnreadableAudioError('That recording is not a WAV file.')
  }

  let format: WavFormat | undefined
  let data: Buffer | undefined

  let offset = 12
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4)
    const size = buffer.readUInt32LE(offset + 4)
    const body = offset + 8

    if (id === 'fmt ' && body + 16 <= buffer.length) {
      format = {
        audioFormat: buffer.readUInt16LE(body),
        channels: buffer.readUInt16LE(body + 2),
        sampleRate: buffer.readUInt32LE(body + 4),
        bitsPerSample: buffer.readUInt16LE(body + 14),
      }
    } else if (id === 'data') {
      // A streamed WAV can declare size 0 (or a lie) because the length was not
      // known when the header was written — trust the buffer over the header.
      const end = size === 0 ? buffer.length : Math.min(body + size, buffer.length)
      data = buffer.subarray(body, end)
    }

    // Chunks are word-aligned: an odd size is followed by a pad byte.
    offset = body + size + (size % 2)
  }

  if (!format) throw new UnreadableAudioError('That recording has no WAV format header.')
  if (!data || data.length === 0) throw new UnreadableAudioError('That recording contains no audio.')

  const mono = toMonoFloat(data, format)
  if (mono.length === 0) throw new UnreadableAudioError('That recording contains no audio.')

  return resample(mono, format.sampleRate, TARGET_SAMPLE_RATE)
}

/** Interleaved PCM → mono float, averaging channels. */
function toMonoFloat(data: Buffer, format: WavFormat): Float32Array {
  const { channels, bitsPerSample, audioFormat } = format
  const bytesPerSample = bitsPerSample / 8
  const frames = Math.floor(data.length / bytesPerSample / channels)
  const out = new Float32Array(frames)

  const readOne = (byteOffset: number): number => {
    if (audioFormat === 3) {
      return bitsPerSample === 64 ? data.readDoubleLE(byteOffset) : data.readFloatLE(byteOffset)
    }
    switch (bitsPerSample) {
      case 8:
        // 8-bit WAV is *unsigned*, centred on 128 — unlike every other depth.
        return (data.readUInt8(byteOffset) - 128) / 128
      case 16:
        return data.readInt16LE(byteOffset) / 32_768
      case 24:
        // No readInt24; sign-extend the top byte by hand.
        return ((data.readUInt8(byteOffset) |
          (data.readUInt8(byteOffset + 1) << 8) |
          (data.readInt8(byteOffset + 2) << 16)) / 8_388_608)
      case 32:
        return data.readInt32LE(byteOffset) / 2_147_483_648
      default:
        throw new UnreadableAudioError(`Unsupported WAV bit depth: ${bitsPerSample}.`)
    }
  }

  for (let frame = 0; frame < frames; frame++) {
    let sum = 0
    for (let channel = 0; channel < channels; channel++) {
      sum += readOne((frame * channels + channel) * bytesPerSample)
    }
    out[frame] = sum / channels
  }
  return out
}

/**
 * Linear resampling.
 *
 * Good enough here and deliberately not more: the browser already delivers
 * 16 kHz via `OfflineAudioContext`, so this only runs for audio that arrived
 * at some other rate (a WAV posted directly to the API, or a future caller).
 * Speech recognition is robust to the interpolation artefacts a windowed-sinc
 * filter would avoid — this is not a mastering pipeline.
 */
function resample(input: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return input

  const ratio = from / to
  const length = Math.floor(input.length / ratio)
  const out = new Float32Array(length)

  for (let i = 0; i < length; i++) {
    const position = i * ratio
    const index = Math.floor(position)
    const fraction = position - index
    const a = input[index] ?? 0
    const b = input[index + 1] ?? a
    out[i] = a * (1 - fraction) + b * fraction
  }
  return out
}
