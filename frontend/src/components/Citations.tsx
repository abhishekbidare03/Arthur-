import { useState } from 'react'
import type { Source } from '../types'
import { ChevronDownIcon, ChevronRightIcon, FileIcon } from './icons'

interface CitationsProps {
  sources: Source[]
}

/** One entry per file, in the order the files were first cited. */
function byFile(sources: Source[]): { filename: string; sources: Source[] }[] {
  const groups = new Map<string, Source[]>()
  for (const source of sources) {
    const list = groups.get(source.filename)
    if (list) list.push(source)
    else groups.set(source.filename, [source])
  }
  return [...groups].map(([filename, list]) => ({ filename, sources: list }))
}

/** `p. 4, 7-9` rather than a wall of numbers. */
function pageSummary(sources: Source[]): string {
  const pages = [...new Set(sources.map((s) => s.pageNo).filter((p): p is number => p != null))].sort(
    (a, b) => a - b,
  )
  if (pages.length === 0) return `${sources.length} passage${sources.length === 1 ? '' : 's'}`

  const ranges: string[] = []
  let start = pages[0]!
  let previous = start
  for (const page of pages.slice(1)) {
    if (page === previous + 1) {
      previous = page
      continue
    }
    ranges.push(start === previous ? `${start}` : `${start}–${previous}`)
    start = page
    previous = page
  }
  ranges.push(start === previous ? `${start}` : `${start}–${previous}`)

  return `p. ${ranges.join(', ')}`
}

/**
 * The passages an answer was actually given.
 *
 * Only appears when a file was too large to send whole and retrieval chose what
 * the model saw. That is exactly the case where an answer is least verifiable —
 * the model was shown a handful of passages out of fifty pages, and nothing on
 * screen otherwise says *which* handful.
 *
 * The passage text is shown in full rather than as a snippet with a link,
 * because there is nowhere to link *to*: the source document is a stored blob,
 * not a rendered page. Showing the text is the whole affordance, so it has to
 * be the real text.
 *
 * Collapsed by default. Most answers are read and accepted; the citation is for
 * the ones that are not.
 */
export default function Citations({ sources }: CitationsProps) {
  const [open, setOpen] = useState(false)
  if (sources.length === 0) return null

  const groups = byFile(sources)

  return (
    <div className="citations mt-2">
      <button
        className="meta-btn"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title="Show the passages this answer was given"
      >
        {open ? <ChevronDownIcon className="h-3 w-3" /> : <ChevronRightIcon className="h-3 w-3" />}
        {sources.length} source{sources.length === 1 ? '' : 's'}
        <span style={{ color: 'var(--text-tertiary)' }}>
          ·{' '}
          {groups
            .map((group) => `${group.filename} ${pageSummary(group.sources)}`)
            .join(' · ')}
        </span>
      </button>

      {open && (
        <div className="mt-1.5 flex flex-col gap-2">
          {sources.map((source, i) => (
            <div key={`${source.chunkId}-${i}`} className="citation">
              <div className="mb-1 flex items-center gap-1.5">
                <FileIcon className="h-3 w-3" style={{ color: 'var(--text-tertiary)' }} />
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
          ))}
        </div>
      )}
    </div>
  )
}
