/**
 * Arthur's local backend.
 *
 * Binds to 127.0.0.1 only — this is a personal app on one machine, and there is
 * no reason for it to be reachable from the network.
 */

import express from 'express'
import { MAX_UPLOAD_BYTES, PORT } from './config.ts'
import { closeDb } from './db/index.ts'
import {
  attachmentsForConversation,
  claimDocument,
  documentsForConversation,
  getDocument,
  linkMessageDocument,
} from './db/documents.ts'
import { UnreadableFileError, UnsupportedFileError } from './documents/extractors/index.ts'
import { readDocumentText, storeUpload } from './documents/store.ts'
import {
  createConversation,
  deleteConversation,
  deleteMessage,
  finishMessage,
  getConversation,
  insertMessage,
  listConversations,
  listMessages,
  messageCount,
  renameConversation,
  touchConversation,
} from './db/conversations.ts'
import { checkOllama, sendMessage } from './inference/ollama.ts'
import { InferenceError, type GenerationStats, type StreamEvent } from './inference/types.ts'
import { isTier, tierConfig } from './tiers.ts'
import { deriveTitle } from './titles.ts'

const app = express()
app.use(express.json({ limit: '1mb' }))

/**
 * Is Ollama up, and which models are pulled?
 *
 * The frontend polls this to decide whether to show the "Start Ollama" prompt.
 * Never starts Ollama itself — see `logs.md`, Session 1.
 */
app.get('/api/health', async (_req, res) => {
  res.json(await checkOllama())
})

/* ------------------------------------------------------------ conversations -- */

app.get('/api/conversations', (_req, res) => {
  res.json(listConversations())
})

app.post('/api/conversations', (req, res) => {
  const { tier } = req.body as { tier?: unknown }
  if (!isTier(tier)) {
    res.status(400).json({ error: 'Unknown tier.' })
    return
  }
  res.status(201).json(createConversation(tier))
})

app.get('/api/conversations/:id/messages', (req, res) => {
  const id = req.params.id
  if (!getConversation(id)) {
    res.status(404).json({ error: 'No such conversation.' })
    return
  }

  // Attachments come back with the messages so a reloaded chat still shows its
  // file chips. One query for the whole conversation, not one per message.
  const byMessage = attachmentsForConversation(id)
  res.json(
    listMessages(id).map((m) => {
      const attachments = byMessage.get(m.id)
      return attachments ? { ...m, attachments } : m
    }),
  )
})

app.patch('/api/conversations/:id', (req, res) => {
  const { title } = req.body as { title?: unknown }
  if (typeof title !== 'string' || title.trim().length === 0) {
    res.status(400).json({ error: 'title must be a non-empty string.' })
    return
  }
  const updated = renameConversation(req.params.id, title.trim().slice(0, 200))
  if (!updated) {
    res.status(404).json({ error: 'No such conversation.' })
    return
  }
  res.json(updated)
})

app.delete('/api/conversations/:id', (req, res) => {
  if (!deleteConversation(req.params.id)) {
    res.status(404).json({ error: 'No such conversation.' })
    return
  }
  res.status(204).end()
})

/* --------------------------------------------------------------- documents -- */

/**
 * Upload a file.
 *
 * Raw bytes in the body rather than multipart: it needs no parser dependency,
 * and it keeps binary fidelity for the PDFs Phase 8 will accept. The filename
 * travels in a header, URL-encoded, because it may contain non-ASCII — and a
 * header rather than a query string keeps it out of URLs and logs.
 *
 * The upload happens when the file is picked, not when the message is sent, so
 * an unsupported type is refused while the user can still do something about it.
 */
app.post(
  '/api/documents',
  express.raw({ type: '*/*', limit: MAX_UPLOAD_BYTES }),
  async (req, res) => {
    const rawName = req.get('X-Arthur-Filename')
    if (!rawName) {
      res.status(400).json({ error: 'Missing X-Arthur-Filename header.' })
      return
    }

    let filename: string
    try {
      filename = decodeURIComponent(rawName)
    } catch {
      res.status(400).json({ error: 'X-Arthur-Filename is not valid percent-encoding.' })
      return
    }

    // Defend the storage path against a crafted name. Files are stored under
    // their hash, so the name is only ever metadata — but it is still attacker-
    // influenced text and must never reach the filesystem.
    filename = filename.replace(/[\\/]/g, '_').slice(0, 255)

    const bytes = req.body as Buffer
    if (!Buffer.isBuffer(bytes) || bytes.byteLength === 0) {
      res.status(400).json({ error: 'The file is empty.' })
      return
    }

    const conversationId =
      typeof req.query.conversationId === 'string' && getConversation(req.query.conversationId)
        ? req.query.conversationId
        : undefined

    try {
      const { row, text, deduped } = await storeUpload({
        filename,
        bytes,
        mime: req.get('Content-Type') ?? undefined,
        conversationId,
      })

      res.status(201).json({
        id: row.id,
        filename: row.filename,
        byteSize: row.byteSize,
        status: row.status,
        // Shown on the chip so the cost of attaching is visible before sending,
        // not discovered as a truncation warning afterwards.
        estimatedTokens: Math.ceil(text.length / 4),
        deduped,
      })
    } catch (error) {
      // An unsupported type is a normal outcome, not a server fault — and the
      // message is the honest one ("PDF support arrives in Phase 8"), which the
      // UI shows verbatim.
      if (error instanceof UnsupportedFileError) {
        res.status(415).json({ error: error.message, extension: error.extension })
        return
      }
      if (error instanceof UnreadableFileError) {
        res.status(422).json({ error: error.message })
        return
      }
      console.error('[documents] upload failed:', error)
      res.status(500).json({ error: 'The file could not be stored.' })
    }
  },
)

/* -------------------------------------------------------------------- chat -- */

app.post('/api/chat', async (req, res) => {
  const body = req.body as {
    conversationId?: unknown
    content?: unknown
    tier?: unknown
    documentIds?: unknown
  }

  if (!isTier(body.tier)) {
    res.status(400).json({ error: 'Unknown tier.' })
    return
  }
  if (typeof body.content !== 'string' || body.content.trim().length === 0) {
    res.status(400).json({ error: 'content must be a non-empty string.' })
    return
  }

  const tier = body.tier
  const content = body.content.trim()

  // Attachments are resolved before the stream opens, so an id that does not
  // exist is a plain 400 rather than a half-streamed answer about nothing.
  const documentIds = Array.isArray(body.documentIds)
    ? body.documentIds.filter((id): id is string => typeof id === 'string')
    : []

  const uploaded = documentIds.map((id) => getDocument(id))
  if (uploaded.some((d) => d === undefined)) {
    res.status(400).json({ error: 'One of the attached files is no longer available.' })
    return
  }

  // Resolve the conversation before opening the stream, so a bad id is a plain
  // HTTP error rather than an SSE frame the UI has to special-case.
  let conversation =
    typeof body.conversationId === 'string' ? getConversation(body.conversationId) : undefined

  if (typeof body.conversationId === 'string' && !conversation) {
    res.status(404).json({ error: 'No such conversation.' })
    return
  }

  const isNew = !conversation
  conversation ??= createConversation(tier, deriveTitle(content))

  // A conversation created empty (via POST /api/conversations) still needs its
  // title on the first real message.
  if (!isNew && messageCount(conversation.id) === 0) {
    const renamed = renameConversation(conversation.id, deriveTitle(content))
    if (renamed) conversation = renamed
  }

  // History must be read *before* the new user row is written, then the new
  // message appended — otherwise the prompt would contain it twice.
  const history = listMessages(conversation.id).map((m) => ({ role: m.role, content: m.content }))

  const userMessage = insertMessage({ conversationId: conversation.id, role: 'user', content })
  touchConversation(conversation.id, tier)

  // Link the uploads to the message they were sent with, and adopt any that
  // were uploaded before this conversation existed. File *text* is never written
  // into the message — see `docs/rag-architecture.md`, seam 1.
  for (const document of uploaded) {
    claimDocument(document!.id, conversation.id)
    linkMessageDocument(userMessage.id, document!.id)
  }

  // Everything attached anywhere in this conversation, newest first — so a
  // follow-up question about a file attached two turns ago still works.
  const attachments = documentsForConversation(conversation.id)
    .map((document) => ({
      id: document.id,
      filename: document.filename,
      text: readDocumentText(document),
    }))
    .filter((a) => a.text.length > 0)

  // The assistant row is created empty up front so a partial answer survives a
  // crash or a closed window — it is filled in as the stream completes. The
  // model is recorded now rather than from the final stats, so even a stopped
  // or partial reply shows which tier produced it on reload.
  const assistantMessage = insertMessage({
    conversationId: conversation.id,
    role: 'assistant',
    content: '',
    model: tierConfig(tier).model,
  })

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  res.flushHeaders()

  const send = (
    event: StreamEvent | { type: 'error'; code: string; message: string; detail?: string } | {
      type: 'start'
      conversationId: string
      title: string
      userMessageId: string
      assistantMessageId: string
      createdAt: string
    },
  ) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`)
  }

  // Tells the client which rows it is streaming into, so it can reconcile its
  // optimistic state with the ids the database actually assigned.
  send({
    type: 'start',
    conversationId: conversation.id,
    title: conversation.title,
    userMessageId: userMessage.id,
    assistantMessageId: assistantMessage.id,
    createdAt: assistantMessage.createdAt,
  })

  // If the user closes the tab or hits Stop, abort the Ollama request too —
  // otherwise the model keeps generating into nothing and holds the GPU.
  //
  // This must listen on `res`, not `req`. `req` is the *request body* stream,
  // which `express.json()` has already consumed by the time this handler runs —
  // so `req.on('close')` fires immediately and aborts every generation before
  // it emits a single token. `res` closes only when the connection really goes.
  const controller = new AbortController()
  res.on('close', () => controller.abort())

  let answer = ''
  let reasoning = ''
  let stats: GenerationStats | undefined
  let failed = false

  try {
    const stream = sendMessage(
      { messages: [...history, { role: 'user', content }], tier, attachments },
      controller.signal,
    )

    for await (const event of stream) {
      if (event.type === 'content') answer += event.delta
      else if (event.type === 'thinking') reasoning += event.delta
      else if (event.type === 'done') stats = event.stats

      if (!res.writableEnded) send(event)
    }
  } catch (error) {
    const known = error instanceof InferenceError
    if (!known) console.error('[chat] unexpected failure:', error)

    // An abort is the user's own doing, not a failure worth reporting back —
    // and the connection is already gone.
    failed = !known || error.code !== 'aborted'

    if (failed && !res.writableEnded) {
      send({
        type: 'error',
        code: known ? error.code : 'unknown',
        message: known ? error.message : 'Something went wrong generating a response.',
        detail: known ? error.detail : undefined,
      })
    }
  } finally {
    const stopped = controller.signal.aborted && answer.length > 0

    if (answer.length === 0) {
      // Nothing usable was produced — an error, or a stop before the first
      // token. Keeping the placeholder would reload as a blank bubble, so it
      // is removed. The user's own message stays: they still said it.
      deleteMessage(assistantMessage.id)
    } else {
      finishMessage({
        id: assistantMessage.id,
        content: answer,
        thinking: reasoning || undefined,
        stats,
        stopped,
      })
    }

    if (!res.writableEnded) res.end()
  }
})

const server = app.listen(PORT, '127.0.0.1', () => {
  console.log(`Arthur backend  →  http://127.0.0.1:${PORT}`)
})

// Checkpoint the WAL on the way out so `arthur.db` is self-contained for backup.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close()
    closeDb()
    process.exit(0)
  })
}
