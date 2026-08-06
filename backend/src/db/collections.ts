/**
 * Collections — Projects-style reusable document sets, Phase 9.
 *
 * The distinction that matters is *ownership*, and the schema already draws it:
 * a document belongs to either a conversation (attached to one chat, dies with
 * it) or a collection (ingested once, answers questions in every chat linked to
 * it). `documents.collection_id` and `documents.conversation_id` are the two
 * halves of that, and moving a document between them is the whole of "assign".
 */

import { db, newId, now } from './index.ts'
import type { DocumentRow } from './documents.ts'

export interface CollectionRow {
  id: string
  name: string
  description?: string
  createdAt: string
  /** How many documents it holds, so the list is useful without a second query. */
  documentCount: number
  /** How many of those are actually searchable. A collection whose files all
   *  failed to index looks identical to a working one without this. */
  indexedCount: number
}

const stmts = {
  list: db.prepare(`
    SELECT c.id, c.name, c.description, c.created_at AS createdAt,
           COUNT(d.id) AS documentCount,
           COALESCE(SUM(CASE WHEN d.status = 'indexed' THEN 1 ELSE 0 END), 0) AS indexedCount
    FROM collections c
    LEFT JOIN documents d ON d.collection_id = c.id
    GROUP BY c.id
    ORDER BY c.name COLLATE NOCASE
  `),

  get: db.prepare(`
    SELECT c.id, c.name, c.description, c.created_at AS createdAt,
           COUNT(d.id) AS documentCount,
           COALESCE(SUM(CASE WHEN d.status = 'indexed' THEN 1 ELSE 0 END), 0) AS indexedCount
    FROM collections c
    LEFT JOIN documents d ON d.collection_id = c.id
    WHERE c.id = ?
    GROUP BY c.id
  `),

  insert: db.prepare(`
    INSERT INTO collections (id, name, description, created_at)
    VALUES (@id, @name, @description, @createdAt)
  `),

  rename: db.prepare(`UPDATE collections SET name = @name, description = @description WHERE id = @id`),

  remove: db.prepare(`DELETE FROM collections WHERE id = ?`),

  documents: db.prepare(`
    SELECT id, collection_id AS collectionId, conversation_id AS conversationId, filename, mime,
           byte_size AS byteSize, sha256, storage_path AS storagePath,
           extracted_text_path AS extractedTextPath, page_count AS pageCount,
           status, created_at AS createdAt
    FROM documents WHERE collection_id = ?
    ORDER BY filename COLLATE NOCASE
  `),

  documentIds: db.prepare(`SELECT id FROM documents WHERE collection_id = ? AND status = 'indexed'`),

  /** Moves a document into a collection. `conversation_id` is cleared in the
   *  same statement: the schema's rule is that a document belongs to one or the
   *  other, and leaving both set would make "which chats can see this?"
   *  ambiguous. */
  assign: db.prepare(`
    UPDATE documents SET collection_id = @collectionId, conversation_id = NULL WHERE id = @id
  `),

  /** Finds a file already in this collection by content hash — what makes
   *  re-scanning a folder cheap rather than a full re-embed. */
  findInCollection: db.prepare(`
    SELECT id, collection_id AS collectionId, conversation_id AS conversationId, filename, mime,
           byte_size AS byteSize, sha256, storage_path AS storagePath,
           extracted_text_path AS extractedTextPath, page_count AS pageCount,
           status, created_at AS createdAt
    FROM documents WHERE collection_id = ? AND sha256 = ?
  `),

  setConversationCollection: db.prepare(`
    UPDATE conversations SET collection_id = @collectionId WHERE id = @id
  `),

  conversationCollection: db.prepare(`SELECT collection_id AS collectionId FROM conversations WHERE id = ?`),
}

export function listCollections(): CollectionRow[] {
  return stmts.list.all() as CollectionRow[]
}

export function getCollection(id: string): CollectionRow | undefined {
  return stmts.get.get(id) as CollectionRow | undefined
}

export function createCollection(name: string, description?: string): CollectionRow {
  const id = newId()
  stmts.insert.run({ id, name, description: description ?? null, createdAt: now() })
  return getCollection(id)!
}

export function updateCollection(
  id: string,
  name: string,
  description?: string,
): CollectionRow | undefined {
  stmts.rename.run({ id, name, description: description ?? null })
  return getCollection(id)
}

/**
 * Deletes a collection.
 *
 * `documents.collection_id` cascades, so the documents go too — which is the
 * honest reading of "delete this collection": the files were ingested *into*
 * it and belong to nothing else. Their chunks cascade in turn, and the index
 * rows those chunks leave behind are cleaned up by the caller.
 */
export function deleteCollection(id: string): boolean {
  return stmts.remove.run(id).changes > 0
}

export function documentsInCollection(collectionId: string): DocumentRow[] {
  return stmts.documents.all(collectionId) as DocumentRow[]
}

/** Only indexed documents: retrieval over a collection is the whole point, and
 *  a file that never indexed has nothing to retrieve from. */
export function indexedDocumentIds(collectionId: string): string[] {
  return (stmts.documentIds.all(collectionId) as { id: string }[]).map((r) => r.id)
}

export function assignDocument(documentId: string, collectionId: string): void {
  stmts.assign.run({ id: documentId, collectionId })
}

export function findInCollectionByHash(
  collectionId: string,
  sha256: string,
): DocumentRow | undefined {
  return stmts.findInCollection.get(collectionId, sha256) as DocumentRow | undefined
}

export function setConversationCollection(
  conversationId: string,
  collectionId: string | null,
): void {
  stmts.setConversationCollection.run({ id: conversationId, collectionId })
}

export function conversationCollection(conversationId: string): string | null {
  const row = stmts.conversationCollection.get(conversationId) as
    | { collectionId: string | null }
    | undefined
  return row?.collectionId ?? null
}
