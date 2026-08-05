/**
 * Chunking — the first step of Phase 8 retrieval.
 *
 * `docs/rag-architecture.md`: "~500 tokens with ~80 tokens of overlap, split on
 * paragraph and page boundaries rather than blindly by character count." A
 * chunk that cuts a sentence in half embeds worse than one that respects the
 * document's own structure, and citations need a page number per chunk.
 */

import { estimateTokens } from '../prompt.ts'
import type { ExtractedPage } from '../documents/extractors/types.ts'

export interface Chunk {
  text: string
  pageNo: number | undefined
  charStart: number
  charEnd: number
  tokenCount: number
}

const TARGET_TOKENS = 500
const OVERLAP_TOKENS = 80
/** ~4 chars/token, the same rule of thumb `estimateTokens` uses. */
const TARGET_CHARS = TARGET_TOKENS * 4
const OVERLAP_CHARS = OVERLAP_TOKENS * 4

/** Splits on blank lines first, falling back to single newlines for a page
 *  that has no paragraph breaks at all (a dense PDF text layer, for example). */
function paragraphs(text: string): string[] {
  const byBlank = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)
  if (byBlank.length > 1) return byBlank
  return text.split('\n').map((p) => p.trim()).filter(Boolean)
}

/**
 * Packs a page's paragraphs into chunks close to `TARGET_CHARS`, carrying the
 * tail of one chunk into the start of the next so a fact split across a
 * paragraph boundary still appears whole in at least one chunk.
 */
function packPage(page: ExtractedPage, offset: number): Chunk[] {
  const paras = paragraphs(page.text)
  if (paras.length === 0) return []

  const chunks: Chunk[] = []
  let current: string[] = []
  let currentChars = 0

  const flush = () => {
    if (current.length === 0) return
    const text = current.join('\n\n')
    chunks.push({
      text,
      pageNo: page.no,
      charStart: offset,
      charEnd: offset + text.length,
      tokenCount: estimateTokens(text),
    })
  }

  for (const para of paras) {
    // A single paragraph longer than a whole chunk (a wall-of-text page, or a
    // page with no paragraph breaks) still has to be split, or it would blow
    // the retrieval budget on its own.
    if (para.length > TARGET_CHARS) {
      flush()
      current = []
      currentChars = 0
      for (let i = 0; i < para.length; i += TARGET_CHARS - OVERLAP_CHARS) {
        const slice = para.slice(i, i + TARGET_CHARS)
        chunks.push({
          text: slice,
          pageNo: page.no,
          charStart: offset + i,
          charEnd: offset + i + slice.length,
          tokenCount: estimateTokens(slice),
        })
      }
      continue
    }

    if (currentChars + para.length > TARGET_CHARS && current.length > 0) {
      flush()
      // Overlap: carry the tail of the just-flushed chunk forward so context
      // does not vanish at the seam.
      const tail = current.join('\n\n')
      const carry = tail.length > OVERLAP_CHARS ? tail.slice(-OVERLAP_CHARS) : tail
      current = carry ? [carry] : []
      currentChars = carry.length
    }

    current.push(para)
    currentChars += para.length
  }

  flush()
  return chunks
}

/** Chunks a whole document's pages. Page boundaries are respected — a chunk
 *  never spans two pages, so every chunk keeps one honest citation. */
export function chunkPages(pages: ExtractedPage[]): Chunk[] {
  const chunks: Chunk[] = []
  let offset = 0
  for (const page of pages) {
    chunks.push(...packPage(page, offset))
    offset += page.text.length
  }
  return chunks
}
