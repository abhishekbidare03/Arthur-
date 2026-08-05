# Arthur — Voice Architecture

Decided 2026-08-05, **implemented 2026-08-06**. Written first the same way `rag-architecture.md`
was written before Phase 8 — seams before code — then revised against what actually shipped.

> **Two decisions below were overturned in implementation**, both toward doing less. whisper.cpp
> became `transformers.js`, and Piper became the browser's own speech synthesis. Both changes are
> marked inline where the original reasoning appears, with the measurement that drove them. The
> shape of the thing — one boundary per direction, CPU-only, models on E:, transcripts editable —
> survived unchanged.

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

> **Both engines were replaced during implementation (2026-08-06).** The model-storage rule held;
> the engines did not.
>
> **whisper.cpp → `@xenova/transformers`.** Phase 8 had already proven `transformers.js` here for
> embeddings, and it runs Whisper through the same ONNX path — so speech cost *zero* new
> dependencies, no GitHub-release binary to fetch and keep current, and no child process. The
> per-request-spawn design below existed to avoid a resident service; not spawning anything at
> all satisfies that more directly. Measured: 3.67 s of speech transcribed in ~1.0 s on CPU
> (~3.7× realtime), ~900 ms warm model load, 42 MB on disk.
>
> **Piper → the browser's `speechSynthesis`.** Chrome already exposes the speech voices Windows
> ships with (two here: Microsoft David and Zira), fully offline. That made TTS a browser API
> call: no model, no binary, no `/api/speak` route, no audio streaming to get right. Piper would
> sound better and can be revisited — but ~60 MB of model plus a binary, to improve a feature
> whose job is reading out an answer already on screen, was not the right place to start.
> The one hard rule this introduces is in `frontend/src/voice/speech.ts`: `speechSynthesis` mixes
> local and *network* voices in one list (Chrome's "Google …" voices synthesize server-side), so
> Arthur filters on `localService` and reports read-aloud unavailable rather than ever making a
> network call.

## `tiny.en` vs `base.en` — resolved by measurement

Listed below as an open question; settled 2026-08-06 by running both against a deliberately
awkward sentence (technical nouns, an acronym containing a digit):

| Model | "Kubernetes" | "FTS5" | Transcribe | On disk |
|---|---|---|---|---|
| **`tiny.en`** | ✅ Kubernetes | FT-S5 | 1.48 s | 42 MB |
| `base.en` | ❌ Kibernets | FTS 5 | 2.36 s | 76 MB |

`tiny.en` was *more* accurate on the proper noun, 60% faster, and roughly half the size — so the
smaller model won outright rather than as a compromise. Neither nails a rare acronym, which
matters less than it looks: the transcript lands in the composer **editable**, so a wrong token is
a one-word fix rather than a re-record.

Caveat worth keeping: the test audio was synthesized, not spoken into a microphone, so it carries
no background noise or accent variation. `base.en` may pull ahead on real speech — it is a
one-constant change in `backend/src/voice/transcribe.ts` if so.

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

> **Moot as implemented (2026-08-06).** Nothing is spawned at all: STT runs in-process via ONNX,
> TTS runs in the browser. The *conclusion* this section was defending — no resident service, no
> competing daemon — holds by construction. The CPU-only rule is unchanged and still load-bearing.

## Where it plugs in

- `InputBar.tsx`'s mic button → `POST /api/transcribe` (raw audio body, mirroring
  `POST /api/documents`'s raw-bytes-plus-header pattern rather than multipart) → text lands in
  the existing `value` state, editable, not auto-submitted. **Shipped as designed**, with the
  transcript *appended* to whatever is already typed rather than replacing it — which also makes
  a failed transcription non-destructive.
- ~~A new small control on each assistant message bubble → `POST /api/speak`~~ → **no route
  exists.** `SpeakButton.tsx` calls `speechSynthesis` directly; there is no audio to stream and
  no latency to measure, so the question this bullet deferred stopped existing.
- Settings: enable/disable STT and TTS independently — **not built.** Both features are
  self-disabling instead: read-aloud renders nothing without an offline voice, and the mic button
  reports a specific error if permission is refused or no device exists. A settings toggle is
  worth adding when there is something to toggle *between*.

## Resolved during implementation

- **Resampling happens browser-side**, and the reason turned out to be stronger than "smaller
  upload": `MediaRecorder` produces WebM/Opus, not WAV, so the backend would have needed a full
  Opus decoder to read it at all. Chrome already ships one behind `decodeAudioData`, and
  `OfflineAudioContext` resamples to 16 kHz while rendering. The backend then only has to read
  uncompressed PCM — `backend/src/voice/wav.ts`, no dependency.
- **`tiny.en` over `base.en`** — see the table above.
- **TTS is per-message**, not a global "speak replies" setting: an answer worth hearing is
  usually a specific one, and auto-speaking every reply is the kind of default people turn off
  once and never turn back on.

## Two things worth knowing before touching this

- **Whisper hallucinates on silence.** It does not return an empty string — two seconds of
  digital silence came back as `"you"` from the real route, which would then be pasted into the
  composer as if the user had said it. Checking for an empty transcript does not catch this.
  `transcribe.ts` therefore gates on the *audio's* RMS (measured: speech ~0.10, silence 0.0,
  threshold 0.003) and never sends silence to the model at all.
- **A WAV `fmt ` chunk is not always 16 bytes.** Windows writes 18. Anything that assumes 16 and
  jumps to a fixed offset lands mid-`data` and decodes garbage; `wav.ts` walks the chunk list.
  This is pinned in `backend/voice.test.mts`, which fails on exactly that regression.

## Exit criteria (unchanged from `phases.md`)

Speak a prompt, see it transcribed, get a response, optionally hear it read back — no internet
used anywhere in that loop. **Met**, with the caveat that the first run downloads the 42 MB
speech model once (same one-time-setup category as `ollama pull`); everything after that is local.
