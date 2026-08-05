import { useLayoutEffect, useRef, useState } from 'react'
import { MicIcon, PaperclipIcon, SendIcon, StopIcon } from './icons'

interface InputBarProps {
  onSend: (text: string) => void
  /** Aborts the in-flight generation. */
  onStop?: () => void
  /** True while a reply is streaming — swaps Send for Stop. */
  streaming?: boolean
  autoFocus?: boolean
  /** Shows the Enter/Shift+Enter hint — used on the empty-state screen. */
  showHint?: boolean
}

const MAX_HEIGHT_PX = 208

export default function InputBar({
  onSend,
  onStop,
  streaming = false,
  autoFocus = false,
  showHint = false,
}: InputBarProps) {
  const [value, setValue] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Auto-grow: reset to auto first so the box can also shrink when text is deleted.
  useLayoutEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT_PX)}px`
    el.style.overflowY = el.scrollHeight > MAX_HEIGHT_PX ? 'auto' : 'hidden'
  }, [value])

  // Return focus to the composer when a reply finishes, so the next message can
  // be typed without reaching for the mouse.
  useLayoutEffect(() => {
    if (!streaming) textareaRef.current?.focus()
  }, [streaming])

  function submit() {
    const trimmed = value.trim()
    if (!trimmed || streaming) return
    onSend(trimmed)
    setValue('')
  }

  // Enter sends, Shift+Enter inserts a newline — matching Claude, not the
  // Ctrl+Enter noted in the original spec.
  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit()
    }
    // Escape stops a running generation — qwen3 can deliberate for a minute,
    // and reaching for the mouse to stop it is friction exactly when you are
    // already impatient.
    if (e.key === 'Escape' && streaming) {
      e.preventDefault()
      onStop?.()
    }
  }

  const canSend = value.trim().length > 0 && !streaming

  return (
    <div>
      <div className="composer">
        <textarea
          ref={textareaRef}
          value={value}
          autoFocus={autoFocus}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onKeyDown}
          rows={1}
          placeholder={streaming ? 'Arthur is replying…' : 'Message Arthur…'}
        />

        <div className="flex items-center justify-between px-2.5 pb-2.5 pt-1.5">
          <div className="flex items-center gap-0.5">
            {/* Wired up in Phase 4 (attach) and Phase 5 (mic). */}
            <button className="btn-icon" disabled title="Attach file — arrives in Phase 4" aria-label="Attach file">
              <PaperclipIcon className="h-[17px] w-[17px]" />
            </button>
            <button className="btn-icon" disabled title="Voice input — arrives in Phase 5" aria-label="Voice input">
              <MicIcon className="h-[17px] w-[17px]" />
            </button>
          </div>

          {streaming ? (
            <button
              className="btn-send"
              data-ready="true"
              data-stop="true"
              onClick={() => onStop?.()}
              aria-label="Stop generating"
              title="Stop generating (Esc)"
            >
              <StopIcon className="h-[15px] w-[15px]" />
            </button>
          ) : (
            <button
              className="btn-send"
              data-ready={canSend}
              onClick={submit}
              disabled={!canSend}
              aria-label="Send message"
            >
              <SendIcon className="h-[17px] w-[17px]" />
            </button>
          )}
        </div>
      </div>

      {showHint && (
        <p className="mt-3 text-center text-[11.5px]" style={{ color: 'var(--text-tertiary)' }}>
          <span className="kbd">Enter</span> to send · <span className="kbd">Shift</span>
          <span className="kbd ml-0.5">Enter</span> for a new line
        </p>
      )}
    </div>
  )
}
