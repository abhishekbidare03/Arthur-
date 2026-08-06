/**
 * Word extraction.
 *
 * Same approach as `pptx.ts`, and for the same reason: a `.docx` is a ZIP of
 * XML, so `fflate` plus a scan of the elements that carry text does the job
 * with no parser dependency and no OCR engine dragged in behind it.
 *
 * The one thing this has to get right that a naive `<w:t>` scan does not:
 * **tables**. A Word table's cells are `<w:t>` runs like everything else, so
 * scanning blindly turns a five-column table into one long line of words with
 * no indication that they were ever columns. Tables are extracted as TSV
 * instead — see `toTsv`.
 */

import { unzipSync, strFromU8 } from 'fflate'
import { textRuns, toTsv } from './ooxml.ts'
import { UnreadableFileError, type Extracted, type ExtractedPage, type Extractor } from './types.ts'

const DOCUMENT_PATH = 'word/document.xml'

/**
 * Splits the body into top-level blocks, keeping tables whole.
 *
 * `<w:tbl>` may contain `<w:p>` paragraphs inside its cells, so paragraphs
 * cannot simply be split on first — that would shred every table into its
 * individual cells before they could be recognised as one.
 */
function blocks(xml: string): { kind: 'paragraph' | 'table'; xml: string }[] {
  const out: { kind: 'paragraph' | 'table'; xml: string }[] = []
  const pattern = /<w:tbl(?:\s[^>]*)?>[\s\S]*?<\/w:tbl>|<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g

  for (const match of xml.matchAll(pattern)) {
    const fragment = match[0]
    out.push({ kind: fragment.startsWith('<w:tbl') ? 'table' : 'paragraph', xml: fragment })
  }
  return out
}

function paragraphText(xml: string): string {
  // `<w:tab/>` and `<w:br/>` carry meaning a run scan would silently drop —
  // a tabbed list becomes one run of words without them.
  const spaced = xml.replace(/<w:tab\s*\/>/g, '\t').replace(/<w:br\s*\/>/g, '\n')
  return textRuns(spaced, 'w:t').join('').trim()
}

function tableText(xml: string): string {
  const rows: string[][] = []
  for (const row of xml.matchAll(/<w:tr(?:\s[^>]*)?>[\s\S]*?<\/w:tr>/g)) {
    const cells: string[] = []
    for (const cell of row[0].matchAll(/<w:tc(?:\s[^>]*)?>[\s\S]*?<\/w:tc>/g)) {
      // A cell can hold several paragraphs; they are one cell's worth of text.
      cells.push(
        blocks(cell[0])
          .filter((b) => b.kind === 'paragraph')
          .map((b) => paragraphText(b.xml))
          .filter(Boolean)
          .join(' '),
      )
    }
    if (cells.length > 0) rows.push(cells)
  }
  return toTsv(rows)
}

export const docxExtractor: Extractor = {
  extensions: ['.docx'],

  extract(bytes: Buffer, filename: string): Promise<Extracted> {
    let files: Record<string, Uint8Array>
    try {
      files = unzipSync(new Uint8Array(bytes))
    } catch (error) {
      throw new UnreadableFileError(
        `${filename} could not be opened. A .docx is a zip archive — this one may be corrupt, or it may be a legacy .doc renamed.`,
        { cause: error },
      )
    }

    const body = files[DOCUMENT_PATH]
    if (!body) {
      throw new UnreadableFileError(
        `${filename} has no ${DOCUMENT_PATH}, so it is not a Word document — check it is not a renamed .doc.`,
      )
    }

    const xml = strFromU8(body)
    const lines: string[] = []
    let tableCount = 0

    for (const block of blocks(xml)) {
      if (block.kind === 'table') {
        const tsv = tableText(block.xml)
        if (tsv.length > 0) {
          tableCount++
          // Labelled so the model reads tab-separated columns as a table
          // rather than as prose that happens to contain tabs.
          lines.push(`[Table ${tableCount}]\n${tsv}`)
        }
        continue
      }
      const text = paragraphText(block.xml)
      if (text.length > 0) lines.push(text)
    }

    // Word has no page boundaries in its XML — pagination is decided by the
    // renderer at layout time, from fonts and paper size, and is simply not
    // present in the file. Reporting a fake page number would put a citation
    // on a page that does not exist, so a .docx is one page and its citations
    // say so honestly.
    const text = lines.join('\n\n')

    if (text.trim().length === 0) {
      throw new UnreadableFileError(
        `${filename} has no readable text — if the content is scanned images, attach it as a PDF and Arthur will OCR it.`,
      )
    }

    const pages: ExtractedPage[] = [{ no: 1, text }]

    return Promise.resolve({
      text,
      pages,
      meta: {
        paragraphs: lines.length - tableCount,
        tables: tableCount,
        // Stated in `meta` rather than left to be inferred: anything downstream
        // reasoning about citations should know these page numbers are nominal.
        paginated: false,
        // A .docx keeps its notes and comments in separate parts; they are not
        // read, and saying so is better than silently omitting them.
        includesFootnotes: false,
      },
    })
  },
}
