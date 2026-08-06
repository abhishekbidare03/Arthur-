/**
 * Phase 7 polish, asserted against the rendered DOM and the real request bodies.
 *
 * The three behaviours here are the ones that are silently wrong rather than
 * visibly broken:
 *
 *   * **Regenerate** must *replace* the previous answer, not append a second
 *     one, and must not re-send the question as a new turn. A transcript with
 *     the same question twice, or two answers under one question, is a
 *     corrupted conversation that only shows up on the next reload.
 *   * **The latency readout** must come from the stats the backend measured for
 *     *this* reply, not from the tier table's idle-machine figure.
 *   * **Export** must round-trip the conversation as usable Markdown —
 *     including reasoning, attachments and a stopped reply, each of which is
 *     easy to drop silently.
 *
 * Run:  npx tsx polish.test.tsx
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

const failures: string[] = []
const check = (ok: boolean, message: string) => {
  if (!ok) failures.push(message)
}

/* -- The pure half: Markdown export ----------------------------------------- */

const { conversationToMarkdown, exportFilename } = await import('./src/export')
type Message = import('./src/types').Message

const exported = conversationToMarkdown(
  {
    id: 'c1',
    title: 'Rotation window',
    tier: 'high',
    createdAt: '2026-08-06T10:00:00Z',
    updatedAt: '2026-08-06T10:05:00Z',
  },
  [
    {
      id: 'm1',
      conversationId: 'c1',
      role: 'user',
      content: 'When is rotation?',
      createdAt: '2026-08-06T10:00:00Z',
      attachments: [{ id: 'd1', filename: 'runbook.md', byteSize: 900 }],
    },
    {
      id: 'm2',
      conversationId: 'c1',
      role: 'assistant',
      content: 'Thursday at 03:00 UTC.\n\n```sql\nSELECT 1;\n```',
      thinking: 'The runbook says Thursday.',
      model: 'qwen3:4b',
      createdAt: '2026-08-06T10:01:00Z',
    },
    {
      id: 'm3',
      conversationId: 'c1',
      role: 'user',
      content: 'And who owns it?',
      createdAt: '2026-08-06T10:04:00Z',
    },
    {
      id: 'm4',
      conversationId: 'c1',
      role: 'assistant',
      content: 'The platform te',
      model: 'qwen3:4b',
      stopped: true,
      createdAt: '2026-08-06T10:05:00Z',
    },
  ] satisfies Message[],
)

check(exported.startsWith('---\n'), 'no front matter — the export loses its title and provenance')
check(exported.includes('title: "Rotation window"'), 'the title is missing from the front matter')
check(
  exported.includes('*Attached: runbook.md*'),
  'the attachment is not named — the question reads as if it were asked about nothing',
)
check(
  exported.includes('```sql\nSELECT 1;\n```'),
  'the code fence did not survive, which is most of the reason to export as Markdown',
)
check(
  exported.includes('<details><summary>Reasoning</summary>'),
  'reasoning was dropped rather than collapsed',
)
check(exported.includes('*(stopped part-way)*'), 'a stopped reply is exported as if it were complete')
check(
  (exported.match(/^## You$/gm) ?? []).length === 2,
  'the two questions did not both survive as their own sections',
)
check(!/\n{3,}/.test(exported), 'blank-line runs were not collapsed')

check(
  exportFilename('Rotation: window/plan?') === `Rotation-windowplan-${new Date().toISOString().slice(0, 10)}.md`,
  `illegal filename characters survived: ${exportFilename('Rotation: window/plan?')}`,
)
check(
  exportFilename('   ').startsWith('arthur-conversation-'),
  'a blank title produces a filename that is only a date',
)

/* -- Mock backend ----------------------------------------------------------- */

const CONV_ID = 'conv-7777'
const bodies: Record<string, unknown>[] = []

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

const stats = (model: string, ttft: number, tps: number, out: number, dropped = 0) => ({
  model,
  timeToFirstTokenMs: ttft,
  totalMs: 1200,
  promptTokens: 40,
  outputTokens: out,
  tokensPerSecond: tps,
  thinkingTokens: 0,
  doneReason: 'stop',
  droppedMessages: dropped,
})

g.fetch = async (input: string, init?: { method?: string; body?: unknown }) => {
  const url = String(input)
  const json = (o: unknown, status = 200) =>
    new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } })

  if (url.endsWith('/api/health')) return json({ running: true, installed: [], missing: [] })
  if (url.endsWith('/api/conversations') && (init?.method ?? 'GET') === 'GET') return json([])

  if (url.endsWith('/api/chat')) {
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
    bodies.push(body)

    const regenerating = body.regenerate === true
    return new Response(
      sse([
        {
          type: 'start',
          conversationId: CONV_ID,
          title: 'Rotation window',
          userMessageId: 'msg-u-1',
          assistantMessageId: regenerating ? 'msg-a-2' : 'msg-a-1',
          createdAt: new Date().toISOString(),
        },
        {
          type: 'content',
          delta: regenerating ? 'Thursday, 03:00 UTC, owned by Platform.' : 'Thursday.',
        },
        {
          type: 'done',
          stats: regenerating
            ? stats('qwen3:4b', 2400, 15, 180, 2)
            : stats('llama3.2:3b', 320, 41.5, 12),
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

const setValue = Object.getOwnPropertyDescriptor(
  dom.window.HTMLTextAreaElement.prototype,
  'value',
)!.set!

async function send(message: string) {
  const textarea = document.querySelector('textarea')!
  await act(async () => {
    setValue.call(textarea, message)
    textarea.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  })
  await act(async () => {
    textarea.dispatchEvent(
      new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    )
  })
  await act(async () => {
    await new Promise((r) => setTimeout(r, 250))
  })
}

const click = async (el: Element) => {
  await act(async () => {
    el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }))
  })
}

await send('When is rotation?')

let text = document.body.textContent ?? ''

/* -- The latency readout ---------------------------------------------------- */

check(text.includes('Thursday.'), 'the first reply did not render')
check(
  text.includes('320 ms to first token'),
  'no time-to-first-token — the one number that says whether a tier is worth its wait',
)
check(
  text.includes('41.5 tok/s') && text.includes('12 tokens'),
  'throughput and output size are missing from the readout',
)
check(
  !text.includes('40 tok/s'),
  'the readout is showing the tier table figure, not what this reply actually measured',
)

/* -- Regenerate at a different tier ------------------------------------------ */

const retry = [...document.querySelectorAll('button')].find((b) => b.textContent?.includes('Retry'))
check(retry !== undefined, 'no Retry control under the finished answer')

if (retry) {
  await click(retry)
  const atHigh = [...document.querySelectorAll('[role=menuitem]')].find((b) =>
    b.textContent?.includes('At High'),
  )
  check(atHigh !== undefined, 'the Retry menu does not offer the other tiers')
  if (atHigh) {
    await click(atHigh)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 300))
    })
  }
}

text = document.body.textContent ?? ''
const last = bodies[bodies.length - 1]

check(bodies.length === 2, `expected 2 chat requests, got ${bodies.length}`)
check(last?.regenerate === true, 'the retry was sent as an ordinary new message')
check(last?.tier === 'high', `the retry did not switch tier: ${String(last?.tier)}`)
check(
  last?.conversationId === CONV_ID,
  'the retry did not target the existing conversation, so it would have started a new one',
)

check(
  text.includes('Thursday, 03:00 UTC, owned by Platform.'),
  'the regenerated answer did not render',
)
// Structural, not textual. A substring check is too weak here: the replaced
// and replacing answers share a prefix, and the meta row sits between them, so
// a leftover bubble hides comfortably inside `textContent`. Counting the
// rendered assistant bodies is the assertion that actually fails when
// regenerate appends.
const answers = document.querySelectorAll('.prose-arthur')
check(
  answers.length === 1,
  `${answers.length} assistant answers rendered — regenerate appended instead of replacing`,
)
check(
  !text.includes('320 ms to first token'),
  'the replaced answer’s own latency readout is still on screen',
)
check(
  (text.match(/When is rotation\?/g) ?? []).length === 1,
  'the question was duplicated, so the transcript now asks it twice',
)
check(
  text.includes('2 earlier turns dropped'),
  'dropped history is not reported, so a partial-context answer looks fully informed',
)

/* -- Keyboard shortcuts ------------------------------------------------------ */

await act(async () => {
  dom.window.document.body.dispatchEvent(
    new dom.window.KeyboardEvent('keydown', { key: '?', bubbles: true, cancelable: true }),
  )
})
check(
  (document.body.textContent ?? '').includes('Keyboard shortcuts'),
  '? did not open the shortcut sheet',
)

await act(async () => {
  dom.window.document.body.dispatchEvent(
    new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
  )
})
check(
  !(document.body.textContent ?? '').includes('Keyboard shortcuts'),
  'Escape did not close the shortcut sheet',
)

// Ctrl+N must not fire while typing into the composer would be the only way to
// reach it - but it must fire *from* the composer, which is where focus always
// is. Sent on the textarea deliberately.
const textarea = document.querySelector('textarea')!
await act(async () => {
  textarea.dispatchEvent(
    new dom.window.KeyboardEvent('keydown', {
      key: 'n',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    }),
  )
})
await act(async () => {
  await new Promise((r) => setTimeout(r, 30))
})
check(
  !(document.body.textContent ?? '').includes('Thursday, 03:00 UTC'),
  'Ctrl+N from the composer did not start a new chat',
)

console.log('\n--- exported markdown ----------------------------------------')
console.log(exported.trim().split('\n').slice(0, 14).join('\n'))
console.log('---------------------------------------------------------------\n')

if (failures.length > 0) {
  console.error('FAIL')
  for (const f of failures) console.error('  - ' + f)
  process.exit(1)
}

console.log('PASS  latency measured per reply, retry replaces rather than appends, export round-trips')
process.exit(0)
