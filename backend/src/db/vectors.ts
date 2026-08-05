/**
 * Vector storage: `sqlite-vec`, loaded into the same `arthur.db` — seam 4 of
 * `docs/rag-architecture.md`. One file, one process, no Python.
 *
 * `chunk_vectors` cannot be created in `schema.sql`: a virtual table needs its
 * module loaded first, and `sqlite-vec` is a runtime extension, not something
 * SQLite ships with. This is the one piece of schema that has to live in code.
 *
 * Row linkage: `chunks.id` is a text UUID, but `vec0` tables require an
 * *integer* rowid. Rather than adding a second id column, this uses SQLite's
 * own implicit rowid on `chunks` — every ordinary table has one unless
 * declared `WITHOUT ROWID`, even when its declared primary key is text — so
 * `chunks_fts` and `chunk_vectors` both key off `chunks.rowid` directly, with
 * no mapping table to keep in sync.
 */

import * as sqliteVec from 'sqlite-vec'
import { db } from './index.ts'
import { EMBEDDING_DIMS } from '../rag/embed.ts'

let loaded = false

/** Idempotent — every function in this file calls it, so it runs exactly once
 *  no matter which one is hit first. */
export function loadVectorExtension(): void {
  if (loaded) return
  sqliteVec.load(db)

  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS chunk_vectors USING vec0(
    embedding float[${EMBEDDING_DIMS}]
  )`)

  // `content=''` (a "contentless" table) rather than `content='chunks'`: FTS5's
  // external-content mode requires the content table's rowid to be a real
  // INTEGER PRIMARY KEY, which `chunks.id` (TEXT PRIMARY KEY) is not. Storing
  // the text a second time here is a few KB per document — trivial next to a
  // model file — and it means BM25 search never has to join back to `chunks`
  // just to read what it already matched against.
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
    text, content=''
  )`)

  loaded = true
}

function toBuffer(vector: Float32Array): Buffer {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength)
}

// Statements are prepared lazily, inside each function, rather than once at
// module load. `chunk_vectors`/`chunks_fts` do not exist until
// `loadVectorExtension()` runs, and preparing against a table that is not
// there yet throws — every function below calls it first (a cheap no-op
// after the first call) so import order can never matter here.

export function insertChunkVector(rowid: number, embedding: Float32Array): void {
  loadVectorExtension()
  db.prepare(`INSERT INTO chunk_vectors (rowid, embedding) VALUES (?, ?)`).run(
    BigInt(rowid),
    toBuffer(embedding),
  )
}

export function insertChunkText(rowid: number, text: string): void {
  loadVectorExtension()
  db.prepare(`INSERT INTO chunks_fts (rowid, text) VALUES (?, ?)`).run(BigInt(rowid), text)
}

/** Removes a chunk's index entries — used when ingestion fails partway and
 *  retries, so a half-indexed document never leaves stale rows behind. */
export function deleteChunkIndex(rowid: number): void {
  loadVectorExtension()
  db.prepare(`DELETE FROM chunk_vectors WHERE rowid = ?`).run(BigInt(rowid))
  db.prepare(`DELETE FROM chunks_fts WHERE rowid = ?`).run(BigInt(rowid))
}

export interface ScoredRowid {
  rowid: number
  score: number
}

/**
 * K-nearest-neighbour search, optionally restricted to a set of chunk rowids
 * (used to scope retrieval to the documents actually attached to this turn —
 * a conversation's other, unrelated files must never leak into an answer).
 * `score` is cosine distance: lower is more similar.
 */
export function searchVectors(query: Float32Array, k: number, rowidFilter?: number[]): ScoredRowid[] {
  if (rowidFilter && rowidFilter.length === 0) return []

  const filterClause = rowidFilter ? `AND rowid IN (${rowidFilter.map(() => '?').join(',')})` : ''
  const rows = db
    .prepare(
      `SELECT rowid, distance FROM chunk_vectors
       WHERE embedding MATCH ? AND k = ? ${filterClause}
       ORDER BY distance`,
    )
    .all(toBuffer(query), k, ...(rowidFilter ?? [])) as { rowid: number; distance: number }[]

  return rows.map((r) => ({ rowid: r.rowid, score: r.distance }))
}

/**
 * BM25 keyword search, optionally restricted to a set of chunk rowids. FTS5
 * scores are negative (more negative = more relevant), matched here as-is —
 * callers only need the *rank order*, produced identically either way.
 */
export function searchFts(query: string, k: number, rowidFilter?: number[]): ScoredRowid[] {
  if (rowidFilter && rowidFilter.length === 0) return []
  // FTS5 query syntax treats bare punctuation as syntax; a plain user question
  // is safest passed as a quoted phrase-free OR-of-terms rather than raw.
  const terms = query
    .split(/\s+/)
    .map((t) => t.replace(/["*^]/g, ''))
    .filter(Boolean)
    .map((t) => `"${t}"`)
  if (terms.length === 0) return []

  const filterClause = rowidFilter ? `AND rowid IN (${rowidFilter.map(() => '?').join(',')})` : ''
  try {
    const rows = db
      .prepare(
        `SELECT rowid, bm25(chunks_fts) AS score FROM chunks_fts
         WHERE chunks_fts MATCH ? ${filterClause}
         ORDER BY score LIMIT ?`,
      )
      .all(terms.join(' OR '), ...(rowidFilter ?? []), k) as { rowid: number; score: number }[]
    return rows.map((r) => ({ rowid: r.rowid, score: r.score }))
  } catch {
    // A pathological query FTS5's parser rejects outright (rare, given the
    // term quoting above) — keyword search just contributes nothing rather
    // than failing the whole retrieval.
    return []
  }
}
