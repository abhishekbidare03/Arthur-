/**
 * Phase 9 — collections, folder ingest, and answering from a linked collection.
 *
 * Real embeddings, real `sqlite-vec`, real files on disk. Only the database
 * path and the ingest root are scratch.
 *
 * The behaviours worth pinning here are the ones that go wrong *quietly*:
 *
 *   * a folder walk that wanders into `node_modules` — nobody notices until a
 *     collection has 12,000 documents in it;
 *   * a re-scan that re-embeds everything, which turns a cheap operation into
 *     a several-minute one and looks identical while it runs;
 *   * folder ingest **stealing a document row a conversation owns**, because
 *     the content-addressed store hands back the existing row for identical
 *     bytes — the chat would then silently lose its attachment;
 *   * a collection whose passages never actually reach the model, which just
 *     looks like the model not knowing something.
 *
 * Run:  npx tsx collections.test.mts
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = mkdtempSync(join(tmpdir(), 'arthur-collections-'))
process.env.ARTHUR_DB = join(scratch, 'test.db')

const root = join(scratch, 'notes')
mkdirSync(join(root, 'sub'), { recursive: true })
mkdirSync(join(root, 'node_modules'), { recursive: true })

writeFileSync(
  join(root, 'rota.md'),
  '# On-call rota\n\nThe staging database password rotation window is Thursday at 03:00 UTC. ' +
    'Rotation is owned by the Platform team and requires no downtime.\n',
)
writeFileSync(
  join(root, 'sub', 'freight.md'),
  '# Freight operations\n\nThe emergency freight override code for the Kowloon depot is ' +
    'QX-7741-B. Only the duty supervisor may authorise its use.\n',
)
writeFileSync(join(root, 'node_modules', 'junk.md'), 'This must never be ingested.\n')
writeFileSync(join(root, 'photo.png'), Buffer.from('89504e470d0a1a0a', 'hex'))

const { ingestFolder } = await import('./src/rag/folder.ts')
const { buildContext } = await import('./src/context/buildContext.ts')
const { retrieveChunks } = await import('./src/rag/retrieve.ts')
const {
  createCollection,
  deleteCollection,
  documentsInCollection,
  getCollection,
  indexedDocumentIds,
} = await import('./src/db/collections.ts')
const { createConversation } = await import('./src/db/conversations.ts')
const { insertDocument } = await import('./src/db/documents.ts')
const { storeUpload } = await import('./src/documents/store.ts')
const { db, closeDb } = await import('./src/db/index.ts')
const { loadVectorExtension } = await import('./src/db/vectors.ts')

const failures: string[] = []
const check = (ok: boolean, message: string) => {
  if (!ok) failures.push(message)
}

/* -- Folder ingest ----------------------------------------------------------- */

const collection = createCollection('Ops handbook', 'Everything the duty team needs')
const first = await ingestFolder(root, collection.id)

check(first.added === 2, `expected 2 files ingested, got ${first.added}`)
check(first.failed.length === 0, `ingest reported failures: ${JSON.stringify(first.failed)}`)

const documents = documentsInCollection(collection.id)
check(
  !documents.some((d) => d.filename.includes('node_modules')),
  'the walk went into node_modules — a real folder would produce thousands of junk documents',
)
check(
  !documents.some((d) => d.filename.endsWith('.png')),
  'a binary image was handed to the extractor instead of being skipped',
)
check(
  documents.some((d) => d.filename.includes('sub')),
  'the path relative to the root was not kept, so two files with the same basename would collide',
)
check(
  documents.every((d) => d.status === 'indexed'),
  `not every ingested document indexed: ${JSON.stringify(documents.map((d) => [d.filename, d.status]))}`,
)

/* -- Re-scan is cheap -------------------------------------------------------- */

const second = await ingestFolder(root, collection.id)
check(
  second.added === 0 && second.unchanged === 2,
  `a re-scan of an unchanged folder should add nothing and recognise both files, got ${JSON.stringify(second)}`,
)
check(
  documentsInCollection(collection.id).length === 2,
  're-scanning duplicated the documents rather than recognising them by content',
)

/* -- A new file is picked up, the rest is not re-embedded -------------------- */

writeFileSync(
  join(root, 'escalation.md'),
  '# Escalation\n\nPayments incidents escalate to the on-call treasury engineer, never to the ' +
    'general platform rota.\n',
)
const third = await ingestFolder(root, collection.id)
check(
  third.added === 1 && third.unchanged === 2,
  `a re-scan after adding one file should add exactly that one, got ${JSON.stringify(third)}`,
)

/* -- Folder ingest must not steal a conversation's document ------------------ */
// The content-addressed store hands back an existing row for identical bytes,
// and `assignDocument` clears `conversation_id`. Left unguarded, ingesting a
// folder containing a file a chat had already attached would take it away from
// that chat, which would then answer about a file it no longer has.

const conversation = createConversation('low', 'Chat with an attachment')
const sharedBytes = Buffer.from('# Shared\n\nThe warehouse audit runs every second Tuesday.\n')
const attached = await storeUpload({
  filename: 'shared.md',
  bytes: sharedBytes,
  conversationId: conversation.id,
})
check(attached.row.conversationId === conversation.id, 'the fixture attachment was not stored against the conversation')

writeFileSync(join(root, 'shared.md'), sharedBytes)
await ingestFolder(root, collection.id)

const stolen = db
  .prepare('SELECT conversation_id AS conversationId, collection_id AS collectionId FROM documents WHERE id = ?')
  .get(attached.row.id) as { conversationId: string | null; collectionId: string | null }

check(
  stolen.conversationId === conversation.id && stolen.collectionId === null,
  'folder ingest took over the document row a conversation owned — that chat would lose its attachment',
)
check(
  documentsInCollection(collection.id).some((d) => d.filename === 'shared.md'),
  'the collection did not get its own copy of the shared file',
)

/* -- Search across a collection, independent of chat ------------------------ */

const hits = await retrieveChunks(
  indexedDocumentIds(collection.id),
  'emergency freight override code',
  4_000,
)
check(hits.length > 0, 'searching the collection returned nothing')
check(
  hits[0]!.text.includes('QX-7741-B'),
  `the best hit is not the passage holding the code: ${JSON.stringify(hits[0]?.text.slice(0, 60))}`,
)

/* -- A linked collection answers without anything being attached ------------ */

const context = await buildContext({
  messages: [{ role: 'user', content: 'What is the Kowloon depot freight override code?' }],
  tier: 'low',
  collection: { name: collection.name, documentIds: indexedDocumentIds(collection.id) },
})

const prompt = context.messages[0]!.content
check(
  prompt.includes('QX-7741-B'),
  'the collection passage that answers the question never reached the prompt',
)
check(
  prompt.includes('<knowledge'),
  'collection material is not marked as reference material, so the model would describe it as an attached file',
)
check(
  prompt.includes('collection="Ops handbook"'),
  'the knowledge block does not name its collection',
)
check(
  context.sources.some((s) => s.text.includes('QX-7741-B')),
  'collection passages are not reported as sources, so they could not be cited',
)
check(
  context.attachments.length === 0,
  'a collection is not an attachment and must not be reported as one',
)

/* -- Deleting a collection takes its documents and leaves no orphans -------- */

loadVectorExtension()
const orphansBefore = (
  db
    .prepare(
      `SELECT COUNT(*) n FROM chunk_vectors v
       WHERE NOT EXISTS (SELECT 1 FROM chunks c WHERE c.rowid = v.rowid)`,
    )
    .get() as { n: number }
).n
check(orphansBefore === 0, `the index was already inconsistent before the delete: ${orphansBefore}`)

deleteCollection(collection.id)
check(getCollection(collection.id) === undefined, 'the collection survived its own deletion')
check(
  documentsInCollection(collection.id).length === 0,
  'documents ingested into a deleted collection were left behind',
)
check(
  db.prepare('SELECT COUNT(*) n FROM documents WHERE id = ?').get(attached.row.id) !== undefined &&
    (db.prepare('SELECT COUNT(*) n FROM documents WHERE id = ?').get(attached.row.id) as { n: number })
      .n === 1,
  'deleting the collection also deleted the conversation’s own document',
)

console.log('\n--- collection --------------------------------------------------')
console.log(`  ingested        ${first.added} files, ${second.unchanged} recognised on re-scan`)
console.log(`  skipped         node_modules, .png`)
console.log(`  answered from   ${context.sources.length} collection passages, nothing attached`)
console.log('-----------------------------------------------------------------\n')

closeDb()
rmSync(scratch, { recursive: true, force: true })

if (failures.length > 0) {
  console.error('FAIL')
  for (const f of failures) console.error('  - ' + f)
  process.exit(1)
}

console.log('PASS  folder ingest skips junk and is cheap to repeat; a linked collection answers without attachments')
process.exit(0)
