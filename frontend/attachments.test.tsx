/**
 * Phase 4 attachment flow, asserted against the rendered DOM.
 *
 * Covers the path a file actually takes: picked in the composer, uploaded,
 * shown as a chip, sent with the message, and reported back as truncated.
 *
 * Run:  npx tsx attachments.test.tsx
 */

import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost:5178',
})

const g = globalThis as Record<string, unknown>
g.window = dom.window
g.document = dom.window.document
Object.defineProperty(globalThis, 'navigator', {
  value: dom.window.navigator,
  configurable: true,
})
g.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window)
g.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window)
g.IS_REACT_ACT_ENVIRONMENT = true
dom.window.Element.prototype.scrollIntoView = function () {}

/* -- Mock backend ----------------------------------------------------------- */

const DOC_ID = 'doc-1111-2222'
const CONV_ID = 'conv-aaaa-bbbb'

let chatBody: { documentIds?: string[]; content?: string } | null = null
let uploadFilename: string | null = null

function sse(frames: unknown[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  return new ReadableStream({
    async start(controller) {
      for (const f of frames) {
        controller.enqueue(enc.encode(`data: ${JSON.stringify(f)}\n\n`))
        await new Promise((r) => setTimeout(r, 5))
      }
      controller.close()
    },
  })
}

g.fetch = async (input: string, init?: { method?: string; body?: unknown; headers?: Record<string, string> }) => {
  const url = String(input)
  const json = (o: unknown, status = 200) =>
    new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } })

  if (url.endsWith('/api/health')) return json({ running: true, installed: [] })
  if (url.endsWith('/api/conversations') && (init?.method ?? 'GET') === 'GET') return json([])

  if (url.includes('/api/documents')) {
    uploadFilename = decodeURIComponent(init?.headers?.['X-Arthur-Filename'] ?? '')
    return json(
      { id: DOC_ID, filename: 'runbook.md', byteSize: 4096, status: 'extracted', estimatedTokens: 1024 },
      201,
    )
  }

  if (url.endsWith('/api/chat')) {
    chatBody = JSON.parse(String(init?.body ?? '{}'))
    return new Response(
      sse([
        {
          type: 'start',
          conversationId: CONV_ID,
          title: 'Runbook question',
          userMessageId: 'msg-u-1',
          assistantMessageId: 'msg-a-1',
          createdAt: new Date().toISOString(),
        },
        // Deliberately truncated, so the warning path is exercised.
        {
          type: 'context',
          attachments: [
            { id: DOC_ID, filename: 'runbook.md', state: 'truncated', keptChars: 600, totalChars: 2400 },
          ],
        },
        { type: 'content', delta: 'Rotation is Thursday.' },
        {
          type: 'done',
          stats: {
            model: 'llama3.2:3b', timeToFirstTokenMs: 90, totalMs: 400, promptTokens: 30,
            outputTokens: 5, tokensPerSecond: 40, thinkingTokens: 0, doneReason: 'stop',
            droppedMessages: 0,
          },
        },
      ]),
      { status: 200 },
    )
  }

  throw new Error(`unexpected fetch: ${url}`)
}

/* -- Render ----------------------------------------------------------------- */

const { act, createElement } = await import('react')
const { createRoot } = await import('react-dom/client')
const App = (await import('./src/App')).default

const root = createRoot(document.getElementById('root')!)
await act(async () => {
  root.render(createElement(App))
})

const failures: string[] = []
const check = (ok: boolean, message: string) => {
  if (!ok) failures.push(message)
}

/* -- Attach a file exactly as the composer does ----------------------------- */

const fileInput = document.querySelector('input[type=file]') as HTMLInputElement | null
check(fileInput !== null, 'no file input rendered — the paperclip is not wired up')

if (fileInput) {
  const file = new dom.window.File(['# Runbook\nRotation is Thursday.'], 'runbook.md', {
    type: 'text/markdown',
  })
  Object.defineProperty(fileInput, 'files', { value: [file], configurable: true })

  await act(async () => {
    fileInput.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
  })
  await act(async () => {
    await new Promise((r) => setTimeout(r, 60))
  })
}

let text = document.body.textContent ?? ''
check(uploadFilename === 'runbook.md', `upload sent the wrong filename: ${String(uploadFilename)}`)
check(text.includes('runbook.md'), 'no chip appeared for the attached file')
check(
  text.includes('1,024 tokens'),
  'the chip does not show the token cost, so the budget is invisible before sending',
)

/* -- Send ------------------------------------------------------------------- */

const textarea = document.querySelector('textarea')!
const setValue = Object.getOwnPropertyDescriptor(
  dom.window.HTMLTextAreaElement.prototype,
  'value',
)!.set!

await act(async () => {
  setValue.call(textarea, 'When is rotation?')
  textarea.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
})
await act(async () => {
  textarea.dispatchEvent(
    new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
  )
})
await act(async () => {
  await new Promise((r) => setTimeout(r, 300))
})

text = document.body.textContent ?? ''

check(
  JSON.stringify(chatBody?.documentIds) === JSON.stringify([DOC_ID]),
  `the message did not carry the document id: ${JSON.stringify(chatBody?.documentIds)}`,
)
check(text.includes('Rotation is Thursday.'), 'the reply did not render')
check(text.includes('runbook.md'), 'the chip vanished from the sent message')
check(
  /truncated/i.test(text) && text.includes('25%'),
  'no truncation warning — a partially-read file would look complete',
)

// The tray must be empty afterwards, or the next message re-sends the file.
const trays = document.querySelectorAll('.composer .chip-tray')
check(trays.length === 0, `${trays.length} chip(s) still staged in the composer after sending`)

console.log('\n--- rendered ------------------------------------------------')
console.log(text.replace(/\s+/g, ' ').trim().slice(0, 340))
console.log('-------------------------------------------------------------\n')

if (failures.length > 0) {
  console.error('FAIL')
  for (const f of failures) console.error('  - ' + f)
  process.exit(1)
}

console.log('PASS  file attached, sent with the message, truncation reported')
process.exit(0)
