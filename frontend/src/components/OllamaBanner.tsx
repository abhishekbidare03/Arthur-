import { useState } from 'react'
import { AlertIcon, RefreshIcon } from './icons'

interface OllamaBannerProps {
  error?: string
  onRetry: () => void
}

/**
 * Shown when the backend cannot reach Ollama.
 *
 * Deliberately offers instructions and a retry button rather than a "Start
 * Ollama" button that actually starts it: a second `ollama serve` holds port
 * 11434 and puts the tray app into a silent crash loop (see `logs.md`,
 * Session 1). Arthur connects to the tray app's server and never spawns one.
 */
export default function OllamaBanner({ error, onRetry }: OllamaBannerProps) {
  const [retrying, setRetrying] = useState(false)

  async function retry() {
    setRetrying(true)
    try {
      await onRetry()
    } finally {
      // Brief floor on the spinner: an instant flicker reads as "nothing happened".
      setTimeout(() => setRetrying(false), 400)
    }
  }

  return (
    <div className="notice mb-3" role="alert">
      <AlertIcon className="mt-px h-4 w-4 shrink-0" style={{ color: 'var(--accent)' }} />

      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-medium" style={{ color: 'var(--text-primary)' }}>
          Ollama isn’t responding
        </p>
        <p className="mt-1 text-[12.5px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
          Arthur needs the Ollama tray app running to generate replies. Start Ollama from the
          Start menu, wait for its icon to appear in the system tray, then retry.
        </p>
        {error && (
          <p className="mt-1.5 truncate font-mono text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
            {error}
          </p>
        )}
      </div>

      <button className="btn-secondary shrink-0" onClick={() => void retry()} disabled={retrying}>
        <RefreshIcon
          className="h-3.5 w-3.5"
          style={{ animation: retrying ? 'spin 900ms linear infinite' : undefined }}
        />
        {retrying ? 'Checking…' : 'Retry'}
      </button>
    </div>
  )
}
