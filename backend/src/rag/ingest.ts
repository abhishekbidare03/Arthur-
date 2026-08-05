/**
 * Turns an extracted document into searchable chunks — chunk, embed, index.
 * Runs once per document (content-addressed dedup means a re-attached file
 * never reaches here twice with the same hash).
 */

import { chunkPages } from './chunk.ts'
import { embedTexts } from './embed.ts'
import {
  chunkCountForDocument,
  clearChunksForDocument,
  insertChunkRow,
} from '../db/chunks.ts'
import { insertChunkText, insertChunkVector } from '../db/vectors.ts'
import { setDocumentStatus, type DocumentRow } from '../db/documents.ts'
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
  if (chunkCountForDocument(row.id) > 0) return // already indexed (dedup hit)

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
    clearChunksForDocument(row.id)
    setDocumentStatus(row.id, 'failed')
    throw error
  }
}
