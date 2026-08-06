import { useEffect, useLayoutEffect, useRef } from 'react'
import type { Message, Tier } from '../types'
import { tierInfo } from '../types'
import AttachmentChip from './AttachmentChip'
import Citations from './Citations'
import { AlertIcon } from './icons'
import Markdown from './Markdown'
import MessageMeta from './MessageMeta'
import ThinkingPanel from './ThinkingPanel'

interface ChatPaneProps {
  messages: Message[]
  /** Id of the message currently being streamed into, if any. */
  streamingId?: string | null
  tier: Tier
  /** True when the next reply must first swap the model in VRAM. */
  willReloadModel?: boolean
  /** True while a stored conversation's messages are being fetched. */
  loading?: boolean
  /** Re-answers the last question, optionally at a different tier. */
  onRegenerate?: (tier: Tier) => void
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
  loading = false,
  onRegenerate,
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
        {loading && messages.length === 0 && (
          <p className="py-8 text-center text-[13px]" style={{ color: 'var(--text-tertiary)' }}>
            Loading conversation…
          </p>
        )}

        {messages.map((m, i) => {
          if (m.role === 'user') {
            // Files that did not fit whole. The model was told about the cut,
            // and so is the user — an answer drawn from half a file is not
            // wrong so much as differently scoped.
            const shortfall = (m.attachmentOutcomes ?? []).filter((o) => o.state !== 'full')

            return (
              <div
                key={m.id}
                className="msg mb-7 flex flex-col items-end"
                // Stagger only the first few, so long histories do not cascade.
                style={{ animationDelay: `${Math.min(i, 6) * 30}ms` }}
              >
                {m.attachments && m.attachments.length > 0 && (
                  <div className="chip-tray mb-1.5 justify-end">
                    {m.attachments.map((a) => (
                      <AttachmentChip key={a.id} attachment={a} />
                    ))}
                  </div>
                )}

                <div className="bubble-user text-[15px]">{m.content}</div>

                {shortfall.length > 0 && (
                  <p className="mt-1.5 max-w-[85%] text-right text-[12px]" style={{ color: 'var(--text-tertiary)' }}>
                    {shortfall.map((o) => {
                      if (o.state === 'dropped') {
                        return `${o.filename} did not fit in the context window and was not sent.`
                      }
                      // Retrieval is not truncation and must not be described as
                      // it: the model saw the passages that matter to *this*
                      // question, drawn from anywhere in the file, rather than
                      // a prefix that stops partway through.
                      if (o.state === 'retrieved') {
                        const n = o.chunksUsed ?? 0
                        return `${o.filename} is too large to send whole — the ${n} most relevant passage${
                          n === 1 ? '' : 's'
                        } were used.`
                      }
                      return `${o.filename} was truncated — the model saw the first ${Math.round(
                        (o.keptChars / o.totalChars) * 100,
                      )}%.`
                    }).join(' ')}
                  </p>
                )}
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

              {/* Under the answer, above the actions: the passages it was
                  given. Only ever present when retrieval chose what the model
                  saw, which is exactly when an answer is least verifiable. */}
              {m.sources && m.sources.length > 0 && !isStreaming && (
                <Citations sources={m.sources} />
              )}

              {m.stopped && (
                <p className="mt-2 text-[12px] italic" style={{ color: 'var(--text-tertiary)' }}>
                  Stopped
                </p>
              )}

              {/* Only once the answer is complete — reading a half-streamed
                  message would speak a sentence that is still being written. */}
              {m.content && !isStreaming && !m.error && (
                <div className="-ml-1.5">
                  <MessageMeta
                    content={m.content}
                    stats={m.stats}
                    tier={tier}
                    // Only the last message. Re-answering an earlier turn would
                    // mean discarding every exchange after it, which is a
                    // different and much more destructive action than the one
                    // this button appears to offer.
                    onRegenerate={i === messages.length - 1 ? onRegenerate : undefined}
                    disabled={streamingId !== null}
                  />
                </div>
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
