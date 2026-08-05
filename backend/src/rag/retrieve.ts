/**
 * Hybrid retrieval — vector + FTS5 BM25, fused by reciprocal rank — seam 4's
 * payoff. This is what makes a document larger than the context window
 * genuinely work, instead of showing the model whichever prefix happened to
 * fit and calling the rest truncated.
 *
 * Scoped to an explicit set of document ids on every call. This is not
 * optional: it is the same guarantee `buildContext`'s per-turn attachment
 * anchoring makes for injected text — a conversation's *other* files must
 * never leak into an answer just because they were embedded into the same
 * database.
 */

import { chunkRowidsForDocuments, chunksByRowids } from '../db/chunks.ts'
import { searchFts, searchVectors } from '../db/vectors.ts'
import { embedQuery } from './embed.ts'
import { estimateTokens } from '../prompt.ts'

export interface RetrievedChunk {
  documentId: string
  filename: string
  pageNo: number | null
  text: string
  tokenCount: number
}

/** How many candidates each retrieval mode contributes before fusion. Wider
 *  than the final top-k so a chunk that one mode ranks low but the other
 *  ranks high still has a chance to surface. */
const CANDIDATES_PER_MODE = 20

/** Standard RRF damping constant — large enough that rank 1 vs. rank 2 is not
 *  a cliff, small enough that being in the top few still matters. */
const RRF_K = 60

/**
 * Retrieves the most relevant chunks from a scoped set of documents for a
 * query, budget-capped by tokens rather than a fixed count — five short
 * chunks and five long ones cost very different shares of the window, per
 * `docs/rag-architecture.md`.
 */
export async function retrieveChunks(
  documentIds: string[],
  query: string,
  tokenBudget: number,
): Promise<RetrievedChunk[]> {
  const scope = chunkRowidsForDocuments(documentIds)
  if (scope.length === 0 || tokenBudget <= 0) return []

  const queryVector = await embedQuery(query)
  const vectorHits = searchVectors(queryVector, CANDIDATES_PER_MODE, scope)
  const ftsHits = searchFts(query, CANDIDATES_PER_MODE, scope)

  // Reciprocal rank fusion: each list contributes 1/(RRF_K + rank) to a
  // chunk's combined score. Cosine distance and BM25 live on incomparable
  // scales, so fusing by *rank* rather than raw score is what lets keyword
  // hits (exact names, ids, rare terms) and semantic hits compete fairly —
  // this is the "hybrid materially outperforms vector-only" claim the
  // architecture doc makes, not just a way to combine two lists.
  const fused = new Map<number, number>()
  const addRanked = (hits: { rowid: number }[]) => {
    hits.forEach((hit, rank) => {
      fused.set(hit.rowid, (fused.get(hit.rowid) ?? 0) + 1 / (RRF_K + rank + 1))
    })
  }
  addRanked(vectorHits)
  addRanked(ftsHits)

  const ranked = [...fused.entries()].sort((a, b) => b[1] - a[1]).map(([rowid]) => rowid)
  const chunkMap = chunksByRowids(ranked)

  const out: RetrievedChunk[] = []
  let used = 0
  for (const rowid of ranked) {
    const chunk = chunkMap.get(rowid)
    if (!chunk) continue
    const cost = chunk.tokenCount ?? estimateTokens(chunk.text)
    if (used + cost > tokenBudget) continue // a later, shorter chunk may still fit
    out.push({
      documentId: chunk.documentId,
      filename: chunk.filename,
      pageNo: chunk.pageNo,
      text: chunk.text,
      tokenCount: cost,
    })
    used += cost
  }
  return out
}
