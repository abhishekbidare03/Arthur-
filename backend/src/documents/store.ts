/**
 * Ingesting an uploaded file.
 *
 * Bytes are written to `data/documents/<sha256>` and recorded as a `documents`
 * row; the extracted text is cached beside it as `<sha256>.txt`. Nothing here
 * puts document text into a message — see `docs/rag-architecture.md`, seam 1.
 *
 * Content-addressed storage means attaching the same file twice stores it once.
 * That is barely worth having for the small text files Phase 4 accepts, but it
 * is the mechanism Phase 8 relies on to avoid re-embedding a 50-page PDF that
 * has already been ingested, so it is worth being right from the start.
 */

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DOCUMENTS_DIR } from '../config.ts'
import { findExtractedByHash, getDocument, insertDocument, type DocumentRow } from '../db/documents.ts'
import { extract } from './extractors/index.ts'
import type { ExtractedPage } from './extractors/types.ts'

export interface StoredDocument {
  row: DocumentRow
  text: string
  /** Per-page text, for `rag/ingest.ts` to chunk without re-extracting the
   *  file — extraction (especially PDF parsing) is not cheap enough to pay
   *  twice per upload. */
  pages: ExtractedPage[]
  /** True when an identical file had already been ingested. */
  deduped: boolean
}

function hash(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * Stores a file and extracts its text.
 *
 * Throws `UnsupportedFileError` or `UnreadableFileError` from the extractor —
 * the caller turns those into an honest message rather than a generic failure.
 */
export async function storeUpload(input: {
  filename: string
  bytes: Buffer
  mime?: string
  conversationId?: string
  /**
   * Whether an existing row with these bytes may be handed back.
   *
   * True for chat attachments, where re-attaching a file should cost nothing.
   * **False for collection ingest**, because the returned row would be one a
   * *conversation* already owns — and assigning it to the collection would
   * silently take it away from that chat, which would then answer about a file
   * it no longer has. The bytes are still stored once either way; only the row
   * is duplicated, and a row is a few hundred bytes.
   */
  reuseExisting?: boolean
  /** Reported by the OCR path only; every other format parses too fast to
   *  bother. See `ExtractProgress`. */
  onProgress?: (progress: { page: number; total: number }) => void
}): Promise<StoredDocument> {
  const sha256 = hash(input.bytes)

  // Extract before writing anything. An unsupported or unreadable file should
  // leave no trace on disk and no row behind.
  const extracted = await extract(input.bytes, input.filename, input.onProgress)

  const existing = input.reuseExisting === false ? undefined : findExtractedByHash(sha256)
  if (existing) {
    // Same bytes, already ingested and already on disk. Re-read the cached text
    // rather than trusting that this upload extracted identically.
    try {
      const cached = existing.extractedTextPath
        ? readFileSync(existing.extractedTextPath, 'utf8')
        : extracted.text
      return { row: existing, text: cached, pages: extracted.pages, deduped: true }
    } catch {
      // The cache file is gone — fall through and re-ingest under a new row.
    }
  }

  mkdirSync(DOCUMENTS_DIR, { recursive: true })

  const storagePath = join(DOCUMENTS_DIR, sha256)
  const extractedTextPath = join(DOCUMENTS_DIR, `${sha256}.txt`)

  writeFileSync(storagePath, input.bytes)
  writeFileSync(extractedTextPath, extracted.text, 'utf8')

  const row = insertDocument({
    filename: input.filename,
    mime: input.mime,
    byteSize: input.bytes.byteLength,
    sha256,
    storagePath,
    extractedTextPath,
    pageCount: extracted.pages.length,
    status: 'extracted',
    conversationId: input.conversationId,
  })

  return { row, text: extracted.text, pages: extracted.pages, deduped: false }
}

/** Reads a stored document's extracted text back for context assembly. */
export function readDocumentText(row: DocumentRow): string {
  if (!row.extractedTextPath) return ''
  try {
    return readFileSync(row.extractedTextPath, 'utf8')
  } catch {
    // The file was removed underneath us. An empty attachment is better than a
    // crashed request; the caller reports it as unavailable.
    return ''
  }
}

/**
 * Resolves several document ids to their text in one pass.
 *
 * Rebuilding conversation history looks up every attachment ever sent, and the
 * same document can be linked to more than one message — so this reads each
 * unique file at most once rather than once per message that references it.
 */
export function readDocumentTexts(ids: string[]): Map<string, string> {
  const texts = new Map<string, string>()
  for (const id of ids) {
    if (texts.has(id)) continue
    const row = getDocument(id)
    texts.set(id, row ? readDocumentText(row) : '')
  }
  return texts
}
