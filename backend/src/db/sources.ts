/**
 * `message_sources` — which passages an answer was actually given.
 *
 * Written after generation rather than before it, keyed to the assistant
 * message, so reopening a conversation shows the same citations it showed when
 * the answer first arrived. Without this the citation strip would exist only
 * for the lifetime of one SSE stream, and a reloaded chat would quietly lose
 * every source it had cited.
 *
 * The chunk *text* is not copied here. `chunks` holds it, and duplicating it
 * would mean a re-indexed document leaves its old citations pointing at text it
 * no longer contains. The foreign key cascades instead: delete the document and
 * its citations go with it, which is the honest outcome — the passage really is
 * gone.
 */

import { db } from './index.ts'

const stmts = {
  insert: db.prepare(`
    INSERT OR REPLACE INTO message_sources (message_id, chunk_id, score)
    VALUES (@messageId, @chunkId, @score)
  `),

  clear: db.prepare(`DELETE FROM message_sources WHERE message_id = ?`),

  /** Joined back to `chunks` and `documents` so a citation carries the filename
   *  and page it needs to be checkable, and the text it needs to be read. */
  forMessage: db.prepare(`
    SELECT s.chunk_id AS chunkId, s.score, c.text, c.page_no AS pageNo,
           c.document_id AS documentId, d.filename
    FROM message_sources s
    JOIN chunks c ON c.id = s.chunk_id
    JOIN documents d ON d.id = c.document_id
    WHERE s.message_id = ?
    ORDER BY s.score DESC
  `),

  /** One query for a whole conversation, matching `attachmentsForConversation`
   *  — a reload must not issue one query per message. */
  forConversation: db.prepare(`
    SELECT s.message_id AS messageId, s.chunk_id AS chunkId, s.score, c.text,
           c.page_no AS pageNo, c.document_id AS documentId, d.filename
    FROM message_sources s
    JOIN chunks c ON c.id = s.chunk_id
    JOIN documents d ON d.id = c.document_id
    JOIN messages m ON m.id = s.message_id
    WHERE m.conversation_id = ?
    ORDER BY s.score DESC
  `),
}

export interface StoredSource {
  chunkId: string
  documentId: string
  filename: string
  pageNo: number | null
  text: string
  score: number
}

export function recordSources(
  messageId: string,
  sources: { chunkId: string; score: number }[],
): void {
  // Cleared first so regenerating an answer does not leave the previous
  // answer's citations attached to the new one.
  stmts.clear.run(messageId)
  if (sources.length === 0) return

  const write = db.transaction((all: typeof sources) => {
    for (const source of all) {
      stmts.insert.run({ messageId, chunkId: source.chunkId, score: source.score })
    }
  })
  write(sources)
}

export function sourcesForMessage(messageId: string): StoredSource[] {
  return stmts.forMessage.all(messageId) as StoredSource[]
}

export function sourcesForConversation(conversationId: string): Map<string, StoredSource[]> {
  const rows = stmts.forConversation.all(conversationId) as (StoredSource & { messageId: string })[]

  const byMessage = new Map<string, StoredSource[]>()
  for (const { messageId, ...source } of rows) {
    const list = byMessage.get(messageId)
    if (list) list.push(source)
    else byMessage.set(messageId, [source])
  }
  return byMessage
}
