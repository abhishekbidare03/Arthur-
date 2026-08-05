import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Attachment } from '../types'
import { transcribeAudio, warmTranscription } from '../api'
import { MicrophoneDeniedError, NoMicrophoneError, Recorder } from '../voice/recorder'
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

  // Voice input. `idle → recording → transcribing → idle`, with the transcript
  // landing in the composer *editable* rather than being sent — a wrong word
  // should be a one-word fix, not a re-record.
  const recorderRef = useRef<Recorder>(null as unknown as Recorder)
  if (recorderRef.current === null) recorderRef.current = new Recorder()
  const [voiceState, setVoiceState] = useState<'idle' | 'recording' | 'transcribing'>('idle')
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

  /**
   * Mic button: press to start, press again to stop and transcribe.
   *
   * Click-to-toggle rather than hold-to-talk — dictating a paragraph with a
   * mouse button held down is miserable, and it makes the feature unusable
   * from a keyboard.
   */
  async function toggleRecording() {
    const recorder = recorderRef.current
    setVoiceError(undefined)

    if (voiceState === 'recording') {
      setVoiceState('transcribing')
      try {
        const recording = await recorder.stop()
        if (!recording) {
          // Too short to be speech — a mis-click, not an error worth a message.
          setVoiceState('idle')
          return
        }
        const text = await transcribeAudio(recording.wav)
        // Append rather than replace: dictating after typing a few words should
        // add to them, which is also what makes a failed transcription
        // non-destructive.
        setValue((current) => (current.trim() ? `${current.trim()} ${text}` : text))
        textareaRef.current?.focus()
      } catch (error) {
        setVoiceError(error instanceof Error ? error.message : 'That recording could not be transcribed.')
      } finally {
        setVoiceState('idle')
      }
      return
    }

    try {
      // Starts the model loading while the user is still talking, so the wait
      // after they stop is transcription only.
      warmTranscription()
      await recorder.start()
      setVoiceState('recording')
    } catch (error) {
      if (error instanceof MicrophoneDeniedError || error instanceof NoMicrophoneError) {
        setVoiceError(error.message)
      } else {
        setVoiceError('The microphone could not be opened.')
      }
      setVoiceState('idle')
    }
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
          placeholder={
            voiceState === 'recording'
              ? 'Listening…'
              : voiceState === 'transcribing'
                ? 'Transcribing…'
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
              data-recording={voiceState === 'recording' || undefined}
              onClick={toggleRecording}
              disabled={streaming || voiceState === 'transcribing'}
              title={
                voiceState === 'recording'
                  ? 'Stop recording and transcribe'
                  : voiceState === 'transcribing'
                    ? 'Transcribing…'
                    : 'Dictate a message'
              }
              aria-label={voiceState === 'recording' ? 'Stop recording' : 'Dictate a message'}
              aria-pressed={voiceState === 'recording'}
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

      {showHint && !voiceError && (
        <p className="mt-3 text-center text-[11.5px]" style={{ color: 'var(--text-tertiary)' }}>
          <span className="kbd">Enter</span> to send · <span className="kbd">Shift</span>
          <span className="kbd ml-0.5">Enter</span> for a new line
        </p>
      )}
    </div>
  )
}
