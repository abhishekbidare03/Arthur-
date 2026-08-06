/**
 * A minimal PNG encoder.
 *
 * ## Why this exists rather than a dependency
 *
 * OCR needs an *encoded* image; pdf.js hands back raw pixel buffers. The usual
 * bridge is `canvas`, which is a native module needing MSVC — the same
 * toolchain requirement that ruled out Tauri in Session 1 and has been avoided
 * everywhere since. Every pure-JS encoder considered was a dependency carrying
 * a decoder, a filter chain and format variants none of which are wanted here.
 *
 * What is actually needed is one direction, one bit depth, no interlacing and
 * no filtering — about sixty lines, with `zlib` (built in) doing the only hard
 * part. PNG's structure is a signature, three chunks and a CRC.
 *
 * Filter type 0 (none) on every scanline: the adaptive filters exist to make
 * files smaller, and these images live for the length of one OCR call.
 */

import { deflateSync } from 'node:zlib'

export type PixelFormat = 'gray' | 'rgb' | 'rgba'

const COLOR_TYPE: Record<PixelFormat, number> = { gray: 0, rgb: 2, rgba: 6 }
const CHANNELS: Record<PixelFormat, number> = { gray: 1, rgb: 3, rgba: 4 }

/** CRC-32, table built once on first use. PNG requires it per chunk. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(bytes: Buffer): number {
  let c = 0xffffffff
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  // The CRC covers the type *and* the data, not the length — a detail that
  // produces a file every viewer rejects if got wrong.
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

export function encodePng(
  pixels: Uint8Array,
  width: number,
  height: number,
  format: PixelFormat,
): Buffer {
  const channels = CHANNELS[format]
  const stride = width * channels

  if (pixels.length < stride * height) {
    throw new Error(
      `pixel buffer is ${pixels.length} bytes, expected ${stride * height} for ${width}x${height} ${format}`,
    )
  }

  // Each scanline is prefixed with its filter byte, hence the +1 per row.
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0
    Buffer.from(pixels.buffer, pixels.byteOffset + y * stride, stride).copy(
      raw,
      y * (stride + 1) + 1,
    )
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = COLOR_TYPE[format]
  ihdr[10] = 0 // compression: deflate, the only defined value
  ihdr[11] = 0 // filter method
  ihdr[12] = 0 // no interlacing

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    // Level 3 rather than the default 6: this image is written, read once by
    // the OCR engine, and discarded, so compression time is pure cost.
    chunk('IDAT', deflateSync(raw, { level: 3 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/**
 * Expands pdf.js's packed 1-bit-per-pixel greyscale to one byte per pixel.
 *
 * In this format a set bit is *white*. Rows are padded to a byte boundary, so
 * the stride is not `width / 8` for any width that is not a multiple of eight —
 * assuming it is shears the image diagonally, which OCR reads as noise.
 */
export function expand1Bpp(packed: Uint8Array, width: number, height: number): Uint8Array {
  const out = new Uint8Array(width * height)
  const stride = (width + 7) >> 3

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const byte = packed[y * stride + (x >> 3)] ?? 0
      const bit = (byte >> (7 - (x & 7))) & 1
      out[y * width + x] = bit ? 0xff : 0x00
    }
  }
  return out
}
