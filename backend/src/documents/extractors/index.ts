/**
 * Extractor dispatch.
 *
 * Phase 4 registers one extractor. Phase 8 adds its parsers to `REGISTRY` and
 * deletes the matching entries from `ARRIVING_LATER` — nothing else in the
 * codebase changes, which is the entire point of the seam.
 */

import { extname } from 'node:path'
import { docxExtractor } from './docx.ts'
import { epubExtractor } from './epub.ts'
import { htmlExtractor } from './html.ts'
import { pdfExtractor } from './pdf.ts'
import { pptxExtractor } from './pptx.ts'
import { textExtractor } from './text.ts'
import { xlsxExtractor } from './xlsx.ts'
import {
  UnsupportedFileError,
  type Extracted,
  type ExtractProgress,
  type Extractor,
} from './types.ts'

export * from './types.ts'

/**
 * Order matters: the first extractor claiming an extension wins.
 *
 * `htmlExtractor` is deliberately ahead of `textExtractor`, which also lists
 * `.html` among its ~60 extensions. Reading a web page as plain text produces
 * its markup *and its JavaScript* as prose, which is worse than useless —
 * whereas the HTML extractor strips both and keeps the tables.
 */
const REGISTRY: readonly Extractor[] = [
  htmlExtractor,
  textExtractor,
  pdfExtractor,
  pptxExtractor,
  docxExtractor,
  xlsxExtractor,
  epubExtractor,
]

/**
 * Formats we knowingly do not support yet, and when they land.
 *
 * Attaching one of these must say so rather than failing generically: a user
 * told "unsupported file type" reasonably concludes the feature is broken,
 * where naming the phase is the truth.
 *
 * The legacy binary formats are not a matter of scheduling — `.ppt` and `.doc`
 * predate the zip-of-XML era and share nothing with their modern namesakes, so
 * the remedy is a re-save rather than a wait.
 */
const ARRIVING_LATER: Record<string, string> = {
  '.doc': 'Legacy .doc is a different format from .docx and is not planned. Re-save it as .docx, .pdf or .txt.',
  '.xls': 'Legacy .xls is not planned. Re-save it as .xlsx, or export to .csv and attach that.',
  '.ppt': 'Legacy .ppt is a different format from .pptx and is not planned. Open it in PowerPoint and re-save as .pptx, which works today.',
  '.pages': 'Pages documents are an Apple format Arthur cannot read. Export to .docx or .pdf.',
  '.key': 'Keynote files are an Apple format Arthur cannot read. Export to .pptx or .pdf.',
  '.numbers': 'Numbers files are an Apple format Arthur cannot read. Export to .xlsx or .csv.',
  '.mobi': 'Kindle .mobi is not planned. Convert it to .epub, which works today.',
  '.azw3': 'Kindle .azw3 is not planned. Convert it to .epub, which works today.',
}

/** Lower-case extension including the dot. Handles dotfiles like `.gitignore`. */
export function extensionOf(filename: string): string {
  const ext = extname(filename).toLowerCase()
  if (ext) return ext
  // `extname('.gitignore')` is '' — the whole name is the extension.
  const base = filename.toLowerCase()
  return base.startsWith('.') ? base : ''
}

export function isSupported(filename: string): boolean {
  const ext = extensionOf(filename)
  return REGISTRY.some((e) => e.extensions.includes(ext))
}

/**
 * Reads a file's text.
 *
 * @throws {UnsupportedFileError} for a format with no extractor
 * @throws {UnreadableFileError} for bytes that are not text after all
 */
export function extract(
  bytes: Buffer,
  filename: string,
  onProgress?: (progress: ExtractProgress) => void,
): Promise<Extracted> {
  const ext = extensionOf(filename)
  const extractor = REGISTRY.find((e) => e.extensions.includes(ext))
  if (extractor) return extractor.extract(bytes, filename, onProgress)

  const planned = ARRIVING_LATER[ext]
  if (planned) throw new UnsupportedFileError(ext, planned)

  throw new UnsupportedFileError(
    ext,
    ext
      ? `Arthur cannot read ${ext} files. PDFs, PowerPoint decks, and text and source files all work.`
      : `Arthur cannot tell what kind of file ${filename} is. Try one with a recognised extension, such as .pdf or .md.`,
  )
}
