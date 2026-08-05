/**
 * Regression test for streamed replies rendering.
 *
 * Renders the real App against a mocked backend and asserts the streamed text
 * actually reaches the DOM. Exists because two separate bugs silently dropped
 * every token on screen while the backend and database were perfectly correct —
 * a class of failure that HTTP-level testing cannot see at all.
 *
 * Run:  npx tsx streaming.test.tsx
 */

import { JSDOM } from 'jsdom'

/* -- DOM must exist before React is imported ------------------------------- */

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  pretendToBeVisual: true, // gives us requestAnimationFrame
  url: 'http://localhost:5178',
})

const g = globalThis as Record<string, unknown>
g.window = dom.window
g.document = dom.window.document
// `navigator` is a getter-only global in Node 22, so it is redefined rather
// than assigned.
Object.defineProperty(globalThis, 'navigator', {
  value: dom.window.navigator,
  configurable: true,
})
g.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window)
g.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window)
g.Event = dom.window.Event
g.KeyboardEvent = dom.window.KeyboardEvent
g.HTMLTextAreaElement = dom.window.HTMLTextAreaElement
g.IS_REACT_ACT_ENVIRONMENT = true

// Not implemented by jsdom; ChatPane calls it on every message change.
dom.window.Element.prototype.scrollIntoView = function () {}

/* -- Mock backend ---------------------------------------------------------- */

const CONV_ID = 'conv-00000000-1111-2222-3333-444444444444'

/** One entry per turn: what the mocked model streams back. */
const TURNS = [
  {
    ask: 'What is the capital of France?',
    chunks: ['The ', 'capital ', 'of ', 'France ', 'is ', '**Paris**.'],
    answer: 'The capital of France is Paris.',
  },
  {
    ask: 'And of Japan?',
    chunks: ['That ', 'would ', 'be ', '**Tokyo**.'],
    answer: 'That would be Tokyo.',
  },
]

let turn = 0
/** conversationId the client sent, per turn — proves the second turn continues
 *  the first rather than silently starting a new conversation. */
const sentConversationIds: (string | undefined)[] = []

function sseStream(index: number): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  const frame = (o: unknown) => enc.encode(`data: ${JSON.stringify(o)}\n\n`)

  return new ReadableStream({
    async start(controller) {
      controller.enqueue(
        frame({
          type: 'start',
          conversationId: CONV_ID,
          title: 'What is the capital of France',
          userMessageId: `msg-user-${index}`,
          assistantMessageId: `msg-asst-${index}`,
          createdAt: new Date().toISOString(),
        }),
      )
      // A real gap between start and the first token: the model has to load.
      await new Promise((r) => setTimeout(r, 20))

      for (const delta of TURNS[index].chunks) {
        controller.enqueue(frame({ type: 'content', delta }))
        await new Promise((r) => setTimeout(r, 8))
      }

      controller.enqueue(
        frame({
          type: 'done',
          stats: {
            model: 'llama3.2:3b',
            timeToFirstTokenMs: 120,
            totalMs: 900,
            promptTokens: 20,
            outputTokens: 9,
            tokensPerSecond: 40,
            thinkingTokens: 0,
            doneReason: 'stop',
            droppedMessages: 0,
          },
        }),
      )
      controller.close()
    },
  })
}

g.fetch = async (input: string, init?: { method?: string; body?: string }) => {
  const url = String(input)
  if (url.endsWith('/api/health')) {
    return new Response(JSON.stringify({ running: true, version: '0.32.5', installed: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  if (url.endsWith('/api/conversations') && (init?.method ?? 'GET') === 'GET') {
    return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
  if (url.endsWith('/api/chat')) {
    const body = JSON.parse(init?.body ?? '{}') as { conversationId?: string }
    sentConversationIds.push(body.conversationId)
    return new Response(sseStream(turn++), { status: 200 })
  }
  throw new Error(`unexpected fetch: ${url}`)
}

/* -- Render ---------------------------------------------------------------- */

const { act } = await import('react')
const { createElement } = await import('react')
const { createRoot } = await import('react-dom/client')
const App = (await import('./src/App')).default

const root = createRoot(document.getElementById('root')!)

await act(async () => {
  root.render(createElement(App))
})

/* -- Drive the composer exactly as a user would ---------------------------- */

const nativeSetter = Object.getOwnPropertyDescriptor(
  dom.window.HTMLTextAreaElement.prototype,
  'value',
)!.set!

async function send(text: string) {
  const textarea = document.querySelector('textarea')!

  await act(async () => {
    nativeSetter.call(textarea, text)
    textarea.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  })

  await act(async () => {
    textarea.dispatchEvent(
      new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    )
  })

  // Let the stream run to completion, plus a few frames for the rAF flush.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 400))
  })
}

const failures: string[] = []
const check = (ok: boolean, message: string) => {
  if (!ok) failures.push(message)
}

/* Turn 1 — a brand-new chat, where the conversation id does not exist yet. */
await send(TURNS[0].ask)

let text = document.body.textContent ?? ''
check(text.includes(TURNS[0].ask), 'turn 1: the user message is not on screen')
check(text.includes(TURNS[0].answer), `turn 1: the answer is missing ("${TURNS[0].answer}")`)
// Markdown must survive: **Paris** should be bold, not literal asterisks.
check(!text.includes('**'), 'turn 1: markdown not rendered (literal ** on screen)')
check(document.querySelector('strong') !== null, 'turn 1: no <strong> — markdown did not render')

/* Turn 2 — same conversation, which takes the already-has-an-id path. */
await send(TURNS[1].ask)

text = document.body.textContent ?? ''
check(text.includes(TURNS[1].ask), 'turn 2: the user message is not on screen')
check(text.includes(TURNS[1].answer), `turn 2: the answer is missing ("${TURNS[1].answer}")`)
check(text.includes(TURNS[0].answer), 'turn 2: turn 1 vanished from the transcript')
check(
  sentConversationIds[1] === CONV_ID,
  `turn 2: continued the wrong conversation (sent ${String(sentConversationIds[1])})`,
)

console.log('\n--- rendered transcript ------------------------------------')
console.log(text.replace(/\s+/g, ' ').trim().slice(0, 400))
console.log('------------------------------------------------------------\n')

if (failures.length > 0) {
  console.error('FAIL')
  for (const f of failures) console.error('  - ' + f)
  process.exit(1)
}

console.log('PASS  both turns streamed to screen, markdown intact, history kept')
process.exit(0)
