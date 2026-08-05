# Arthur — RAG Architecture

Decided 2026-08-05. **Core retrieval implemented 2026-08-05** — see the amendment after seam 5
and the Phase 8 section of `phases.md` for what actually shipped versus what's still open. This
document was originally written before any of it existed, specifically so Phases 1–4 would be
built along seams that made RAG (Phases 8–10) additive rather than a rewrite; it held.

## Why this matters now

Runtime context on this machine is **~4096 tokens** (4 GB VRAM pins it there — see
`model-notes.md`). A 10-page PDF is roughly 5,000 tokens.

**A single real document already exceeds the entire context budget.** So retrieval is not a
later enhancement here; it is the only mechanism by which documents will ever work. Phase 4's
"inject raw file text into the prompt" approach is viable only for small text files, which is
exactly why Phase 4 has been narrowed to that.

## Scope decision

**Projects-style — both models of document ownership:**

- **Collections** — persistent sets of documents, ingested once, reusable across conversations
  (like Claude Projects). A conversation may be linked to a collection.
- **Per-chat attachments** — one-off files attached to a single conversation.

---

## The five seams

### 1. Documents are first-class rows, never inline text

Files are copied to `E:\Arthur\data\documents\<sha256>` and recorded in a `documents` table.
Messages **reference** documents; they never embed document text.

If Phase 4 were to bake file content into `messages.content`, adding RAG later would require
migrating every historical message. The `sha256` also gives free deduplication — attach the
same PDF twice, ingest it once.

### 2. One extraction layer — `backend/src/documents/extractors/`

`index.ts` dispatches on file extension. Every extractor returns the same shape:

```ts
{ text: string, pages: { no: number, text: string }[], meta: Record<string, unknown> }
```

| Phase | Extractors |
|---|---|
| 4 | `text.ts` — ~60 text and source extensions |
| 4 *(pulled forward)* | `pdf.ts` (`pdfjs-dist`) · `pptx.ts` (`fflate`) |
| 8 | `docx.ts` (`mammoth`) · `xlsx.ts` (`xlsx`) |
| 10 | OCR (`tesseract.js`) · HTML (`cheerio`) · EPUB |

> **PDF and PPTX arrived in Phase 4, not 8** (2026-08-05), on request. The seam held: both
> registered behind `Extractor` and nothing above the extraction layer changed. They are
> *injected* rather than retrieved, so a large PDF is still truncated to the token budget with a
> visible warning — a 16-page paper measured at ~22,500 tokens against an 8192 window, of which
> ~19% fits. Retrieval in Phase 8 is what makes large documents genuinely work; this makes them
> attachable and honest about what was read.
>
> **`pptx.ts` uses `fflate`, not `officeparser` as specified above.** `officeparser` pulls in
> `tesseract.js` — an entire OCR engine, which is Phase 10 work — and flattens a deck to a single
> string, discarding the slide boundaries this document's citation design depends on. A `.pptx`
> is a ZIP of XML, so unzipping it and scanning `<a:t>` runs gives per-slide text with the slide
> numbers intact, for one tiny pure-JS dependency.

Phase 4 *injects* this output; Phase 8 *chunks* the same output. The interface is fixed now so
the code is written once. Page numbers are captured from the start because citations need them.

All parsers are pure JS — no Python, no MSVC, consistent with the rest of the stack.

### 3. A single context-assembly boundary — `backend/src/context/buildContext.ts`

Mirrors the `sendMessage()` boundary already in `phases.md`:

```ts
buildContext({ conversation, tier, attachments }) → { system, messages }
```

- **Phase 4:** recent messages + full or truncated attachment text
- **Phase 8:** recent messages + top-k retrieved chunks + citation metadata

Nothing above this boundary — UI, streaming renderer, DB schema — changes when RAG lands.

### 4. Vector storage: `sqlite-vec`, not ChromaDB

The original spec referenced a ChromaDB pattern. ChromaDB means running a second Python service
alongside the app. `sqlite-vec` is an extension loaded into the **same `arthur.db`** that
Phase 3 already creates: one file, one process, no Python, prebuilt binaries via npm.

Bonus: SQLite's built-in **FTS5** provides BM25 keyword search for free, so Phase 8 can do
**hybrid retrieval** — vector + keyword, fused by reciprocal rank — instead of vector-only.
Hybrid materially outperforms pure vector search on exact names, IDs and rare terms.

Backup story is correspondingly simple: `arthur.db` + `data/documents/` is the entire state.

> **Implemented (2026-08-05).** `backend/src/db/vectors.ts`. One wrinkle the design above didn't
> anticipate: `vec0` tables require an *integer* rowid, but `chunks.id` is a text UUID (matching
> every other table's id scheme in this schema). Rather than add a second mapping table, both
> `chunk_vectors` and `chunks_fts` key off SQLite's own **implicit** rowid on `chunks` — every
> ordinary table has one automatically unless declared `WITHOUT ROWID`, even with a non-integer
> declared primary key, so `chunks.rowid` (never exposed as an id anywhere else) is exactly the
> integer needed and there is nothing extra to keep in sync. `chunks_fts` uses FTS5's
> `content=''` (contentless) mode rather than external-content mode tied to `chunks`, because
> external-content mode requires the content table's rowid to be a *real* `INTEGER PRIMARY KEY`
> alias, which a `TEXT PRIMARY KEY` table's implicit rowid is not. The cost is storing chunk text
> twice (once in `chunks`, once in `chunks_fts`) — a few KB per document, irrelevant next to a
> 130 MB model file.

### 5. Embeddings on CPU via `transformers.js` — **not** Ollama

**The most important hardware decision in this document.**

An embedding model loaded into Ollama competes for the same 4 GB of VRAM as the chat model,
causing repeated unload/reload thrashing on every query.

Instead: `@xenova/transformers` running **bge-small-en-v1.5** (384 dimensions, ~130 MB) on CPU
via ONNX.

- Zero VRAM — never contends with the chat model
- No Ollama involvement, no model swapping
- Ingestion is a one-time background cost per document
- Query embedding is one short string — milliseconds on CPU

Model files live in `E:\Arthur\models\embeddings\` (gitignored).

> **Implemented as designed (2026-08-05).** `backend/src/rag/embed.ts`. Cold start (first-ever
> download) measured at ~14 s; every load after that reads from `E:\Arthur\models\embeddings\`
> and takes ~300 ms. A batch embed call is ~15–20 ms regardless of batch size in the tested range.
> Confirmed zero GPU involvement — this runs purely on CPU via ONNX, and nothing about it touches
> Ollama or the 4 GB VRAM budget. `bge`'s query-side instruction prefix
> (`"Represent this sentence for searching relevant passages: "`) is applied to queries only, not
> to indexed chunks, per how the model was trained.

---

## Schema (created in Phase 3)

Tables marked *(empty until Phase 8)* are created early specifically to avoid a later migration.

```sql
collections        (id, name, description, created_at)

conversations      (id, title, tier, collection_id NULL, created_at, updated_at)

messages           (id, conversation_id, role, content, thinking, model, created_at)

documents          (id, collection_id NULL, conversation_id NULL,
                    filename, mime, byte_size, sha256,
                    storage_path, extracted_text_path,
                    page_count, status, created_at)
                   -- status: pending | extracted | indexed | failed

message_documents  (message_id, document_id)                       -- Phase 4

chunks             (id, document_id, ordinal, text,
                    page_no, char_start, char_end, token_count)    -- (empty until Phase 8)

chunk_vectors      -- sqlite-vec vec0(embedding float[384])         -- (empty until Phase 8)

message_sources    (message_id, chunk_id, score)                    -- (empty until Phase 8)
```

A document belongs to **either** a collection **or** a conversation — `collection_id` and
`conversation_id` are mutually exclusive nullable FKs.

`message_sources` is what makes inline citations possible. Adding it after the fact would mean
backfilling every existing message, so it is created now even though nothing writes to it until
Phase 8.

`documents.status` drives the ingestion pipeline and gives the UI real failure states — a PDF
that fails to parse must show as `failed`, not silently vanish.

---

## Retrieval design (Phase 8)

**Chunking:** ~500 tokens with ~80 tokens of overlap, split on paragraph and page boundaries
rather than blindly by character count. Page numbers preserved per chunk for citations.

**Retrieval budget — the binding constraint.** With ~4096 tokens total:

| Allocation | Tokens |
|---|---|
| System prompt | ~200 |
| Retrieved chunks (top-k ≈ 5) | ~1,500 |
| Conversation history | ~1,200 |
| Room for the answer | ~1,200 |

Top-k must be *budget-capped*, not a fixed count — five long chunks can blow the allowance
where five short ones fit.

**Tier interaction — a useful consequence.** Retrieval supplies the knowledge, so raw model
strength matters less for document questions. The **Low** tier (`qwen2.5:1.5b`, 100% GPU,
95 tok/s) may well be the *best* RAG tier: fast, fully GPU-resident, and it does not burn
1,000 tokens thinking before answering. The High tier's reasoning is better spent on synthesis
than on lookup.

> **Implemented (2026-08-05), scoped to the newest turn.** `backend/src/rag/chunk.ts`,
> `retrieve.ts`, and `context/buildContext.ts`. What's real:
>
> - Chunking splits on paragraph boundaries (falling back to line boundaries for a page with
>   none) and **never crosses a page**, so every chunk has exactly one honest page citation.
>   A paragraph longer than one chunk's target is itself split, so a wall-of-text page can't
>   produce one unbounded chunk.
> - Retrieval is hybrid as designed: `sqlite-vec` KNN + FTS5 BM25, both scoped to an explicit
>   document-id set (never the whole database — a conversation's other files must not leak into
>   an answer, the same guarantee the Phase 4 per-turn-attachment fix makes for injected text),
>   fused by reciprocal rank fusion (`1/(60 + rank + 1)` per list, summed).
> - Budget capping is real: `buildContext` passes whatever token budget the newest turn's
>   attachment share has left, and `retrieveChunks` stops adding chunks once the next one would
>   exceed it — verified in `backend/rag.test.mts` with a deliberately tiny budget.
> - **What's not (yet) covered:** retrieval only kicks in for the *newest* turn's own attachments
>   — the one case the reported bug and the "large PDF truncated" limitation both concerned.
>   Older history turns still use the Phase 4 whole-turn-fits-or-drops rule; making them
>   retrieval-aware too is additive, not deferred for architectural reasons, just time. The
>   `message_sources` table (inline, clickable UI citations) is still empty — the model receives
>   and can quote page numbers in its answer text, but there's no dedicated UI for it yet.
> - **Verified live**, not just in a unit test: a 49,633-character (~12,400-token) document with
>   a fact placed at roughly the 60% mark, against the `low` tier's ~4,200-token attachment
>   budget, correctly retrieved and answered from the buried fact (`state: "retrieved"`,
>   10 chunks) — something the old blind truncation (first ~16,700 characters, well short of
>   where the fact lived) structurally could not do.

---

## Definition of "production ready" (single local user)

**In scope:** durable storage, no data loss, real error handling with visible failure states,
fast startup, a clean backup story.

**Out of scope:** authentication, multi-tenancy, horizontal scaling, rate limiting. This is a
personal app; building for those would be gold-plating.
