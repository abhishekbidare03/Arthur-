/**
 * Repairs the one markdown mistake small models make constantly: a fenced code
 * block opened inside a list item, whose body and closing fence are then written
 * at column 0.
 *
 *     - 08:00 - Gym time:
 *       ```bash
 *     echo "Getting ready"
 *     ```
 *
 * CommonMark is right to render that badly, and the result is spectacular. The
 * body is less indented than the list item requires, so it closes the item *and*
 * the code block — producing an empty code box. The script becomes an ordinary
 * paragraph (joined onto one line by lazy continuation), and the orphaned ```
 * then *opens* a fence that swallows everything up to the next one, so plain
 * prose renders as syntax-highlighted code and stray ``` markers show up inside
 * it. One malformed block corrupts the whole rest of the message.
 *
 * The fix is to indent the body and closing fence up to the opening fence, which
 * keeps the block inside the list item where the model meant to put it. Relative
 * indentation within the body is preserved, so code structure survives. Markdown
 * that is already well-formed is returned untouched.
 */

/** Matches a fence line, capturing indent, marker and info string. */
const FENCE = /^([ \t]*)(`{3,}|~{3,})(.*)$/

/** Leading spaces on a line, with tabs counted as one. Blank lines report -1 so
 *  they never drag the minimum down. */
function indentOf(line: string): number {
  if (line.trim().length === 0) return -1
  return line.length - line.trimStart().length
}

export function repairFences(markdown: string): string {
  // Cheap bail-out: no fences, nothing to do. Most messages take this path.
  if (!markdown.includes('```') && !markdown.includes('~~~')) return markdown

  const lines = markdown.split('\n')
  const out: string[] = []

  let i = 0
  while (i < lines.length) {
    const open = FENCE.exec(lines[i])
    if (!open) {
      out.push(lines[i])
      i++
      continue
    }

    const [, indent, marker] = open
    // A closing fence is the same character, at least as long, and carries no
    // info string.
    const closing = new RegExp(`^[ \\t]*${marker[0] === '`' ? '`' : '~'}{${marker.length},}[ \\t]*$`)

    const body: string[] = []
    let j = i + 1
    let closedAt = -1
    while (j < lines.length) {
      if (closing.test(lines[j])) {
        closedAt = j
        break
      }
      body.push(lines[j])
      j++
    }

    if (indent.length === 0) {
      // Opened at column 0: nothing to align to. Emit unchanged.
      out.push(lines[i], ...body)
      if (closedAt !== -1) out.push(lines[closedAt])
      i = closedAt === -1 ? j : closedAt + 1
      continue
    }

    const indents = body.map(indentOf).filter((n) => n >= 0)
    const minIndent = indents.length > 0 ? Math.min(...indents) : indent.length
    const deficit = indent.length - minIndent

    if (deficit <= 0) {
      // Body is already at or beyond the fence's indentation — well-formed.
      out.push(lines[i], ...body)
      if (closedAt !== -1) out.push(lines[closedAt])
    } else {
      const pad = ' '.repeat(deficit)
      out.push(lines[i], ...body.map((l) => (l.trim().length === 0 ? l : pad + l)))
      // An unclosed fence is normal mid-stream; no closer is invented for it,
      // since the block is still being written.
      if (closedAt !== -1) out.push(indent + lines[closedAt].trim())
    }

    i = closedAt === -1 ? j : closedAt + 1
  }

  return out.join('\n')
}
