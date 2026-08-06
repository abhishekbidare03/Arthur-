/**
 * Shared bits of the Office Open XML formats.
 *
 * `.docx`, `.xlsx` and `.pptx` are all ZIPs of XML, and all three need the same
 * two things: entity decoding and a way to pull text runs out without a full
 * parser. Kept here so a fix to entity handling lands once rather than three
 * times.
 *
 * No XML parser dependency, deliberately. These files are machine-generated
 * from a narrow schema, the elements that carry text are known by name, and a
 * regex scan over them has held up across real decks since Phase 4. A general
 * parser would be correct for XML Arthur will never see.
 */

const ENTITIES: Record<string, string> = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'",
}

export function decodeXmlEntities(xml: string): string {
  return xml
    .replace(/&(?:amp|lt|gt|quot|apos);/g, (m) => ENTITIES[m] ?? m)
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
}

/**
 * Collects the contents of every `<tag>` in a fragment, decoded.
 *
 * Runs within one paragraph are split by *formatting*, not meaning — a single
 * bolded word is its own run — so callers join them with no separator.
 */
export function textRuns(xml: string, tag: string): string[] {
  const pattern = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'g')
  const out: string[] = []
  for (const match of xml.matchAll(pattern)) out.push(decodeXmlEntities(match[1] ?? ''))
  return out
}

/**
 * Renders a table as tab-separated rows.
 *
 * The Phase 10 brief asks for tables as "structured text rather than flattened
 * into unreadable runs", and TSV is the structure that survives: it keeps rows
 * and columns aligned for the model, costs almost no tokens next to a markdown
 * grid of pipes and dashes, and does not tempt the renderer into drawing a
 * table out of something that was a layout grid.
 */
export function toTsv(rows: string[][]): string {
  return rows
    .filter((row) => row.some((cell) => cell.trim().length > 0))
    .map((row) => row.map((cell) => cell.replace(/\s+/g, ' ').trim()).join('\t'))
    .join('\n')
}
