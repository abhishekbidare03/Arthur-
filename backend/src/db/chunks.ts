/**
 * Chunk persistence. `chunks` rows carry the citation metadata (page, ordinal,
 * character span); the vector and BM25 indexes in `db/vectors.ts` are keyed to
 * the same rows by SQLite's own implicit rowid — see that file's header.
 */

import { db, newId } from './index.ts'
import { deleteChunkIndex } from './vectors.ts'
import type { Chunk } from '../rag/chunk.ts'

const stmts = {
  insert: db.prepare(`
    INSERT INTO chunks (id, document_id, ordinal, text, page_no, char_start, char_end, token_count)
    VALUES (@id, @documentId, @ordinal, @text, @pageNo, @charStart, @charEnd, @tokenCount)
  `),

  forRowids: (placeholders: string) =>
    db.prepare(`
      SELECT c.rowid AS rowid, c.id, c.document_id AS documentId, c.ordinal, c.text,
             c.page_no AS pageNo, c.token_count AS tokenCount, d.filename AS filename
      FROM chunks c
      JOIN documents d ON d.id = c.document_id
      WHERE c.rowid IN (${placeholders})
    `),

  countForDocument: db.prepare(`SELECT COUNT(*) AS n FROM chunks WHERE document_id = ?`),

  rowidsForDocument: db.prepare(`SELECT rowid AS rowid FROM chunks WHERE document_id = ?`),

  clearForDocument: db.prepare(`DELETE FROM chunks WHERE document_id = ?`),
}

export interface ChunkRow {
  rowid: number
  id: string
  documentId: string
  ordinal: number
  text: string
  pageNo: number | null
  tokenCount: number | null
}

export interface ChunkWithSource extends ChunkRow {
  filename: string
}

/** Inserts one chunk row and returns its rowid — the integer the vector and
 *  FTS indexes are keyed to. */
export function insertChunkRow(documentId: string, ordinal: number, chunk: Chunk): number {
  const info = stmts.insert.run({
    id: newId(),
    documentId,
    ordinal,
    text: chunk.text,
    pageNo: chunk.pageNo ?? null,
    charStart: chunk.charStart,
    charEnd: chunk.charEnd,
    tokenCount: chunk.tokenCount,
  })
  return Number(info.lastInsertRowid)
}

/** Rowids already indexed for a document — used to make re-ingestion a no-op
 *  rather than a duplicate index. */
export function chunkCountForDocument(documentId: string): number {
  return (stmts.countForDocument.get(documentId) as { n: number }).n
}

/** Wipes a document's chunks and their index entries — used if ingestion is
 *  retried after a partial failure, so stale rows never linger. */
export function clearChunksForDocument(documentId: string): void {
  const rowids = stmts.rowidsForDocument.all(documentId) as { rowid: number }[]
  for (const { rowid } of rowids) deleteChunkIndex(rowid)
  stmts.clearForDocument.run(documentId)
}

/** Rowids for every chunk belonging to a set of documents — the scope
 *  retrieval passes to `searchVectors`/`searchFts` so one conversation's
 *  unrelated files can never leak into an answer. */
export function chunkRowidsForDocuments(documentIds: string[]): number[] {
  if (documentIds.length === 0) return []
  const placeholders = documentIds.map(() => '?').join(',')
  const rows = db
    .prepare(`SELECT rowid AS rowid FROM chunks WHERE document_id IN (${placeholders})`)
    .all(...documentIds) as { rowid: number }[]
  return rows.map((r) => r.rowid)
}

/** Resolves a set of rowids back to their chunk text and citation metadata. */
export function chunksByRowids(rowids: number[]): Map<number, ChunkWithSource> {
  const out = new Map<number, ChunkWithSource>()
  if (rowids.length === 0) return out
  const placeholders = rowids.map(() => '?').join(',')
  const rows = stmts.forRowids(placeholders).all(...rowids) as ChunkWithSource[]
  for (const row of rows) out.set(row.rowid, row)
  return out
}
