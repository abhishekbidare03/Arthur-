import { useEffect } from 'react'
import { CloseIcon } from './icons'

interface ShortcutsHelpProps {
  onClose: () => void
}

/** The list is the documentation. Duplicating it in a README would guarantee
 *  the two drift; this is the one place shortcuts are described. */
const GROUPS: { title: string; items: [string[], string][] }[] = [
  {
    title: 'Conversation',
    items: [
      [['Ctrl', 'N'], 'New chat'],
      [['Ctrl', 'E'], 'Export this conversation as Markdown'],
      [['Ctrl', 'B'], 'Show or hide the sidebar'],
    ],
  },
  {
    title: 'Composing',
    items: [
      [['Enter'], 'Send'],
      [['Shift', 'Enter'], 'New line'],
      [['Esc'], 'Stop generating'],
      [['Ctrl', 'Shift', 'M'], 'Start or stop dictating'],
    ],
  },
  {
    title: 'Effort tier',
    items: [
      [['Ctrl', '1'], 'Low'],
      [['Ctrl', '2'], 'Medium'],
      [['Ctrl', '3'], 'High'],
    ],
  },
]

/**
 * The keyboard-shortcut reference, on `?`.
 *
 * Worth a panel rather than a tooltip somewhere: shortcuts that are not
 * discoverable are shortcuts nobody uses, and this app has no menu bar to hang
 * them from.
 */
export default function ShortcutsHelp({ onClose }: ShortcutsHelpProps) {
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [onClose])

  return (
    <div
      className="modal-scrim"
      role="dialog"
      aria-modal="true"
      aria-label="Keyboard shortcuts"
      onMouseDown={(e) => {
        // Only a click that both starts and ends on the backdrop — otherwise a
        // text selection that drifts outside the panel closes it.
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="modal-panel w-full max-w-md">
        <div className="flex items-start justify-between gap-4">
          <h2 className="text-[15px] font-medium" style={{ color: 'var(--text-primary)' }}>
            Keyboard shortcuts
          </h2>
          <button className="btn-icon h-7 w-7" onClick={onClose} aria-label="Close">
            <CloseIcon className="h-4 w-4" />
          </button>
        </div>

        <div className="mt-4 flex flex-col gap-4">
          {GROUPS.map((group) => (
            <div key={group.title}>
              <p
                className="mb-1.5 text-[11px] font-medium uppercase tracking-wide"
                style={{ color: 'var(--text-tertiary)' }}
              >
                {group.title}
              </p>
              <div className="flex flex-col gap-1.5">
                {group.items.map(([keys, description]) => (
                  <div key={description} className="flex items-baseline justify-between gap-4">
                    <span className="text-[13px]" style={{ color: 'var(--text-secondary)' }}>
                      {description}
                    </span>
                    <span className="shrink-0">
                      {keys.map((key) => (
                        <span key={key} className="kbd ml-1">
                          {key}
                        </span>
                      ))}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        <p className="mt-4 text-[11.5px]" style={{ color: 'var(--text-tertiary)' }}>
          Press <span className="kbd">?</span> any time to see this again.
        </p>
      </div>
    </div>
  )
}
