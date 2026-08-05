import { useEffect, useRef, useState } from 'react'
import { TIERS, tierInfo, type Tier } from '../types'
import { ChevronDownIcon, MoonIcon, SettingsIcon, SunIcon } from './icons'

interface TopBarProps {
  tier: Tier
  onTierChange: (tier: Tier) => void
  theme: 'light' | 'dark'
  onToggleTheme: () => void
  /** Locked while a reply streams — switching mid-generation is incoherent. */
  disabled?: boolean
  /** Models Ollama actually has pulled, from `/api/health`. */
  installed?: string[]
}

/**
 * The tier selector is the one piece of Phase 1 that is not cosmetic: Phase 2
 * needs the chosen tier as a parameter of `sendMessage()`, so its state is real.
 */
export default function TopBar({
  tier,
  onTierChange,
  theme,
  onToggleTheme,
  disabled = false,
  installed,
}: TopBarProps) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const active = tierInfo(tier)

  // Close on outside click and on Escape — a dropdown that traps the user is
  // worse than no dropdown.
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
    <header className="topbar sticky top-0 z-20 flex h-14 shrink-0 items-center justify-between px-3.5">
      <div className="relative" ref={wrapRef}>
        <button
          className="tier-trigger"
          onClick={() => setOpen((v) => !v)}
          aria-haspopup="listbox"
          aria-expanded={open}
          disabled={disabled}
          title={disabled ? 'Finish or stop the current reply before switching tier' : undefined}
        >
          <span className="text-[14px] font-medium">{active.label}</span>
          <span className="font-mono text-[11.5px]" style={{ color: 'var(--text-tertiary)' }}>
            {active.model}
          </span>
          <ChevronDownIcon className="chevron h-3.5 w-3.5" />
        </button>

        {open && (
          <div role="listbox" className="popover absolute left-0 top-full z-30 mt-1.5 w-[264px] py-1">
            {TIERS.map((t) => {
              const selected = t.id === tier
              // `installed` is undefined until the first health check resolves;
              // only treat a model as missing once we actually know.
              const missing = installed !== undefined && !installed.includes(t.model)
              return (
                <button
                  key={t.id}
                  role="option"
                  aria-selected={selected}
                  className="tier-option"
                  title={missing ? `Not installed — run: ollama pull ${t.model}` : undefined}
                  onClick={() => {
                    onTierChange(t.id)
                    setOpen(false)
                  }}
                >
                  <span className="flex w-full items-baseline gap-2">
                    <span
                      className="text-[13px] font-medium"
                      style={{ color: selected ? 'var(--accent)' : 'var(--text-primary)' }}
                    >
                      {t.label}
                    </span>
                    {missing && (
                      <span
                        className="shrink-0 text-[10.5px] font-medium"
                        style={{ color: 'var(--accent)' }}
                      >
                        not pulled
                      </span>
                    )}
                    <span
                      className="min-w-0 flex-1 truncate font-mono text-[10.5px]"
                      style={{ color: 'var(--text-tertiary)' }}
                    >
                      {t.model}
                    </span>
                    <span
                      className="shrink-0 font-mono text-[10.5px] tabular-nums"
                      style={{ color: 'var(--text-tertiary)' }}
                    >
                      {t.tokensPerSecond}/s
                    </span>
                  </span>
                  <span className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>
                    {t.blurb}
                  </span>
                </button>
              )
            })}

            <div className="divider my-1" />
            <p
              className="px-3 pb-1 pt-0.5 text-[11px] leading-snug"
              style={{ color: 'var(--text-tertiary)' }}
            >
              Switching reloads the model — the next reply is slower.
            </p>
          </div>
        )}
      </div>

      <div className="flex items-center gap-0.5">
        <button
          className="btn-icon"
          onClick={onToggleTheme}
          aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
          title={theme === 'dark' ? 'Light theme' : 'Dark theme'}
        >
          {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
        </button>
        <button className="btn-icon" aria-label="Settings" title="Settings">
          <SettingsIcon />
        </button>
      </div>
    </header>
  )
}
