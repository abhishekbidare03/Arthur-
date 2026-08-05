/**
 * The extraction contract — seam 2 of `docs/rag-architecture.md`.
 *
 * Every extractor returns this same shape, whatever the format. Phase 4 ships
 * only `text.ts`; Phase 8 adds `pdf.ts`, `docx.ts`, `xlsx.ts` and `pptx.ts`
 * behind this interface, and Phase 10 adds OCR, HTML and EPUB. Callers above
 * this line never learn which one ran.
 *
 * `pages` is populated even for formats that have no real pagination — a plain
 * text file reports a single page. Phase 4 does not use page numbers at all, but
 * Phase 8's citations do, and a chunk cannot be attributed to a page that was
 * never recorded. Capturing it from the start is what makes citations additive.
 */

export interface ExtractedPage {
  /** 1-based. Formats without pagination report a single page 1. */
  no: number
  text: string
}

export interface Extracted {
  /** The whole document, pages joined. What Phase 4 injects and Phase 8 chunks. */
  text: string
  pages: ExtractedPage[]
  /** Format-specific detail — line counts here, PDF producer/title in Phase 8. */
  meta: Record<string, unknown>
}

export interface Extractor {
  /** Lower-case extensions including the dot, e.g. `.md`. */
  extensions: readonly string[]
  /** Async because Phase 8's parsers are; the text one resolves immediately. */
  extract(bytes: Buffer, filename: string): Promise<Extracted>
}

/**
 * A file we can store but not read.
 *
 * Carries the reason as prose because the UI shows it verbatim — "PDF support
 * arrives in Phase 8" is a genuinely different message from "unknown file type",
 * and the phase spec calls for the honest one.
 */
export class UnsupportedFileError extends Error {
  constructor(
    readonly extension: string,
    message: string,
  ) {
    super(message)
    this.name = 'UnsupportedFileError'
  }
}

/**
 * A file of a supported type that could not be read anyway — a binary wearing a
 * `.txt` extension, a corrupt or encrypted PDF, a scan with no text layer.
 */
export class UnreadableFileError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'UnreadableFileError'
  }
}
