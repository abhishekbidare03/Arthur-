import { useEffect, useLayoutEffect, useRef } from 'react'
import type { Message, Tier } from '../types'
import { tierInfo } from '../types'
import { AlertIcon } from './icons'
import Markdown from './Markdown'
import ThinkingPanel from './ThinkingPanel'

interface ChatPaneProps {
  messages: Message[]
  /** Id of the message currently being streamed into, if any. */
  streamingId?: string | null
  tier: Tier
  /** True when the next reply must first swap the model in VRAM. */
  willReloadModel?: boolean
}

/** Human-readable remedy for each backend failure code. */
function errorHint(code: string, detail?: string): string {
  switch (code) {
    case 'ollama_unreachable':
      return 'Start the Ollama tray app, then send the message again.'
    case 'model_missing':
      return `Run \`ollama pull ${detail ?? 'the model'}\` in a terminal, then retry.`
    case 'empty_response':
      return 'The model finished without producing an answer. Try rephrasing, or use a different tier.'
    case 'thinking_truncated':
      return 'The High tier reasons before answering and sometimes over-deliberates on open-ended questions. Send it again, or switch to Medium for conversational messages.'
    default:
      return 'Try sending the message again.'
  }
}

export default function ChatPane({
  messages,
  streamingId = null,
  tier,
  willReloadModel = false,
}: ChatPaneProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)

  // Follow the stream only while the user is already at the bottom. Yanking the
  // view back down while they are reading earlier text is worse than not
  // following at all.
  const stickToBottom = useRef(true)

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return

    function onScroll() {
      const distance = el!.scrollHeight - el!.scrollTop - el!.clientHeight
      stickToBottom.current = distance < 120
    }

    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [])

  useLayoutEffect(() => {
    if (stickToBottom.current) {
      bottomRef.current?.scrollIntoView({ block: 'end' })
    }
  }, [messages])

  return (
    <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl px-6 pb-4 pt-8">
        {messages.map((m, i) => {
          if (m.role === 'user') {
            return (
              <div
                key={m.id}
                className="msg mb-7 flex justify-end"
                // Stagger only the first few, so long histories do not cascade.
                style={{ animationDelay: `${Math.min(i, 6) * 30}ms` }}
              >
                <div className="bubble-user text-[15px]">{m.content}</div>
              </div>
            )
          }

          const isStreaming = m.id === streamingId
          // Waiting on the very first token — which on the High tier means
          // waiting through a model load *and* ~1,000 tokens of reasoning.
          const awaitingFirstToken = isStreaming && !m.content && !m.thinking

          return (
            <div key={m.id} className="msg mb-9" style={{ animationDelay: `${Math.min(i, 6) * 30}ms` }}>
              {m.thinking && <ThinkingPanel thinking={m.thinking} streaming={isStreaming && !m.content} />}

              {awaitingFirstToken && (
                <div className="flex items-center gap-2.5" style={{ color: 'var(--text-tertiary)' }}>
                  <span className="typing-dots" aria-hidden="true">
                    <i /><i /><i />
                  </span>
                  <span className="text-[12.5px]">
                    {willReloadModel
                      ? `Loading ${tierInfo(tier).model} — only one model fits in VRAM, so this first reply is slower`
                      : tierInfo(tier).thinks
                        ? 'Thinking…'
                        : 'Working…'}
                  </span>
                </div>
              )}

              {m.content && (
                <div className="prose-arthur" style={{ color: 'var(--text-primary)' }}>
                  <Markdown content={m.content} streaming={isStreaming} />
                  {isStreaming && <span className="caret" aria-hidden="true" />}
                </div>
              )}

              {m.stopped && (
                <p className="mt-2 text-[12px] italic" style={{ color: 'var(--text-tertiary)' }}>
                  Stopped
                </p>
              )}

              {m.error && (
                <div className="notice mt-1" role="alert">
                  <AlertIcon className="mt-px h-4 w-4 shrink-0" style={{ color: 'var(--accent)' }} />
                  <div className="min-w-0 flex-1">
                    <p className="text-[13px] font-medium" style={{ color: 'var(--text-primary)' }}>
                      {m.error.message}
                    </p>
                    <p className="mt-1 text-[12.5px]" style={{ color: 'var(--text-secondary)' }}>
                      {errorHint(m.error.code, m.error.detail)}
                    </p>
                  </div>
                </div>
              )}
            </div>
          )
        })}
        <div ref={bottomRef} />
      </div>
    </div>
  )
}
