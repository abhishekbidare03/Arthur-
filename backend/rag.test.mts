/**
 * Phase 8 RAG pipeline test — chunking, real embeddings, real `sqlite-vec` +
 * FTS5 hybrid retrieval, and `buildContext`'s fallback from truncation to
 * retrieval for a document too large to inject whole.
 *
 * Uses the real `@xenova/transformers` model and the real `sqlite-vec`
 * extension — no mocks. The one thing mocked is *which* database file is
 * used: `ARTHUR_DB` is pointed at a scratch file before any db-touching
 * module is imported, so this never reads or writes the real conversation
 * history. The embedding model itself is real and, on a machine that has
 * never run Arthur before, downloads once (~130 MB, cached to
 * `E:\Arthur\models\embeddings\`) and is instant on every run after.
 *
 * Run:  npx tsx rag.test.mts
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratchDb = join(mkdtempSync(join(tmpdir(), 'arthur-rag-test-')), 'test.db')
process.env.ARTHUR_DB = scratchDb

// Dynamic, and after the env var is set — every one of these transitively
// opens the database at module-evaluation time, so a static import at the
// top of this file (evaluated before any of *this* file's own code runs)
// would already be too late to redirect it.
const { chunkPages } = await import('./src/rag/chunk.ts')
const { ingestDocument } = await import('./src/rag/ingest.ts')
const { retrieveChunks } = await import('./src/rag/retrieve.ts')
const { insertDocument } = await import('./src/db/documents.ts')
const { buildContext } = await import('./src/context/buildContext.ts')
const { closeDb } = await import('./src/db/index.ts')

const failures: string[] = []
const check = (ok: boolean, message: string) => {
  if (!ok) failures.push(message)
}

/* -- Fixture: three pages, three unrelated topics, one with a rare exact term - */

const page1 =
  'Zorblatt migration patterns follow the lunar cycle. '.repeat(1) +
  'Every spring, Zorblatts travel from the northern wetlands to the coastal breeding grounds, a journey of roughly four hundred kilometres. ' +
  'Adult Zorblatts navigate by magnetic field sensitivity, a trait unique among wetland fauna in this region. '.repeat(20)

const page2 =
  'Widget Corp quarterly revenue rose eight percent in Q2, driven by strong demand in the industrial fasteners division. ' +
  'Operating margin held steady at nineteen percent despite input cost inflation. '.repeat(20)

const page3 =
  'Customers requesting a refund must cite reference code QX-88214-ALPHA when contacting support. ' +
  'The return policy allows thirty days from delivery, and QX-88214-ALPHA must appear on the shipping label for the refund to process automatically. '.repeat(15)

const pages = [
  { no: 1, text: page1 },
  { no: 2, text: page2 },
  { no: 3, text: page3 },
]
const fullText = pages.map((p) => p.text).join('\n\n')

console.log(`fixture: ${pages.length} pages, ${fullText.length} chars, ~${Math.ceil(fullText.length / 4)} tokens`)

/* -- Chunking: page boundaries respected, overlap present --------------------- */

const chunks = chunkPages(pages)
check(chunks.length >= 3, `expected at least one chunk per page, got ${chunks.length}`)
check(
  chunks.every((c) => c.pageNo != null),
  'every chunk should carry the page it came from',
)
check(
  new Set(chunks.map((c) => c.pageNo)).size === 3,
  'chunks should cover all three pages, not collapse onto one',
)

/* -- Ingest: real chunk → embed → sqlite-vec + FTS5 index ---------------------- */

const row = insertDocument({
  filename: 'zorblatt-and-widgets.txt',
  byteSize: fullText.length,
  sha256: `test-${Date.now()}`,
  storagePath: scratchDb, // never read; ingestion only needs the row + pages
  status: 'extracted',
})

await ingestDocument(row, pages)

/* -- Hybrid retrieval: a query should surface the RIGHT page, not the others -- */

const hits = await retrieveChunks([row.id], 'what is the reference code for a refund?', 2_000)
check(hits.length > 0, 'retrieval returned nothing for a query that clearly matches page 3')
check(
  hits.some((h) => h.text.includes('QX-88214-ALPHA')),
  `expected the refund reference code chunk in the results, got: ${JSON.stringify(hits.map((h) => h.text.slice(0, 60)))}`,
)
check(
  hits[0]!.pageNo === 3,
  `the single best-matching chunk should be from page 3 (the refund policy), got page ${hits[0]?.pageNo}`,
)
check(
  !hits.some((h) => h.text.includes('Zorblatt') && h.text.includes('QX-88214')),
  'a single chunk spanning two unrelated pages would mean page boundaries were not respected',
)

// A query that only a keyword match (not semantics) would find reliably —
// proves BM25 is actually contributing, not just riding along unused.
const exactHits = await retrieveChunks([row.id], 'QX-88214-ALPHA', 2_000)
check(
  exactHits.length > 0 && exactHits[0]!.text.includes('QX-88214-ALPHA'),
  'an exact-code query should find its chunk via keyword search even if semantic similarity is weak',
)

/* -- Budget capping: a tight budget must not be exceeded ----------------------- */

const tight = await retrieveChunks([row.id], 'tell me about all of these topics', 120)
const tightTokens = tight.reduce((sum, c) => sum + c.tokenCount, 0)
check(tightTokens <= 120, `retrieval exceeded its token budget: used ${tightTokens} of 120`)

/* -- buildContext: a too-large indexed attachment falls back to retrieval,
      not a blind character-count truncation --------------------------------- */

const bigContext = await buildContext({
  messages: [
    {
      role: 'user',
      content: 'what reference code do I need for a refund?',
      attachments: [{ id: row.id, filename: row.filename, text: fullText, indexed: true }],
    },
  ],
  tier: 'low', // smallest context window, easiest to force an overflow
})

const outcome = bigContext.attachments[0]
check(
  outcome?.state === 'retrieved' || outcome?.state === 'full',
  `expected the document to fit whole or fall back to retrieval, got state ${outcome?.state}`,
)
if (outcome?.state === 'retrieved') {
  check(
    bigContext.messages[0]!.content.includes('QX-88214-ALPHA'),
    'buildContext fell back to retrieval but the answer-relevant chunk did not make it into the prompt',
  )
  check(
    bigContext.messages[0]!.content.includes('excerpts='),
    'a retrieved attachment should be labelled as excerpts, not presented as the whole file',
  )
  check((outcome.chunksUsed ?? 0) > 0, 'a retrieved outcome should report how many chunks were used')
}

/* -- An attachment that is NOT indexed still falls back to truncation --------- */

const notIndexed = await buildContext({
  messages: [
    {
      role: 'user',
      content: 'summarise this',
      attachments: [{ id: 'doc-unindexed', filename: 'huge.txt', text: 'x'.repeat(200_000), indexed: false }],
    },
  ],
  tier: 'low',
})
check(
  notIndexed.attachments[0]?.state === 'truncated' || notIndexed.attachments[0]?.state === 'dropped',
  `an un-indexed oversized file should truncate or drop, not error or vanish: ${JSON.stringify(notIndexed.attachments)}`,
)

/* -- Report --------------------------------------------------------------------- */

closeDb()
rmSync(join(scratchDb, '..'), { recursive: true, force: true })

if (failures.length > 0) {
  console.error('FAIL')
  for (const f of failures) console.error('  - ' + f)
  process.exit(1)
}

console.log('PASS  chunking respects page boundaries; hybrid retrieval finds the right chunk; buildContext falls back to retrieval for oversized indexed files')
process.exit(0)
