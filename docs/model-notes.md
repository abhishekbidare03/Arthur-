# Arthur — Model Notes

Recorded 2026-08-05. Machine: i5-10300H (4c/8t), 15.8 GB RAM, GTX 1650 Ti (4 GB VRAM).

Per the user's direction, Phase 0's model *comparison benchmark* was skipped. `qwen3:4b` was
/btwselected directly. What follows is characterization of that one model — the numbers Phases 2
and 4 depend on — not a comparison.

## Default model: `qwen3:4b`

| Property | Value |
|---|---|
| Architecture | qwen3, 4.0B params |
| Quantization | Q4_K_M |
| On-disk size | 2.5 GB |
| **Max context length** | **262,144** (theoretical ceiling — see caveat below) |
| Embedding length | 2560 |
| Capabilities | completion, tools, **thinking** |
| Default sampling | temp 0.6, top_k 20, top_p 0.95, repeat_penalty 1 |
| License | Apache 2.0 |

## Measured performance

Original Phase 0 figures, at Ollama's stock settings (f16 KV cache, no flash attention):

| Metric | Value |
|---|---|
| Throughput | **~15.7 tok/s** |
| Time to first token (warm) | **0.63 s** |
| Cold model load | ~8.8 s |
| GPU/CPU split @ 4096 ctx | **67% GPU / 33% CPU** |
| VRAM used | 2307 MiB of 4096 MiB |
| Resident size @ 4096 ctx | 3.5 GB |

> **Superseded 2026-08-05.** With `q8_0` KV cache + flash attention now enabled, the same
> model runs **23.6 tok/s at 4096** (73% GPU) or **15.7 tok/s at 8192**. See the
> context-window section below for the full table.

### The context-window caveat — important for Phase 4

The model *advertises* 262,144 tokens, but that number is unusable here. At Ollama's default
**4096** context the model already spills 33% onto CPU, because 4 GB of VRAM cannot hold
3.5 GB of weights plus KV cache plus the Windows desktop's own usage.

**Phase 4 must size its file-injection cap against the runtime `num_ctx`, not against 262144.**

#### Why 4096 — the arithmetic (measured 2026-08-05)

The 4096 default is not Ollama being cautious; it is `OLLAMA_CONTEXT_LENGTH`'s documented
`4k/32k/256k based on VRAM` ladder picking the bottom rung. The binding constraint is the
KV cache, whose size is fixed by architecture:

```
KV bytes/token = layers × kv_heads × (key_len + value_len) × bytes_per_element
               = 36 × 8 × (128 + 128) × 2      (f16)
               = 147,456 bytes = 144 KiB/token
```

Confirmed empirically — resident size grew 0.57 GB from `num_ctx` 4096→8192, i.e. ~142 KiB
per token. At the advertised 262,144 tokens the KV cache alone would need **36 GiB**. No
runtime change (llama.cpp, vLLM, ONNX) alters this; it is bytes-per-token, not an
optimization.

#### The lever that works: quantized KV cache

`OLLAMA_KV_CACHE_TYPE=q8_0` with `OLLAMA_FLASH_ATTENTION=1` roughly halves KV bytes/token
(~77 KiB measured). **Both are now set as User env vars.** Flash attention is required — the
quantized-KV path depends on it.

Measured, `qwen3:4b`, warm, temp 0, 3 reps at 4k/8k and 2 at 16k/32k:

| `num_ctx` | f16 (old default) | | q8_0 + FA (now) | | |
|---|---|---|---|---|---|
| | tok/s | GPU | tok/s | GPU | resident |
| 4,096 | 16.3 | 67% | **23.6** | **73%** | 3.03 GB |
| 8,192 | 11.1 | 55% | **15.7** | **64%** | 3.33 GB |
| 16,384 | 9.3 | 42% | **12.0** | **54%** | 4.00 GB |
| 32,768 | — | — | 9.1 | 41% | 5.33 GB |

Two independent wins: **+45% throughput at the same 4096 context**, or **4× the context
(16,384) while still beating the old 4096 baseline** (12.0 vs 16.3 tok/s is a 26% cost for
4× the window). 8,192 is close to free — 15.7 vs 16.3 tok/s for double the context.

Output quality was spot-checked at q8_0/16384 (primes, factual recall, arithmetic — all
correct) and `message.thinking` still separates cleanly from `content`.

> **First-load caveat.** The first generation after an Ollama restart runs ~2× slower on the
> q8_0 path (10.7 tok/s observed, vs 23.6 once warm) — CUDA kernels for the quantized-FA path
> appear to compile on first use. Do not benchmark a cold server; and Phase 2's perceived
> latency on the very first message will be worse than steady state.

**Recommended working budget: `num_ctx` 8192, with 16384 available when context matters more
than speed.** Set it explicitly per request — Ollama's auto-selection still picks 4096.
Raising `num_ctx` further pushes more layers to CPU and throughput falls roughly linearly.

## Thinking behaviour — decisive for Phase 2

Qwen3 is a hybrid-reasoning model and **it thinks on every turn on this setup.** Three
approaches were tested:

| Approach | Thinking suppressed? | `content` clean? | Verdict |
|---|---|---|---|
| Default (no flag) | No | **Yes** | ✅ **Use this** |
| `"think": false` | No | **No** — raw CoT and a stray `</think>` dumped into `content` | ❌ Avoid |
| `/no_think` in prompt | No (4791 chars) | Yes | ⚠️ No benefit over default |

**Conclusion: leave thinking at its default.** Ollama returns reasoning in a separate
`message.thinking` field, cleanly split from `message.content`. Phase 2 should stream that
field into a collapsible "thinking" panel — which is what Claude's own extended-thinking UI
does, so this is a feature, not a workaround. Do **not** pass `think: false`; it actively
corrupts the response by merging chain-of-thought into `content`.

### Latency consequence — the real UX risk

Thinking is verbose. A one-sentence question ("what is a hash map?") produced **1057–1315
tokens** and took **~68 seconds** end to end.

Warm TTFT is only 0.63 s, so **streaming is what makes this bearable** — the user sees motion
immediately even though the full answer takes a minute. Phase 2 must stream; a
wait-for-complete implementation would feel broken.

Levers if this proves too slow in practice:
- **Quantized KV cache (`q8_0` + flash attention) — done, ~+45%.** See the context-window
  section above; this closes part of the CPU spill (67% → 73% GPU) at no quality cost.
- Close the remaining ~27% CPU spill (a smaller quant, or a lower `num_ctx`).
- Cap `num_predict`.
- Route quick queries to `llama3.2:3b` (2.0 GB, already pulled, would fit VRAM fully) via
  Phase 7's model-swap feature.

### System prompt length drives thinking length — counter-intuitive, measured

On `qwen3:4b`, **every line added to the system prompt costs reasoning time.** Measured on
"how are you?" (the case this model spirals worst on), 4 runs each at temperature 0.3:

| System prompt | Mean | Thinking |
|---|---|---|
| 1 line | 32 s | 1,899 c |
| 7 lines | 51 s | 3,140 c |
| 11 lines | 44 s | 2,873 c |
| 12 lines, incl. "answer immediately" rule | **102 s** | **6,129 c** |

The last row differs from the one above by a **single added line** — *"Greetings and simple
questions need no reasoning — answer them immediately"* — and it more than doubled
deliberation. **Do not add brevity instructions to a reasoning model's system prompt.**
Telling it not to reason gives it something new to reason about.

Arthur's system prompt is therefore **tier-dependent** (`backend/src/prompt.ts`): the thinking
tier gets identity only; the non-thinking tiers get the full formatting guidance, which costs
them nothing and which they need more.

### Levers that do and do not work on thinking latency

| Lever | Effect | Verdict |
|---|---|---|
| Shorter system prompt | 102 s → 32 s | ✅ **Biggest available win** |
| `temperature` 0.3 (from 0.6) | mean 42.3 → 31.6 s, worst 65 → 48 s | ✅ Shipped |
| `num_predict` cap | bounds worst case, but **empty `content` 1 run in 3** | ⚠️ Runaway guard only |
| Ollama thinking *levels* (`think:"low"`) | 19.1 s → 14.4 s, but `"medium"` → 34.5 s | ❌ Unreliable |
| `think: false` | raw CoT dumped into `content` | ❌ Broken (see above) |
| "Be brief" in system prompt | **3× worse** | ❌ Actively harmful |

**Inherent limit:** `qwen3:4b` is Qwen3-4B-**Thinking**-2507 — reasoning-only, no fast path.
`qwen3:4b-instruct` exists in the registry as a non-thinking sibling (confirmed available, not
pulled) if the High tier ever needs one.

### Do not cap `num_predict` low

With `num_predict: 80`, the model spent all 80 tokens thinking and returned **empty
`content`** (`done_reason: "length"`). Any output cap must leave room for the thinking phase
first, or the user sees a blank reply.

## Effort tiers — DECIDED (2026-08-05)

Resolves the open question at the bottom of `phases.md` ("Consider whether Arthur needs
per-conversation model selection"). **Yes** — three user-selectable effort levels mirroring
Claude's, each backed by a different local model. All three are already pulled.

Original Phase 0 figures — `num_ctx` 4096, f16 KV cache:

| Tier | Model | Throughput | GPU split | Resident | Thinks? |
|---|---|---|---|---|---|
| **Low** | `qwen2.5:1.5b` | **94.8 tok/s** | **100% GPU** | 1.2 GB | No |
| **Medium** | `llama3.2:3b` | **51.3 tok/s** | 80% GPU / 20% CPU | 2.9 GB | No |
| **High** | `qwen3:4b` | **15.7 tok/s** | 67% GPU / 33% CPU | 3.5 GB | **Yes** |

**Re-measured 2026-08-05 at the settings Arthur actually ships** — `num_ctx` **8192** with a
`q8_0` KV cache. These are the numbers the tier dropdown displays. Mean of 3 warm runs each,
after a discarded warm-up:

| Tier | Model | Throughput | GPU split | Resident |
|---|---|---|---|---|
| **Low** | `qwen2.5:1.5b` | **105.9 tok/s** | **100% GPU** | 1.25 GB |
| **Medium** | `llama3.2:3b` | **39.6 tok/s** | 78% GPU / 22% CPU | 2.97 GB |
| **High** | `qwen3:4b` | **14.9 tok/s** | 64% GPU / 36% CPU | 3.58 GB |

A ~7× spread, so the tiers are genuinely distinct. Only Low fits entirely in the 4 GB of VRAM.

Note the two tiers moved in opposite directions. **Low got faster while doubling its context**
(94.8 → 105.9) — it is fully GPU-resident, so the cheaper KV cache is pure gain. **Medium got
slower** (51.3 → 39.6) because it already spills to CPU, and it is spending the q8_0 saving on
the larger window rather than on speed. If Medium's latency ever matters more than its context,
dropping it back to `num_ctx` 4096 is the lever.

### Consequences for implementation

- **Only one model fits in VRAM at a time.** 1.2 + 2.9 GB already exceeds 4 GB, so switching
  tiers forces an unload/reload — expect a ~1–10 s stall on the first message after a switch.
  Ollama's default `keep_alive` of 5 m means it stays warm afterwards. Do not try to
  pre-load all three.
- **Only High produces a `thinking` field.** The collapsible thinking panel must render
  conditionally, not unconditionally. This matches Claude, where extended thinking is a
  high-effort behaviour.
- **Context windows differ per model** — `qwen2.5:1.5b` 32,768 · `llama3.2:3b` 131,072 ·
  `qwen3:4b` 262,144 — but the *runtime* limit is VRAM, not these ceilings.
  **Phase 4's file-size cap must therefore be per-model, not one global constant**, and must
  read the runtime `num_ctx` rather than the advertised max. With `q8_0` KV now enabled,
  `qwen3:4b`'s practical budget is 8,192–16,384 rather than 4,096; the two smaller tiers have
  more headroom still and have not yet been re-measured under `q8_0`.
- **Suggested default: Medium** (`llama3.2:3b`) — usable speed without qwen3's minute-long
  deliberation on trivial questions.

### Phase impact

Model selection moves **out of Phase 7 and into Phase 2**. The model must be a parameter of
the `sendMessage(conversation)` boundary from the start — retrofitting it later would mean
touching the API, the DB schema (tier stored per conversation or per message), and the UI.
Phase 3's schema should carry the tier alongside each message.

## Model storage — RESOLVED via directory junction

Models physically live at **`E:\Arthur\models`** (5.12 GB: `qwen3:4b`, `llama3.2:3b`,
`qwen2.5:1.5b`). `models/` is gitignored. ~2.7 GB was reclaimed on C:.

### The problem

The Ollama tray app (`ollama app.exe`, auto-started from the Startup folder via `Ollama.lnk`)
**hardcodes the model path and ignores `OLLAMA_MODELS` entirely.** Its server logs, every time:

```
OLLAMA_MODELS:C:\Users\hp\.ollama\models
```

Changing the model location in the Ollama app's own settings UI **also had no effect** — the
tray-spawned server still reported the C: path and listed zero models. Only a manually started
`ollama.exe serve` honoured the env var, and that does not survive a reboot.

### The fix (implemented)

`C:\Users\hp\.ollama\models` is now an **NTFS directory junction** pointing at
`E:\Arthur\models`:

```powershell
New-Item -ItemType Junction -Path "$env:USERPROFILE\.ollama\models" -Target "E:\Arthur\models"
```

The tray app reads its hardcoded C: path, NTFS transparently redirects to E:, and the files
stay on E: as the spec requires. Chosen because it needs no admin rights, keeps the tray icon,
leaves the Startup folder untouched, survives Ollama updates, and works for every tool that
assumes the default path.

**Verified:** with `OLLAMA_MODELS` completely unset in the calling shell, the tray-launched
server lists all three models and successfully loads `qwen3:4b` (3.5 GB resident) — proving
the junction alone does the work.

The `OLLAMA_MODELS` User env var is still set to `E:\Arthur\models`. It is now redundant but
harmless, since it resolves to the same physical directory as the junction. Keep the two in
agreement if either is ever changed.

> The path setting inside the Ollama app's settings UI does nothing here. It can safely be
> returned to its default to avoid future confusion.

### ⚠️ Never leave a manual `ollama serve` running

A hand-started server holds port 11434 and puts the tray app into a **silent crash loop** —
retrying and dying with `"ollama exited" err="exit status 1"` roughly every 1.8 seconds,
indefinitely, with no visible error to the user. If Ollama behaves strangely, check for
duplicate `ollama.exe` processes first and check `%LOCALAPPDATA%\Ollama\app.log`.

Arthur's launcher (Phase 6) must therefore **never** spawn its own `ollama serve`. It should
connect to the tray app's existing server on `127.0.0.1:11434`, and only surface a "start
Ollama" prompt if nothing is listening.
