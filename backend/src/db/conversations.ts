/**
 * Conversation and message persistence.
 *
 * Every query is a prepared statement created once at module load — SQLite
 * re-parses ad-hoc SQL on each call, and these run on the streaming path.
 */

import { db, newId, now } from './index.ts'
import type { Tier } from '../tiers.ts'

export interface ConversationRow {
  id: string
  title: string
  tier: Tier
  /** The collection this chat answers from, if any. Phase 9. */
  collectionId: string | null
  createdAt: string
  updatedAt: string
}

export interface MessageRow {
  id: string
  conversationId: string
  role: 'user' | 'assistant'
  content: string
  thinking?: string
  model?: string
  stats?: unknown
  stopped?: boolean
  createdAt: string
}

/* ------------------------------------------------------------- statements -- */

const stmts = {
  listConversations: db.prepare(`
    SELECT id, title, tier, collection_id AS collectionId,
           created_at AS createdAt, updated_at AS updatedAt
    FROM conversations
    ORDER BY updated_at DESC
  `),

  getConversation: db.prepare(`
    SELECT id, title, tier, collection_id AS collectionId,
           created_at AS createdAt, updated_at AS updatedAt
    FROM conversations WHERE id = ?
  `),

  insertConversation: db.prepare(`
    INSERT INTO conversations (id, title, tier, created_at, updated_at)
    VALUES (@id, @title, @tier, @createdAt, @updatedAt)
  `),

  touchConversation: db.prepare(`
    UPDATE conversations SET updated_at = @updatedAt, tier = @tier WHERE id = @id
  `),

  renameConversation: db.prepare(`
    UPDATE conversations SET title = @title, updated_at = @updatedAt WHERE id = @id
  `),

  deleteConversation: db.prepare('DELETE FROM conversations WHERE id = ?'),

  listMessages: db.prepare(`
    SELECT id, conversation_id AS conversationId, role, content, thinking, model,
           stats, stopped, created_at AS createdAt
    FROM messages
    WHERE conversation_id = ?
    ORDER BY created_at, rowid
  `),

  insertMessage: db.prepare(`
    INSERT INTO messages
      (id, conversation_id, role, content, thinking, model, stats, stopped, created_at)
    VALUES
      (@id, @conversationId, @role, @content, @thinking, @model, @stats, @stopped, @createdAt)
  `),

  updateMessage: db.prepare(`
    UPDATE messages
    SET content = @content, thinking = @thinking, stats = @stats, stopped = @stopped
    WHERE id = @id
  `),

  countMessages: db.prepare(
    'SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?',
  ),

  deleteMessage: db.prepare('DELETE FROM messages WHERE id = ?'),
}

/* ----------------------------------------------------------- conversations -- */

export function listConversations(): ConversationRow[] {
  return stmts.listConversations.all() as ConversationRow[]
}

export function getConversation(id: string): ConversationRow | undefined {
  return stmts.getConversation.get(id) as ConversationRow | undefined
}

export function createConversation(tier: Tier, title = 'New chat'): ConversationRow {
  const row: ConversationRow = {
    id: newId(),
    title,
    tier,
    collectionId: null,
    createdAt: now(),
    updatedAt: now(),
  }
  // `collectionId` is not in the INSERT — a new chat is linked afterwards, via
  // PATCH, if at all.
  const { collectionId: _unused, ...insertable } = row
  stmts.insertConversation.run(insertable)
  return row
}

/** Marks a conversation as just used, and records the tier it was used with. */
export function touchConversation(id: string, tier: Tier): void {
  stmts.touchConversation.run({ id, tier, updatedAt: now() })
}

export function renameConversation(id: string, title: string): ConversationRow | undefined {
  stmts.renameConversation.run({ id, title, updatedAt: now() })
  return getConversation(id)
}

export function deleteConversation(id: string): boolean {
  // `messages` cascades via the foreign key, with `foreign_keys = ON` set at
  // connection time.
  return stmts.deleteConversation.run(id).changes > 0
}

export function messageCount(conversationId: string): number {
  return (stmts.countMessages.get(conversationId) as { n: number }).n
}

/* ---------------------------------------------------------------- messages -- */

interface RawMessage {
  id: string
  conversationId: string
  role: 'user' | 'assistant'
  content: string
  thinking: string | null
  model: string | null
  stats: string | null
  stopped: number
  createdAt: string
}

function hydrate(row: RawMessage): MessageRow {
  return {
    id: row.id,
    conversationId: row.conversationId,
    role: row.role,
    content: row.content,
    ...(row.thinking ? { thinking: row.thinking } : {}),
    ...(row.model ? { model: row.model } : {}),
    ...(row.stats ? { stats: JSON.parse(row.stats) as unknown } : {}),
    ...(row.stopped ? { stopped: true } : {}),
    createdAt: row.createdAt,
  }
}

export function listMessages(conversationId: string): MessageRow[] {
  return (stmts.listMessages.all(conversationId) as RawMessage[]).map(hydrate)
}

export function insertMessage(input: {
  conversationId: string
  role: 'user' | 'assistant'
  content: string
  thinking?: string
  model?: string
  stats?: unknown
  stopped?: boolean
}): MessageRow {
  const id = newId()
  const createdAt = now()
  stmts.insertMessage.run({
    id,
    conversationId: input.conversationId,
    role: input.role,
    content: input.content,
    thinking: input.thinking ?? null,
    model: input.model ?? null,
    stats: input.stats ? JSON.stringify(input.stats) : null,
    stopped: input.stopped ? 1 : 0,
    createdAt,
  })
  return { id, createdAt, ...input }
}

/**
 * Removes a message row outright.
 *
 * Used when a generation fails before producing anything: the placeholder
 * assistant row would otherwise reload as a blank bubble.
 */
export function deleteMessage(id: string): void {
  stmts.deleteMessage.run(id)
}

/** Fills in an assistant row once its stream finishes (or is stopped). */
export function finishMessage(input: {
  id: string
  content: string
  thinking?: string
  stats?: unknown
  stopped?: boolean
}): void {
  stmts.updateMessage.run({
    id: input.id,
    content: input.content,
    thinking: input.thinking ?? null,
    stats: input.stats ? JSON.stringify(input.stats) : null,
    stopped: input.stopped ? 1 : 0,
  })
}
