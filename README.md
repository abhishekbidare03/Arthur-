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
| 6 | Packaging & launcher | ⬜ Next |
| 7 | Polish | 🟡 Markdown + code blocks done early |
| 8 | RAG core (chunking, embeddings, hybrid retrieval) | 🟡 Core done, citation UI pending |
| 9–10 | Collections, advanced formats | ⬜ |

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

This only covers the file(s) attached to the message being answered right now — older
conversation turns still use the Phase 4 whole-turn-fits-or-drops rule. And there's no
clickable citation UI yet, though the model does receive and can quote page numbers.

Scanned PDFs with no text layer, and image-only decks, are refused by name rather than attached
empty — OCR arrives in Phase 10. `.docx` and `.xlsx` name their phase; legacy `.doc`/`.ppt`/`.xls`
say to re-save instead.

## Voice

**Dictate** with the mic button: press to record, press again to stop. The transcript lands in
the composer **editable** — never sent for you — so a misheard word is a one-word fix rather than
a re-record. Speech recognition is `whisper-tiny.en` running on CPU through ONNX, ~3.7× realtime
here, with the model cached on E: beside the others.

`tiny.en` rather than `base.en` because it measured *better*, not just faster: on a deliberately
awkward test sentence it got "Kubernetes" right where `base.en` produced "Kibernets", while being
60% quicker and half the size.

**Read aloud** any answer with the speaker button. This uses the voices Windows already ships,
through the browser — no model, no download. Markdown is stripped to prose first, so a code block
is announced rather than read out backtick by backtick. Voices that synthesize over the network
(Chrome's "Google …" ones) are filtered out; if a machine has *only* those, the button hides
itself rather than quietly making a network call.

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

## Running it

Requires [Ollama](https://ollama.com) running, and the tier models pulled:

```bash
ollama pull qwen2.5:1.5b
ollama pull llama3.2:3b
ollama pull qwen3:4b
```

With the Ollama tray app running, from the repo root:

```powershell
.\start.ps1
```

That checks Ollama is up, installs anything missing, and opens the backend and the dev server
in their own windows. Ports already in use are left alone, so running it twice is harmless.
Then open **http://localhost:5178**.

Or start the two halves by hand:

```bash
cd backend  && npm install && npm run dev   # http://127.0.0.1:5179
cd frontend && npm install && npm run dev   # http://localhost:5178
```

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

Two jsdom tests, both asserting against the rendered DOM:

- **`streaming.test.tsx`** renders the real `App` against a mocked SSE backend and checks the
  streamed reply reaches the screen, across a new chat and a follow-up turn.
- **`markdown.test.tsx`** feeds the renderer malformed fences copied verbatim from the
  conversation database and checks they come out as real code blocks.
- **`attachments.test.tsx`** picks a file in the composer and checks the chip, the document id
  on the request, and the truncation warning.
- **`voice.test.tsx`** drives the mic button with the browser audio APIs mocked, checking the
  recorder opens the mic, uploads WAV, releases the device afterwards, and leaves the transcript
  editable rather than sending it.

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
