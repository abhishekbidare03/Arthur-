/**
 * Arthur's local backend.
 *
 * Binds to 127.0.0.1 only — this is a personal app on one machine, and there is
 * no reason for it to be reachable from the network.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import express from 'express'
import { APP_MODE, MAX_AUDIO_BYTES, MAX_UPLOAD_BYTES, PORT, WEB_DIR } from './config.ts'
import { closeDb } from './db/index.ts'
import {
  attachmentsForConversation,
  attachmentsForMessage,
  claimDocument,
  getDocument,
  linkMessageDocument,
} from './db/documents.ts'
import { UnreadableFileError, UnsupportedFileError } from './documents/extractors/index.ts'
import { readDocumentText, readDocumentTexts, storeUpload } from './documents/store.ts'
import { ingestDocument, reindexPending } from './rag/ingest.ts'
import { warmEmbeddings } from './rag/embed.ts'
import { MAX_AUDIO_SECONDS, transcribe, warmTranscription } from './voice/transcribe.ts'
import { UnreadableAudioError } from './voice/types.ts'
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
  type MessageRow,
} from './db/conversations.ts'
import { checkOllama, pullModel, sendMessage } from './inference/ollama.ts'
import { InferenceError, type GenerationStats, type StreamEvent } from './inference/types.ts'
import { isTier, tierConfig, TIER_CONFIG } from './tiers.ts'
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
  const status = await checkOllama()

  // Which tier models are actually pulled. Ollama reports names with an
  // explicit tag (`llama3.2:3b`), and so do the tier configs, so this is a
  // straight comparison — but a model pulled as `llama3.2:3b-instruct-q4_K_M`
  // is a different model and is correctly reported as missing.
  const required = Object.values(TIER_CONFIG).map((c) => c.model)
  const installed = new Set(status.installed ?? [])

  res.json({
    ...status,
    // Only meaningful when Ollama is up: an unreachable server has told us
    // nothing about what is pulled, and reporting all three as missing would
    // send the user to fix the wrong problem.
    missing: status.running ? required.filter((m) => !installed.has(m)) : [],
  })
})

/**
 * Pull a missing tier model, streaming progress as SSE.
 *
 * Setup, not runtime — see `pullModel`. The UI only offers this when
 * `/api/health` reports the model missing, which is the one moment where the
 * alternative is telling a user to open a terminal.
 */
app.post('/api/models/pull', async (req, res) => {
  const { model } = req.body as { model?: unknown }

  // Only the three tier models, never an arbitrary string from the client.
  // This route reaches the network, so what it can be asked to fetch is a fixed
  // list rather than whatever arrives in the body.
  const known = Object.values(TIER_CONFIG).map((c) => c.model)
  if (typeof model !== 'string' || !known.includes(model)) {
    res.status(400).json({ error: 'Not one of Arthur’s tier models.' })
    return
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  res.flushHeaders()

  const controller = new AbortController()
  res.on('close', () => controller.abort())

  try {
    for await (const progress of pullModel(model, controller.signal)) {
      if (res.writableEnded) break
      res.write(`data: ${JSON.stringify({ type: 'progress', ...progress })}\n\n`)
    }
    if (!res.writableEnded) res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`)
  } catch (error) {
    if (!controller.signal.aborted && !res.writableEnded) {
      const known = error instanceof InferenceError
      if (!known) console.error('[models] pull failed:', error)
      res.write(
        `data: ${JSON.stringify({
          type: 'error',
          message: known ? error.message : 'The download failed.',
        })}\n\n`,
      )
    }
  } finally {
    if (!res.writableEnded) res.end()
  }
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
      const { row, text, pages, deduped } = await storeUpload({
        filename,
        bytes,
        mime: req.get('Content-Type') ?? undefined,
        conversationId,
      })

      // Chunk and embed now, not lazily on first retrieval — the very next
      // request after this one can be the message that attaches this file,
      // and retrieval needs the index to already exist by then. Every upload
      // is indexed, not just ones that turn out too large to inject whole:
      // one code path, and the cost for a small file that will never need
      // retrieval is a few chunks' worth of CPU, not worth branching around.
      //
      // Failure here must not fail the upload — `ingestDocument` already
      // records `status: 'failed'` and `buildContext` falls back to
      // truncation for anything not indexed, so this is a real degradation
      // path, not a crash.
      let status = row.status
      try {
        await ingestDocument(row, pages)
        status = 'indexed'
      } catch (indexError) {
        console.error('[documents] indexing failed, falling back to truncation:', indexError)
      }

      res.status(201).json({
        id: row.id,
        filename: row.filename,
        byteSize: row.byteSize,
        status,
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

/* ------------------------------------------------------------------- voice -- */

/**
 * Transcribe a recording.
 *
 * Raw PCM WAV in the body, same shape as `POST /api/documents` — no multipart
 * parser dependency, and no base64 round-trip inflating audio by a third.
 *
 * The browser resamples to 16 kHz mono before uploading. That is not laziness
 * on the backend's part: Chrome has a full Opus decoder and resampler built in
 * (`OfflineAudioContext`), the backend does not, and shipping one to redo work
 * the browser already did would be a dependency bought for nothing. It also
 * cuts the upload to roughly a tenth of the raw capture.
 */
app.post(
  '/api/transcribe',
  express.raw({ type: '*/*', limit: MAX_AUDIO_BYTES }),
  async (req, res) => {
    const audio = req.body as Buffer
    if (!Buffer.isBuffer(audio) || audio.byteLength === 0) {
      res.status(400).json({ error: 'The recording is empty.' })
      return
    }

    try {
      const result = await transcribe({ audio })

      if (result.audioMs > MAX_AUDIO_SECONDS * 1000) {
        res.status(413).json({
          error: `That recording is ${Math.round(result.audioMs / 1000)} seconds long; the limit is ${MAX_AUDIO_SECONDS}.`,
        })
        return
      }

      // Silence, or a room tone whisper heard nothing in. Reported as its own
      // case rather than an empty string the UI would paste into the composer.
      if (result.text.length === 0) {
        res.status(422).json({ error: 'No speech was detected in that recording.' })
        return
      }

      console.log(
        `[voice] ${result.audioMs} ms audio → ${result.elapsedMs} ms transcribe ` +
          `(${(result.audioMs / Math.max(result.elapsedMs, 1)).toFixed(1)}× realtime)`,
      )
      res.json(result)
    } catch (error) {
      if (error instanceof UnreadableAudioError) {
        res.status(422).json({ error: error.message })
        return
      }
      console.error('[voice] transcription failed:', error)
      res.status(500).json({ error: 'That recording could not be transcribed.' })
    }
  },
)

/** Loads the speech model before it is needed, so the first mic press does not
 *  pay for it. Called by the UI when the mic button is first used — not at
 *  startup, since most sessions never record anything. */
app.post('/api/transcribe/warm', (_req, res) => {
  warmTranscription()
  res.status(202).end()
})

/* -------------------------------------------------------------------- chat -- */

app.post('/api/chat', async (req, res) => {
  const body = req.body as {
    conversationId?: unknown
    content?: unknown
    tier?: unknown
    documentIds?: unknown
    regenerate?: unknown
  }

  if (!isTier(body.tier)) {
    res.status(400).json({ error: 'Unknown tier.' })
    return
  }

  /**
   * Re-answer the last question instead of asking a new one.
   *
   * The message being answered already exists, so nothing is re-typed and no
   * file is re-uploaded — the point of the feature is precisely that switching
   * tier should cost nothing but the wait. The stale answer is deleted rather
   * than kept alongside the new one: this is "answer that again", not a
   * branching history, and two answers to one question in a linear transcript
   * is a different (larger) feature than the one asked for.
   */
  const regenerate = body.regenerate === true

  if (!regenerate && (typeof body.content !== 'string' || body.content.trim().length === 0)) {
    res.status(400).json({ error: 'content must be a non-empty string.' })
    return
  }
  if (regenerate && typeof body.conversationId !== 'string') {
    res.status(400).json({ error: 'regenerate needs an existing conversation.' })
    return
  }

  const tier = body.tier

  // Attachments are resolved before the stream opens, so an id that does not
  // exist is a plain 400 rather than a half-streamed answer about nothing.
  const documentIds =
    !regenerate && Array.isArray(body.documentIds)
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
  const draftTitle = typeof body.content === 'string' ? deriveTitle(body.content.trim()) : 'New chat'
  conversation ??= createConversation(tier, draftTitle)

  // A conversation created empty (via POST /api/conversations) still needs its
  // title on the first real message.
  if (!isNew && !regenerate && messageCount(conversation.id) === 0) {
    const renamed = renameConversation(conversation.id, draftTitle)
    if (renamed) conversation = renamed
  }

  /*
   * History must be read *before* the new user row is written, then the new
   * message appended — otherwise the prompt would contain it twice.
   *
   * Each earlier turn carries its own attachments — the file(s) it was sent
   * with, not every file ever attached anywhere in the conversation. Gluing
   * every attachment onto the newest message was the original design here,
   * and it caused a real bug: attach file A, ask about it, attach a
   * *different* file B and ask "what is this" — both files landed on the
   * question with nothing to say which one "this" meant, and the model could
   * answer about the wrong one. Positioning a file next to the question it
   * was actually sent with is what makes that unambiguous, and it is what a
   * real conversation looks like.
   */
  const stored = listMessages(conversation.id)

  let content: string
  let userMessage: MessageRow
  let priorRows: MessageRow[]
  /** Document ids attached to the turn being answered. */
  let turnDocumentIds: string[]

  if (regenerate) {
    // Drop the answer being replaced. Only a trailing *assistant* row is
    // removed — a conversation whose last row is a user message is one whose
    // generation already failed, and re-answering it is exactly right.
    const last = stored[stored.length - 1]
    if (last?.role === 'assistant') {
      deleteMessage(last.id)
      stored.pop()
    }

    const target = stored.pop()
    if (!target || target.role !== 'user') {
      res.status(400).json({ error: 'There is no question here to answer again.' })
      return
    }

    content = target.content
    userMessage = target
    priorRows = stored
    turnDocumentIds = (attachmentsForMessage(target.id) ?? []).map((a) => a.id)
  } else {
    content = (body.content as string).trim()
    priorRows = stored
    userMessage = insertMessage({ conversationId: conversation.id, role: 'user', content })
    turnDocumentIds = documentIds

    // Link the uploads to the message they were sent with, and adopt any that
    // were uploaded before this conversation existed. File *text* is never
    // written into the message — see `docs/rag-architecture.md`, seam 1.
    for (const document of uploaded) {
      claimDocument(document!.id, conversation.id)
      linkMessageDocument(userMessage.id, document!.id)
    }
  }

  touchConversation(conversation.id, tier)

  const priorAttachments = attachmentsForConversation(conversation.id)
  const priorTexts = readDocumentTexts([...priorAttachments.values()].flat().map((a) => a.id))

  const history = priorRows.map((m) => {
    const files = priorAttachments.get(m.id)
    const attachments = files
      ?.map((f) => ({
        id: f.id,
        filename: f.filename,
        text: priorTexts.get(f.id) ?? '',
        indexed: f.status === 'indexed',
      }))
      .filter((f) => f.text.length > 0)
    return { role: m.role, content: m.content, ...(attachments?.length ? { attachments } : {}) }
  })

  const attachments = turnDocumentIds
    .map((id) => getDocument(id))
    .filter((document) => document !== undefined)
    .map((document) => ({
      id: document.id,
      filename: document.filename,
      text: readDocumentText(document),
      // Re-read fresh rather than trusting the upload response: ingestion can
      // still be running for a file attached and sent in quick succession,
      // and `buildContext` needs to know the *current* state to decide
      // whether retrieval is actually available.
      indexed: document.status === 'indexed',
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
      {
        messages: [
          ...history,
          { role: 'user', content, ...(attachments.length > 0 ? { attachments } : {}) },
        ],
        tier,
      },
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

/* ---------------------------------------------------------------- the app -- */

/**
 * In app mode this process *is* the app: it serves the built UI as well as the
 * API, on one port, from one window. No Vite, no proxy, no second terminal.
 *
 * Registered last so it can never shadow an API route — a static handler that
 * ran first would happily answer `/api/health` with `index.html` if a file of
 * that name ever appeared in the build.
 */
if (APP_MODE) {
  if (!existsSync(join(WEB_DIR, 'index.html'))) {
    console.error(`No UI build found at ${WEB_DIR}. Run setup.bat, or "npm run build" in frontend/.`)
    process.exit(1)
  }

  // Hashed filenames are immutable, so they can be cached hard; index.html must
  // not be, or a rebuilt app keeps loading the previous bundle.
  app.use(express.static(WEB_DIR, { index: false, maxAge: '1y' }))

  app.get(/.*/, (req, res, next) => {
    if (req.path.startsWith('/api/')) {
      next()
      return
    }
    res.setHeader('Cache-Control', 'no-store')
    res.sendFile(join(WEB_DIR, 'index.html'))
  })
}

const server = app.listen(PORT, '127.0.0.1', () => {
  console.log(
    APP_MODE
      ? `Arthur  →  http://localhost:${PORT}`
      : `Arthur backend  →  http://127.0.0.1:${PORT}`,
  )
  // Loads the embedding model in the background so the first upload or the
  // first retrieval isn't the request that pays the cold-start cost, then
  // repairs any document left unindexed by an earlier failure. Both are
  // deliberately after `listen`: neither should delay the app being usable.
  warmEmbeddings()
  void reindexPending()
})

// A stale copy still holding the port is the most likely startup failure once
// there is a double-clickable launcher, and the default `EADDRINUSE` stack
// trace flashes past in a window that closes. Say what it means instead.
server.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use — Arthur is probably already running.`)
    process.exit(1)
  }
  throw error
})

// Checkpoint the WAL on the way out so `arthur.db` is self-contained for backup.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close()
    closeDb()
    process.exit(0)
  })
}
