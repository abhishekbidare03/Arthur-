import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ChatPane from './components/ChatPane'
import InputBar from './components/InputBar'
import OllamaBanner from './components/OllamaBanner'
import Sidebar from './components/Sidebar'
import TopBar from './components/TopBar'
import { checkHealth, streamChat, type HealthStatus } from './api'
import { mockConversations, mockMessages } from './mockData'
import { DEFAULT_TIER, tierInfo, type Conversation, type Message, type Tier } from './types'

type Theme = 'light' | 'dark'

function greeting(): string {
  const h = new Date().getHours()
  if (h < 12) return 'Good morning'
  if (h < 18) return 'Good afternoon'
  return 'Good evening'
}

export default function App() {
  const [conversations, setConversations] = useState<Conversation[]>(mockConversations)
  const [messagesByConversation, setMessagesByConversation] =
    useState<Record<string, Message[]>>(mockMessages)
  const [activeId, setActiveId] = useState<string | null>(mockConversations[0]?.id ?? null)
  const [collapsed, setCollapsed] = useState(false)
  const [tier, setTier] = useState<Tier>(DEFAULT_TIER)
  const [theme, setTheme] = useState<Theme>(() =>
    window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
  )

  const [health, setHealth] = useState<HealthStatus | null>(null)
  const [streamingId, setStreamingId] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  /**
   * The model currently resident in VRAM, as far as we know.
   *
   * Only one model fits in 4 GB at a time, so switching tiers forces an
   * unload/reload that costs several seconds on the next message. Tracking this
   * lets the pending indicator say so instead of just appearing to hang.
   */
  const loadedModelRef = useRef<string | null>(null)

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
  }, [theme])

  const refreshHealth = useCallback(async () => {
    setHealth(await checkHealth())
  }, [])

  useEffect(() => {
    void refreshHealth()
  }, [refreshHealth])

  // Abort any in-flight generation if the window goes away, so the model is not
  // left generating into a closed connection.
  useEffect(() => () => abortRef.current?.abort(), [])

  const activeMessages = useMemo(
    () => (activeId ? (messagesByConversation[activeId] ?? []) : []),
    [activeId, messagesByConversation],
  )

  const patchMessage = useCallback(
    (conversationId: string, messageId: string, patch: Partial<Message>) => {
      setMessagesByConversation((prev) => ({
        ...prev,
        [conversationId]: (prev[conversationId] ?? []).map((m) =>
          m.id === messageId ? { ...m, ...patch } : m,
        ),
      }))
    },
    [],
  )

  // Selecting a conversation adopts the tier it was last used with, so reopening
  // an old chat does not silently answer at a different effort level.
  function handleSelect(id: string) {
    if (streamingId) return
    setActiveId(id)
    const conv = conversations.find((c) => c.id === id)
    if (conv) setTier(conv.tier)
  }

  function handleNewChat() {
    if (streamingId) return
    setActiveId(null)
  }

  function handleDelete(id: string) {
    if (id === activeId && streamingId) abortRef.current?.abort()
    setConversations((prev) => prev.filter((c) => c.id !== id))
    setMessagesByConversation((prev) => {
      const next = { ...prev }
      delete next[id]
      return next
    })
    if (activeId === id) setActiveId(null)
  }

  function handleStop() {
    abortRef.current?.abort()
  }

  async function handleSend(text: string) {
    if (streamingId) return

    const now = new Date().toISOString()
    const info = tierInfo(tier)
    let conversationId = activeId

    if (!conversationId) {
      conversationId = `c${Date.now()}`
      setConversations((prev) => [
        {
          id: conversationId!,
          // Phase 3 replaces this with a generated title.
          title: text.length > 40 ? `${text.slice(0, 40).trimEnd()}…` : text,
          tier,
          createdAt: now,
          updatedAt: now,
        },
        ...prev,
      ])
      setActiveId(conversationId)
    } else {
      setConversations((prev) =>
        prev.map((c) => (c.id === conversationId ? { ...c, updatedAt: now, tier } : c)),
      )
    }

    const userMessage: Message = {
      id: `m${Date.now()}`,
      conversationId,
      role: 'user',
      content: text,
      createdAt: now,
    }

    const assistantId = `m${Date.now() + 1}`
    const assistantMessage: Message = {
      id: assistantId,
      conversationId,
      role: 'assistant',
      content: '',
      model: info.model,
      createdAt: now,
      streaming: true,
    }

    // The history sent to the model is everything *before* the empty
    // placeholder — the placeholder itself must never be sent.
    const history = [...(messagesByConversation[conversationId] ?? []), userMessage]
      .filter((m) => !m.error && m.content.trim().length > 0)
      .map((m) => ({ role: m.role, content: m.content }))

    setMessagesByConversation((prev) => ({
      ...prev,
      [conversationId]: [...(prev[conversationId] ?? []), userMessage, assistantMessage],
    }))
    setStreamingId(assistantId)

    const controller = new AbortController()
    abortRef.current = controller

    // Ollama can emit >100 tokens/second. Committing each one to React state
    // would re-render the whole pane that many times a second, so deltas are
    // buffered and flushed at most once per animation frame.
    let pendingContent = ''
    let pendingThinking = ''
    let frame: number | null = null

    const flush = () => {
      frame = null
      if (!pendingContent && !pendingThinking) return
      const content = pendingContent
      const thinking = pendingThinking
      pendingContent = ''
      pendingThinking = ''
      setMessagesByConversation((prev) => ({
        ...prev,
        [conversationId]: (prev[conversationId] ?? []).map((m) =>
          m.id === assistantId
            ? {
                ...m,
                content: m.content + content,
                thinking: thinking ? (m.thinking ?? '') + thinking : m.thinking,
              }
            : m,
        ),
      }))
    }

    const schedule = () => {
      frame ??= requestAnimationFrame(flush)
    }

    try {
      for await (const event of streamChat({ messages: history, tier }, controller.signal)) {
        if (event.type === 'content') {
          pendingContent += event.delta
          schedule()
        } else if (event.type === 'thinking') {
          pendingThinking += event.delta
          schedule()
        } else if (event.type === 'done') {
          if (frame !== null) cancelAnimationFrame(frame)
          flush()
          loadedModelRef.current = event.stats.model
          patchMessage(conversationId, assistantId, { streaming: false, stats: event.stats })
        } else if (event.type === 'error') {
          if (frame !== null) cancelAnimationFrame(frame)
          flush()
          patchMessage(conversationId, assistantId, {
            streaming: false,
            error: { code: event.code, message: event.message, detail: event.detail },
          })
          if (event.code === 'ollama_unreachable') void refreshHealth()
        }
      }
    } finally {
      if (frame !== null) cancelAnimationFrame(frame)
      flush()

      // An abort leaves the loop without a terminal event, so the partial
      // message is closed out here rather than left spinning forever.
      setMessagesByConversation((prev) => ({
        ...prev,
        [conversationId]: (prev[conversationId] ?? []).map((m) =>
          m.id === assistantId && m.streaming
            ? { ...m, streaming: false, stopped: controller.signal.aborted }
            : m,
        ),
      }))
      setStreamingId(null)
      abortRef.current = null
    }
  }

  const isEmptyState = activeId === null || activeMessages.length === 0

  // Only warn about a reload when we know a *different* model is resident.
  const willReloadModel =
    loadedModelRef.current !== null && loadedModelRef.current !== tierInfo(tier).model

  const banner =
    health && !health.running ? (
      <OllamaBanner error={health.error} onRetry={() => void refreshHealth()} />
    ) : null

  return (
    <div className="flex h-full" style={{ background: 'var(--surface-0)' }}>
      <Sidebar
        conversations={conversations}
        activeId={activeId}
        collapsed={collapsed}
        onToggleCollapse={() => setCollapsed((v) => !v)}
        onSelect={handleSelect}
        onNewChat={handleNewChat}
        onDelete={handleDelete}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar
          tier={tier}
          onTierChange={setTier}
          theme={theme}
          onToggleTheme={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
          disabled={streamingId !== null}
          installed={health?.installed}
        />

        {isEmptyState ? (
          // Home screen: centred greeting with the composer inline, the way
          // Claude presents a new chat.
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-6 pb-16">
            <div
              className="w-full max-w-2xl"
              style={{ animation: 'rise 480ms var(--ease-out) backwards' }}
            >
              <h1 className="mb-9 flex items-center justify-center gap-3 text-[34px] font-medium tracking-tight">
                <span
                  style={{
                    color: 'var(--accent)',
                    animation: 'rise 600ms var(--ease-spring) backwards',
                  }}
                >
                  ✻
                </span>
                <span style={{ color: 'var(--text-primary)' }}>{greeting()}</span>
              </h1>

              {banner}

              <div style={{ animation: 'rise 560ms var(--ease-out) 80ms backwards' }}>
                <InputBar
                  onSend={handleSend}
                  onStop={handleStop}
                  streaming={streamingId !== null}
                  autoFocus
                  showHint
                />
              </div>

              <p
                className="mt-7 text-center text-[12px]"
                style={{ color: 'var(--text-tertiary)', animation: 'rise 600ms var(--ease-out) 160ms backwards' }}
              >
                Running locally · no internet, no API key
              </p>
            </div>
          </div>
        ) : (
          <>
            <ChatPane
              messages={activeMessages}
              streamingId={streamingId}
              tier={tier}
              willReloadModel={willReloadModel}
            />
            <div className="composer-scrim shrink-0 px-6 pb-5 pt-3">
              <div className="mx-auto w-full max-w-3xl">
                {banner}
                <InputBar
                  onSend={handleSend}
                  onStop={handleStop}
                  streaming={streamingId !== null}
                />
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
