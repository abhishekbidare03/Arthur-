import { useEffect, useRef, useState } from 'react'
import type { Conversation } from '../types'
import { PanelIcon, PencilIcon, PlusIcon, SettingsIcon, TrashIcon } from './icons'

interface SidebarProps {
  conversations: Conversation[]
  activeId: string | null
  collapsed: boolean
  /** True while a reply is streaming — switching or starting a chat is blocked. */
  busy?: boolean
  onToggleCollapse: () => void
  onSelect: (id: string) => void
  onNewChat: () => void
  onDelete: (id: string) => void
  onRename: (id: string, title: string) => void
}

const DAY_MS = 24 * 60 * 60 * 1000

/** Local midnight for a given date. */
function startOfDay(d: Date): number {
  const x = new Date(d)
  x.setHours(0, 0, 0, 0)
  return x.getTime()
}

/**
 * Groups conversations into Today / Yesterday / Previous 7 days / Older.
 *
 * Boundaries are *calendar days*, not rolling 24-hour windows. Elapsed-time
 * bucketing puts a chat from 11pm last night under "Today" at 1am, which is
 * plainly wrong to anyone reading the list.
 */
function groupByRecency(conversations: Conversation[]) {
  const todayStart = startOfDay(new Date())
  const yesterdayStart = todayStart - DAY_MS
  const weekStart = todayStart - 6 * DAY_MS

  const groups: { label: string; items: Conversation[] }[] = [
    { label: 'Today', items: [] },
    { label: 'Yesterday', items: [] },
    { label: 'Previous 7 days', items: [] },
    { label: 'Older', items: [] },
  ]

  // Newest first within each group.
  const sorted = [...conversations].sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
  )

  for (const c of sorted) {
    const t = new Date(c.updatedAt).getTime()
    if (t >= todayStart) groups[0]!.items.push(c)
    else if (t >= yesterdayStart) groups[1]!.items.push(c)
    else if (t >= weekStart) groups[2]!.items.push(c)
    else groups[3]!.items.push(c)
  }

  return groups.filter((g) => g.items.length > 0)
}

export default function Sidebar({
  conversations,
  activeId,
  collapsed,
  busy = false,
  onToggleCollapse,
  onSelect,
  onNewChat,
  onDelete,
  onRename,
}: SidebarProps) {
  const groups = groupByRecency(conversations)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editingId) inputRef.current?.select()
  }, [editingId])

  function beginRename(c: Conversation) {
    setEditingId(c.id)
    setDraft(c.title)
  }

  function commitRename() {
    if (editingId) onRename(editingId, draft)
    setEditingId(null)
  }

  // Collapsed keeps a narrow icon rail rather than vanishing, so the expand
  // affordance is always reachable.
  if (collapsed) {
    return (
      <aside className="sidebar flex w-[56px] shrink-0 flex-col items-center gap-1.5 py-3">
        <button className="btn-icon" onClick={onToggleCollapse} aria-label="Expand sidebar" title="Expand sidebar">
          <PanelIcon />
        </button>
        <button className="btn-icon" onClick={onNewChat} disabled={busy} aria-label="New chat" title="New chat">
          <PlusIcon />
        </button>
      </aside>
    )
  }

  return (
    <aside className="sidebar flex w-[268px] shrink-0 flex-col">
      <div className="flex items-center justify-between px-3.5 py-3">
        <span className="flex items-center gap-1.5 text-[15px] font-semibold tracking-tight">
          <span style={{ color: 'var(--accent)' }}>✻</span>
          <span style={{ color: 'var(--text-primary)' }}>Arthur</span>
        </span>
        <button className="btn-icon" onClick={onToggleCollapse} aria-label="Collapse sidebar" title="Collapse sidebar">
          <PanelIcon />
        </button>
      </div>

      <div className="px-3 pb-3">
        <button className="btn btn-outline w-full justify-start" onClick={onNewChat} disabled={busy}>
          <PlusIcon className="h-4 w-4" style={{ color: 'var(--accent)' }} />
          New chat
        </button>
      </div>

      <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {groups.length === 0 && (
          <p className="px-3 py-8 text-center text-[13px]" style={{ color: 'var(--text-tertiary)' }}>
            No conversations yet
          </p>
        )}

        {groups.map((group) => (
          <div key={group.label} className="mb-4">
            <h2 className="sidebar-label px-3 pb-1.5 pt-1">{group.label}</h2>
            <ul className="flex flex-col gap-0.5">
              {group.items.map((c) => (
                <li key={c.id}>
                  {editingId === c.id ? (
                    <div className="conv-item" data-active={c.id === activeId}>
                      <input
                        ref={inputRef}
                        className="conv-rename"
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        // Blur commits, so clicking away saves rather than
                        // silently discarding what was typed.
                        onBlur={commitRename}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault()
                            commitRename()
                          }
                          if (e.key === 'Escape') {
                            e.preventDefault()
                            setEditingId(null)
                          }
                        }}
                        aria-label="Conversation title"
                      />
                    </div>
                  ) : (
                    <div className="conv-item" data-active={c.id === activeId}>
                      <button
                        className="conv-title"
                        onClick={() => onSelect(c.id)}
                        onDoubleClick={() => beginRename(c)}
                        disabled={busy && c.id !== activeId}
                        title={c.title}
                      >
                        {c.title}
                      </button>
                      <button
                        className="conv-action"
                        onClick={(e) => {
                          e.stopPropagation()
                          beginRename(c)
                        }}
                        aria-label={`Rename ${c.title}`}
                        title="Rename"
                      >
                        <PencilIcon className="h-3.5 w-3.5" />
                      </button>
                      <button
                        className="conv-action conv-delete"
                        onClick={(e) => {
                          e.stopPropagation()
                          onDelete(c.id)
                        }}
                        aria-label={`Delete ${c.title}`}
                        title="Delete"
                      >
                        <TrashIcon className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>

      <div className="divider mx-3" />
      <div className="p-2.5">
        <button className="btn btn-ghost w-full justify-start">
          <SettingsIcon className="h-4 w-4" />
          Settings
        </button>
      </div>
    </aside>
  )
}
