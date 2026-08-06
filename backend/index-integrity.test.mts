/**
 * The retrieval index must survive a deleted conversation.
 *
 * This pins a bug that silently disabled retrieval for an entire phase, and it
 * is worth spelling out because nothing on screen ever said anything was wrong.
 *
 * `chunk_vectors` and `chunks_fts` are **virtual tables**, and a virtual table
 * cannot participate in a foreign key. So when deleting a conversation cascades
 * `conversations` -> `documents` -> `chunks`, both indexes keep every row.
 * SQLite then *reuses* the freed `chunks.rowid` values for the next document —
 * and those rowids are still occupied — so indexing fails on a UNIQUE
 * constraint. From the first conversation deletion onward, every upload fell
 * back to blind truncation, permanently.
 *
 * Two further faults made it invisible:
 *
 *   * the rollback in `ingestDocument` threw its own error ("cannot DELETE from
 *     contentless fts5 table") *over* the real one, so the log described the
 *     handler instead of the fault;
 *   * a document that fails to index is a legitimate state — `buildContext`
 *     degrades to truncation by design — so nothing surfaced.
 *
 * Real embeddings, real `sqlite-vec`, real FTS5. Only the database path is
 * redirected.
 *
 * Run:  npx tsx index-integrity.test.mts
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = mkdtempSync(join(tmpdir(), 'arthur-index-'))
process.env.ARTHUR_DB = join(scratch, 'index.db')

// Dynamic, after ARTHUR_DB is set: a static import would open the real
// database before this line ran.
const { db } = await import('./src/db/index.ts')
const { chunkPages } = await import('./src/rag/chunk.ts')
const { ingestDocument } = await import('./src/rag/ingest.ts')
const { retrieveChunks } = await import('./src/rag/retrieve.ts')
const { insertDocument, getDocument } = await import('./src/db/documents.ts')
const { createConversation, deleteConversation } = await import('./src/db/conversations.ts')
const { loadVectorExtension, pruneOrphanedIndexRows } = await import('./src/db/vectors.ts')

const failures: string[] = []
const check = (ok: boolean, message: string) => {
  if (!ok) failures.push(message)
}

const counts = () => {
  loadVectorExtension()
  const one = (sql: string) => (db.prepare(sql).get() as { n: number }).n
  return {
    chunks: one('SELECT COUNT(*) n FROM chunks'),
    vectors: one('SELECT COUNT(*) n FROM chunk_vectors'),
    fts: one('SELECT COUNT(*) n FROM chunks_fts'),
    orphans: one(
      `SELECT COUNT(*) n FROM chunk_vectors v
       WHERE NOT EXISTS (SELECT 1 FROM chunks c WHERE c.rowid = v.rowid)`,
    ),
  }
}

async function addDocument(filename: string, conversationId: string, pages: string[]) {
  const row = insertDocument({
    filename,
    byteSize: 1000,
    sha256: `${filename}-${Math.random()}`,
    storagePath: join(scratch, filename),
    status: 'extracted',
    conversationId,
  })
  await ingestDocument(
    row,
    pages.map((text, i) => ({ pageNo: i + 1, text })),
  )
  return row
}

/* -- 1. A first document indexes cleanly ------------------------------------ */

const convA = createConversation('low', 'First')
const docA = await addDocument('alpha.md', convA.id, [
  'The staging database password rotation window is Thursday at 03:00 UTC. ' +
    'Rotation is handled by the platform automation and requires no downtime.',
  'The incident review board meets on the first Monday of each month to go over ' +
    'every severity-one page raised in the preceding period.',
])

let state = counts()
check(state.chunks > 0, 'the first document produced no chunks at all')
check(
  state.chunks === state.vectors && state.chunks === state.fts,
  `indexes out of step after a clean ingest: ${JSON.stringify(state)}`,
)
check(
  getDocument(docA.id)?.status === 'indexed',
  `a cleanly ingested document is not marked indexed: ${getDocument(docA.id)?.status}`,
)

const chunksBefore = state.chunks

/* -- 2. Deleting the conversation strands the index ------------------------- */

deleteConversation(convA.id)

state = counts()
check(state.chunks === 0, `chunks did not cascade away with the conversation: ${state.chunks}`)
// This is the hazard itself. If this ever stops being true — because SQLite
// grew foreign keys for virtual tables, say — the rest of this test is
// asserting against a situation that can no longer arise, and should be
// revisited rather than quietly passing.
check(
  state.orphans === chunksBefore,
  `expected ${chunksBefore} stranded vector rows after the cascade, found ${state.orphans}`,
)

/* -- 3. A second document must still index --------------------------------- */
// The freed rowids start again at 1, landing exactly on the stranded rows.
// This is the insert that used to fail with a UNIQUE constraint and take
// retrieval down with it for good.

const convB = createConversation('low', 'Second')
let indexError: unknown = null
let docB
try {
  docB = await addDocument('beta.md', convB.id, [
    'The quarterly capacity review is scheduled for the second Wednesday and ' +
      'covers storage growth across every production cluster.',
    'Escalation for the payments service goes to the on-call treasury engineer, ' +
      'never to the general platform rota.',
  ])
} catch (error) {
  indexError = error
}

check(
  indexError === null,
  `indexing failed after a conversation was deleted — the original bug: ${String(indexError)}`,
)
check(
  docB !== undefined && getDocument(docB.id)?.status === 'indexed',
  'the second document did not reach `indexed`, so it would silently truncate instead of retrieve',
)

state = counts()
check(
  state.chunks === state.vectors && state.chunks === state.fts,
  `indexes out of step after re-use of freed rowids: ${JSON.stringify(state)}`,
)

/* -- 4. And it must retrieve its own content, not the deleted document's ---- */

if (docB) {
  const hits = await retrieveChunks([docB.id], 'who handles payments escalation?', 2000)
  check(hits.length > 0, 'retrieval returned nothing for a document that just indexed')
  check(
    hits.some((h) => /treasury/i.test(h.text)),
    `retrieval missed the passage that answers the question: ${JSON.stringify(hits.map((h) => h.text.slice(0, 50)))}`,
  )
  check(
    !hits.some((h) => /rotation window/i.test(h.text)),
    'a deleted document’s text came back from the index — stale rows are being matched',
  )
}

/* -- 5. Pruning is idempotent and leaves live rows alone -------------------- */

const before = counts()
const prunedAgain = pruneOrphanedIndexRows()
const after = counts()

check(prunedAgain === 0, `pruning a healthy index removed ${prunedAgain} rows it should not have`)
check(
  before.chunks === after.chunks && before.vectors === after.vectors && before.fts === after.fts,
  'pruning changed a consistent index',
)

/* -- 6. A contentless FTS5 table must actually accept DELETE ---------------- */
// The rollback path in `ingestDocument` depends on this, and a plain
// `content=''` table rejects it outright. If the flag is ever dropped from the
// CREATE, this fails here rather than three phases later.

let deleteWorked = true
try {
  db.prepare(`INSERT INTO chunks_fts (rowid, text) VALUES (?, ?)`).run(BigInt(999_999), 'scratch')
  db.prepare(`DELETE FROM chunks_fts WHERE rowid = ?`).run(BigInt(999_999))
} catch (error) {
  deleteWorked = false
  failures.push(`chunks_fts refuses DELETE, so failed ingests cannot roll back: ${String(error)}`)
}
if (deleteWorked) pruneOrphanedIndexRows()

console.log('\n--- index state ----------------------------------------------')
console.log(`  after clean ingest      ${chunksBefore} chunks, in step`)
console.log(`  after cascade delete    0 chunks, ${chunksBefore} stranded index rows`)
console.log(`  after second ingest     ${JSON.stringify(counts())}`)
console.log('---------------------------------------------------------------\n')

db.close()
rmSync(scratch, { recursive: true, force: true })

if (failures.length > 0) {
  console.error('FAIL')
  for (const f of failures) console.error('  - ' + f)
  process.exit(1)
}

console.log('PASS  index survives a cascade delete; freed rowids re-index; stale rows never match')
process.exit(0)
