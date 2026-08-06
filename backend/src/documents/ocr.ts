/**
 * OCR for scanned pages, via `tesseract.js`.
 *
 * ## The shape of this, and why
 *
 * The obvious approach — rasterise each PDF page and OCR the picture — needs a
 * renderer, and in Node that means `canvas`: a native module requiring MSVC.
 * That toolchain has been avoided since Session 1 and is not being adopted for
 * one feature.
 *
 * A scanned page does not need rendering. It *is* an image: the scanner
 * produced one picture per page and the PDF wraps it. pdf.js will hand that
 * image over decoded (`page.objs`), so the pipeline is
 *
 *     PDF page -> embedded image -> PNG (src/documents/png.ts) -> tesseract
 *
 * with no renderer anywhere in it. The trade is honest and worth stating: a
 * page whose text is *drawn* rather than photographed — vector diagrams with
 * embedded labels — has no single image to pull, and is not OCR'd. Those pages
 * are reported rather than silently returned empty.
 *
 * ## Cost
 *
 * Tesseract is slow on CPU: seconds per page, and it competes with whatever
 * chat model is resident. Everything below is shaped by that — a page cap, a
 * single worker reused across pages, and progress reported per page so a
 * three-minute scan is visibly working rather than apparently hung.
 *
 * Language data (~11 MB) downloads once into `models/ocr`, the same
 * one-time-setup category as `ollama pull` and the speech model. Never C:.
 */

import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { encodePng, expand1Bpp } from './png.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

/** Beside the embedding and speech models, on E:, never on C:. */
const CACHE_DIR = join(ROOT, 'models', 'ocr')

/**
 * How many pages will be OCR'd.
 *
 * At several seconds a page this is already a minute or two. A 300-page scanned
 * book is not something to start silently; the cap is reported so the user
 * knows what they got rather than wondering why chapter nine is missing.
 */
export const MAX_OCR_PAGES = 40

/** Below this an "image" is a logo, a rule or a bullet, not a scanned page. */
const MIN_IMAGE_PIXELS = 40_000

export interface OcrPage {
  no: number
  text: string
}

export interface OcrProgress {
  page: number
  total: number
}

/** pdf.js `ImageKind`. Named rather than inlined — 1/2/3 says nothing. */
const GRAYSCALE_1BPP = 1
const RGB_24BPP = 2
const RGBA_32BPP = 3

interface DecodedImage {
  width: number
  height: number
  kind: number
  data?: Uint8Array
}

/** Converts a pdf.js image into PNG bytes, or `undefined` if its format is not
 *  one of the three pdf.js produces. */
function toPng(image: DecodedImage): Buffer | undefined {
  if (!image.data) return undefined
  const { width, height, kind, data } = image

  if (kind === RGB_24BPP) return encodePng(data, width, height, 'rgb')
  if (kind === RGBA_32BPP) return encodePng(data, width, height, 'rgba')
  if (kind === GRAYSCALE_1BPP) return encodePng(expand1Bpp(data, width, height), width, height, 'gray')
  return undefined
}

/**
 * A tesseract worker, created once and reused.
 *
 * Worker startup loads the WASM engine and the language model — seconds. Paying
 * that per page would dominate the run on any document with more than a couple
 * of pages.
 */
let workerPromise: Promise<Awaited<ReturnType<typeof createWorker>>> | null = null

async function createWorker() {
  const { createWorker: create } = await import('tesseract.js')
  mkdirSync(CACHE_DIR, { recursive: true })
  return create('eng', undefined, {
    cachePath: CACHE_DIR,
    // tesseract.js logs a progress object per internal step; the useful
    // progress here is per *page*, reported by the caller.
    logger: () => {},
  })
}

function worker() {
  workerPromise ??= createWorker().catch((error) => {
    // A failed load must not be cached as a permanently broken worker — the
    // usual cause is the one-time language download failing, and retrying
    // after fixing the network should work.
    workerPromise = null
    throw error
  })
  return workerPromise
}

/** Frees the OCR engine. Called on shutdown; a worker holds a WASM heap. */
export async function releaseOcr(): Promise<void> {
  const existing = workerPromise
  workerPromise = null
  if (!existing) return
  await existing.then((w) => w.terminate()).catch(() => {})
}

/**
 * Reads the pages of an already-open pdf.js document that have no text layer.
 *
 * `pageNumbers` is the set that came back empty from normal extraction — pages
 * with text are never OCR'd, both because it would be slower and because
 * tesseract's guess is worse than the text the PDF already contains.
 */
export async function ocrPdfPages(
  doc: {
    getPage(no: number): Promise<{
      getOperatorList(): Promise<{ fnArray: number[]; argsArray: unknown[][] }>
      objs: { get(name: string, callback: (value: unknown) => void): void }
      cleanup(): void
    }>
  },
  /**
   * pdf.js's opcode table.
   *
   * Note there is no `paintJpegXObject` in pdf.js 6 — a JPEG arrives through
   * `paintImageXObject` already decoded, which is exactly what is wanted here.
   * `paintInlineImageXObject` is included because small scans are sometimes
   * embedded inline, and it passes the image *itself* rather than a name.
   */
  ops: {
    paintImageXObject: number
    paintImageXObjectRepeat: number
    paintInlineImageXObject: number
  },
  pageNumbers: number[],
  onProgress?: (progress: OcrProgress) => void,
): Promise<{ pages: OcrPage[]; skipped: number[]; capped: boolean }> {
  const targets = pageNumbers.slice(0, MAX_OCR_PAGES)
  const capped = pageNumbers.length > MAX_OCR_PAGES

  const pages: OcrPage[] = []
  const skipped: number[] = []
  const engine = await worker()

  for (const [index, no] of targets.entries()) {
    onProgress?.({ page: index + 1, total: targets.length })

    const page = await doc.getPage(no)
    try {
      const list = await page.getOperatorList()

      const names: string[] = []
      const inline: DecodedImage[] = []

      for (let i = 0; i < list.fnArray.length; i++) {
        const fn = list.fnArray[i]
        const first = list.argsArray[i]?.[0]

        if (fn === ops.paintImageXObject || fn === ops.paintImageXObjectRepeat) {
          if (typeof first === 'string') names.push(first)
        } else if (fn === ops.paintInlineImageXObject) {
          // Inline images carry their pixels in the operator itself; there is
          // no name to look up.
          if (first && typeof first === 'object') inline.push(first as DecodedImage)
        }
      }

      // The largest image on the page is the scan; anything else is a logo or
      // a rule. Picking the largest rather than the first matters for pages
      // with a letterhead above the scanned body.
      let best: DecodedImage | undefined
      const consider = (image: DecodedImage | undefined) => {
        if (!image?.data) return
        const pixels = image.width * image.height
        if (pixels < MIN_IMAGE_PIXELS) return
        if (!best || pixels > best.width * best.height) best = image
      }

      for (const name of names) {
        consider(
          await new Promise<DecodedImage | undefined>((resolve) => {
            try {
              page.objs.get(name, (value) => resolve(value as DecodedImage))
            } catch {
              // An image pdf.js could not decode. One missing picture must not
              // abort the whole document.
              resolve(undefined)
            }
          }),
        )
      }
      for (const image of inline) consider(image)

      const png = best ? toPng(best) : undefined
      if (!png) {
        // No single image to read — a vector page with drawn labels, most
        // likely. Recorded so it can be reported rather than silently empty.
        skipped.push(no)
        continue
      }

      const { data } = await engine.recognize(png)
      const text = (data.text ?? '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
      if (text.length > 0) pages.push({ no, text })
      else skipped.push(no)
    } finally {
      page.cleanup()
    }
  }

  return { pages, skipped, capped }
}
