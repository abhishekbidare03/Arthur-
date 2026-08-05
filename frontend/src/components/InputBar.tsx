import { useLayoutEffect, useRef, useState } from 'react'
import type { Attachment } from '../types'
import AttachmentChip from './AttachmentChip'
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
  /** Files staged for the next message. */
  attachments?: Attachment[]
  onAttach?: (files: FileList) => void
  onRemoveAttachment?: (id: string) => void
}

const MAX_HEIGHT_PX = 208

/**
 * Extensions offered in the file picker.
 *
 * Mirrors the backend's extractor registry. The picker filter is a convenience,
 * not the check — the backend refuses anything it cannot read, and that refusal
 * is what the user actually sees for an unsupported format.
 */
const ACCEPT = [
  '.pdf', '.pptx',
  '.txt', '.md', '.markdown', '.rst', '.log',
  '.json', '.jsonl', '.csv', '.tsv', '.yaml', '.yml', '.toml', '.ini', '.xml',
  '.html', '.htm', '.css', '.scss', '.less', '.svg',
  '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.py', '.rb', '.go', '.rs',
  '.java', '.kt', '.c', '.h', '.cpp', '.hpp', '.cs', '.php', '.swift', '.lua',
  '.sh', '.bash', '.zsh', '.ps1', '.bat', '.sql', '.r', '.pl', '.dart', '.scala',
].join(',')

export default function InputBar({
  onSend,
  onStop,
  streaming = false,
  autoFocus = false,
  showHint = false,
  attachments = [],
  onAttach,
  onRemoveAttachment,
}: InputBarProps) {
  const [value, setValue] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)

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

  // Sending while a file is still being read would silently drop it.
  const uploading = attachments.some((a) => a.uploading)
  const canSend = value.trim().length > 0 && !streaming && !uploading

  function pickFiles() {
    fileRef.current?.click()
  }

  return (
    <div>
      <div className="composer">
        {attachments.length > 0 && (
          <div className="chip-tray">
            {attachments.map((a) => (
              <AttachmentChip key={a.id} attachment={a} onRemove={onRemoveAttachment} />
            ))}
          </div>
        )}

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
            <input
              ref={fileRef}
              type="file"
              multiple
              accept={ACCEPT}
              className="hidden"
              onChange={(e) => {
                if (e.target.files?.length) onAttach?.(e.target.files)
                // Reset so picking the same file twice in a row still fires.
                e.target.value = ''
              }}
            />
            <button
              className="btn-icon"
              onClick={pickFiles}
              disabled={!onAttach || streaming}
              title="Attach a file — PDF, PowerPoint, text or source"
              aria-label="Attach a file"
            >
              <PaperclipIcon className="h-[17px] w-[17px]" />
            </button>
            {/* Wired up in Phase 5. */}
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
