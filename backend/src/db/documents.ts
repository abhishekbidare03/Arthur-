/**
 * Document persistence — seam 1 of `docs/rag-architecture.md`.
 *
 * Documents are rows that *reference* stored files. Message content never
 * embeds document text: baking a file into `messages.content` would mean
 * migrating every historical message when Phase 8 switches to retrieval.
 */

import { db, newId, now } from './index.ts'

export interface DocumentRow {
  id: string
  conversationId?: string
  filename: string
  mime?: string
  byteSize: number
  sha256: string
  storagePath: string
  extractedTextPath?: string
  pageCount?: number
  status: 'pending' | 'extracted' | 'indexed' | 'failed'
  createdAt: string
}

const stmts = {
  insert: db.prepare(`
    INSERT INTO documents (
      id, conversation_id, filename, mime, byte_size, sha256,
      storage_path, extracted_text_path, page_count, status, created_at
    ) VALUES (
      @id, @conversationId, @filename, @mime, @byteSize, @sha256,
      @storagePath, @extractedTextPath, @pageCount, @status, @createdAt
    )
  `),

  get: db.prepare(`
    SELECT id, conversation_id AS conversationId, filename, mime,
           byte_size AS byteSize, sha256, storage_path AS storagePath,
           extracted_text_path AS extractedTextPath, page_count AS pageCount,
           status, created_at AS createdAt
    FROM documents WHERE id = ?
  `),

  /** Dedupe lookup. The hash is what makes attaching the same file twice free. */
  findByHash: db.prepare(`
    SELECT id, conversation_id AS conversationId, filename, mime,
           byte_size AS byteSize, sha256, storage_path AS storagePath,
           extracted_text_path AS extractedTextPath, page_count AS pageCount,
           status, created_at AS createdAt
    FROM documents WHERE sha256 = ? AND status = 'extracted'
    ORDER BY created_at DESC LIMIT 1
  `),

  /** A document uploaded before its conversation existed gets adopted on send. */
  claim: db.prepare(`
    UPDATE documents SET conversation_id = @conversationId
    WHERE id = @id AND conversation_id IS NULL
  `),

  link: db.prepare(`
    INSERT OR IGNORE INTO message_documents (message_id, document_id)
    VALUES (@messageId, @documentId)
  `),

  /** Attachments for one message, so a reloaded chat still shows its chips. */
  forMessage: db.prepare(`
    SELECT d.id, d.filename, d.byte_size AS byteSize, d.status
    FROM message_documents md
    JOIN documents d ON d.id = md.document_id
    WHERE md.message_id = ?
    ORDER BY d.created_at
  `),

  /** One query for a whole conversation, rather than one per message. */
  forConversation: db.prepare(`
    SELECT md.message_id AS messageId, d.id, d.filename,
           d.byte_size AS byteSize, d.status
    FROM message_documents md
    JOIN documents d ON d.id = md.document_id
    JOIN messages m ON m.id = md.message_id
    WHERE m.conversation_id = ?
    ORDER BY d.created_at
  `),
}

export interface AttachmentSummary {
  id: string
  filename: string
  byteSize: number
  status: string
}

export function insertDocument(input: {
  filename: string
  mime?: string
  byteSize: number
  sha256: string
  storagePath: string
  extractedTextPath?: string
  pageCount?: number
  status?: DocumentRow['status']
  conversationId?: string
}): DocumentRow {
  const row: DocumentRow = {
    id: newId(),
    conversationId: input.conversationId,
    filename: input.filename,
    mime: input.mime,
    byteSize: input.byteSize,
    sha256: input.sha256,
    storagePath: input.storagePath,
    extractedTextPath: input.extractedTextPath,
    pageCount: input.pageCount,
    status: input.status ?? 'extracted',
    createdAt: now(),
  }

  stmts.insert.run({
    ...row,
    conversationId: row.conversationId ?? null,
    mime: row.mime ?? null,
    extractedTextPath: row.extractedTextPath ?? null,
    pageCount: row.pageCount ?? null,
  })

  return row
}

export function getDocument(id: string): DocumentRow | undefined {
  return stmts.get.get(id) as DocumentRow | undefined
}

export function findExtractedByHash(sha256: string): DocumentRow | undefined {
  return stmts.findByHash.get(sha256) as DocumentRow | undefined
}

export function claimDocument(id: string, conversationId: string): void {
  stmts.claim.run({ id, conversationId })
}

export function linkMessageDocument(messageId: string, documentId: string): void {
  stmts.link.run({ messageId, documentId })
}

export function attachmentsForMessage(messageId: string): AttachmentSummary[] {
  return stmts.forMessage.all(messageId) as AttachmentSummary[]
}

/** Attachments for every message in a conversation, keyed by message id. */
export function attachmentsForConversation(
  conversationId: string,
): Map<string, AttachmentSummary[]> {
  const rows = stmts.forConversation.all(conversationId) as (AttachmentSummary & {
    messageId: string
  })[]

  const byMessage = new Map<string, AttachmentSummary[]>()
  for (const { messageId, ...attachment } of rows) {
    const list = byMessage.get(messageId)
    if (list) list.push(attachment)
    else byMessage.set(messageId, [attachment])
  }
  return byMessage
}
