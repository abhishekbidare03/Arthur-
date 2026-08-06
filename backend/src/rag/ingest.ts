/**
 * Turns an extracted document into searchable chunks — chunk, embed, index.
 * Runs once per document (content-addressed dedup means a re-attached file
 * never reaches here twice with the same hash).
 */

import { readFileSync } from 'node:fs'
import { chunkPages } from './chunk.ts'
import { embedTexts } from './embed.ts'
import {
  chunkCountForDocument,
  clearChunksForDocument,
  insertChunkRow,
} from '../db/chunks.ts'
import { insertChunkText, insertChunkVector } from '../db/vectors.ts'
import { documentsNeedingIndex, setDocumentStatus, type DocumentRow } from '../db/documents.ts'
import { extract } from '../documents/extractors/index.ts'
import type { ExtractedPage } from '../documents/extractors/types.ts'

/** Chunks per embedding call. Batching amortizes the model call; 32 keeps a
 *  single batch's memory small on a machine whose GPU-adjacent CPU/RAM budget
 *  is already tight from running a chat model at the same time. */
const EMBED_BATCH = 32

/**
 * Indexes a document for retrieval. Safe to call for every upload — small
 * files that will always fit whole get indexed too, at negligible cost, so
 * there is exactly one code path rather than a size-based fork that has to
 * be tested twice.
 *
 * Failures are caught and recorded as `documents.status = 'failed'` rather
 * than thrown to the caller: an embedding failure must not block the upload
 * itself, only retrieval for that one file. `buildContext` already falls
 * back to truncation for any attachment that is not indexed, so this is a
 * genuine degradation, not a broken feature.
 */
export async function ingestDocument(row: DocumentRow, pages: ExtractedPage[]): Promise<void> {
  if (chunkCountForDocument(row.id) > 0) {
    // Already chunked — a dedup hit, or a re-attach of a file indexed earlier.
    // The status is re-asserted rather than assumed: a row can carry chunks and
    // still say `extracted` if it was written before a later step failed, and
    // leaving it saying that would keep retrieval switched off for a document
    // that is perfectly well indexed.
    setDocumentStatus(row.id, 'indexed')
    return
  }

  const chunks = chunkPages(pages)
  if (chunks.length === 0) {
    setDocumentStatus(row.id, 'indexed') // nothing to chunk, trivially "done"
    return
  }

  try {
    for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
      const batch = chunks.slice(i, i + EMBED_BATCH)
      const vectors = await embedTexts(batch.map((c) => c.text))
      batch.forEach((chunk, j) => {
        const rowid = insertChunkRow(row.id, i + j, chunk)
        insertChunkVector(rowid, vectors[j]!)
        insertChunkText(rowid, chunk.text)
      })
    }
    setDocumentStatus(row.id, 'indexed')
  } catch (error) {
    // Partial index is worse than none — a chunk with no vector would match
    // nothing, silently, forever.
    //
    // The cleanup must never throw over the failure it is cleaning up after.
    // It did, once, and the cost was real: a UNIQUE constraint failure on
    // `chunk_vectors` was replaced by "cannot DELETE from contentless fts5
    // table" from this very line, so the log described the handler instead of
    // the fault, and the actual cause went unfound while every upload silently
    // fell back to truncation.
    try {
      clearChunksForDocument(row.id)
    } catch (cleanupError) {
      console.error('[rag] could not roll back a failed index:', cleanupError)
    }
    setDocumentStatus(row.id, 'failed')
    throw error
  }
}

/**
 * Re-indexes a document from the bytes already on disk.
 *
 * Re-extracts rather than storing `pages` in the database: the original file is
 * kept content-addressed anyway, extraction is deterministic, and a second copy
 * of every PDF's page text would be state to keep in step for no gain.
 */
export async function reindexDocument(row: DocumentRow): Promise<void> {
  clearChunksForDocument(row.id)
  const bytes = readFileSync(row.storagePath)
  const extracted = await extract(bytes, row.filename)
  await ingestDocument({ ...row, status: 'extracted' }, extracted.pages)
}

/**
 * Re-indexes everything that is not currently indexed, in the background.
 *
 * Called once at startup. Its reason for existing is a bug that was invisible
 * for a full phase: orphaned index rows (see `pruneOrphanedIndexRows`) made
 * every upload fail to index, and each one was recorded as a document that
 * quietly falls back to truncation. Fixing the cause does not fix the
 * documents already in that state, and asking someone to re-upload files
 * Arthur already has is not a repair.
 *
 * Sequential on purpose: this competes with a chat model for the same CPU, and
 * a startup that saturates it to rebuild an index nobody has asked for yet is
 * a worse trade than one that takes longer.
 */
export async function reindexPending(): Promise<void> {
  const pending = documentsNeedingIndex()
  if (pending.length === 0) return

  console.log(`[rag] re-indexing ${pending.length} document(s) left unindexed`)
  for (const row of pending) {
    try {
      await reindexDocument(row)
    } catch (error) {
      console.error(`[rag] could not re-index ${row.filename}:`, error)
    }
  }
}
