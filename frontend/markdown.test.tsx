/**
 * Markdown rendering test, driven by real llama3.2:3b output.
 *
 * The sample below is copied verbatim from the conversation database — a model
 * opening fences inside list items and writing the bodies at column 0. Rendered
 * naively it produced empty code boxes, shell scripts as prose, and the rest of
 * the schedule swallowed into a syntax-highlighted block.
 *
 * Run:  npx tsx markdown.test.tsx
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

/* -- Verbatim model output -------------------------------------------------- */

const SAMPLE = [
  "Here's a more detailed version of the schedule with gym timings:",
  '',
  '- 07:00 - Wake up',
  '  ```',
  'echo "Wake up"',
  'sleep 10 # 10 minute wake-up period',
  '```',
  '- 07:15 - Morning routine (shower, dress, brush teeth)',
  '- 07:30 - Breakfast (oatmeal with fruit and nuts)',
  '  ```python',
  'print("Having a healthy breakfast")',
  '```',
  '- 08:00 - Gym time:',
  '  ```bash',
  'echo "Getting ready for my workout"',
  'sleep 10 # 10 minute warm-up',
  '```',
  '- 09:15 - Post-workout routine (shower, change clothes, stretch)',
].join('\n')

/* -- Render ----------------------------------------------------------------- */

const { act, createElement } = await import('react')
const { createRoot } = await import('react-dom/client')
const Markdown = (await import('./src/components/Markdown')).default

const root = createRoot(document.getElementById('root')!)
await act(async () => {
  root.render(createElement(Markdown, { content: SAMPLE }))
})

/* -- Assert ----------------------------------------------------------------- */

const failures: string[] = []
const check = (ok: boolean, message: string) => {
  if (!ok) failures.push(message)
}

const blocks = [...document.querySelectorAll('.codeblock')]
const blockText = blocks.map((b) => b.querySelector('code')?.textContent ?? '')
const bodyText = document.body.textContent ?? ''

// Three fenced blocks in, three out.
check(blocks.length === 3, `expected 3 code blocks, got ${blocks.length}`)

// None of them empty — the headline symptom was a bare header over a void.
check(
  blockText.every((t) => t.trim().length > 0),
  `an empty code block rendered (bodies: ${JSON.stringify(blockText)})`,
)

// The scripts belong inside code blocks, not loose in a paragraph.
check(
  blockText.some((t) => t.includes('echo "Getting ready for my workout"')),
  'the shell script did not land inside a code block',
)
check(
  blockText.some((t) => t.includes('print("Having a healthy breakfast")')),
  'the python line did not land inside a code block',
)

// Prose must NOT be inside a code block — this was the ugliest artifact.
check(
  !blockText.some((t) => t.includes('Post-workout routine')),
  'schedule prose was swallowed into a code block',
)

// No fence markers should survive into the rendered output.
check(!bodyText.includes('```'), 'a literal ``` reached the screen')

// The list must stay a single list; the broken fences used to split it.
check(
  document.querySelectorAll('ul').length === 1,
  `expected 1 list, got ${document.querySelectorAll('ul').length}`,
)
check(
  document.querySelectorAll('li').length === 5,
  `expected 5 list items, got ${document.querySelectorAll('li').length}`,
)

// Language tags must survive the repair.
const labels = blocks.map((b) => b.querySelector('.codeblock-lang')?.textContent)
check(labels.includes('Python'), `expected a Python label, got ${JSON.stringify(labels)}`)
check(labels.includes('Bash'), `expected a Bash label, got ${JSON.stringify(labels)}`)

/* -- Well-formed markdown must survive untouched ---------------------------- */

const { repairFences } = await import('./src/repairFences')

const WELL_FORMED = [
  'Some prose.',
  '',
  '```python',
  'def f(x):',
  '    return x * 2',
  '```',
  '',
  '- a list item',
  '  ```js',
  '  const a = 1',
  '  ```',
  '- another item',
].join('\n')

check(
  repairFences(WELL_FORMED) === WELL_FORMED,
  'well-formed markdown was altered by the repair pass',
)
check(repairFences('no fences here at all') === 'no fences here at all', 'plain text was altered')

// Indentation *inside* the body must keep its relative shape.
const nested = ['- item', '  ```python', 'def f(x):', '    return x * 2', '```'].join('\n')
check(
  repairFences(nested).includes('      return x * 2'),
  `relative indentation lost: ${JSON.stringify(repairFences(nested))}`,
)

console.log('\n--- code blocks --------------------------------------------')
blocks.forEach((b, n) => {
  console.log(`[${n + 1}] ${b.querySelector('.codeblock-lang')?.textContent}`)
  console.log((b.querySelector('code')?.textContent ?? '').replace(/^/gm, '    '))
})
console.log('------------------------------------------------------------\n')

if (failures.length > 0) {
  console.error('FAIL')
  for (const f of failures) console.error('  - ' + f)
  process.exit(1)
}

console.log('PASS  malformed fences repaired, list intact, no prose in code')
process.exit(0)
