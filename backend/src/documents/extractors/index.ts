/**
 * Extractor dispatch.
 *
 * Phase 4 registers one extractor. Phase 8 adds its parsers to `REGISTRY` and
 * deletes the matching entries from `ARRIVING_LATER` — nothing else in the
 * codebase changes, which is the entire point of the seam.
 */

import { extname } from 'node:path'
import { textExtractor } from './text.ts'
import { UnsupportedFileError, type Extracted, type Extractor } from './types.ts'

export * from './types.ts'

const REGISTRY: readonly Extractor[] = [textExtractor]

/**
 * Formats we knowingly do not support yet, and when they land.
 *
 * The phase spec is explicit that attaching a PDF must say so rather than
 * failing generically: a user who is told "unsupported file type" reasonably
 * concludes the feature is broken, where "arrives in Phase 8" is the truth.
 */
const ARRIVING_LATER: Record<string, string> = {
  '.pdf': 'PDF support arrives in Phase 8, which reads documents by retrieval instead of pasting them into the prompt.',
  '.docx': 'Word support arrives in Phase 8.',
  '.doc': 'Word support arrives in Phase 8, and legacy .doc may not be supported even then — re-save as .docx or .txt.',
  '.xlsx': 'Excel support arrives in Phase 8.',
  '.xls': 'Excel support arrives in Phase 8 — re-save as .xlsx or export to .csv.',
  '.pptx': 'PowerPoint support arrives in Phase 8.',
  '.epub': 'EPUB support arrives in Phase 10.',
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
export function extract(bytes: Buffer, filename: string): Promise<Extracted> {
  const ext = extensionOf(filename)
  const extractor = REGISTRY.find((e) => e.extensions.includes(ext))
  if (extractor) return extractor.extract(bytes, filename)

  const planned = ARRIVING_LATER[ext]
  if (planned) throw new UnsupportedFileError(ext, planned)

  throw new UnsupportedFileError(
    ext,
    ext
      ? `Arthur cannot read ${ext} files. Text and source files work today; PDFs and Office documents arrive in Phase 8.`
      : `Arthur cannot tell what kind of file ${filename} is. Try one with a recognised extension, such as .txt or .md.`,
  )
}
