import { useCallback, useEffect, useRef, useState } from 'react'
import {
  createCollection,
  deleteCollection,
  deleteDocument,
  fetchCollectionDocuments,
  fetchCollections,
  ingestFolder,
  reindexDocument,
  searchCollection,
  updateCollection,
  type Collection,
  type CollectionDocument,
  type IngestEvent,
} from '../api'
import type { Source } from '../types'
import { formatBytes } from './AttachmentChip'
import {
  CheckIcon,
  CloseIcon,
  FileIcon,
  FolderIcon,
  PlusIcon,
  RefreshIcon,
  SearchIcon,
  TrashIcon,
} from './icons'

interface KnowledgePanelProps {
  onClose: () => void
  /** The conversation to link, if one is open. */
  activeConversationId: string | null
  activeCollectionId: string | null
  onLink: (collectionId: string | null) => void
}

/**
 * The knowledge base: collections, their documents, and search.
 *
 * One panel rather than three screens, because the three tasks are one task in
 * practice — you make a collection *in order to* put documents in it, and you
 * search it to check that worked. Splitting them would mean navigating between
 * views to answer "did that folder actually ingest?".
 */
export default function KnowledgePanel({
  onClose,
  activeConversationId,
  activeCollectionId,
  onLink,
}: KnowledgePanelProps) {
  const [collections, setCollections] = useState<Collection[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(activeCollectionId)
  const [documents, setDocuments] = useState<CollectionDocument[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()

  const [creating, setCreating] = useState(false)
  const [draftName, setDraftName] = useState('')

  const [folderPath, setFolderPath] = useState('')
  const [ingest, setIngest] = useState<IngestEvent | null>(null)
  const ingestController = useRef<AbortController | null>(null)

  const [query, setQuery] = useState('')
  const [results, setResults] = useState<Source[] | null>(null)
  const [searching, setSearching] = useState(false)

  const selected = collections.find((c) => c.id === selectedId)

  const refresh = useCallback(async () => {
    try {
      const list = await fetchCollections()
      setCollections(list)
      setSelectedId((current) => current ?? list[0]?.id ?? null)
    } catch {
      setError('The collection list could not be loaded.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // Documents belong to the selected collection, so they are re-fetched on
  // every change of selection rather than cached per id — a folder ingest or a
  // delete makes any cache wrong immediately, and this is a local request.
  useEffect(() => {
    if (!selectedId) {
      setDocuments([])
      return
    }
    let cancelled = false
    void fetchCollectionDocuments(selectedId)
      .then((docs) => {
        if (!cancelled) setDocuments(docs)
      })
      .catch(() => {
        if (!cancelled) setDocuments([])
      })
    return () => {
      cancelled = true
    }
  }, [selectedId, ingest])

  // Results belong to the query *and* the collection. Without this a stale
  // result list stays on screen under a different collection's name, which
  // reads as that collection containing something it does not.
  useEffect(() => {
    setResults(null)
    setQuery('')
  }, [selectedId])

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

  // Stop a running ingest if the panel goes away — the request would otherwise
  // keep walking a folder nobody is watching.
  useEffect(() => () => ingestController.current?.abort(), [])

  async function handleCreate() {
    const name = draftName.trim()
    if (!name) return
    try {
      const created = await createCollection(name)
      setDraftName('')
      setCreating(false)
      setSelectedId(created.id)
      await refresh()
    } catch {
      setError('The collection could not be created.')
    }
  }

  async function handleRename(collection: Collection, name: string) {
    if (!name.trim() || name.trim() === collection.name) return
    await updateCollection(collection.id, name.trim(), collection.description).catch(() => {})
    await refresh()
  }

  async function handleDeleteCollection(collection: Collection) {
    // Deleting a collection deletes the documents ingested into it, which is
    // not obvious from the button. Said plainly rather than discovered.
    const ok = window.confirm(
      `Delete "${collection.name}" and the ${collection.documentCount} document${
        collection.documentCount === 1 ? '' : 's'
      } in it?\n\nThe original files on disk are untouched.`,
    )
    if (!ok) return

    await deleteCollection(collection.id).catch(() => {})
    if (activeCollectionId === collection.id) onLink(null)
    setSelectedId(null)
    await refresh()
  }

  async function handleIngest() {
    const path = folderPath.trim()
    if (!path || !selectedId) return

    const controller = new AbortController()
    ingestController.current = controller
    setIngest({ stage: 'scanning' })

    try {
      for await (const event of ingestFolder(selectedId, path, controller.signal)) {
        setIngest(event)
      }
    } finally {
      ingestController.current = null
      await refresh()
    }
  }

  async function handleSearch() {
    const q = query.trim()
    if (!q || !selectedId) return
    setSearching(true)
    try {
      setResults(await searchCollection(selectedId, q))
    } catch {
      setResults([])
    } finally {
      setSearching(false)
    }
  }

  async function handleReindex(document: CollectionDocument) {
    setDocuments((prev) =>
      prev.map((d) => (d.id === document.id ? { ...d, status: 'pending' } : d)),
    )
    try {
      const { status } = await reindexDocument(document.id)
      setDocuments((prev) =>
        prev.map((d) =>
          d.id === document.id ? { ...d, status: status as CollectionDocument['status'] } : d,
        ),
      )
    } catch {
      setDocuments((prev) =>
        prev.map((d) => (d.id === document.id ? { ...d, status: 'failed' } : d)),
      )
    }
    await refresh()
  }

  async function handleDeleteDocument(document: CollectionDocument) {
    setDocuments((prev) => prev.filter((d) => d.id !== document.id))
    await deleteDocument(document.id).catch(() => {})
    await refresh()
  }

  const ingesting = ingest !== null && ingest.stage !== 'complete' && ingest.stage !== 'error'

  return (
    <div
      className="modal-scrim"
      role="dialog"
      aria-modal="true"
      aria-label="Knowledge collections"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="modal-panel flex w-full max-w-3xl flex-col" style={{ height: '78vh' }}>
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-[15px] font-medium" style={{ color: 'var(--text-primary)' }}>
              Knowledge
            </h2>
            <p className="mt-0.5 text-[12px]" style={{ color: 'var(--text-secondary)' }}>
              Collections you build once and reuse. A chat linked to one answers from it without
              re-attaching anything.
            </p>
          </div>
          <button className="btn-icon h-7 w-7 shrink-0" onClick={onClose} aria-label="Close">
            <CloseIcon className="h-4 w-4" />
          </button>
        </div>

        {error && (
          <p className="mt-2 text-[12px]" style={{ color: 'var(--accent)' }}>
            {error}
          </p>
        )}

        <div className="mt-3 flex min-h-0 flex-1 gap-4">
          {/* ---------------------------------------------------- collections -- */}
          <div className="flex w-[200px] shrink-0 flex-col">
            <div className="min-h-0 flex-1 overflow-y-auto pr-1">
              {loading ? (
                <p className="px-1 py-2 text-[12px]" style={{ color: 'var(--text-tertiary)' }}>
                  Loading…
                </p>
              ) : collections.length === 0 ? (
                <p className="px-1 py-2 text-[12px] leading-relaxed" style={{ color: 'var(--text-tertiary)' }}>
                  No collections yet. Make one, then point it at a folder.
                </p>
              ) : (
                collections.map((collection) => (
                  <button
                    key={collection.id}
                    className="collection-item"
                    data-active={collection.id === selectedId || undefined}
                    onClick={() => setSelectedId(collection.id)}
                  >
                    <span className="truncate text-[13px]">{collection.name}</span>
                    <span className="shrink-0 text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
                      {/* Indexed vs total, because a collection whose files all
                          failed looks identical to a working one otherwise. */}
                      {collection.indexedCount === collection.documentCount
                        ? collection.documentCount
                        : `${collection.indexedCount}/${collection.documentCount}`}
                    </span>
                  </button>
                ))
              )}
            </div>

            {creating ? (
              <div className="mt-2 flex items-center gap-1">
                <input
                  className="field flex-1"
                  autoFocus
                  value={draftName}
                  placeholder="Collection name"
                  onChange={(e) => setDraftName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void handleCreate()
                    if (e.key === 'Escape') {
                      e.stopPropagation()
                      setCreating(false)
                      setDraftName('')
                    }
                  }}
                />
                <button className="btn-icon h-7 w-7" onClick={() => void handleCreate()} aria-label="Create">
                  <CheckIcon className="h-4 w-4" />
                </button>
              </div>
            ) : (
              <button className="btn-secondary mt-2 justify-center" onClick={() => setCreating(true)}>
                <PlusIcon className="h-3.5 w-3.5" />
                New collection
              </button>
            )}
          </div>

          <div className="divider-v" />

          {/* ------------------------------------------------------- selected -- */}
          <div className="flex min-w-0 flex-1 flex-col overflow-y-auto">
            {!selected ? (
              <p className="text-[12.5px]" style={{ color: 'var(--text-tertiary)' }}>
                Select a collection, or make one.
              </p>
            ) : (
              <>
                <div className="flex items-center justify-between gap-3">
                  <input
                    className="field-plain min-w-0 flex-1 text-[14px] font-medium"
                    defaultValue={selected.name}
                    key={selected.id}
                    onBlur={(e) => void handleRename(selected, e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                    }}
                    aria-label="Collection name"
                  />
                  <button
                    className="btn-icon h-7 w-7 shrink-0"
                    onClick={() => void handleDeleteCollection(selected)}
                    title="Delete this collection"
                    aria-label="Delete collection"
                  >
                    <TrashIcon className="h-4 w-4" />
                  </button>
                </div>

                {activeConversationId && (
                  <label className="mt-2 flex items-center gap-2 text-[12.5px]" style={{ color: 'var(--text-secondary)' }}>
                    <input
                      type="checkbox"
                      checked={activeCollectionId === selected.id}
                      onChange={(e) => onLink(e.target.checked ? selected.id : null)}
                    />
                    This chat answers from this collection
                  </label>
                )}

                {/* ------------------------------------------ folder ingest -- */}
                <div className="mt-4">
                  <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wide" style={{ color: 'var(--text-tertiary)' }}>
                    Add a folder
                  </p>
                  <div className="flex items-center gap-1.5">
                    <FolderIcon className="h-4 w-4 shrink-0" style={{ color: 'var(--text-tertiary)' }} />
                    <input
                      className="field min-w-0 flex-1"
                      value={folderPath}
                      placeholder="E:\notes"
                      disabled={ingesting}
                      onChange={(e) => setFolderPath(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void handleIngest()
                      }}
                    />
                    <button
                      className="btn-secondary shrink-0"
                      onClick={() => (ingesting ? ingestController.current?.abort() : void handleIngest())}
                      disabled={!ingesting && folderPath.trim().length === 0}
                    >
                      {ingesting ? 'Stop' : 'Scan'}
                    </button>
                  </div>

                  {ingest && (
                    <p className="mt-1.5 text-[11.5px]" style={{ color: ingest.stage === 'error' ? 'var(--accent)' : 'var(--text-secondary)' }}>
                      {ingest.stage === 'scanning'
                        ? 'Scanning the folder…'
                        : ingest.stage === 'file'
                          ? `${ingest.seen}/${ingest.total} · ${ingest.filename}`
                          : ingest.stage === 'error'
                            ? ingest.error
                            : ingest.stage === 'complete'
                              ? // Unchanged is reported separately from skipped:
                                // re-scanning a folder and being told "0 added"
                                // looks broken unless it also says why.
                                `Added ${ingest.added}, ${ingest.unchanged} already indexed, ${ingest.skipped} unsupported` +
                                (ingest.failed.length > 0 ? `, ${ingest.failed.length} failed` : '') +
                                (ingest.truncated ? ' — stopped at the 500-file limit' : '')
                              : `Scanned ${ingest.seen} files`}
                    </p>
                  )}

                  <p className="mt-1 text-[11px] leading-relaxed" style={{ color: 'var(--text-tertiary)' }}>
                    A local path on this machine. Files are read once and recognised by content
                    afterwards, so re-scanning only costs the parts that changed.
                  </p>
                </div>

                {/* ----------------------------------------------- documents -- */}
                <div className="mt-4">
                  <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wide" style={{ color: 'var(--text-tertiary)' }}>
                    {documents.length} document{documents.length === 1 ? '' : 's'}
                  </p>
                  <div className="flex flex-col">
                    {documents.map((document) => (
                      <div key={document.id} className="doc-row">
                        <FileIcon className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--text-tertiary)' }} />
                        <span className="min-w-0 flex-1 truncate text-[12.5px]" title={document.filename}>
                          {document.filename}
                        </span>
                        <span
                          className="shrink-0 text-[11px]"
                          style={{
                            color:
                              document.status === 'indexed'
                                ? 'var(--text-tertiary)'
                                : 'var(--accent)',
                          }}
                        >
                          {document.status === 'indexed'
                            ? formatBytes(document.byteSize)
                            : document.status === 'pending'
                              ? 'indexing…'
                              : // Named rather than shown as a neutral badge:
                                // an un-indexed document is invisible to
                                // retrieval, which is the whole feature.
                                'not searchable'}
                        </span>
                        <button
                          className="btn-icon h-6 w-6 shrink-0"
                          onClick={() => void handleReindex(document)}
                          title="Re-index this document"
                          aria-label={`Re-index ${document.filename}`}
                        >
                          <RefreshIcon className="h-3.5 w-3.5" />
                        </button>
                        <button
                          className="btn-icon h-6 w-6 shrink-0"
                          onClick={() => void handleDeleteDocument(document)}
                          title="Remove from this collection"
                          aria-label={`Delete ${document.filename}`}
                        >
                          <TrashIcon className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>

                {/* -------------------------------------------------- search -- */}
                <div className="mt-4">
                  <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wide" style={{ color: 'var(--text-tertiary)' }}>
                    Search this collection
                  </p>
                  <div className="flex items-center gap-1.5">
                    <SearchIcon className="h-4 w-4 shrink-0" style={{ color: 'var(--text-tertiary)' }} />
                    <input
                      className="field min-w-0 flex-1"
                      value={query}
                      placeholder="What do these documents say about…"
                      onChange={(e) => setQuery(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void handleSearch()
                      }}
                    />
                  </div>

                  {/* No model is loaded for this — it is the same retrieval the
                      chat path uses, without generation, so it answers in
                      milliseconds. */}
                  {searching && (
                    <p className="mt-1.5 text-[11.5px]" style={{ color: 'var(--text-tertiary)' }}>
                      Searching…
                    </p>
                  )}
                  {results !== null && !searching && (
                    <div className="mt-2 flex flex-col gap-2">
                      {results.length === 0 ? (
                        <p className="text-[12px]" style={{ color: 'var(--text-tertiary)' }}>
                          Nothing matched.
                        </p>
                      ) : (
                        results.map((source, i) => (
                          <div key={`${source.chunkId}-${i}`} className="citation">
                            <div className="mb-1 flex items-center gap-1.5">
                              <span className="text-[11.5px] font-medium" style={{ color: 'var(--text-secondary)' }}>
                                {source.filename}
                              </span>
                              {source.pageNo != null && (
                                <span className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
                                  page {source.pageNo}
                                </span>
                              )}
                            </div>
                            <p className="text-[12.5px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
                              {source.text}
                            </p>
                          </div>
                        ))
                      )}
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
