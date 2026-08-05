/**
 * Arthur's local backend.
 *
 * Binds to 127.0.0.1 only — this is a personal app on one machine, and there is
 * no reason for it to be reachable from the network.
 */

import express from 'express'
import { PORT } from './config.ts'
import { checkOllama, sendMessage } from './inference/ollama.ts'
import { InferenceError, type StreamEvent } from './inference/types.ts'
import { isTier } from './tiers.ts'
import type { ChatMessage } from './context/buildContext.ts'

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

app.post('/api/chat', async (req, res) => {
  const body = req.body as { messages?: unknown; tier?: unknown }

  if (!isTier(body.tier)) {
    res.status(400).json({ error: 'Unknown tier.' })
    return
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    res.status(400).json({ error: 'messages must be a non-empty array.' })
    return
  }

  const messages = body.messages as ChatMessage[]
  const tier = body.tier

  // SSE. `X-Accel-Buffering` and the explicit flush matter — without them the
  // first token can sit in a buffer and the UI looks frozen exactly when it
  // most needs to look alive.
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  res.flushHeaders()

  const send = (event: StreamEvent | { type: 'error'; code: string; message: string; detail?: string }) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`)
  }

  // If the user closes the tab or hits Stop, abort the Ollama request too —
  // otherwise the model keeps generating into nothing and holds the GPU.
  //
  // This must listen on `res`, not `req`. `req` is the *request body* stream,
  // which `express.json()` has already consumed by the time this handler runs —
  // so `req.on('close')` fires immediately and aborts every generation before
  // it emits a single token. `res` closes only when the connection really goes.
  const controller = new AbortController()
  res.on('close', () => controller.abort())

  try {
    for await (const event of sendMessage({ messages, tier }, controller.signal)) {
      if (res.writableEnded) break
      send(event)
    }
  } catch (error) {
    if (!res.writableEnded) {
      const known = error instanceof InferenceError
      if (!known) console.error('[chat] unexpected failure:', error)

      // The client is gone; there is nobody to tell.
      if (!known || error.code !== 'aborted') {
        send({
          type: 'error',
          code: known ? error.code : 'unknown',
          message: known ? error.message : 'Something went wrong generating a response.',
          detail: known ? error.detail : undefined,
        })
      }
    }
  } finally {
    if (!res.writableEnded) res.end()
  }
})

app.listen(PORT, '127.0.0.1', () => {
  console.log(`Arthur backend  →  http://127.0.0.1:${PORT}`)
})
