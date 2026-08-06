import { useRef, useState } from 'react'
import { pullModel, type PullEvent } from '../api'
import { TIERS } from '../types'
import { AlertIcon, CheckIcon, RefreshIcon } from './icons'

interface ModelSetupProps {
  /** Tier models Ollama does not have, as reported by `/api/health`. */
  missing: string[]
  /** Re-checks health once a download finishes, so the banner can disappear. */
  onDone: () => void
}

/** State of one model's download. */
interface PullState {
  status: string
  fraction?: number
  error?: string
  finished?: boolean
}

function label(model: string): string {
  return TIERS.find((t) => t.model === model)?.label ?? model
}

/**
 * Roughly what each model costs to fetch, quoted before the button is pressed.
 *
 * Hardcoded from Ollama's published sizes rather than asked for, because there
 * is no way to know a model's size without starting to download it — and "how
 * big is this" is exactly the question someone needs answered *before* they
 * commit to it on a metered connection.
 */
const SIZES: Record<string, string> = {
  'qwen2.5:1.5b': '~1 GB',
  'llama3.2:3b': '~2 GB',
  'qwen3:4b': '~2.6 GB',
}

/**
 * First-launch setup: pull whichever tier models are missing.
 *
 * This is the one screen in Arthur that uses the internet, and it exists so a
 * fresh machine never has to be told "open a terminal and run `ollama pull`
 * three times". Ollama does the downloading; Arthur asks and shows progress.
 *
 * Only the *missing* tiers are offered, and each is a separate button rather
 * than one "install everything" action: the tiers are independent, roughly 1–3
 * GB each, and someone who only wants the fast one should not be made to fetch
 * 6 GB to start chatting.
 */
export default function ModelSetup({ missing, onDone }: ModelSetupProps) {
  const [pulls, setPulls] = useState<Record<string, PullState>>({})
  const controllers = useRef(new Map<string, AbortController>())

  async function start(model: string) {
    if (controllers.current.has(model)) return

    const controller = new AbortController()
    controllers.current.set(model, controller)
    setPulls((prev) => ({ ...prev, [model]: { status: 'starting' } }))

    try {
      for await (const event of pullModel(model, controller.signal)) {
        apply(model, event)
      }
    } finally {
      controllers.current.delete(model)
      // Re-check health either way: a finished pull should make this banner
      // disappear, and a failed one should not leave a stale "downloading".
      onDone()
    }
  }

  function apply(model: string, event: PullEvent) {
    setPulls((prev) => {
      if (event.type === 'error') {
        return { ...prev, [model]: { status: 'failed', error: event.message } }
      }
      if (event.type === 'done') {
        return { ...prev, [model]: { status: 'ready', finished: true } }
      }
      return {
        ...prev,
        [model]: {
          status: event.status,
          // Ollama reports `completed`/`total` only while a layer is
          // transferring; the verify and write phases have neither, so the bar
          // holds its last value rather than snapping back to zero.
          fraction:
            event.total && event.total > 0
              ? Math.min(1, (event.completed ?? 0) / event.total)
              : prev[model]?.fraction,
        },
      }
    })
  }

  function stop(model: string) {
    controllers.current.get(model)?.abort()
  }

  return (
    <div className="notice mb-3" role="status">
      <AlertIcon className="mt-px h-4 w-4 shrink-0" style={{ color: 'var(--accent)' }} />

      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-medium" style={{ color: 'var(--text-primary)' }}>
          {missing.length === 1
            ? 'One effort tier still needs its model'
            : `${missing.length} effort tiers still need their models`}
        </p>
        <p className="mt-1 text-[12.5px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
          Arthur can fetch them through Ollama now. This is a one-time download and the only
          moment Arthur uses the internet — everything after it runs locally.
        </p>

        <div className="mt-2.5 flex flex-col gap-2">
          {missing.map((model) => {
            const pull = pulls[model]
            const running = pull !== undefined && !pull.finished && !pull.error

            return (
              <div key={model} className="flex items-center gap-2.5">
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className="text-[12.5px] font-medium" style={{ color: 'var(--text-primary)' }}>
                      {label(model)}
                    </span>
                    <span className="truncate font-mono text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
                      {model}
                    </span>
                    {SIZES[model] && (
                      <span className="shrink-0 text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
                        {SIZES[model]}
                      </span>
                    )}
                  </div>

                  {pull && (
                    <>
                      <p
                        className="mt-0.5 truncate text-[11.5px]"
                        style={{ color: pull.error ? 'var(--accent)' : 'var(--text-secondary)' }}
                      >
                        {pull.error ?? pull.status}
                        {pull.fraction !== undefined && !pull.finished && !pull.error
                          ? ` · ${Math.round(pull.fraction * 100)}%`
                          : ''}
                      </p>
                      {running && (
                        <div className="setup-track mt-1">
                          <div
                            className="setup-fill"
                            style={{
                              // No `total` yet (verifying, writing the manifest)
                              // — an indeterminate sliver reads as "working",
                              // where a full-width bar would claim it is done.
                              width: pull.fraction !== undefined ? `${pull.fraction * 100}%` : '15%',
                              opacity: pull.fraction !== undefined ? 1 : 0.5,
                            }}
                          />
                        </div>
                      )}
                    </>
                  )}
                </div>

                {pull?.finished ? (
                  <span
                    className="flex shrink-0 items-center gap-1 text-[12px]"
                    style={{ color: 'var(--text-secondary)' }}
                  >
                    <CheckIcon className="h-3.5 w-3.5" /> Ready
                  </span>
                ) : running ? (
                  <button className="btn-secondary shrink-0" onClick={() => stop(model)}>
                    Cancel
                  </button>
                ) : (
                  <button className="btn-secondary shrink-0" onClick={() => void start(model)}>
                    <RefreshIcon className="h-3.5 w-3.5" />
                    {pull?.error ? 'Retry' : 'Download'}
                  </button>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
