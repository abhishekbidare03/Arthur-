# Arthur

A Claude-style desktop chat app that runs entirely on your own machine. No internet, no API
key, no cloud calls — local models via [Ollama](https://ollama.com), served as a local web app
in a chromeless Chrome window.

Built to be usable on modest hardware: the reference machine is a GTX 1650 Ti with **4 GB of
VRAM**, which drives most of the design decisions in this repo.

## Status

| Phase | | |
|---|---|---|
| 0 | Model selection | ✅ Complete |
| 1 | UI shell (static) | ✅ Complete |
| 2 | Local inference wiring | ✅ Complete |
| 3 | Conversation persistence | ✅ Complete |
| 4 | File input (text only) | ✅ Complete |
| 5 | Voice in/out | ✅ Complete |
| 6 | Packaging & launcher | ✅ Complete |
| 7 | Polish | ✅ Complete |
| 8 | RAG core (chunking, embeddings, hybrid retrieval) | ✅ Complete |
| 9 | Collections / knowledge base | ✅ Complete |
| 10 | Advanced formats | ⬜ |

Working chat with real streamed responses across three effort tiers, with durable local
history in SQLite. Conversations survive restarts; rename and delete from the sidebar.
Text files can be attached by picker or drag-and-drop and asked about.

## Attachments

Attach **PDFs**, **PowerPoint decks**, or any of ~60 text and source formats — by paperclip or
by dropping onto the chat column. The chip shows its **token** cost rather than its byte size,
because tokens are what decide whether it fits.

| Format | Read as |
|---|---|
| `.pdf` | Per-page text via `pdfjs-dist`, fonts resolved locally — no CDN, no network |
| `.pptx` | Per-slide text with speaker notes, by reading the file's own XML |
| ~60 text/source types | Directly, with binary files refused rather than mangled |

Context is 8192 tokens, so a newly-attached file takes at most 60% of the working budget and is
truncated rather than silently dropped — both the model and the message are told what was cut.

**Each file stays with the turn it was attached to**, not re-pasted onto every later message.
Ask a follow-up about it later in the same chat and it is still there, because that turn is
still in history — but attach a *different* file and ask "what is this", and only the new one
answers. Gluing every attachment onto the newest question was the original design and it
produced exactly that mix-up; a file now sits next to the question it actually belongs to, the
way a real conversation does.

**Large files are retrieved, not blindly truncated.** A file too large to inject whole is
chunked (~500 tokens, page-aware) and embedded on CPU (`bge-small-en-v1.5`, never via Ollama —
zero VRAM contention with the chat model), then searched by a hybrid of vector similarity and
SQLite FTS5 keyword search, fused by reciprocal rank. The chunks most relevant to *this
question* are sent instead of whichever characters happened to come first. Verified against a
real 49,633-character document with a fact placed 60% of the way through, against the smallest
tier's ~4,200-token attachment budget — the old truncation path (first ~16,700 characters) would
never have reached it; retrieval did.

**Every retrieved answer says what it was given.** Under the reply, a collapsed `8 sources ·
report.pdf p. 4, 11–13` opens to the passages themselves, in full. Not a snippet with a link —
there is nowhere to link *to*, since the source is a stored file rather than a rendered page, so
showing the text is the whole affordance. They're stored against the answer, so reopening the
conversation months later shows the same citations it showed when the answer first arrived.

**Files stay useful for the rest of the conversation.** Ask about an attachment three turns
later and Arthur retrieves from it against your new question, rather than dropping the turn
because it no longer fits. Only the most recent oversized turn is compressed — anything older
wouldn't have fit either, and spending the remaining budget there would starve the part of the
conversation you're actually in.

Large uploads show real progress (`indexing 32/49`), counted in chunks, because that's what the
work is made of.

Scanned PDFs with no text layer, and image-only decks, are refused by name rather than attached
empty — OCR arrives in Phase 10. `.docx` and `.xlsx` name their phase; legacy `.doc`/`.ppt`/`.xls`
say to re-save instead.

## Collections

Build a document set once and reuse it. Point a collection at a **folder** (`Ctrl+K`) and Arthur
walks it, reads what it can, and indexes it — skipping `node_modules`, `.git`, build output and
binaries rather than drowning the collection in them. Re-scan any time: files are recognised by
content, so an unchanged one costs a single read and nothing else.

Link a chat to a collection and every turn answers from it — **nothing attached, nothing
re-uploaded**. The passages come back as citations like any other retrieval, so you can see what
the answer was built from. Collection material is marked as reference material rather than as an
attached file, so the model doesn't describe your notes as "the document you sent me".

You can also just **search** a collection without asking anything. Same hybrid retrieval, no
model loaded, results in milliseconds — "which of my notes mentions this?" is a different
question from "answer this".

The document list shows what's actually searchable. A file that failed to index says **"not
searchable"** rather than showing a neutral badge, because to retrieval it may as well not
exist; re-index or remove it from there.

## Voice

**Dictate** with the mic button and the words appear **as you speak** — each phrase is
transcribed the moment you pause, so the text keeps pace with you rather than arriving in a lump
at the end. Press again to stop; the text stays in the composer **editable** and is never sent
for you, so a misheard word is a one-word fix rather than a re-record. Pressing send while still
talking finishes the sentence first rather than cutting it off.

Whisper is not a streaming model — it transcribes a finished clip. Splitting on natural pauses is
what makes it feel live: the pieces are short enough to transcribe quickly *and* whole enough
that the model still has the context it needs to hear correctly. The obvious alternative,
re-transcribing everything every second, gets slower exactly as you talk longer; this way the lag
stays flat however long the recording runs. Speech recognition is `whisper-tiny.en` on CPU
through ONNX, ~3.7× realtime here, cached on E: beside the other models.

`tiny.en` rather than `base.en` because it measured *better*, not just faster: on a deliberately
awkward test sentence it got "Kubernetes" right where `base.en` produced "Kibernets", while being
60% quicker and half the size.

**Read aloud** any answer with the speaker button. This uses the voices Windows already ships,
through the browser — no model, no download. Markdown is stripped to prose first, so a code block
is announced rather than read out backtick by backtick. Voices that synthesize over the network
(Chrome's "Google …" ones) are filtered out; if a machine has *only* those, the button hides
itself rather than quietly making a network call.

## Finishing touches

Under every finished answer: **how long it actually took** — time to first token, measured
tok/s, output tokens, with the full breakdown on hover. Which tier is worth its wait is a real,
repeated decision on this hardware, and it can't be made from a number measured once on an idle
machine. If earlier turns were dropped to fit the context window, it says so — an answer
assembled without the start of a conversation can be wrong in a way that looks entirely
confident.

**Retry at a different tier** without retyping anything. The question stays exactly as asked,
attached files come with it, and the stale answer is *replaced* rather than joined by a second
one. The tier you pick is adopted for the rest of the conversation.

**Export as Markdown** (`Ctrl+E`) — code fences intact, reasoning collapsed into a `<details>`,
attachments named, stopped replies marked. Built from what's already on screen, so it works even
with the backend down.

Shortcuts: `Ctrl+N` new chat · `Ctrl+E` export · `Ctrl+B` sidebar · `Ctrl+1/2/3` tier ·
`Ctrl+Shift+M` dictate · `Esc` stop · `?` for the list.

## Effort tiers

Three user-selectable levels, each a different local model rather than one model with a
thinking budget. Only one fits in 4 GB of VRAM at a time, so switching costs a reload.

| Tier | Model | Throughput | GPU |
|---|---|---|---|
| Low | `qwen2.5:1.5b` | ~106 tok/s | 100% |
| Medium *(default)* | `llama3.2:3b` | ~40 tok/s | 78% |
| High | `qwen3:4b` | ~15 tok/s | 64% |

Measured at `num_ctx` 8192 with a `q8_0` KV cache. Only High produces reasoning, rendered in a
separate collapsible panel.

## Stack

React 19 · TypeScript · Vite 7 · Tailwind v4 · Express 5 · Ollama · SQLite · sqlite-vec ·
pdfjs-dist · transformers.js (bge-small-en-v1.5 embeddings and whisper-tiny.en speech, both
CPU-only)

No Rust, no MSVC, no Python — every dependency installs from npm with prebuilt binaries.

## Installing it

Install [Ollama](https://ollama.com) and let its tray app start. Then, from the repo root:

```
setup.bat
```

That installs dependencies, builds the UI, generates the Windows icon and puts **Arthur** on the
Desktop and in the Start menu. After it, Arthur is a double-click — no terminal, no commands.
The launcher starts the backend with no console window and opens a chromeless Chrome window
with its own taskbar entry.

You do **not** need to pull the models by hand. If a tier's model is missing, Arthur says so on
launch and offers to fetch it, with progress, one tier at a time — that download is the only
moment Arthur uses the internet. If you'd rather do it yourself:

```bash
ollama pull qwen2.5:1.5b
ollama pull llama3.2:3b
ollama pull qwen3:4b
```

Setup is idempotent: run it again after a `git pull` and it rebuilds and moves on.

### Running it for development

```powershell
.\start.ps1
```

That checks Ollama is up, installs anything missing, and opens the backend and the Vite dev
server in their own windows. Ports already in use are left alone, so running it twice is
harmless. Then open **http://localhost:5178**.

Or start the halves by hand:

```bash
cd backend  && npm install && npm run dev     # API only, http://127.0.0.1:5179
cd frontend && npm install && npm run dev     # UI,        http://localhost:5178

cd backend  && npm run serve                  # what the launcher runs: both, on 5178
```

**http://localhost:5178** is the address in both modes. In development that port is Vite,
proxying `/api` to the backend on 5179; in the shipped app there is no Vite, so the backend
takes 5178 and serves the built UI itself. One process, one port, one URL to remember — and
same-origin either way, which is why there is no CORS middleware anywhere.

Arthur connects to Ollama's tray-app server and **never spawns its own `ollama serve`** — a
second server holds the port and silently crash-loops the tray app. `start.ps1` therefore
checks for Ollama and stops with instructions rather than trying to start it.

### Recommended Ollama settings

A quantized KV cache roughly halves memory per token, which is what makes an 8192-token context
viable on 4 GB. Set these as user environment variables:

```
OLLAMA_FLASH_ATTENTION=1
OLLAMA_KV_CACHE_TYPE=q8_0
```

Flash attention is a prerequisite, not an optional extra.

## Tests

```bash
cd backend  && npm test
cd frontend && npm test
```

`backend/extractors.test.mts` builds a real two-page PDF and a real `.pptx` in memory — no
committed fixtures — and checks page and slide numbers survive, speaker notes are labelled, and
each refusal is specific (a corrupt PDF, a text-free scan, and a legacy `.ppt` all say different
things).

`backend/buildContext.test.mts` pins the cross-file mix-up bug: attach file A, ask about it,
attach a different file B, ask "what is this" — asserts B's text lands on the new turn and A's
does not, that a genuine follow-up about A (no re-attach) still works, and that an oversized,
un-indexed attachment truncates rather than dropping the whole turn.

`backend/rag.test.mts` exercises the real retrieval pipeline — real embeddings, real
`sqlite-vec`, real FTS5, no mocks (only the database file is redirected to a scratch path).
Builds a three-page fixture with a distinct fact per page, chunks it, indexes it, and checks
that a query about one page's fact returns that page's chunk and not the others; that keyword
search finds an exact code; that a tight token budget is never exceeded; and that
`buildContext` falls back from truncation to retrieval for an oversized *indexed* file while
still truncating one that isn't.

`backend/index-integrity.test.mts` pins a bug that silently disabled retrieval for a whole
phase. `chunk_vectors` and `chunks_fts` are virtual tables, which cannot participate in a foreign
key — so deleting a conversation cascaded away its chunks while both indexes kept every row, and
SQLite then reused those rowids for the next document and failed on a UNIQUE constraint. The test
ingests, cascade-deletes, asserts the stranding actually happens, then re-ingests onto the freed
rowids.

`backend/collections.test.mts` covers folder ingest with real files: that the walk skips
`node_modules` and binaries, that a re-scan recognises unchanged files instead of re-embedding
them, that ingesting a folder **cannot steal a document row a conversation owns**, and that a
linked collection's passages reach the prompt with nothing attached to the message.

Two jsdom tests, both asserting against the rendered DOM:

- **`streaming.test.tsx`** renders the real `App` against a mocked SSE backend and checks the
  streamed reply reaches the screen, across a new chat and a follow-up turn.
- **`markdown.test.tsx`** feeds the renderer malformed fences copied verbatim from the
  conversation database and checks they come out as real code blocks.
- **`attachments.test.tsx`** picks a file in the composer and checks the chip, the document id
  on the request, and the truncation warning.
- **`voice.test.tsx`** drives the mic button with the browser audio graph mocked, *playing audio
  into* the recorder to check that words land in the composer **while recording is still
  running** — the point of the feature — that phrases accumulate in order, that the mic and
  audio context are released on stop, and that nothing is auto-sent.
- **`polish.test.tsx`** covers the Phase 7 behaviours that fail *silently* rather than visibly:
  that the latency readout comes from what this reply measured rather than the tier table, that
  retry replaces the previous answer instead of appending a second one under the same question,
  and that the Markdown export round-trips code fences, reasoning, attachment names and a
  stopped reply. The retry assertion counts rendered answer bodies rather than matching text —
  the substring version passed even with the replacement sabotaged.
- **`segmenter.test.mts`** covers the logic that decides when a phrase has ended: a real pause
  ends one, a gap between words does not (or dictation would fragment into unusable scraps), a
  long unbroken run is still cut so text keeps appearing, and silence is never sent at all.

`backend/voice.test.mts` builds real WAVs for each case that actually differs — an 18-byte `fmt `
chunk (what Windows writes, and what a fixed-offset reader decodes as garbage), an unexpected
chunk before `data`, stereo downmix, unsigned 8-bit, resampling — then synthesizes real speech
and transcribes it through the real model. It also pins the silence case: whisper *hallucinates*
on silence rather than returning nothing, so the gate checks the audio, not the transcript.

Both exist because bugs in this layer are invisible from the backend: `/api/chat` streamed
correctly and SQLite stored every answer while the UI was showing nothing at all.

## Documentation

This repo keeps its reasoning, not just its code:

- **[`docs/model-notes.md`](docs/model-notes.md)** — measured model behaviour: the KV-cache
  arithmetic behind the context limit, per-tier throughput, and which latency levers actually
  work (several do not)
- **[`docs/rag-architecture.md`](docs/rag-architecture.md)** — the document/RAG design, and the
  five seams built early so it lands as an addition rather than a rewrite
- **[`docs/voice-architecture.md`](docs/voice-architecture.md)** — the Phase 5 (voice) design:
  the STT/TTS boundary shape, why whisper.cpp/Piper are spawned per-request rather than run as
  a service, and what's still an open question

The build plan and the session-by-session work log are kept locally rather than published —
they record hardware specifics and local paths. Commit messages carry the reasoning behind
each phase.

## License

Personal project. Models carry their own licenses (`qwen3:4b` is Apache 2.0).
