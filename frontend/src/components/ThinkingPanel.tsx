import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ChevronRightIcon, SparkIcon } from './icons'

interface ThinkingPanelProps {
  thinking: string
  /** True while reasoning tokens are still arriving. */
  streaming?: boolean
}

/**
 * Collapsible reasoning panel.
 *
 * Ollama returns `message.thinking` as a field entirely separate from
 * `message.content`, so no tag parsing is needed — see `docs/model-notes.md`.
 * Only the High tier (`qwen3:4b`) ever produces this, so callers render it
 * conditionally.
 *
 * Collapsed by default: qwen3 routinely spends ~1,000 tokens deliberating over a
 * one-line question, and showing that raw is what made the terminal output feel
 * broken.
 *
 * While collapsed *and* streaming it shows a live word count. Measured, 147 of
 * 150 stream chunks for a two-word answer were reasoning — without some visible
 * progress the app looks frozen for the entire time the model is thinking.
 */
export default function ThinkingPanel({ thinking, streaming = false }: ThinkingPanelProps) {
  const [open, setOpen] = useState(false)
  const bodyRef = useRef<HTMLDivElement>(null)

  // Keep the newest reasoning in view while it streams, but only while the panel
  // is open — no point scrolling a collapsed element.
  useLayoutEffect(() => {
    if (open && streaming && bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight
    }
  }, [thinking, open, streaming])

  // Collapse again once reasoning ends, so a finished answer is not buried
  // under a wall of deliberation the next time it renders.
  useEffect(() => {
    if (!streaming) setOpen(false)
  }, [streaming])

  const words = streaming ? thinking.trim().split(/\s+/).filter(Boolean).length : 0

  return (
    <div className="mb-3">
      <button className="thinking-toggle" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <ChevronRightIcon className="chevron h-3 w-3" />
        <SparkIcon
          className="h-3.5 w-3.5"
          style={{
            color: 'var(--accent)',
            animation: streaming ? 'pulse-dot 1.4s ease-in-out infinite' : undefined,
          }}
        />
        <span>{streaming ? 'Thinking…' : 'Thought process'}</span>
        {streaming && words > 0 && (
          <span className="font-mono text-[10.5px] tabular-nums" style={{ color: 'var(--text-tertiary)' }}>
            {words}w
          </span>
        )}
      </button>

      {open && (
        <div ref={bodyRef} className="thinking-body max-h-72 overflow-y-auto">
          {thinking}
        </div>
      )}
    </div>
  )
}
