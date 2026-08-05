/**
 * PowerPoint extraction, by reading the file's own XML.
 *
 * `docs/rag-architecture.md` named `officeparser` for this. That was the wrong
 * pick on inspection: it drags in `tesseract.js` — a whole OCR engine, which is
 * Phase 10 work — and it flattens a deck to a single string, losing the slide
 * boundaries Phase 8's citations depend on. "It's on slide 12" is the entire
 * value of citing a deck.
 *
 * A .pptx is a ZIP of XML, so `fflate` (tiny, pure JS, already a transitive
 * dependency) plus a text-run scan does the job with slide numbers intact.
 */

import { unzipSync, strFromU8 } from 'fflate'
import { UnreadableFileError, type Extracted, type ExtractedPage, type Extractor } from './types.ts'

/** `ppt/slides/slide12.xml` — the number is the slide's real position. */
const SLIDE_PATH = /^ppt\/slides\/slide(\d+)\.xml$/
/** `ppt/notesSlides/notesSlide12.xml` — speaker notes for the matching slide. */
const NOTES_PATH = /^ppt\/notesSlides\/notesSlide(\d+)\.xml$/

/** `<a:t>` holds every visible text run — titles, bullets, table cells alike. */
const TEXT_RUN = /<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g
/** `<a:p>` is a paragraph; its boundaries are where line breaks belong. */
const PARAGRAPH_SPLIT = /<\/a:p>/

const ENTITIES: Record<string, string> = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'",
}

function decode(xml: string): string {
  return xml
    .replace(/&(?:amp|lt|gt|quot|apos);/g, (m) => ENTITIES[m] ?? m)
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
}

/** Pulls readable text out of one slide's XML, one line per paragraph. */
function slideText(xml: string): string {
  const lines: string[] = []

  for (const paragraph of xml.split(PARAGRAPH_SPLIT)) {
    const runs: string[] = []
    for (const match of paragraph.matchAll(TEXT_RUN)) {
      runs.push(decode(match[1] ?? ''))
    }
    // Runs inside one paragraph are split by formatting, not by meaning — a
    // bolded word alone is its own run — so they are joined without a separator.
    const line = runs.join('').trim()
    if (line.length > 0) lines.push(line)
  }

  return lines.join('\n')
}

export const pptxExtractor: Extractor = {
  extensions: ['.pptx'],

  extract(bytes: Buffer, filename: string): Promise<Extracted> {
    let files: Record<string, Uint8Array>
    try {
      files = unzipSync(new Uint8Array(bytes))
    } catch (error) {
      throw new UnreadableFileError(
        `${filename} could not be opened. A .pptx is a zip archive — this one may be corrupt, or it may be a legacy .ppt renamed.`,
        { cause: error },
      )
    }

    const notesBySlide = new Map<number, string>()
    for (const [path, data] of Object.entries(files)) {
      const match = NOTES_PATH.exec(path)
      if (!match) continue
      const text = slideText(strFromU8(data)).trim()
      if (text) notesBySlide.set(Number(match[1]), text)
    }

    const pages: ExtractedPage[] = []
    for (const [path, data] of Object.entries(files)) {
      const match = SLIDE_PATH.exec(path)
      if (!match) continue

      const no = Number(match[1])
      const body = slideText(strFromU8(data))
      const notes = notesBySlide.get(no)

      pages.push({
        no,
        // Notes are included but labelled: they often carry the actual argument
        // while the slide carries three words, and mixing them silently would
        // make the model quote "speaker notes" as if it were on the slide.
        text: notes ? `${body}\n\n[Speaker notes] ${notes}` : body,
      })
    }

    if (pages.length === 0) {
      throw new UnreadableFileError(
        `${filename} contains no slides — it may not be a PowerPoint file.`,
      )
    }

    // Zip entries come back in archive order, which is not slide order.
    pages.sort((a, b) => a.no - b.no)

    const text = pages
      .filter((p) => p.text.trim().length > 0)
      // Slide numbers are kept inline as well as in `pages`, because the model
      // only sees the flattened text and "which slide?" is the first thing
      // anyone asks about a deck.
      .map((p) => `--- Slide ${p.no} ---\n${p.text}`)
      .join('\n\n')

    if (text.trim().length === 0) {
      throw new UnreadableFileError(
        `${filename} has ${pages.length} slides but no text on any of them — the content is probably images. Reading those needs OCR, which arrives in Phase 10.`,
      )
    }

    return Promise.resolve({
      text,
      pages,
      meta: {
        slideCount: pages.length,
        slidesWithNotes: [...notesBySlide.keys()].sort((a, b) => a - b),
        emptySlides: pages.filter((p) => p.text.trim().length === 0).map((p) => p.no),
      },
    })
  },
}
