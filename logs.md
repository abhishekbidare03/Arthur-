# Arthur — Work Log

Chronological record of what was done, what was decided, and why. Newest session at the top.

---

## Session 7 — 2026-08-05 · Phase 3 complete — conversation persistence

History is durable. Close the app, reopen it, everything is there.

### What was built

`better-sqlite3` installed with **no compilation** — the prebuilt binary for Node 22 resolved
straight away, so the no-MSVC constraint holds. SQLite 3.53.4, and **FTS5 is available**, which
Phase 8's hybrid retrieval depends on.

| File | Role |
|---|---|
| `src/db/schema.sql` | Full RAG-ready schema, created in one pass |
| `src/db/index.ts` | Connection, pragmas, schema setup, clean shutdown |
| `src/db/conversations.ts` | Prepared-statement CRUD for conversations and messages |
| `src/titles.ts` | Title derivation from the first user message |

REST surface: `GET/POST /api/conversations`, `GET /api/conversations/:id/messages`,
`PATCH` (rename), `DELETE`. Frontend gained inline rename in the sidebar; `mockData.ts` is gone.

### The significant design change

**`/api/chat` no longer takes a `messages` array.** It takes `{ conversationId?, content, tier }`
and reads history from the database itself. The database is now the single source of truth
rather than whatever the browser happened to be holding.

Consequences, all of them good:
- The assistant row is written **before** streaming starts and filled in as it completes, so a
  partial answer survives a crash or a closed window
- The frontend cannot desynchronise its history from what is stored
- A new SSE `start` event reports the ids the database assigned, letting the client reconcile
  its optimistic bubbles with real rows — and learn the id of a conversation the backend
  created for it

### Decisions

- **Titles are text-derived, not model-generated.** `phases.md` allowed either. The model route
  is the wrong trade here: only one model fits in 4 GB, so titling with a *smaller* model evicts
  the chat model and charges the user a 1–10 s reload on their next message, while titling with
  the *same* model costs a second generation — which on High means reasoning, measured at
  20–100 s for one line. Extraction is instant and costs no VRAM. Reasoning recorded in
  `titles.ts`; Phase 7 can revisit.
- **`chunk_vectors` is not created**, and cannot be. It is a `sqlite-vec` virtual table and
  SQLite will not create a virtual table whose module is not loaded. The extension arrives in
  Phase 8. Everything it references exists, so it stays additive.
- **Two columns beyond the spec** — `messages.stats` and `messages.stopped`. Both would
  otherwise force a migration: Phase 7's latency readout needs the former, and without the
  latter a stopped reply reloads looking complete.
- **WAL journaling with `synchronous = NORMAL`.** `FULL` fsyncs every commit and would stutter
  during streaming; WAL means a reader is never blocked and an unclean shutdown recovers.
  The WAL is checkpointed on `SIGINT`/`SIGTERM` so `arthur.db` stays self-contained for backup.
- **An assistant row that produced nothing is deleted, not stored empty** — otherwise a failed
  generation reloads as a blank bubble. The user's own message stays; they still said it.

### A bug caught by testing, and a false alarm

- **`model` was never persisted.** The assistant row was created before the model was known,
  and `finishMessage` did not set it — so every reloaded conversation would have shown no tier
  attribution, which `phases.md` explicitly requires. Now written at insert time from the tier
  config, so even a stopped reply records which model produced it.
- **A "failed" stop test was the test's fault, not the code's.** The abort fired at 1,200 ms
  but the Low tier had already finished — 51 chars, exactly a completed A–Z listing. Re-run
  against a 900-word essay it passed properly: 559 chars persisted, flagged `stopped`.

### Verification

Killed the backend process outright and restarted it, then checked 9 properties: conversation
survived, renamed title survived, tier stored, message count, role ordering, content non-empty,
model recorded, stats recorded, sequence preserved. **All pass.** Also verified follow-up turns
answer from stored history ("What country is that in?" → "Japan"), cascade delete, and title
derivation across markdown, long text and one-word inputs.

**Still not visually confirmed** — the Claude-in-Chrome extension remains unconnected, so
verification was again by driving the HTTP surface. Worth eyeballing the sidebar, reload and
rename by hand.

**Next:** Phase 4 — file input, text files only.

---

## Session 6 — 2026-08-05 · Markdown rendering, code blocks, and a failed attempt at faster thinking

**Trigger:** two complaints after using the app. Code answers arrived as one unbroken line of
prose, and `qwen3:4b` took ~1.5 minutes to answer "hi".

### Markdown + code blocks — done

The Phase 1 stand-in renderer split on blank lines and understood only `**bold**` and
`` `code` ``, so a fenced block was flattened into a paragraph. Replaced with
**`react-markdown` + `remark-gfm` + `highlight.js`** (pulled forward from Phase 7).

- `components/Markdown.tsx` — intercepts at `pre` rather than `code`, which keeps the fence's
  language tag and sidesteps the inline-vs-block ambiguity. Memoised on content, since
  streaming re-renders the pane every animation frame
- `components/CodeBlock.tsx` — language label, **copy button** with a clipboard fallback,
  ~40 languages via `highlight.js/lib/common` plus auto-detection for untagged fences
- Syntax colours written against the app's own design tokens rather than importing a stock
  highlight.js theme, so code matches the warm palette and follows the theme toggle
- Also gained: tables (scroll in their own box), headings, blockquotes, task lists,
  strikethrough, links
- **Highlighting is skipped while streaming** — re-highlighting a half-written line every
  frame is wasted work; the block lights up when it lands

Bundle went 221 kB → 546 kB, so markdown and highlighting are split into their own chunk:
app shell stays 216 kB (68 kB gzipped), markdown vendor 328 kB (104 kB) loads alongside.
Everything is served from localhost, so this is about first paint, not bandwidth.

**Verified** by rendering the component through `react-dom/server` against realistic model
output: 13 checks including fenced blocks, hljs spans, language labels, copy button, tables,
task lists, and inline code staying inline. Plus the streaming edge case — an **unterminated
fence** still renders as a code block with no stray backticks. Confirmed end to end that the
real model emits ` ```python ` and the block survives with its 8 lines intact.

### Thinking latency — investigated, mostly not fixed

Reproduced the complaint: "how are you?" hit **114 s**. Findings, all measured:

- **`think: false` is still broken** — re-confirmed it dumps raw chain-of-thought into
  `content`, exactly as Phase 0 recorded
- **Ollama's thinking *levels* make it worse**, not better: `think:"medium"` took 34.5 s
  against a 19.1 s baseline
- **`num_predict` bounds the worst case tightly** (max 65 s → 33 s) but returned **empty
  `content` in 1 of 3 runs** — the documented `done_reason: "length"` failure. Unusable as a
  latency control
- **`temperature` 0.3 helped** — mean 42.3 s → 31.6 s, worst 65 s → 48 s, no empty responses

**The finding that mattered — and that I got backwards first.** I added an anti-overthinking
instruction to the system prompt. It made things **3× worse**: 101.7 s mean, thinking tripled
from 1,899 to 6,129 characters. Isolating it, reasoning length tracks *system prompt length*
almost linearly:

| System prompt | Mean | Thinking |
|---|---|---|
| 1 line | 32 s | 1,899 c |
| 7 lines | 51 s | 3,140 c |
| 11 lines | 44 s | 2,873 c |
| 12 lines, with "answer immediately" rule | **102 s** | **6,129 c** |

The worst row differs from the one above it by a **single line** — *"Greetings and simple
questions need no reasoning — answer them immediately"* — which more than doubled
deliberation. Telling a reasoning model not to reason gives it something new to reason about.

**Shipped as a result:** the system prompt is now **tier-dependent**. The thinking tier gets
identity only; the non-thinking tiers get the full formatting guidance, which costs them
nothing and which they need more, being smaller models. High also runs at temperature 0.3,
with `num_predict` kept only as a runaway guard — and when it *does* fire, the backend now
reports `thinking_truncated` instead of showing an empty bubble.

**Left open at the user's direction.** `qwen3:4b` is Qwen3-4B-**Thinking**-2507, a
reasoning-only model with no fast path — this is inherent, not a misconfiguration. Options for
later: `qwen3:4b-instruct` exists in the registry (confirmed, not pulled) as a non-thinking
sibling, or move the High tier to gemma. Medium remains the default and answers chat in ~1 s.

**Next:** Phase 3 — SQLite persistence.

---

## Session 5 — 2026-08-05 · Phase 2 complete — real streaming inference

Arthur now talks to the local models. Typed prompt → streamed reply, all three tiers.

### What was built

A new `backend/` — Express 5 + `tsx`, two runtime dependencies, no MSVC, consistent with the
no-toolchain stack. Binds to `127.0.0.1` only.

| File | Role |
|---|---|
| `src/server.ts` | Express app; SSE `/api/chat`, `/api/health` |
| `src/inference/ollama.ts` | The `sendMessage()` boundary — NDJSON → typed events |
| `src/inference/types.ts` | Provider-agnostic contract + typed error codes |
| `src/context/buildContext.ts` | Context assembly, with budget-based history trimming |
| `src/tiers.ts` | tier → model + `num_ctx` |
| `src/prompt.ts` | Arthur's system prompt |

Frontend: `src/api.ts` (fetch + `ReadableStream` SSE client), `OllamaBanner.tsx`, and real
wiring through `App.tsx`, `ChatPane.tsx`, `InputBar.tsx`, `ThinkingPanel.tsx`, `TopBar.tsx`.
Vite proxies `/api` → `127.0.0.1:5179`, so everything is same-origin and the backend needs no
CORS middleware.

### The measurement that shaped the UI

Probing Ollama's stream for *"What is 2+2?"* on the High tier: **147 of 150 chunks were
`thinking`.** The first `content` token arrived at chunk 149.

Without live reasoning feedback the app looks frozen for the entire generation. So the pending
state is explicit, `ThinkingPanel` shows a **live word count** while collapsed, and the panel
auto-collapses once the answer starts. This one number justified more UI work than anything
else in the phase.

### Two bugs worth recording

- **`req.on('close')` fires immediately on a POST with a parsed body.** `express.json()` has
  already consumed the request stream, so the handler aborted every generation before it
  emitted a token — the symptom was a clean 200 with **zero SSE events** and nothing in the
  log. The disconnect signal belongs on **`res`**, not `req`.
- **`npm start` is not `npm run dev`.** The first fix appeared not to work because the backend
  was running under plain `tsx` with no watcher. Wasted a full test cycle.

### Decisions

- **Stop button added** (button + `Esc`), beyond the phase's task list. At 15 tok/s with a
  minute of deliberation, no way to cancel is not a viable UI. Verified it aborts *Ollama*,
  not just the client: after a mid-stream abort the next request answered in **444 ms**.
- **`buildContext.ts` built now** rather than in Phase 4. Phase 2 must assemble
  `{ system, messages }` anyway; writing it in its final shape avoids a throwaway.
- **`num_ctx: 8192` sent explicitly on every request** — Ollama otherwise auto-selects 4096.
- **Streaming deltas are batched through `requestAnimationFrame`.** The Low tier emits 106
  tok/s; committing each token to React state would re-render the whole pane that often.
- **Tier switching is locked while streaming**, and models not pulled are flagged in the
  dropdown from `/api/health`.

### Verification

- All three tiers stream end to end; the system prompt holds (Medium introduces itself as
  Arthur, not Llama)
- **Streaming is genuinely incremental through the Vite proxy** — 43 events spread over
  1,063 ms, not one buffered lump. This was worth proving; a buffering dev proxy is the
  classic way SSE silently degrades
- Mid-stream abort: 99 events received, then clean cancellation, backend still healthy
- Ollama-down path returns typed `ollama_unreachable`; `/api/health` reports `running: false`
- `tsc -b --force` and `npm run build` pass (221 kB JS / 69 kB gzipped)
- Warm TTFT **~0.5 s**, cold **~8–10 s** — the tier-switch reload the UI now warns about

**Still not visually confirmed.** The Claude-in-Chrome extension was not connected this
session either, so verification was by driving the HTTP surface directly. Someone should open
`http://localhost:5178/` and eyeball the streaming, thinking panel and Stop button.

**Next:** Phase 3 — SQLite persistence. Mock data is still in place; `messages.thinking` and
`messages.model` already exist in the frontend types, so the schema lines up.

---

## Session 4 — 2026-08-05 · Context window investigated — 4096 was a default, not a ceiling

**Trigger:** the user asked why the models report only ~4k context when `qwen3:4b` advertises
262,144. Investigated on the live machine rather than reasoning from spec sheets.

### Why 4096

Not conservatism — `ollama serve --help` documents `OLLAMA_CONTEXT_LENGTH` as
`4k/32k/256k based on VRAM`. On 4 GB it picks the bottom rung. The real constraint is the KV
cache, which is fixed by architecture (pulled from `/api/show`: 36 layers, 8 KV heads,
key/value length 128):

```
36 × 8 × (128 + 128) × 2 bytes = 144 KiB per token
```

Verified against reality: resident size grew 0.57 GB when `num_ctx` went 4096→8192 (~142 KiB
/token). **The advertised 262,144 context would need 36 GiB of KV cache alone.** That figure
is a property of the attention math, not of Ollama — no runtime swap changes it.

### The fix — quantized KV cache

`OLLAMA_KV_CACHE_TYPE=q8_0` + `OLLAMA_FLASH_ATTENTION=1` (flash attention is a prerequisite,
not an optional extra). Both set as **User env vars**, so the Startup-folder tray app picks
them up at login.

| `num_ctx` | f16 tok/s | q8_0 tok/s | f16 GPU | q8_0 GPU |
|---|---|---|---|---|
| 4,096 | 16.3 | **23.6** | 67% | **73%** |
| 8,192 | 11.1 | **15.7** | 55% | **64%** |
| 16,384 | 9.3 | **12.0** | 42% | **54%** |
| 32,768 | — | 9.1 | — | 41% |

**8,192 tokens is now roughly free** (15.7 vs the old 16.3 tok/s) and **16,384 costs 26% of
throughput for 4× the window.** Quality spot-checked at q8_0/16384 — correct output,
`thinking` still cleanly separated from `content`.

### Two process lessons

- **Benchmark warm, never cold.** The first q8_0 sweep read 10.7 tok/s and suggested the
  change was a regression; three warm repeats gave 23.6 with tight spread. CUDA kernels for
  the quantized-FA path appear to JIT on first use. The initial single-run conclusion was
  simply wrong.
- **`Start-Process` does not pick up freshly-set User env vars** — a child inherits the
  *parent shell's* environment, captured at its start. The first restart silently came up with
  `OLLAMA_FLASH_ATTENTION:false`. Always verify against `%LOCALAPPDATA%\Ollama\server.log`'s
  `server config` line rather than assuming.

### Consequences

- `docs/model-notes.md` — Phase 0's performance table marked superseded; new arithmetic and
  measurement sections added; the "levers if too slow" list updated.
- **Phase 2 should send `num_ctx: 8192` explicitly.** Ollama still auto-selects 4096 otherwise.
- **Phase 4's budget quadruples**, but the Session 2 conclusion stands: a 10-page PDF is ~5,000
  tokens, so 8,192 still cannot hold a document *plus* history *plus* qwen3's ~1,000 thinking
  tokens. **RAG is still the only mechanism that makes documents work here** — retrieval now
  has a more comfortable budget to spend, not a reprieve.
- ~~The two smaller tiers have **not** been re-measured under `q8_0`~~ — **done in Session 5**,
  at the shipping `num_ctx` of 8192: Low **105.9 tok/s** (100% GPU, 1.25 GB), Medium
  **39.6 tok/s** (78% GPU, 2.97 GB), High **14.9 tok/s** (64% GPU, 3.58 GB). Low *gained*
  against its Phase 0 figure (94.8 → 105.9) despite doubling its context; Medium lost ground
  (51.3 → 39.6) because it is paying for the larger window out of a partial CPU spill.

**No application code written.** Configuration and documentation only.

---

## Session 3 — 2026-08-05 · Phase 1 complete — UI shell

First application code. `frontend/` now holds a working static Claude-style UI on mock data.

### Scaffolding

Vite config, `tsconfig.json` and `package.json` were **hand-written rather than generated**
via `npm create vite`, which can drop into interactive prompts and hang a non-interactive run.
Stack: **React 19 · TypeScript 5.7 · Vite 7 · Tailwind v4** (CSS-first `@theme`, via
`@tailwindcss/vite` — no `tailwind.config.js`).

Dev server pinned to **port 5178 with `strictPort`**, matching the URL the Phase 6 launcher
will open with `chrome --app=`, so the address never changes between dev and production.

### What was built

| File | Notes |
|---|---|
| `src/types.ts` | Domain types mirroring the Phase 3 schema, so swapping mock data for DB rows is a straight substitution. `TIERS` carries each tier's model, blurb, measured tok/s and whether it thinks |
| `src/mockData.ts` | Four conversations; one deliberately carries `thinking` blocks |
| `components/Sidebar.tsx` | Recency grouping (Today / Yesterday / Previous 7 days / Older), collapse to a 52 px icon rail, hover-reveal delete |
| `components/TopBar.tsx` | Tier selector with per-tier stats and a model-reload warning; theme toggle; settings gear |
| `components/ChatPane.tsx` | User bubbles right, assistant prose full-width; auto-scroll |
| `components/InputBar.tsx` | Auto-grow textarea capped at 200 px; Enter sends, Shift+Enter newlines |
| `components/ThinkingPanel.tsx` | Collapsible reasoning panel |
| `components/icons.tsx` | Hand-rolled inline SVGs — no icon dependency |

### Decisions made during the build

- **`ThinkingPanel` built in Phase 1, not Phase 2.** It renders from mock data now, which
  de-risks the trickiest part of Phase 2. Collapsed by default — qwen3 spends ~1,000 tokens
  deliberating over a one-line question, and showing that raw is exactly what made the terminal
  output feel broken.
- **Enter sends, Shift+Enter newlines** — matching Claude, rather than the Ctrl+Enter in the
  original Phase 7 notes.
- **Selecting a conversation adopts the tier it was last used with**, so reopening an old chat
  never silently answers at a different effort level.
- **Attach and mic buttons are visible but disabled**, with "arrives in Phase 4 / Phase 5"
  tooltips rather than being hidden — the layout is final, and the honesty is free.
- **Warm off-white/clay palette** (`#faf9f5` / `#f0eee6`, accent `#c15f3c`) via CSS custom
  properties. This is what makes it read as Claude rather than a generic grey chat UI. Both
  themes defined; defaults to the OS preference.
- A minimal bold/code/list renderer stands in for markdown; Phase 7 replaces it. HTML is
  escaped before formatting is applied.

### Verification

- `tsc -b --noEmit` → **PASS** (needed `src/vite-env.d.ts` for the CSS module declaration)
- `npm run build` → **PASS**, 216 kB JS / 67 kB gzipped, 37 modules
- Dev server serves `index.html`, `main.tsx`, `App.tsx`; Tailwind compiles with design tokens
  present in the output CSS

**Not visually confirmed by me** — the Claude-in-Chrome extension was not connected, so no
screenshot was taken. The user should open `http://localhost:5178/` to eyeball it.

**Next:** Phase 2 — wire real streaming inference.

---

## Session 2 — 2026-08-05 · RAG architecture decided (no code)

**Trigger:** the user stated the real end-goal — Arthur should eventually read PDFs, DOCX, MD,
TXT and more, store them, and answer from them as "a proper RAG application", at a
production-ready standard for personal use. They explicitly wanted to **defer** building it and
get the chat app working first.

### The finding that reframed everything

Runtime context is ~4096 tokens (4 GB VRAM). **A 10-page PDF is ~5,000 tokens.** So Phase 4's
"inject raw file text into the prompt" approach cannot work for real documents on this hardware
— one document exceeds the entire budget before the model sees the question.

**Retrieval is therefore not a later enhancement; it is the only mechanism by which documents
will ever work here.** This moved RAG from "out of scope" to a planned, necessary part of the
build — while still deferring the implementation as the user wanted.

### Decisions

| Decision | Choice | Why |
|---|---|---|
| Document scope | **Projects-style — both** | Persistent collections *and* per-chat attachments, like Claude Projects |
| Phase 4 | **Stay minimal** | Text files only, truncate-and-warn; builds the extraction layer and `documents` table properly. PDFs wait for Phase 8 |
| Vector store | **`sqlite-vec`**, not ChromaDB | Loads into the same `arthur.db`; no second Python service. FTS5 comes free for hybrid search |
| Embeddings | **CPU via `@xenova/transformers`**, not Ollama | An embedding model in Ollama competes for the 4 GB VRAM and thrashes against the chat model. CPU/ONNX uses zero VRAM |
| Parsers | Pure JS (`pdfjs-dist`, `mammoth`, `xlsx`, `officeparser`) | No Python, no MSVC — consistent with the no-toolchain stack |

### The five seams built into Phases 3–4

So RAG is additive rather than a rewrite:

1. **Documents as first-class rows**, never inline in `messages.content`
2. **One `extractText()` layer** with a fixed return shape — Phase 4 injects its output,
   Phase 8 chunks the same output
3. **A `buildContext()` boundary** — internals swap from injection to retrieval; nothing above
   it changes
4. **Full schema created in Phase 3**, including `chunks`, `chunk_vectors` and `message_sources`
   left empty until Phase 8 — avoids migrating every historical message later
5. **CPU embeddings** decided now, because the VRAM constraint makes the alternative unworkable

### Roadmap changes

- Phase 4 narrowed and retitled "File Input (Text Files Only — deliberately narrow)", with the
  reason stated inline
- **Phase 8 — RAG Core** · **Phase 9 — Knowledge Base UX** · **Phase 10 — Advanced Formats**
  appended
- Phase 3 now creates the full RAG-ready schema
- "RAG… not in this scope" struck from Open Decisions; ChromaDB superseded by `sqlite-vec`

**Interesting consequence:** because retrieval supplies the knowledge, the **Low** tier
(`qwen2.5:1.5b`, 100% GPU, 95 tok/s) may turn out to be the *best* RAG tier — fast, fully
GPU-resident, and it doesn't burn 1,000 tokens thinking before answering.

### Files

- **Created** `docs/rag-architecture.md` — five seams, full schema, retrieval budget, rationale
- **Updated** `phases.md` — header, Phase 3, Phase 4, new Phases 8–10, Open Decisions

**No application code written.** Phase 1 is next.

---

## Session 1 — 2026-08-05 · Phase 0 complete

**Starting point:** `E:\Arthur` contained only `phases.md`. Greenfield.

### Environment audit

| | |
|---|---|
| CPU / RAM | i5-10300H (4c/8t), 15.8 GB |
| GPU | GTX 1650 Ti, **4 GB VRAM** |
| Disks | C: 22.1 GB free · D: 56.3 GB · **E: 66.4 GB free** |
| Present | Node 22.15, npm 11.6, Python 3.12, Git, Ollama 0.32.5, WebView2 151, Chrome, Edge |
| Absent | **Rust, MSVC C++ Build Tools** |
| Pre-existing models | `llama3.2:3b`, `qwen2.5:1.5b` — 2.80 GB on C: |

### Decision 1 — Tauri dropped in favour of a local web app

Tauri requires Rust + MSVC Build Tools (~7 GB one-time) and C: had only 22 GB free. The user
proposed a web app with a Windows shortcut instead; this was adopted and upgraded to Chrome's
`--app=` chromeless window mode, which gives a desktop-app look with its own taskbar icon and
Alt+Tab entry at zero toolchain cost.

Traded away: the native OS file picker (HTML file input + drag-drop covers it) and the `.msi`
installer (replaced by `setup.bat` + shortcut). Mic, streaming, SQLite, whisper.cpp and Piper
all still work via a small local Node backend.

### Decision 2 — benchmarking skipped

At the user's instruction, Phase 0's model comparison was dropped. `qwen3:4b` was selected
directly; `gemma3:4b` was never pulled. Benchmarking may be revisited on request.

### Model store relocated to `E:\Arthur\models`

Per the spec's requirement that models never live on C:.

1. Stopped Ollama, created `E:\Arthur\models`, set `OLLAMA_MODELS` at User scope.
2. Moved 2.80 GB of blobs and manifests off C: with `robocopy /MOVE` (verified byte-for-byte).
3. Pulled `qwen3:4b` (2.5 GB, Q4_K_M).

**Result:** 5.12 GB on E:, zero files on C:, **C: free went 22.1 → 24.9 GB**.

### Problem: the Ollama tray app ignores `OLLAMA_MODELS`

`ollama app.exe` — auto-started from the Startup folder — **hardcodes the model path**. Its
server logged `OLLAMA_MODELS:C:\Users\hp\.ollama\models` every time and listed zero models.
The user also changed the model location in the Ollama app's own settings UI; **that had no
effect either.**

**Self-inflicted complication:** a manual `ollama serve` left running after the pull held port
11434, which put the tray app into a **silent crash loop** — `"ollama exited" err="exit status
1"` every ~1.8 s for roughly six minutes, with no user-visible error. This masked the real
diagnosis until the port was freed. *Lesson recorded: never leave a hand-started `ollama serve`
running.*

**Fix — NTFS directory junction:**

```powershell
New-Item -ItemType Junction -Path "$env:USERPROFILE\.ollama\models" -Target "E:\Arthur\models"
```

The tray app reads its hardcoded C: path, NTFS redirects to E:, files stay on E:. Chosen over
editing the Startup shortcut because it needs no admin rights, keeps the tray icon, leaves
Startup untouched, and survives Ollama updates.

**Verified with `OLLAMA_MODELS` unset in the shell** — proving the junction alone does the
work: tray app starts clean, lists all three models, loads `qwen3:4b` (3.5 GB resident), and
generates successfully.

### Model characterization

`qwen3:4b` — 4.0B params, Q4_K_M, Apache 2.0, advertised context **262,144**.

Critical findings (full detail in `docs/model-notes.md`):

- **The 262K context is unusable.** Ollama auto-selects 4096 on 4 GB VRAM, and even then the
  model spills 33% to CPU. Phase 4 must size its cap against runtime `num_ctx`, never 262144.
- **`"think": false` corrupts output** — dumps raw chain-of-thought plus a stray `</think>`
  into `content`. Default mode cleanly splits `message.thinking` from `message.content`.
  Phase 2 must leave thinking at default and render the `thinking` field separately.
- **`num_predict` must not be set low.** At 80 tokens the model spent all of them thinking and
  returned empty `content`.
- **Thinking is expensive:** a one-sentence question cost ~1057 tokens / ~68 s. Warm TTFT is
  only 0.63 s, so **streaming is what makes this bearable.**

### Decision 3 — three effort tiers

The user tested all three models and proposed Claude-style effort levels. Adopted; this
resolves the open question at the bottom of `phases.md`.

| Tier | Model | Throughput | GPU split | Thinks? |
|---|---|---|---|---|
| Low | `qwen2.5:1.5b` | 94.8 tok/s | **100% GPU** | No |
| Medium | `llama3.2:3b` | 51.3 tok/s | 80% / 20% CPU | No |
| High | `qwen3:4b` | 15.7 tok/s | 67% / 33% CPU | **Yes** |

~6× spread, so the tiers are genuinely distinct. Consequences: only one model fits in 4 GB
VRAM at a time (switching costs a 1–10 s reload); the thinking panel renders only on High;
context caps must be per-model. **This moves model selection out of Phase 7 and into Phase 2**,
since the model must be a parameter of `sendMessage()` from the first wiring.

### Files created

```
E:\Arthur\
  .gitignore              models/, data/, node_modules/, dist/, bin/, voices/
  logs.md                 this file
  docs\model-notes.md     model characterization + storage setup
  models\                 5.12 GB — 3 models (gitignored)
```

### State at session end

- Ollama tray app running normally, serving from E: via the junction
- `ollama list` → `qwen3:4b`, `llama3.2:3b`, `qwen2.5:1.5b`
- `OLLAMA_MODELS` User env var still set to `E:\Arthur\models` (now redundant but consistent)
- **Phase 0 complete. No application code written yet.**

### Open items for next session

- Begin Phase 1 (static UI shell)
- Decide tier labels: `Low / Medium / High` vs `Fast / Balanced / Deep`
- The Ollama app's own model-path setting can be reverted to default — it does nothing here
