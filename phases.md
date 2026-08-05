# Arthur — Build Spec (Offline-First Scope)

**What it is:** A Windows app that mirrors the Claude.ai interface (sidebar, chat pane, input bar), running entirely on local models via Ollama. No internet dependency, no API key, no cloud calls. Voice in/out, file attach, full conversation history — all local.

**Stack:** React + Vite (UI) + Node/Express (local backend) + SQLite (history) + Ollama (local inference) + whisper.cpp (STT) + Piper (TTS), opened in a chromeless `chrome --app=` window with a pinned Windows shortcut.

> **Stack changed from Tauri (2026-08-05).** Tauri needs Rust + MSVC Build Tools (~7 GB) and C: had only 22 GB free. A local web app in Chrome's app-mode gives the same desktop look — own taskbar icon, no address bar or tabs — at zero toolchain cost. See `logs.md`.

**Working docs:** `logs.md` (what was done and why) · `docs/model-notes.md` (measured model behaviour — read before Phase 2 or 4) · `docs/rag-architecture.md` (document/RAG design — read before Phase 3, 4 or 8).

**End state:** a personal, production-quality local assistant — chat, voice, and full RAG over PDFs and documents. Phases 0–7 build the app; Phases 8–10 add documents. Phases 3 and 4 deliberately build the seams that make RAG additive rather than a rewrite.

---

## Phase 0 — Model Selection ✅ COMPLETE (2026-08-05)
**Goal:** Pick the default local models before any UI work starts. Everything downstream (context handling, prompt formatting, latency expectations) depends on this.

Tasks:
- [x] Install Ollama, pull `qwen3:4b` (Q4_K_M). *`gemma3:4b` skipped — see below.*
- [x] Store models in this folder only, never on C: — `E:\Arthur\models`, wired up via an NTFS junction because the Ollama tray app hardcodes its model path and ignores both `OLLAMA_MODELS` and its own settings UI
- [x] Record context window and latency for each chosen model
- [x] Decide effort tiers (resolves the open question at the bottom of this file)
- [ ] ~~Benchmark script `bench/run_bench.py`~~ — **skipped by decision**, may be revisited
- [ ] ~~Manually score quality across candidates~~ — **skipped by decision**

**Outcome — three effort tiers, all already pulled:**

| Tier | Model | Throughput | GPU split | Thinks? |
|---|---|---|---|---|
| Low | `qwen2.5:1.5b` | 94.8 tok/s | **100% GPU** | No |
| Medium *(default)* | `llama3.2:3b` | 51.3 tok/s | 80% / 20% CPU | No |
| High | `qwen3:4b` | 15.7 tok/s | 67% / 33% CPU | **Yes** |

**Hard constraint discovered:** the GTX 1650 Ti has only **4 GB VRAM**. `qwen3:4b` advertises a 262,144 context but Ollama defaults to **4096** here and still spills 33% to CPU. Only one model fits in VRAM at a time — switching tiers costs a 1–10 s reload.

> **Updated 2026-08-05 (Session 4).** The 4096 was Ollama's coarse `4k/32k/256k based on VRAM` default, not a measured fit. With a `q8_0` KV cache and flash attention enabled, **Arthur now runs at `num_ctx` 8192** and the tier throughputs are **106 / 40 / 15 tok/s** (re-measured at 8192; the figures in the table above were taken at 4096 with an f16 cache). 16,384 is available at ~12 tok/s if a phase needs it. The 262,144 ceiling remains unreachable — its KV cache alone would need 36 GiB. See `docs/model-notes.md`.

**Exit criteria:** ✅ Models chosen, latency documented, context limits noted, storage on E: verified.

---

## Phase 1 — UI Shell (Static) ✅ COMPLETE (2026-08-05)
**Goal:** Pixel-close Claude.ai layout, no backend wired yet.

Tasks:
- [x] Vite + React 19 + TS + Tailwind v4 scaffolded in `frontend/` (hand-written config, not `npm create` — deterministic, no interactive prompts). Dev server pinned to **port 5178**, matching the Phase 6 launcher URL
- [x] `Sidebar.tsx` — conversation list from mock data, grouped Today / Yesterday / Previous 7 days / Older; "New chat"; collapse to a 52 px icon rail; hover-reveal delete
- [x] `ChatPane.tsx` — user messages as right-aligned bubbles, assistant messages full-width prose; auto-scroll to newest
- [x] `InputBar.tsx` — auto-grow textarea (capped 200 px), Enter sends / Shift+Enter newline, attach + mic buttons present but disabled with "arrives in Phase 4/5" tooltips
- [x] `TopBar.tsx` — **effort tier selector** showing model, blurb and measured tok/s per tier, plus a warning that switching reloads the model; theme toggle; settings gear
- [x] `ThinkingPanel.tsx` — collapsible reasoning panel, built early with mock data to de-risk Phase 2. Collapsed by default
- [x] React state switches between mock conversations; selecting a conversation adopts the tier it was last used with
- [x] Light/dark themes via CSS custom properties, defaulting to the OS preference

**Verified:** `tsc -b --noEmit` passes · `npm run build` succeeds (216 kB JS / 68 kB gzipped) · dev server serves and Tailwind compiles with design tokens present.

**Exit criteria:** ✅ App looks and navigates like Claude.ai with fake data.

**Deferred to Phase 7 as planned:** real markdown rendering (a minimal bold/code/list renderer stands in), keyboard shortcuts beyond Enter/Shift+Enter, conversation rename.

---

## Phase 2 — Local Inference Wiring ✅ COMPLETE (2026-08-05)
**Goal:** Real messages, real streaming responses.

Tasks:
- [x] `backend/src/inference/ollama.ts`: POST to `http://localhost:11434/api/chat` with `stream: true`
- [x] Express SSE route `/api/chat` streams chunks to the frontend; React consumes with `fetch` + `ReadableStream`
- [x] `ChatPane.tsx`: render streamed tokens incrementally
- [x] **Render `message.thinking` in a collapsible panel, separate from `message.content`** — Ollama returns them as distinct fields. Only the High tier produces thinking, so render it conditionally. **Do not pass `think: false`** — it corrupts output by dumping raw chain-of-thought into `content`.
- [x] **Model/tier is a parameter of `sendMessage()` from day one** — moved up from Phase 7. Retrofitting it later would mean touching the API, DB schema and UI at once.
- [x] Handle Ollama-not-running case: detect connection failure, show inline "Start Ollama" prompt with a retry button. **Never spawn `ollama serve` ourselves** — a second server crash-loops the tray app (see `logs.md`).
- [x] Loading/typing indicator while waiting for first token, plus a hint on the first message after a tier switch (1–10 s model reload)
- [x] Basic system prompt (Arthur's persona/behavior) sent with every request — without it the model introduces itself as "Qwen"

**Added beyond the original list:**
- [x] **Stop button** (and `Esc`) aborting generation end to end — verified to actually free Ollama, not just drop the client. Not optional in practice: the High tier can deliberate for a minute before its first word.
- [x] **`num_ctx` sent explicitly on every request** (8192) — Ollama otherwise auto-selects 4096. See Session 4 in `logs.md`.
- [x] `backend/src/context/buildContext.ts` built now rather than in Phase 4 — Phase 2 has to assemble `{ system, messages }` regardless, so writing it in its final shape avoids a throwaway. Includes budget-based history trimming.

**Verified:** all three tiers stream end to end · `thinking` renders separately from `content` · streaming confirmed *incremental* through the Vite proxy (43 events spread over 1,063 ms, not buffered) · mid-stream abort leaves Ollama free (follow-up request answered in 444 ms) · Ollama-down path returns a typed `ollama_unreachable` error · `tsc -b --force` and `npm run build` both pass.

**Not visually confirmed** — the Claude-in-Chrome extension was not connected, so again no screenshot. Verification was by driving the HTTP surface directly.

**Exit criteria:** ✅ Type a prompt, get a real streamed response from the local model, end to end, at any of the three tiers.

---

## Phase 3 — Conversation Persistence ✅ COMPLETE (2026-08-05)
**Goal:** Durable local history.

Tasks:
- [x] Add `better-sqlite3` to the backend (ships prebuilt binaries for Node 22 — no MSVC needed; `node:sqlite` is the fallback). SQLite at `E:\Arthur\data\arthur.db`
- [x] **Create the full RAG-ready schema now** — see `docs/rag-architecture.md`. Creating these tables early costs little; adding them later means migrating every existing message.
  - `collections (id, name, description, created_at)`
  - `conversations (id, title, tier, collection_id NULL, created_at, updated_at)`
  - `messages (id, conversation_id, role, content, thinking, model, created_at)`
  - `documents (id, collection_id NULL, conversation_id NULL, filename, mime, byte_size, sha256, storage_path, extracted_text_path, page_count, status, created_at)`
  - `message_documents (message_id, document_id)`
  - `chunks`, `chunk_vectors`, `message_sources` — created empty, unused until Phase 8
  - `thinking` and `model` on messages are needed so a reloaded conversation can re-render the thinking panel and show which tier produced each reply
- [x] Sidebar reads conversation list from DB instead of mock data — `mockData.ts` deleted
- [x] New chat → creates DB row; every send/receive persists a message row
- [x] Load conversation on click → populate `ChatPane` from DB
- [x] Delete/rename conversation from sidebar context menu — rename is inline (pencil or double-click; Enter or blur commits, Escape cancels)
- [x] Auto-generate a conversation title from the first message — **text-derived, not model-generated**; see `backend/src/titles.ts` for why the model route is the wrong trade on this hardware

**One deviation from the list above:** `chunk_vectors` is **not** created. It is a `sqlite-vec` virtual table (`vec0(embedding float[384])`) and SQLite cannot create a virtual table whose module is not loaded — the extension does not arrive until Phase 8. Everything it references (`chunks`, `message_sources`) does exist, so adding it later is additive, not a migration. Noted in `schema.sql`.

**Beyond the list:**
- [x] `messages.stats` and `messages.stopped` columns — so a reloaded chat can show Phase 7's latency readout and distinguish a stopped reply from a complete one, without a later migration
- [x] The assistant row is written **before** streaming and filled in as it completes, so a partial answer survives a crash or a closed window
- [x] WAL journaling, `foreign_keys = ON`, and a WAL checkpoint on shutdown so `arthur.db` is self-contained for backup

**Verified:** history intact across a real backend kill/restart (9 checks — conversation, renamed title, tier, message count, role ordering, content, model, stats, sequence) · follow-up turns answer from stored history · cascade delete removes messages · rename persists · stop mid-stream stores the partial answer flagged `stopped` (559 chars) · title derivation strips markdown and cuts on sentence/word boundaries · `tsc` and `npm run build` pass both halves.

**Exit criteria:** ✅ Close and reopen the app — history is intact.

---

## Phase 4 — File Input (Text Files Only — deliberately narrow)
**Goal:** Attach a small text file and inject its content into context. **PDFs and Office documents are explicitly NOT in this phase** — they arrive in Phase 8 via retrieval.

> **Why so narrow:** runtime context is **8192 tokens** (raised from 4096 in Session 4). A 10-page PDF is ~5,000 tokens, and once the system prompt, conversation history and qwen3's ~1,000 thinking tokens are accounted for, a single real document still does not fit alongside a useful conversation. Raw injection genuinely cannot work for documents on this hardware. This phase proves the attachment UX and builds the extraction layer; Phase 8 makes documents actually work. See `docs/rag-architecture.md`.

Tasks:
- [ ] Attach-file button opens an HTML `<input type="file">`; also support drag-and-drop onto the chat pane
- [ ] **Build `backend/src/documents/extractors/` with `text.ts` only** (`.txt` `.md` `.py` `.js` `.ts` `.json` `.csv`). Fix the return shape now — `{ text, pages[], meta }` — so Phase 8 adds PDF/DOCX/XLSX behind the same interface without touching callers
- [ ] **Store documents as rows, never inline** — copy the file to `data/documents/<sha256>`, insert a `documents` row, link via `message_documents`. Do **not** bake file text into `messages.content`; that would force a migration in Phase 8
- [ ] **Build `backend/src/context/buildContext.ts`** as the single context-assembly boundary. Phase 4's implementation returns recent messages + file text; Phase 8 swaps the internals for retrieval and nothing above it changes
- [ ] Inject content with a clear delimiter (e.g. `<file name="x.py">...</file>`)
- [ ] **Size cap per-tier, not one global constant** — and the real limit is runtime `num_ctx` (8192, set in `backend/src/tiers.ts`), not the advertised 262,144. Read it from `tierConfig()` rather than hardcoding, so tuning it again never means hunting for a second copy. Truncate with a visible warning; never fail silently
- [ ] Reject unsupported types with an explicit "PDF support arrives in Phase 8" message rather than a generic error
- [ ] Show attached file as a chip/tag above the input bar before sending

**Exit criteria:** Attach a `.md` or `.py` file, ask a question about it, get a relevant answer. Attaching a PDF gives a clear, honest "not yet supported" message.

---


## Phase 5 — Voice Integration
**Goal:** Voice in and out, fully offline.

Tasks:
- [ ] Bundle whisper.cpp with `tiny.en` or `base.en` quantized model (prebuilt Windows binaries — no compilation needed)
- [ ] Mic button in `InputBar.tsx` → records via `getUserMedia` → backend spawns whisper.cpp as a child process → transcribed text lands in input field (editable before send)
- [ ] Bundle Piper with a lightweight English voice
- [ ] "Read aloud" toggle per message or globally — assistant text → Piper → playback
- [ ] Settings: enable/disable STT and TTS independently

**Exit criteria:** Speak a prompt, see it transcribed, get a response, optionally hear it read back — no internet used anywhere in this loop.

---

## Phase 6 — Packaging & Background Service
**Goal:** One installer, zero manual setup.

Tasks:
- [ ] `setup.bat` — installs npm deps, builds the frontend, creates the Desktop/Start-Menu shortcut
- [ ] `Arthur.vbs` launcher — starts the backend silently, then opens `chrome --app=http://localhost:5178`
- [ ] First-launch check: is Ollama installed? If not, prompt + auto-download installer
- [ ] First-launch check: are all three tier models pulled? If not, `ollama pull <model>` with progress bar in UI
- [ ] ~~Register Ollama as a Windows background service~~ — **moot.** Ollama's tray app already auto-starts from the Startup folder, and the NTFS junction makes it read from E:. Do **not** start a competing server.
- [ ] App icon, name, version metadata as "Arthur"

**Exit criteria:** Fresh Windows machine → run `setup.bat` → app works fully offline, zero terminal commands.

---

## Phase 7 — Polish
**Goal:** Make it feel finished.

Tasks:
- [x] ~~Markdown + code-block rendering (syntax highlighting) in message bubbles~~ — **done early (2026-08-05)**, pulled forward on request: the Phase 1 stand-in renderer flattened fenced code into one unbroken line of prose, which made every code answer unusable. Now `react-markdown` + `remark-gfm` + `highlight.js`, with per-block language labels and a copy button. See Session 6 in `logs.md`
- [ ] Keyboard shortcuts (Ctrl+Enter to send, Ctrl+N new chat, etc.)
- [ ] Theme (light/dark)
- [ ] Latency indicator in UI (ms to first token) — useful for tuning model choice later
- [ ] ~~Model swap from settings without restarting the app~~ — **moved up to Phase 2** as the effort-tier selector
- [ ] Export conversation (markdown/txt)
- [ ] "Regenerate at a higher tier" — re-run the last message at High without retyping it

---

## Phase 8 — RAG Core
**Goal:** Documents actually work. PDFs, Office files and large text handled by retrieval instead of raw injection.

> Full design in `docs/rag-architecture.md`. Phases 3 and 4 build the seams; this phase fills them in.

Tasks:
- [ ] Remaining extractors behind the Phase 4 interface: `pdf.ts` (`pdfjs-dist`), `docx.ts` (`mammoth`), `xlsx.ts` (`xlsx`), `pptx.ts` (`officeparser`) — all pure JS, no Python or MSVC
- [ ] Chunking: ~500 tokens, ~80 overlap, split on paragraph and page boundaries — never blind character splits. Preserve page numbers per chunk for citations
- [ ] **Embeddings on CPU via `@xenova/transformers` + bge-small-en-v1.5 (384-dim, ~130 MB)** — *not* via Ollama. An embedding model in Ollama competes for the 4 GB VRAM and thrashes against the chat model. CPU embedding uses zero VRAM
- [ ] `sqlite-vec` loaded into the existing `arthur.db` — no separate service, no Python
- [ ] Hybrid retrieval: vector search + SQLite FTS5 (BM25), fused by reciprocal rank. FTS5 is built in and free, and beats pure vector search on names, IDs and rare terms
- [ ] Swap `buildContext()` internals to retrieval. **Budget-capped top-k (~5 chunks / ~1,500 tokens)**, not a fixed count — five long chunks blow the allowance where five short ones fit
- [ ] Inline citations in the UI, backed by `message_sources`; click a citation to see the source chunk and page
- [ ] Ingestion progress and real failure states — a PDF that fails to parse shows as `failed`, never silently vanishes

**Exit criteria:** Drop in a 50-page PDF, ask a question about page 30, get a correct answer with a citation pointing there.

---

## Phase 9 — Knowledge Base UX
**Goal:** Collections you build once and reuse — Projects-style.

Tasks:
- [ ] Collections UI: create, rename, delete; assign documents
- [ ] Link a conversation to a collection; chats then answer from that collection by default
- [ ] Folder ingest: point Arthur at a directory, ingest recursively, re-scan for changes (`sha256` gives free dedupe)
- [ ] Document manager: list, view extraction status, re-index, delete
- [ ] Search across a collection independent of chat

**Exit criteria:** Ingest a folder of notes once; every new chat linked to that collection can answer from it without re-uploading.

---

## Phase 10 — Advanced Formats
**Goal:** The awkward inputs.

Tasks:
- [ ] OCR for scanned PDFs via `tesseract.js` (CPU, slow — run as a background job with progress)
- [ ] HTML (`cheerio`) and EPUB
- [ ] Tables extracted as structured text rather than flattened into unreadable runs
- [ ] Detect image-only PDFs and route them to OCR automatically

**Exit criteria:** A scanned PDF becomes searchable and answerable.

---

## Architecture note for future Online mode
Keep one function boundary clean now so Online mode is a bolt-on later, not a rewrite: route all inference through a single `sendMessage(conversation, tier)` call, with the Ollama call as its only implementation for now. When you add the Anthropic API path later, you swap what's *inside* that function based on a mode flag — the UI, DB schema, and streaming renderer shouldn't need to change at all. Worth building it this way from Phase 2 even though you're only implementing the local path today.

**Now living in `backend/src/inference/`.** The tier parameter fits this design naturally: online mode later maps the same three tiers onto Anthropic models instead of local ones, and nothing above the boundary changes.

## Notes / Open Decisions to Revisit
- ~~RAG over files/folders (your ChromaDB pattern) is a natural next step... not in this scope~~ — **RESOLVED 2026-08-05:** RAG is now Phases 8–10 and in scope. **`sqlite-vec` replaces ChromaDB** — it loads into the same `arthur.db` instead of running a second Python service. Phase 4's raw injection was never going to survive contact with a real PDF at 4096 tokens
- ~~Consider whether Arthur needs per-conversation model selection~~ — **RESOLVED 2026-08-05:** yes, three effort tiers. See Phase 0.
- **Document scope RESOLVED 2026-08-05:** Projects-style — persistent collections *and* per-chat attachments
- **Tier labels still undecided:** `Low / Medium / High` (familiar, matches Claude) vs `Fast / Balanced / Deep` (more accurate — these are three different models, not one model with a thinking budget)
- ~~Closing the CPU spill on High (smaller quant, or lower `num_ctx`) is the single biggest available speedup~~ — **partly banked 2026-08-05:** the `q8_0` KV cache took High from 67% → 73% GPU and **+45% throughput at 4096**, spent on doubling the context to 8192 rather than on speed. A smaller weight quant remains untried
- **Phase 7's "regenerate at a higher tier"** now has a second use: re-running at Low is the fast path, and per `docs/rag-architecture.md` Low may be the *best* tier once retrieval supplies the knowledge
- **Not yet done:** the tier dropdown reports tok/s measured on an idle machine. Real figures drop when Chrome is also holding VRAM
- Benchmarking was skipped in Phase 0 and can be revisited; `gemma3:4b` was never pulled and remains an untested candidate
