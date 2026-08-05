-- Arthur schema, v1.
--
-- Created in full at Phase 3 even though Phases 4 and 8 are what fill most of
-- it. Adding these tables later would mean migrating every historical message;
-- creating them empty now costs nothing. See `docs/rag-architecture.md`.
--
-- Ids are text UUIDs rather than integers: they can be generated before the row
-- exists, which lets the API return an id without a round trip.
-- Timestamps are ISO-8601 text, matching what the frontend already carries.

-- Persistent, reusable document sets — Projects-style. Phase 9.
CREATE TABLE IF NOT EXISTS collections (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS conversations (
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  -- Which effort tier this chat was last used with, so reopening it never
  -- silently answers at a different effort level.
  tier          TEXT NOT NULL CHECK (tier IN ('low', 'medium', 'high')),
  collection_id TEXT REFERENCES collections (id) ON DELETE SET NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

-- The sidebar orders by recency on every render.
CREATE INDEX IF NOT EXISTS idx_conversations_updated ON conversations (updated_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  role            TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content         TEXT NOT NULL,
  -- Reasoning, kept separate from `content` exactly as Ollama returns it, so a
  -- reloaded conversation can re-render its thinking panel. Only the High tier
  -- ever populates this.
  thinking        TEXT,
  -- Which model produced this message. NULL for user messages. Needed so a
  -- reloaded chat can show which tier answered each turn.
  model           TEXT,
  -- Generation stats as JSON: latency, token counts, throughput. Phase 7's
  -- latency indicator reads this; a column avoids a migration then.
  stats           TEXT,
  -- Set when the user pressed Stop, so a partial answer is not mistaken for a
  -- complete one on reload.
  stopped         INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation
  ON messages (conversation_id, created_at);

-- A document belongs to EITHER a collection OR a conversation, never both.
CREATE TABLE IF NOT EXISTS documents (
  id                  TEXT PRIMARY KEY,
  collection_id       TEXT REFERENCES collections (id) ON DELETE CASCADE,
  conversation_id     TEXT REFERENCES conversations (id) ON DELETE CASCADE,
  filename            TEXT NOT NULL,
  mime                TEXT,
  byte_size           INTEGER NOT NULL,
  -- Content hash gives free deduplication: attach the same PDF twice, store once.
  sha256              TEXT NOT NULL,
  storage_path        TEXT NOT NULL,
  extracted_text_path TEXT,
  page_count          INTEGER,
  -- Drives the ingestion pipeline and gives the UI real failure states — a PDF
  -- that fails to parse must show as `failed`, never silently vanish.
  status              TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'extracted', 'indexed', 'failed')),
  created_at          TEXT NOT NULL,
  CHECK (collection_id IS NULL OR conversation_id IS NULL)
);

CREATE INDEX IF NOT EXISTS idx_documents_sha256 ON documents (sha256);

-- Phase 4: links an attachment to the message it was sent with.
CREATE TABLE IF NOT EXISTS message_documents (
  message_id  TEXT NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
  document_id TEXT NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
  PRIMARY KEY (message_id, document_id)
);

-- Phase 8: created empty now to avoid backfilling later.
CREATE TABLE IF NOT EXISTS chunks (
  id          TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
  ordinal     INTEGER NOT NULL,
  text        TEXT NOT NULL,
  page_no     INTEGER,
  char_start  INTEGER,
  char_end    INTEGER,
  token_count INTEGER
);

CREATE INDEX IF NOT EXISTS idx_chunks_document ON chunks (document_id, ordinal);

-- Phase 8: what makes inline citations possible. Backfilling this after the
-- fact would mean revisiting every historical message.
CREATE TABLE IF NOT EXISTS message_sources (
  message_id TEXT NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
  chunk_id   TEXT NOT NULL REFERENCES chunks (id) ON DELETE CASCADE,
  score      REAL,
  PRIMARY KEY (message_id, chunk_id)
);

-- NOTE: `chunk_vectors` is NOT created here.
-- It is a `sqlite-vec` virtual table — `vec0(embedding float[384])` — and the
-- extension is not loaded until Phase 8 installs it. Creating a virtual table
-- requires its module to be present, so this one genuinely cannot be created
-- early. Everything it references (`chunks`, `message_sources`) does exist, so
-- adding it later is additive rather than a migration.
