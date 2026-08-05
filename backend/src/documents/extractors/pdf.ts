/**
 * PDF extraction via `pdfjs-dist`.
 *
 * Pure JS with no native build step, consistent with the rest of the stack — the
 * legacy build is the one that runs under Node rather than expecting a DOM.
 *
 * This is the first extractor where `pages` carries real information. A text
 * file reports one page because it has one; a PDF reports what it actually has,
 * which is what Phase 8's citations are built on. Getting page numbers right
 * here is the difference between "the answer is in the document somewhere" and
 * "the answer is on page 30".
 */

import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { UnreadableFileError, type Extracted, type ExtractedPage, type Extractor } from './types.ts'

/**
 * Local paths to the font and character-map data pdf.js needs.
 *
 * These ship inside `pdfjs-dist`. Without them pdf.js warns on every page of
 * any document using a standard font, and mis-maps characters in some encodings
 * — resolvable only by fetching from a CDN, which this app will not do. Pointing
 * at the installed copy keeps extraction correct and entirely offline.
 *
 * Two Windows-specific traps, both of which cost a round of "unable to load font
 * data" warnings to find: under Node these must be filesystem paths rather than
 * `file://` URLs, and pdf.js validates the trailing character as `/` — so a
 * backslash separator is rejected outright.
 */
const pdfjsRoot = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'))
const asFactoryUrl = (path: string) => `${path.replace(/\\/g, '/')}/`

const STANDARD_FONTS = asFactoryUrl(join(pdfjsRoot, 'standard_fonts'))
const CMAPS = asFactoryUrl(join(pdfjsRoot, 'cmaps'))

/** A text item from pdf.js, with the position fields needed to rebuild lines. */
interface TextItem {
  str: string
  /** Set by pdf.js when the item ends a line. */
  hasEOL?: boolean
  transform?: number[]
}

/**
 * Rebuilds readable text from positioned glyph runs.
 *
 * A PDF has no paragraphs — only text fragments at coordinates. Items are
 * assembled into lines, and a line break is declared when pdf.js sets `hasEOL`
 * or when the baseline moves. Without the baseline check a two-column paper
 * collapses into one unreadable run.
 *
 * Lines are accumulated and joined at the end rather than appended to a growing
 * string. The append approach double-counts: `hasEOL` adds a newline and the
 * next item's baseline change adds another, so a five-page paper arrives with a
 * blank line between every line — roughly doubling its token cost for nothing,
 * which matters a great deal inside an 8192-token window.
 */
function itemsToText(items: TextItem[]): string {
  const lines: string[] = []
  let current = ''
  let lastY: number | null = null

  const endLine = () => {
    lines.push(current.trimEnd())
    current = ''
  }

  for (const item of items) {
    const y = item.transform?.[5] ?? null
    const movedBaseline = lastY !== null && y !== null && Math.abs(y - lastY) > 1

    if (movedBaseline && current.length > 0) endLine()
    // Runs on the same line arrive separately and pdf.js omits the space between.
    else if (current.length > 0 && !current.endsWith(' ') && item.str) current += ' '

    current += item.str
    if (item.hasEOL) endLine()
    if (y !== null) lastY = y
  }
  if (current.trim().length > 0) endLine()

  // Collapse runs of blank lines to a single blank: a paragraph break is worth
  // one newline pair, never four.
  return lines
    .join('\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export const pdfExtractor: Extractor = {
  extensions: ['.pdf'],

  async extract(bytes: Buffer, filename: string): Promise<Extracted> {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')

    // `destroy()` lives on the loading task, not on the document — the document
    // only has `cleanup()`, which frees page resources but leaves the worker
    // running. Holding the task is what lets us shut it down properly.
    let task
    let doc
    try {
      task = pdfjs.getDocument({
        // A copy, because pdf.js transfers ownership of the buffer it is given
        // and would detach the one the caller still holds for hashing.
        data: new Uint8Array(bytes),
        // Font and CMap data resolved from the installed package rather than a
        // CDN: this app is offline by design, and a parser that reaches for the
        // internet would break that promise.
        standardFontDataUrl: STANDARD_FONTS,
        cMapUrl: CMAPS,
        cMapPacked: true,
        // Text extraction never rasterises, so no font needs to reach a
        // renderer — and not consulting system fonts keeps output identical
        // across machines.
        disableFontFace: true,
        useSystemFonts: false,
      })
      doc = await task.promise
    } catch (error) {
      await task?.destroy().catch(() => {})
      throw new UnreadableFileError(
        `${filename} could not be opened as a PDF — it may be corrupt or password-protected.`,
        { cause: error },
      )
    }

    const pages: ExtractedPage[] = []
    const pageCount = doc.numPages
    try {
      for (let no = 1; no <= pageCount; no++) {
        const page = await doc.getPage(no)
        const content = await page.getTextContent()
        pages.push({ no, text: itemsToText(content.items as TextItem[]).trim() })
        // Release the page's resources; a large PDF otherwise holds every page
        // in memory at once.
        page.cleanup()
      }
    } finally {
      // Tears down the worker too. Without this the process keeps a worker
      // thread alive per PDF and never exits.
      await task.destroy().catch(() => {})
    }

    const text = pages
      .filter((p) => p.text.length > 0)
      .map((p) => p.text)
      .join('\n\n')

    // A PDF of scanned images parses perfectly and yields nothing. Saying so is
    // far better than attaching an empty file and letting the model invent an
    // answer about it. OCR is Phase 10.
    if (text.trim().length === 0) {
      throw new UnreadableFileError(
        `${filename} has no extractable text — it is probably a scan. Reading scanned PDFs needs OCR, which arrives in Phase 10.`,
      )
    }

    return {
      text,
      pages,
      meta: {
        pageCount,
        /** Pages that yielded nothing — a hint that part of it is scanned. */
        emptyPages: pages.filter((p) => p.text.length === 0).map((p) => p.no),
      },
    }
  },
}
