import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ChatPane from './components/ChatPane'
import InputBar from './components/InputBar'
import OllamaBanner from './components/OllamaBanner'
import Sidebar from './components/Sidebar'
import TopBar from './components/TopBar'
import {
  checkHealth,
  deleteConversation as apiDeleteConversation,
  fetchConversations,
  fetchMessages,
  renameConversation as apiRenameConversation,
  streamChat,
  type HealthStatus,
} from './api'
import { DEFAULT_TIER, tierInfo, type Conversation, type Message, type Tier } from './types'

type Theme = 'light' | 'dark'

function greeting(): string {
  const h = new Date().getHours()
  if (h < 12) return 'Good morning'
  if (h < 18) return 'Good afternoon'
  return 'Good evening'
}

/**
 * Key used for a conversation the backend has not created yet.
 *
 * A brand-new chat streams before its row exists — the backend assigns the id
 * and reports it in the `start` event. Messages are staged under this key and
 * moved to the real id the moment it arrives.
 */
const DRAFT = '__draft__'

export default function App() {
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [messagesByConversation, setMessagesByConversation] = useState<Record<string, Message[]>>({})
  const [activeId, setActiveId] = useState<string | null>(null)
  const [loadedIds, setLoadedIds] = useState<Set<string>>(() => new Set())

  const [collapsed, setCollapsed] = useState(false)
  const [tier, setTier] = useState<Tier>(DEFAULT_TIER)
  const [theme, setTheme] = useState<Theme>(() =>
    window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
  )

  const [health, setHealth] = useState<HealthStatus | null>(null)
  const [streamingId, setStreamingId] = useState<string | null>(null)
  const [loadingMessages, setLoadingMessages] = useState(false)
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

  // Initial load: conversation list and Ollama status.
  useEffect(() => {
    void refreshHealth()
    void fetchConversations()
      .then(setConversations)
      .catch(() => {
        // The backend is down; the banner already covers this case.
      })
  }, [refreshHealth])

  // Abort any in-flight generation if the window goes away, so the model is not
  // left generating into a closed connection.
  useEffect(() => () => abortRef.current?.abort(), [])

  const activeMessages = useMemo(
    () => (activeId ? (messagesByConversation[activeId] ?? []) : []),
    [activeId, messagesByConversation],
  )

  // Selecting a conversation adopts the tier it was last used with, so reopening
  // an old chat never silently answers at a different effort level.
  async function handleSelect(id: string) {
    if (streamingId) return
    setActiveId(id)

    const conv = conversations.find((c) => c.id === id)
    if (conv) setTier(conv.tier)

    // Messages are fetched once per conversation and cached thereafter.
    if (loadedIds.has(id)) return
    setLoadingMessages(true)
    try {
      const messages = await fetchMessages(id)
      setMessagesByConversation((prev) => ({ ...prev, [id]: messages }))
      setLoadedIds((prev) => new Set(prev).add(id))
    } catch {
      setMessagesByConversation((prev) => ({ ...prev, [id]: [] }))
    } finally {
      setLoadingMessages(false)
    }
  }

  function handleNewChat() {
    if (streamingId) return
    setActiveId(null)
    // Clear any abandoned draft so a new chat never inherits stale bubbles.
    setMessagesByConversation((prev) => {
      const next = { ...prev }
      delete next[DRAFT]
      return next
    })
  }

  async function handleDelete(id: string) {
    if (id === activeId && streamingId) abortRef.current?.abort()

    // Optimistic: the row is gone from the UI immediately, and restored only if
    // the request fails.
    const previous = conversations
    setConversations((prev) => prev.filter((c) => c.id !== id))
    if (activeId === id) setActiveId(null)

    try {
      await apiDeleteConversation(id)
      setMessagesByConversation((prev) => {
        const next = { ...prev }
        delete next[id]
        return next
      })
    } catch {
      setConversations(previous)
    }
  }

  async function handleRename(id: string, title: string) {
    const trimmed = title.trim()
    const current = conversations.find((c) => c.id === id)
    if (!trimmed || !current || trimmed === current.title) return

    const previous = conversations
    setConversations((prev) => prev.map((c) => (c.id === id ? { ...c, title: trimmed } : c)))
    try {
      await apiRenameConversation(id, trimmed)
    } catch {
      setConversations(previous)
    }
  }

  function handleStop() {
    abortRef.current?.abort()
  }

  async function handleSend(text: string) {
    if (streamingId) return

    const now = new Date().toISOString()
    const info = tierInfo(tier)

    // Until the `start` event arrives, a new chat has no id — stage it.
    const isNewChat = activeId === null
    let key = isNewChat ? DRAFT : activeId!

    const tempUserId = `tmp-u-${Date.now()}`
    const tempAssistantId = `tmp-a-${Date.now()}`

    // Tracks the assistant row's *current* id. It starts as the temporary one
    // and is replaced when `start` reports the id the database assigned, so the
    // terminal handlers below always patch the right row.
    let assistantId = tempAssistantId

    // Matches the row being streamed into under *either* id.
    //
    // The `start` handler renames the row from the temporary id to the one the
    // database assigned, but that rename is a queued state update while
    // `assistantId` changes immediately — so for a brief window the two
    // disagree about which id is live. Matching both is what makes the writes
    // below independent of that ordering. Both ids are unique to this send, so
    // there is no chance of hitting an unrelated row.
    const isTarget = (m: Message) => m.id === assistantId || m.id === tempAssistantId

    const userMessage: Message = {
      id: tempUserId,
      conversationId: key,
      role: 'user',
      content: text,
      createdAt: now,
    }
    const assistantMessage: Message = {
      id: tempAssistantId,
      conversationId: key,
      role: 'assistant',
      content: '',
      model: info.model,
      createdAt: now,
      streaming: true,
    }

    setMessagesByConversation((prev) => ({
      ...prev,
      [key]: [...(prev[key] ?? []), userMessage, assistantMessage],
    }))
    setStreamingId(tempAssistantId)

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
        [key]: (prev[key] ?? []).map((m) =>
          isTarget(m)
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

    const patchTarget = (patch: Partial<Message>) => {
      setMessagesByConversation((prev) => ({
        ...prev,
        [key]: (prev[key] ?? []).map((m) => (isTarget(m) ? { ...m, ...patch } : m)),
      }))
    }

    try {
      for await (const event of streamChat(
        { ...(isNewChat ? {} : { conversationId: key }), content: text, tier },
        controller.signal,
      )) {
        if (event.type === 'start') {
          // Adopt the ids the database assigned. For a new chat this also moves
          // the staged messages from the draft key onto the real conversation.
          const realId = event.conversationId

          setMessagesByConversation((prev) => {
            const staged = (prev[key] ?? []).map((m) =>
              m.id === tempUserId
                ? { ...m, id: event.userMessageId, conversationId: realId }
                : m.id === tempAssistantId
                  ? { ...m, id: event.assistantMessageId, conversationId: realId }
                  : m,
            )
            const next = { ...prev, [realId]: staged }
            if (key !== realId) delete next[key]
            return next
          })

          if (isNewChat) {
            setConversations((prev) => [
              { id: realId, title: event.title, tier, createdAt: now, updatedAt: now },
              ...prev.filter((c) => c.id !== realId),
            ])
            setActiveId(realId)
            setLoadedIds((prev) => new Set(prev).add(realId))
          } else {
            setConversations((prev) =>
              prev.map((c) => (c.id === realId ? { ...c, updatedAt: now, tier } : c)),
            )
          }

          key = realId
          assistantId = event.assistantMessageId
          setStreamingId(event.assistantMessageId)
        } else if (event.type === 'content') {
          pendingContent += event.delta
          schedule()
        } else if (event.type === 'thinking') {
          pendingThinking += event.delta
          schedule()
        } else if (event.type === 'done') {
          if (frame !== null) cancelAnimationFrame(frame)
          flush()
          loadedModelRef.current = event.stats.model
          patchTarget({ streaming: false, stats: event.stats })
        } else if (event.type === 'error') {
          if (frame !== null) cancelAnimationFrame(frame)
          flush()
          patchTarget({
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
      const finalKey = key
      setMessagesByConversation((prev) => ({
        ...prev,
        [finalKey]: (prev[finalKey] ?? []).map((m) =>
          m.streaming ? { ...m, streaming: false, stopped: controller.signal.aborted } : m,
        ),
      }))
      setStreamingId(null)
      abortRef.current = null
    }
  }

  // The greeting screen is for a genuinely new chat. Without the `loading`
  // guard, clicking a stored conversation flashes the greeting for as long as
  // its messages take to arrive.
  const isEmptyState = activeId === null || (activeMessages.length === 0 && !loadingMessages)

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
        busy={streamingId !== null}
        onToggleCollapse={() => setCollapsed((v) => !v)}
        onSelect={(id) => void handleSelect(id)}
        onNewChat={handleNewChat}
        onDelete={(id) => void handleDelete(id)}
        onRename={(id, title) => void handleRename(id, title)}
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
                  onSend={(t) => void handleSend(t)}
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
              loading={loadingMessages}
            />
            <div className="composer-scrim shrink-0 px-6 pb-5 pt-3">
              <div className="mx-auto w-full max-w-3xl">
                {banner}
                <InputBar
                  onSend={(t) => void handleSend(t)}
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
