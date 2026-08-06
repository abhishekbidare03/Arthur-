import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Attachment } from '../types'
import { transcribeAudio, warmTranscription } from '../api'
import { LiveRecorder, MicrophoneDeniedError, NoMicrophoneError } from '../voice/recorder'
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
  /**
   * Filled with this composer's dictation toggle while it is mounted, so a
   * global shortcut can reach it. A ref rather than lifting recording state to
   * the app: the microphone belongs to the composer that opened it.
   */
  micToggleRef?: React.RefObject<(() => void) | null>
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
  '.pdf', '.pptx', '.docx', '.xlsx', '.xlsm', '.epub',
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
  micToggleRef,
}: InputBarProps) {
  const [value, setValue] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  /**
   * A synchronous mirror of `value`.
   *
   * Dictated phrases arrive from a callback, and `submit()` reads the text
   * *after* awaiting the final one — by which point the `value` closed over by
   * the current render is stale. Keeping a ref updated in the same breath as
   * the state gives a value that is always current, without making every
   * reader depend on when React last rendered.
   */
  const valueRef = useRef('')

  /** Sets the composer text and its mirror together. Nothing should write to
   *  `setValue` directly — that is how the two drift apart. */
  const setText = (next: string) => {
    valueRef.current = next
    setValue(next)
  }

  // Voice input. Text appears *while* you speak — each phrase is transcribed
  // as soon as you pause — and stays editable rather than being sent, so a
  // misheard word is a one-word fix and the send button is still yours to press.
  const recorderRef = useRef<LiveRecorder>(null as unknown as LiveRecorder)
  if (recorderRef.current === null) {
    recorderRef.current = new LiveRecorder((wav) => transcribeAudio(wav))
  }
  const [recording, setRecording] = useState(false)
  const [catchingUp, setCatchingUp] = useState(false)
  const [voiceError, setVoiceError] = useState<string>()

  // Drop the mic if the component goes away mid-recording — otherwise Chrome
  // keeps showing the recording indicator for a tab that is no longer using it.
  useEffect(() => {
    const recorder = recorderRef.current
    return () => recorder.cancel()
  }, [])

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

  /**
   * Sends the message, finishing any dictation still in progress first.
   *
   * Pressing send mid-sentence is a natural way to say "that's it" — so rather
   * than refusing, this closes the recording and waits for the last phrase to
   * land. Reading `valueRef` rather than `value` afterwards is the point: those
   * final words arrive *during* the await, and the `value` captured by this
   * render would not include them.
   */
  async function submit() {
    if (streaming) return

    if (recording) {
      setRecording(false)
      await recorderRef.current.stop()
    }

    const trimmed = valueRef.current.trim()
    if (!trimmed) return
    onSend(trimmed)
    setText('')
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
  // Recording deliberately does *not* block sending: `submit()` closes the
  // dictation and waits for the last phrase first, so pressing send mid-sentence
  // does the obvious thing instead of being refused.
  const canSend = value.trim().length > 0 && !streaming && !uploading

  function pickFiles() {
    fileRef.current?.click()
  }

  /** Appends a transcribed phrase to whatever is in the composer, spacing it
   *  the way a sentence needs rather than jamming it against the last word. */
  function appendPhrase(phrase: string) {
    const current = valueRef.current
    if (!current) {
      setText(phrase)
      return
    }
    setText(/\s$/.test(current) ? current + phrase : `${current} ${phrase}`)
  }

  /**
   * Mic button: press to start, press again to stop.
   *
   * Click-to-toggle rather than hold-to-talk — dictating a paragraph with a
   * mouse button held down is miserable, and it makes the feature unusable
   * from a keyboard.
   *
   * Text arrives *during* recording, a phrase at a time, so pressing stop is
   * about ending the recording rather than starting the transcription.
   */
  async function toggleRecording() {
    const recorder = recorderRef.current
    setVoiceError(undefined)

    if (recording) {
      setRecording(false)
      // Resolves once the last phrase has landed, so focus moves to a composer
      // that already holds the complete text.
      await recorder.stop()
      textareaRef.current?.focus()
      return
    }

    try {
      // Starts the model loading while the user is still talking, so the first
      // phrase is not the one paying for it.
      warmTranscription()
      await recorder.start({
        onText: appendPhrase,
        // A failed phrase is reported but does not stop the recording — the
        // rest of what is being said still lands.
        onError: setVoiceError,
        onPendingChange: setCatchingUp,
      })
      setRecording(true)
    } catch (error) {
      if (error instanceof MicrophoneDeniedError || error instanceof NoMicrophoneError) {
        setVoiceError(error.message)
      } else {
        setVoiceError('The microphone could not be opened.')
      }
      setRecording(false)
    }
  }

  // Published on every render so the shortcut always calls a toggle that sees
  // the current recording state, and cleared on unmount so the empty-state
  // composer's stale toggle cannot be fired once the chat view replaces it.
  useEffect(() => {
    if (!micToggleRef) return
    micToggleRef.current = () => void toggleRecording()
    return () => {
      micToggleRef.current = null
    }
  })

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
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          rows={1}
          placeholder={
            recording
              ? 'Listening — speak, and it will write along with you…'
              : streaming
                ? 'Arthur is replying…'
                : 'Message Arthur…'
          }
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
            <button
              className="btn-icon"
              data-recording={recording || undefined}
              onClick={toggleRecording}
              disabled={streaming}
              title={recording ? 'Stop dictating' : 'Dictate a message'}
              aria-label={recording ? 'Stop dictating' : 'Dictate a message'}
              aria-pressed={recording}
            >
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

      {voiceError && (
        <p className="mt-2 text-center text-[12px]" style={{ color: 'var(--accent)' }} role="alert">
          {voiceError}
        </p>
      )}

      {/* Only while a phrase is still being transcribed after you have stopped
          talking — during recording the arriving text is its own feedback. */}
      {catchingUp && !voiceError && (
        <p className="mt-2 text-center text-[12px]" style={{ color: 'var(--text-tertiary)' }}>
          Catching up…
        </p>
      )}

      {showHint && !voiceError && !catchingUp && (
        <p className="mt-3 text-center text-[11.5px]" style={{ color: 'var(--text-tertiary)' }}>
          <span className="kbd">Enter</span> to send · <span className="kbd">Shift</span>
          <span className="kbd ml-0.5">Enter</span> for a new line
        </p>
      )}
    </div>
  )
}
