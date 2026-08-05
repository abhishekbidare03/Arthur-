# Arthur — Voice Architecture

Decided 2026-08-05. **Not implemented yet** — this is Phase 5's structure, written the same way
`rag-architecture.md` was written before Phase 8: so the seams are right before any code exists,
rather than discovered mid-implementation. `phases.md` still carries the authoritative task
checklist; this document is the reasoning behind it.

## Scope

Speech in, speech out, both fully offline — no cloud STT/TTS API, matching the rest of the app.

- **STT (speech → text):** mic button in `InputBar.tsx` (already present, disabled, wired to
  nothing — see line ~145) records audio, sends it to the backend, gets text back, and drops
  that text into the composer **editable before send**. Never auto-sends — a wrong transcription
  should be as easy to fix as a typo, not require re-recording.
- **TTS (text → speech):** a "read aloud" affordance per assistant message (mirrors the existing
  copy-button pattern on code blocks) plays the answer back.

## The two boundaries

Same shape as `inference/types.ts` — one provider-agnostic interface per direction, so a future
swap (a different STT engine, a hosted API in an eventual Online mode) touches one file, not
every call site.

```ts
// backend/src/voice/types.ts (not yet created)

interface TranscribeInput {
  audio: Buffer          // WAV, 16kHz mono — what whisper.cpp wants, so the frontend
                          // resamples before upload rather than the backend after
}
interface TranscribeResult {
  text: string
  durationMs: number     // for the UI's "transcribing…" spinner to have a sane timeout
}

interface SynthesizeInput {
  text: string
}
// Returns a raw audio stream, not a whole-file buffer — TTS should start playing before
// the whole sentence has finished generating, the same reasoning `sendMessage`'s
// AsyncGenerator streams tokens instead of waiting for the full reply.
type SynthesizeResult = AsyncGenerator<Uint8Array>
```

## Why whisper.cpp and Piper, not something else

Both are the same shape as the Ollama decision: a prebuilt, offline, CPU-friendly binary rather
than a Python service. Specifically:

- **whisper.cpp**, `tiny.en` or `base.en`, quantized. Pure C++, prebuilt Windows binaries exist,
  no MSVC needed — the same reasoning that ruled out Tauri in Session 1 rules out anything
  requiring a build toolchain here too.
- **Piper**, a lightweight English voice. Same story: prebuilt binary, no Python.

Model files go in `E:\Arthur\models\voice\` (or a `whisper/` + `piper/` split under it) —
**not C:**, matching every other model asset in this repo (chat models via the `models/`
junction, embeddings in `models/embeddings/`). `bin/` and `voices/` are already gitignored,
suggesting this was anticipated before this document existed.

## The process boundary — spawned per-request, not a running service

This is the one place this phase's reasoning **differs** from the Ollama rule ("never spawn a
competing server"). Ollama is long-running because model load is the expensive part and staying
resident avoids paying it every message. whisper.cpp and Piper are the opposite: invoked once
per utterance, each run is short (a few seconds of audio, a few hundred words of reply), and
there is no shared state to protect by staying resident. So the backend spawns a child process
per transcription/synthesis call (`node:child_process`), same pattern as `pdfjs-dist`/`fflate`
being called inline rather than run as a service — nothing here needs to be "the tray app."

**GPU:** deliberately CPU-only for both, same reasoning as the embedding model in
`rag-architecture.md` — the 4 GB VRAM budget belongs to whichever chat model is loaded, full
stop. whisper.cpp *can* use CUDA; this app should never ask it to.

## Where it plugs in

- `InputBar.tsx`'s mic button → `POST /api/transcribe` (raw audio body, mirroring
  `POST /api/documents`'s raw-bytes-plus-header pattern rather than multipart) → text lands in
  the existing `value` state, editable, not auto-submitted.
- A new small control on each assistant message bubble → `POST /api/speak` → streamed audio →
  `<audio>` element or the Web Audio API, whichever ends up simpler once real latency is
  measured. Not decided yet; deferred to implementation, since guessing now without a measured
  time-to-first-audio-byte would just be the same mistake the original `num_ctx: 4096` default
  was — a plausible-sounding number nobody actually measured.
- Settings: enable/disable STT and TTS independently (`phases.md`'s existing task list — unchanged
  by this document).

## What is NOT decided yet

- Exact resampling approach for mic audio (`getUserMedia` typically gives 44.1/48kHz; whisper.cpp
  wants 16kHz mono) — browser-side via `AudioContext`, or sent as-is and resampled server-side.
  Leaning browser-side (smaller upload), not yet measured.
- Whether `base.en` is fast enough to feel responsive on this machine's CPU (the same one already
  sharing cycles with a loaded chat model) or whether `tiny.en` is the right default with `base.en`
  as an opt-in for accuracy. Needs a real measurement, not a guess — same standard this repo has
  held every other model choice to.
- TTS playback UX details (per-message toggle vs. a single global "speak replies" setting).

## Exit criteria (unchanged from `phases.md`)

Speak a prompt, see it transcribed, get a response, optionally hear it read back — no internet
used anywhere in that loop.
