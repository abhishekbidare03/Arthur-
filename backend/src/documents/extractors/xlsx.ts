/**
 * Excel extraction.
 *
 * A spreadsheet is the format where "flattened into unreadable runs" does the
 * most damage: cell values carry meaning only in relation to their row and
 * column, and a sheet read as a stream of words is worse than useless — it
 * looks like data while being unanswerable.
 *
 * So each sheet comes out as TSV with its real grid preserved, including
 * **empty cells**, which are what keep column 4 in column 4. Getting that right
 * means resolving each cell's `r` reference (`D7`) rather than trusting the
 * order cells appear in: Excel omits empty cells from the XML entirely.
 *
 * One sheet is one page, so a citation can say which sheet a number came from.
 */

import { unzipSync, strFromU8 } from 'fflate'
import { decodeXmlEntities, toTsv } from './ooxml.ts'
import { UnreadableFileError, type Extracted, type ExtractedPage, type Extractor } from './types.ts'

/** `A`, `AB`, `ZZ` → 0-based column index. */
function columnIndex(reference: string): number {
  const letters = /^([A-Z]+)/.exec(reference)?.[1] ?? 'A'
  let index = 0
  for (const character of letters) index = index * 26 + (character.charCodeAt(0) - 64)
  return index - 1
}

/**
 * The shared string table.
 *
 * Excel stores most text once here and refers to it by index from the cells, so
 * without this a sheet of text reads as a grid of integers.
 */
function sharedStrings(files: Record<string, Uint8Array>): string[] {
  const raw = files['xl/sharedStrings.xml']
  if (!raw) return []

  const xml = strFromU8(raw)
  const out: string[] = []
  for (const item of xml.matchAll(/<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g)) {
    // A string can be split across several `<t>` runs by formatting; they are
    // one value and are joined without a separator.
    const runs = [...(item[1] ?? '').matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)]
    out.push(decodeXmlEntities(runs.map((r) => r[1] ?? '').join('')))
  }
  return out
}

/** Sheet display names, in workbook order, so a page can be named not numbered. */
function sheetNames(files: Record<string, Uint8Array>): string[] {
  const raw = files['xl/workbook.xml']
  if (!raw) return []
  const xml = strFromU8(raw)
  return [...xml.matchAll(/<sheet\s[^>]*name="([^"]*)"/g)].map((m) =>
    decodeXmlEntities(m[1] ?? ''),
  )
}

function sheetRows(xml: string, strings: string[]): string[][] {
  const rows: string[][] = []

  for (const row of xml.matchAll(/<row(?:\s[^>]*)?>[\s\S]*?<\/row>|<row[^>]*\/>/g)) {
    const cells: string[] = []

    for (const cell of row[0].matchAll(/<c\s([^>]*?)\/>|<c\s([^>]*?)>([\s\S]*?)<\/c>/g)) {
      const attributes = cell[1] ?? cell[2] ?? ''
      const body = cell[3] ?? ''
      const reference = /r="([A-Z]+\d+)"/.exec(attributes)?.[1]
      const type = /t="([^"]*)"/.exec(attributes)?.[1]

      let value = ''
      if (type === 'inlineStr') {
        const runs = [...body.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)]
        value = decodeXmlEntities(runs.map((r) => r[1] ?? '').join(''))
      } else {
        const raw = decodeXmlEntities(/<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? '')
        // `t="s"` means the value is an index into the shared string table, not
        // a number. Without this branch every text cell reads as an integer.
        value = type === 's' ? (strings[Number(raw)] ?? '') : raw
      }

      // Placed by its reference, not by its position in the XML. Excel omits
      // empty cells entirely, so appending in order silently shifts every
      // value left of a gap into the wrong column.
      const index = reference ? columnIndex(reference) : cells.length
      while (cells.length < index) cells.push('')
      cells[index] = value
    }

    rows.push(cells)
  }

  return rows
}

export const xlsxExtractor: Extractor = {
  extensions: ['.xlsx', '.xlsm'],

  extract(bytes: Buffer, filename: string): Promise<Extracted> {
    let files: Record<string, Uint8Array>
    try {
      files = unzipSync(new Uint8Array(bytes))
    } catch (error) {
      throw new UnreadableFileError(
        `${filename} could not be opened. An .xlsx is a zip archive — this one may be corrupt, or it may be a legacy .xls renamed.`,
        { cause: error },
      )
    }

    const strings = sharedStrings(files)
    const names = sheetNames(files)

    const sheetPaths = Object.keys(files)
      .filter((path) => /^xl\/worksheets\/sheet\d+\.xml$/.test(path))
      .sort((a, b) => {
        const n = (p: string) => Number(/sheet(\d+)\.xml$/.exec(p)?.[1] ?? 0)
        return n(a) - n(b)
      })

    if (sheetPaths.length === 0) {
      throw new UnreadableFileError(
        `${filename} contains no worksheets, so it is not an Excel workbook.`,
      )
    }

    const pages: ExtractedPage[] = []
    sheetPaths.forEach((path, i) => {
      const tsv = toTsv(sheetRows(strFromU8(files[path]!), strings))
      // The sheet's own name, not "Sheet 3" — "which tab was that on?" is
      // answered by the name people actually see in Excel.
      const name = names[i] ?? `Sheet${i + 1}`
      pages.push({ no: i + 1, text: tsv.length > 0 ? `[Sheet: ${name}]\n${tsv}` : '' })
    })

    const text = pages
      .filter((p) => p.text.trim().length > 0)
      .map((p) => p.text)
      .join('\n\n')

    if (text.trim().length === 0) {
      throw new UnreadableFileError(
        `${filename} has ${pages.length} sheet${pages.length === 1 ? '' : 's'} but every cell is empty.`,
      )
    }

    return Promise.resolve({
      text,
      pages,
      meta: {
        sheetCount: pages.length,
        sheetNames: names.length > 0 ? names : sheetPaths.map((_, i) => `Sheet${i + 1}`),
        // Cells hold cached *values*, which is what a reader wants. Formulas
        // are in the file but are not extracted, and saying so beats leaving
        // someone to wonder why "=SUM(B2:B9)" never appears.
        formulasIncluded: false,
      },
    })
  },
}
