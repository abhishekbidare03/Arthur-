import { useEffect, useRef, useState } from 'react'
import type { GenerationStats } from '../api'
import { TIERS, tierInfo, type Tier } from '../types'
import { ChevronDownIcon, RefreshIcon } from './icons'
import SpeakButton from './SpeakButton'

interface MessageMetaProps {
  content: string
  stats?: GenerationStats
  /** Tier this reply was produced at, inferred from the model it names. */
  tier: Tier
  /** Absent on anything but the last assistant message — re-answering an
   *  earlier turn would mean discarding everything after it. */
  onRegenerate?: (tier: Tier) => void
  disabled?: boolean
}

function seconds(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`
}

/**
 * The row under a finished assistant message: read aloud, regenerate, timings.
 *
 * The timings are the Phase 7 "latency indicator", and they earn their place on
 * this hardware specifically. Which tier is worth using is a real, repeated
 * decision here — one model fits in 4 GB at a time and they differ by 7x in
 * throughput — and it cannot be made from a number measured once on an idle
 * machine. Showing what *this* reply actually cost is what makes the tier
 * selector something to reason about rather than guess at.
 *
 * Deliberately quiet: tertiary text, no border, no badge. It is reference
 * material for when you go looking, not a scoreboard competing with the answer.
 */
export default function MessageMeta({
  content,
  stats,
  tier,
  onRegenerate,
  disabled = false,
}: MessageMetaProps) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function onPointerDown(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-1 gap-y-1">
      <SpeakButton content={content} />

      {onRegenerate && (
        <div className="relative" ref={wrapRef}>
          <button
            className="meta-btn"
            onClick={() => setOpen((v) => !v)}
            disabled={disabled}
            aria-haspopup="menu"
            aria-expanded={open}
            title="Answer this again, optionally at a different effort tier"
          >
            <RefreshIcon className="h-3.5 w-3.5" />
            Retry
            <ChevronDownIcon className="h-3 w-3" />
          </button>

          {open && (
            <div role="menu" className="popover absolute bottom-full left-0 z-30 mb-1.5 w-[248px] py-1">
              {TIERS.map((t) => (
                <button
                  key={t.id}
                  role="menuitem"
                  className="tier-option"
                  onClick={() => {
                    setOpen(false)
                    onRegenerate(t.id)
                  }}
                >
                  <span className="flex w-full items-baseline gap-2">
                    <span
                      className="text-[13px] font-medium"
                      style={{ color: t.id === tier ? 'var(--accent)' : 'var(--text-primary)' }}
                    >
                      {t.id === tier ? `Again at ${t.label}` : `At ${t.label}`}
                    </span>
                    <span
                      className="min-w-0 flex-1 truncate text-right font-mono text-[10.5px]"
                      style={{ color: 'var(--text-tertiary)' }}
                    >
                      {t.model}
                    </span>
                  </span>
                </button>
              ))}
              <div className="divider my-1" />
              <p className="px-3 pb-1 pt-0.5 text-[11px] leading-snug" style={{ color: 'var(--text-tertiary)' }}>
                Replaces this answer. The question stays as you asked it.
              </p>
            </div>
          )}
        </div>
      )}

      {stats && (
        <p
          className="ml-1.5 text-[11px] tabular-nums"
          style={{ color: 'var(--text-tertiary)' }}
          // The visible line is deliberately terse; the full picture is one
          // hover away rather than four more numbers on screen forever.
          title={
            `${stats.model}\n` +
            `First token: ${seconds(stats.timeToFirstTokenMs)}\n` +
            `Total: ${seconds(stats.totalMs)}\n` +
            `Prompt: ${stats.promptTokens} tokens\n` +
            `Output: ${stats.outputTokens} tokens` +
            (stats.thinkingTokens > 0 ? ` (${stats.thinkingTokens} reasoning)` : '') +
            (stats.doneReason && stats.doneReason !== 'stop' ? `\nEnded: ${stats.doneReason}` : '')
          }
        >
          {seconds(stats.timeToFirstTokenMs)} to first token · {stats.tokensPerSecond} tok/s ·{' '}
          {stats.outputTokens} tokens
        </p>
      )}

      {/* Not a detail — an answer assembled without the start of the
          conversation can be wrong in a way that looks entirely confident. */}
      {stats && stats.droppedMessages > 0 && (
        <p className="ml-1.5 text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
          · {stats.droppedMessages} earlier turn{stats.droppedMessages === 1 ? '' : 's'} dropped to
          fit the {tierInfo(tier).label.toLowerCase()} tier's context window
        </p>
      )}
    </div>
  )
}
