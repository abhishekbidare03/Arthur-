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
| 4 | File input (text only) | ⬜ Next |
| 5 | Voice in/out | ⬜ |
| 6 | Packaging & launcher | ⬜ |
| 7 | Polish | 🟡 Markdown + code blocks done early |
| 8–10 | RAG over documents | ⬜ |

Working chat with real streamed responses across three effort tiers, with durable local
history in SQLite. Conversations survive restarts; rename and delete from the sidebar.

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

React 19 · TypeScript · Vite 7 · Tailwind v4 · Express 5 · Ollama

No Rust, no MSVC, no Python — every dependency installs from npm with prebuilt binaries.

## Running it

Requires [Ollama](https://ollama.com) running, and the tier models pulled:

```bash
ollama pull qwen2.5:1.5b
ollama pull llama3.2:3b
ollama pull qwen3:4b
```

Then, in two terminals:

```bash
cd backend  && npm install && npm run dev   # http://127.0.0.1:5179
cd frontend && npm install && npm run dev   # http://localhost:5178
```

Arthur connects to Ollama's tray-app server and **never spawns its own `ollama serve`** — a
second server holds the port and silently crash-loops the tray app.

### Recommended Ollama settings

A quantized KV cache roughly halves memory per token, which is what makes an 8192-token context
viable on 4 GB. Set these as user environment variables:

```
OLLAMA_FLASH_ATTENTION=1
OLLAMA_KV_CACHE_TYPE=q8_0
```

Flash attention is a prerequisite, not an optional extra.

## Documentation

This repo keeps its reasoning, not just its code:

- **[`phases.md`](phases.md)** — the build plan, with completed phases marked up
- **[`logs.md`](logs.md)** — chronological record of what was done and why, newest first
- **[`docs/model-notes.md`](docs/model-notes.md)** — measured model behaviour: context
  arithmetic, throughput, and which latency levers actually work
- **[`docs/rag-architecture.md`](docs/rag-architecture.md)** — the document/RAG design, and the
  five seams built early so it lands as an addition rather than a rewrite

## License

Personal project. Models carry their own licenses (`qwen3:4b` is Apache 2.0).
