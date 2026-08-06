/**
 * Folder ingest — point Arthur at a directory and index what it can read.
 *
 * Reading a local directory is the feature, not a hole: the backend binds to
 * 127.0.0.1 only, serves one person on their own machine, and the path comes
 * from that person typing it. There is nothing here they could not read by
 * opening the folder. The guards below exist to stop an *accident* — walking
 * into `node_modules` and embedding 40,000 files — not an attacker.
 *
 * Re-scanning is cheap by construction. Documents are content-addressed, so a
 * file whose bytes have not changed is recognised by hash and skipped without
 * re-extracting or re-embedding it; only genuinely new or edited files cost
 * anything.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join } from 'node:path'
import { MAX_UPLOAD_BYTES } from '../config.ts'
import { assignDocument, findInCollectionByHash } from '../db/collections.ts'
import { UnreadableFileError, UnsupportedFileError } from '../documents/extractors/index.ts'
import { storeUpload } from '../documents/store.ts'
import { ingestDocument } from './ingest.ts'

/**
 * Directories never worth walking into.
 *
 * Not a security boundary — a whitelist would be — but the difference between
 * ingesting a project's documentation and ingesting its dependency tree. Every
 * name here is a directory whose contents are generated, vendored, or private
 * to a tool.
 */
const SKIP_DIRECTORIES = new Set([
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  'dist',
  'build',
  'out',
  'target',
  '.next',
  '.venv',
  'venv',
  '__pycache__',
  '.cache',
  '.idea',
  '.vscode',
  'coverage',
  'vendor',
])

/** How deep to walk. Deep enough for a real documents folder, shallow enough
 *  that a symlink loop or a stray drive root cannot run away. */
const MAX_DEPTH = 8

/** Above this, stop and report rather than silently ingesting for an hour. */
const MAX_FILES = 500

export interface FolderIngestProgress {
  stage: 'scanning' | 'file' | 'done'
  /** Files examined so far. */
  seen?: number
  /** The file currently being read. */
  filename?: string
  added?: number
  skipped?: number
  failed?: number
  total?: number
}

export interface FolderIngestResult {
  added: number
  /** Already in this collection with identical bytes — the re-scan case. */
  unchanged: number
  /** A type Arthur cannot read. Counted, not an error: a documents folder
   *  normally contains images and archives too, and refusing the whole folder
   *  because of them would make the feature useless. */
  skipped: number
  failed: { filename: string; reason: string }[]
  /** True when `MAX_FILES` cut the walk short, so the caller can say so. */
  truncated: boolean
}

/**
 * Extensions not worth opening.
 *
 * Cosmetic, not authoritative — the extractor registry still decides what can
 * actually be read. This exists so a folder of holiday photos does not consume
 * the 500-file budget on files that were never going to be ingested, and does
 * not report 400 identical refusals.
 */
function isProbablyIngestible(name: string): boolean {
  const binary = new Set([
    '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.ico', '.svgz',
    '.mp3', '.mp4', '.wav', '.avi', '.mov', '.mkv', '.flac',
    '.zip', '.gz', '.tar', '.7z', '.rar', '.iso', '.dmg',
    '.exe', '.dll', '.so', '.dylib', '.bin', '.o', '.obj',
    '.ttf', '.otf', '.woff', '.woff2', '.eot',
  ])
  return !binary.has(extname(name).toLowerCase())
}

function walk(root: string): string[] {
  const files: string[] = []

  const visit = (directory: string, depth: number) => {
    if (depth > MAX_DEPTH || files.length >= MAX_FILES) return

    let entries
    try {
      entries = readdirSync(directory, { withFileTypes: true })
    } catch {
      // Permission denied, or it vanished mid-walk. One unreadable directory
      // must not abort the whole scan.
      return
    }

    for (const entry of entries) {
      if (files.length >= MAX_FILES) return
      if (entry.name.startsWith('.') && entry.isDirectory()) continue

      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        if (SKIP_DIRECTORIES.has(entry.name)) continue
        // `isDirectory()` is false for a symlink, so this never follows one —
        // which is what keeps a loop from being possible at all.
        visit(path, depth + 1)
      } else if (entry.isFile() && isProbablyIngestible(entry.name)) {
        files.push(path)
      }
    }
  }

  visit(root, 0)
  return files
}

export async function ingestFolder(
  root: string,
  collectionId: string,
  onProgress?: (progress: FolderIngestProgress) => void,
): Promise<FolderIngestResult> {
  const stats = statSync(root)
  if (!stats.isDirectory()) throw new Error(`${root} is not a folder.`)

  onProgress?.({ stage: 'scanning' })
  const files = walk(root)
  const truncated = files.length >= MAX_FILES

  const result: FolderIngestResult = {
    added: 0,
    unchanged: 0,
    skipped: 0,
    failed: [],
    truncated,
  }

  for (const [index, path] of files.entries()) {
    const filename = path.slice(root.length + 1) || path
    onProgress?.({
      stage: 'file',
      filename,
      seen: index + 1,
      total: files.length,
      added: result.added,
      skipped: result.skipped + result.unchanged,
      failed: result.failed.length,
    })

    try {
      const size = statSync(path).size
      if (size === 0 || size > MAX_UPLOAD_BYTES) {
        result.skipped++
        continue
      }

      const bytes = readFileSync(path)

      // Hash-first: a re-scan of a mostly-unchanged folder should cost one read
      // per file and nothing else. Checked against *this collection* rather
      // than globally, so the same file can legitimately live in two
      // collections without one shadowing the other.
      const { createHash } = await import('node:crypto')
      const sha256 = createHash('sha256').update(bytes).digest('hex')
      if (findInCollectionByHash(collectionId, sha256)) {
        result.unchanged++
        continue
      }

      const { row, pages } = await storeUpload({
        // The path relative to the root, not just the basename: two files
        // called `README.md` in different subfolders are different documents,
        // and a citation naming only `README.md` would be useless.
        filename,
        bytes,
        // Never adopt a row a conversation already owns — see `reuseExisting`.
        // The `findInCollectionByHash` check above is what keeps a re-scan
        // cheap; this only governs collisions across *different* owners.
        reuseExisting: false,
      })
      assignDocument(row.id, collectionId)

      try {
        await ingestDocument(row, pages)
        result.added++
      } catch (error) {
        result.failed.push({
          filename,
          reason: error instanceof Error ? error.message : String(error),
        })
      }
    } catch (error) {
      // An unreadable or unsupported file in a folder of hundreds is expected,
      // not exceptional. Counted rather than thrown.
      if (error instanceof UnsupportedFileError) {
        result.skipped++
        continue
      }
      if (error instanceof UnreadableFileError) {
        result.skipped++
        continue
      }
      result.failed.push({
        filename,
        reason: error instanceof Error ? error.message : String(error),
      })
    }
  }

  onProgress?.({
    stage: 'done',
    seen: files.length,
    total: files.length,
    added: result.added,
    skipped: result.skipped + result.unchanged,
    failed: result.failed.length,
  })

  return result
}
