/**
 * Plain-text extraction — the only extractor in Phase 4.
 *
 * Covers source code, notes, config and data files: anything whose bytes are
 * already the text. Phase 8's parsers do real work; this one mostly decodes and
 * refuses convincingly-named binaries.
 */

import { UnreadableFileError, type Extracted, type Extractor } from './types.ts'

/**
 * Extensions treated as text.
 *
 * Deliberately a list rather than "anything that decodes as UTF-8": a `.png`
 * occasionally survives a lossy decode and would attach as mojibake, which is
 * worse than an honest refusal.
 */
const EXTENSIONS = [
  // Prose and notes
  '.txt', '.md', '.markdown', '.rst', '.log',
  // Data and config
  '.json', '.jsonl', '.csv', '.tsv', '.yaml', '.yml', '.toml', '.ini', '.env', '.xml',
  // Web
  '.html', '.htm', '.css', '.scss', '.less', '.svg',
  // Source
  '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.py', '.rb', '.go', '.rs',
  '.java', '.kt', '.c', '.h', '.cpp', '.hpp', '.cs', '.php', '.swift', '.lua',
  '.sh', '.bash', '.zsh', '.ps1', '.bat', '.sql', '.r', '.pl', '.dart', '.scala',
  // Build and tooling
  '.gitignore', '.dockerfile', '.editorconfig', '.gradle', '.cmake',
] as const

/** UTF-8 byte-order mark, which would otherwise show as a stray glyph. */
const BOM = '﻿'

/**
 * Rejects binaries wearing a text extension.
 *
 * A NUL byte in the first few KB is the standard heuristic and the one `git`
 * itself uses — real text files essentially never contain one, and every common
 * binary format does within its header.
 */
function looksBinary(bytes: Buffer): boolean {
  const window = bytes.subarray(0, 8_192)
  return window.includes(0)
}

export const textExtractor: Extractor = {
  extensions: EXTENSIONS,

  extract(bytes: Buffer, filename: string): Promise<Extracted> {
    if (looksBinary(bytes)) {
      throw new UnreadableFileError(
        `${filename} looks like a binary file rather than text, so its contents cannot be read.`,
      )
    }

    // Normalise line endings so token estimates, truncation offsets and the
    // model's view of the file are all consistent regardless of where the file
    // was written.
    let text = bytes.toString('utf8').replace(/\r\n?/g, '\n')
    if (text.startsWith(BOM)) text = text.slice(1)

    return Promise.resolve({
      text,
      // No pagination in a text file. Phase 8's PDF extractor is where this
      // array becomes interesting.
      pages: [{ no: 1, text }],
      meta: {
        lineCount: text.length === 0 ? 0 : text.split('\n').length,
        charCount: text.length,
      },
    })
  },
}
