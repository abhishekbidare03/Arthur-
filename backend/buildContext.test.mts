/**
 * `buildContext` unit tests — no live Ollama needed, since this is pure
 * assembly logic. Covers the bug reported against the running app: attach
 * file A, ask about it; attach a *different* file B later in the same
 * conversation and ask "what is this" — the model answered about A.
 *
 * The cause was structural: every attachment ever sent in a conversation was
 * collected into one list and glued onto the newest message, regardless of
 * which turn it actually belonged to. These tests pin the fix — a file's text
 * travels with the turn it was attached to — at the level where it cannot
 * regress silently through a prompt-wording change.
 *
 * Run:  npx tsx buildContext.test.mts
 */

import { buildContext, type HistoryMessage } from './src/context/buildContext.ts'

const failures: string[] = []
const check = (ok: boolean, message: string) => {
  if (!ok) failures.push(message)
}

/* -- The reported bug, at the assembly level --------------------------------- */

const coverLetter = { id: 'doc-cover', filename: 'cover-letter.txt', text: 'Applying for the Nokia trainee role. Sincerely, Abhishek.' }
const docket = { id: 'doc-docket', filename: 'docket-project.pptx', text: 'Docket is an agentic dispute-resolution pipeline for AMEX chargebacks.' }

const conversation: HistoryMessage[] = [
  { role: 'user', content: 'tell me what is this', attachments: [coverLetter] },
  { role: 'assistant', content: 'That is a cover letter for a Nokia trainee role.' },
  { role: 'user', content: 'tell me what is this', attachments: [docket] },
]

const result = await buildContext({ messages: conversation, tier: 'low' })
const newestTurn = result.messages.at(-1)!
const olderTurns = result.messages.slice(0, -1)

check(
  newestTurn.content.includes('docket-project.pptx') && newestTurn.content.includes('AMEX chargebacks'),
  'the newest turn does not carry the file it was actually attached with',
)
check(
  !newestTurn.content.includes('cover-letter.txt') && !newestTurn.content.includes('Nokia trainee role'),
  `the OLD file leaked onto the new question — this is the reported bug: ${newestTurn.content.slice(0, 200)}`,
)
check(
  olderTurns.some((m) => m.content.includes('cover-letter.txt')),
  'the cover letter is not attached to its own (first) turn at all — a genuine follow-up about it would fail',
)
check(
  result.attachments.length === 1 && result.attachments[0]?.filename === 'docket-project.pptx',
  `the context event should report only the turn just sent, got ${JSON.stringify(result.attachments)}`,
)

/* -- Follow-up without re-attaching must still work --------------------------- */

const followUp: HistoryMessage[] = [
  { role: 'user', content: 'what team owns the rotation?', attachments: [
    { id: 'doc-runbook', filename: 'runbook.md', text: 'Rotation is owned by the Platform team. Window: Thursday 03:00 UTC.' },
  ] },
  { role: 'assistant', content: 'The Platform team owns it.' },
  { role: 'user', content: 'and when exactly?' }, // no new attachment
]

const followUpResult = await buildContext({ messages: followUp, tier: 'low' })
check(
  followUpResult.messages.some((m) => m.content.includes('Thursday 03:00 UTC')),
  'a follow-up turn lost access to a file attached two turns ago — it should still be in history',
)
check(
  followUpResult.attachments.length === 0,
  'the context event fired for a turn with no new attachment of its own',
)

/* -- A single turn with no attachments at all --------------------------------- */

const plain = await buildContext({ messages: [{ role: 'user', content: 'hi' }], tier: 'low' })
check(plain.messages.length === 1 && plain.messages[0]?.content === 'hi', 'a plain message without attachments was altered')
check(plain.attachments.length === 0, 'a context event fired with no attachments present')

/* -- An oversized attachment on the newest turn is truncated, never dropped --- */

const huge = { id: 'doc-huge', filename: 'huge.txt', text: 'x'.repeat(200_000) }
const truncated = await buildContext({ messages: [{ role: 'user', content: 'summarise this', attachments: [huge] }], tier: 'low' })
check(
  truncated.messages.length === 1 && truncated.messages[0]?.content.includes('summarise this'),
  'the newest turn was dropped entirely rather than having its file truncated',
)
check(
  truncated.attachments[0]?.state === 'truncated' || truncated.attachments[0]?.state === 'dropped',
  `an oversized file should be truncated or dropped, not silently sent whole: ${JSON.stringify(truncated.attachments)}`,
)

/* -- Report -------------------------------------------------------------------- */

if (failures.length > 0) {
  console.error('FAIL')
  for (const f of failures) console.error('  - ' + f)
  process.exit(1)
}

console.log('PASS  attachments stay anchored to their own turn; no cross-file mixup')
process.exit(0)
