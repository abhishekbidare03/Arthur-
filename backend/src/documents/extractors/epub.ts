/**
 * EPUB extraction.
 *
 * An EPUB is a ZIP of XHTML, so this is `fflate` plus the HTML extractor — no
 * new dependency, and every fix to entity handling or table extraction applies
 * to books for free.
 *
 * The part worth doing properly is **reading order**. Zip entries come back in
 * archive order, and chapter files are commonly named `ch10.xhtml`,
 * `ch2.xhtml`, `part_01.html`, or opaque ids like `id_9723.xhtml` — sorting the
 * filenames gives chapter 10 before chapter 2, or no order at all. The book
 * states its own order in the OPF spine, which is what this follows. Getting it
 * wrong would not fail loudly; it would just answer questions about a book
 * whose chapters are shuffled.
 *
 * One spine item is one page, so a citation names a chapter.
 */

import { unzipSync, strFromU8 } from 'fflate'
import { decodeXmlEntities } from './ooxml.ts'
import { htmlToText } from './html.ts'
import { UnreadableFileError, type Extracted, type ExtractedPage, type Extractor } from './types.ts'

/** `META-INF/container.xml` points at the OPF; its location is not fixed. */
function opfPath(files: Record<string, Uint8Array>): string | undefined {
  const container = files['META-INF/container.xml']
  if (!container) return undefined
  return /full-path="([^"]+)"/.exec(strFromU8(container))?.[1]
}

/** Resolves a manifest href against the OPF's own directory. */
function resolve(opf: string, href: string): string {
  const directory = opf.includes('/') ? opf.slice(0, opf.lastIndexOf('/') + 1) : ''
  const joined = `${directory}${href}`
  // EPUBs do use `../` in hrefs; normalising by hand avoids pulling in `path`
  // semantics that differ on Windows.
  const parts: string[] = []
  for (const segment of joined.split('/')) {
    if (segment === '.' || segment === '') continue
    if (segment === '..') parts.pop()
    else parts.push(segment)
  }
  return parts.join('/')
}

/** Spine order: the manifest maps id → href, the spine lists ids in order. */
function readingOrder(opfXml: string, opf: string): string[] {
  const manifest = new Map<string, string>()
  for (const item of opfXml.matchAll(/<item\s[^>]*>/g)) {
    const id = /id="([^"]*)"/.exec(item[0])?.[1]
    const href = /href="([^"]*)"/.exec(item[0])?.[1]
    const type = /media-type="([^"]*)"/.exec(item[0])?.[1] ?? ''
    // Images and stylesheets are in the manifest too.
    if (id && href && /xhtml|html/.test(type)) manifest.set(id, decodeXmlEntities(href))
  }

  const order: string[] = []
  for (const ref of opfXml.matchAll(/<itemref\s[^>]*>/g)) {
    // `linear="no"` marks front matter a reader may skip — covers, adverts.
    // Kept anyway: a copyright page is cheap, and dropping content because a
    // publisher tagged it is a judgement this has no business making.
    const idref = /idref="([^"]*)"/.exec(ref[0])?.[1]
    const href = idref ? manifest.get(idref) : undefined
    if (href) order.push(resolve(opf, href))
  }
  return order
}

export const epubExtractor: Extractor = {
  extensions: ['.epub'],

  extract(bytes: Buffer, filename: string): Promise<Extracted> {
    let files: Record<string, Uint8Array>
    try {
      files = unzipSync(new Uint8Array(bytes))
    } catch (error) {
      throw new UnreadableFileError(
        `${filename} could not be opened. An .epub is a zip archive — this one may be corrupt, or DRM-protected.`,
        { cause: error },
      )
    }

    const opf = opfPath(files)
    const opfXml = opf && files[opf] ? strFromU8(files[opf]!) : undefined

    // Falls back to whatever XHTML is in the archive, sorted, when the spine is
    // unreadable. Wrong order beats no book — and it is reported in `meta`
    // rather than passed off as the author's ordering.
    let order = opfXml && opf ? readingOrder(opfXml, opf) : []
    const spineFound = order.length > 0
    if (!spineFound) {
      order = Object.keys(files)
        .filter((p) => /\.x?html?$/i.test(p))
        .sort()
    }

    const title = opfXml
      ? decodeXmlEntities(/<dc:title[^>]*>([\s\S]*?)<\/dc:title>/.exec(opfXml)?.[1] ?? '').trim()
      : ''

    const pages: ExtractedPage[] = []
    for (const path of order) {
      const raw = files[path]
      if (!raw) continue
      const { text } = htmlToText(strFromU8(raw))
      if (text.trim().length === 0) continue
      pages.push({ no: pages.length + 1, text })
    }

    if (pages.length === 0) {
      throw new UnreadableFileError(
        `${filename} has no readable chapters — it may be DRM-protected, or a picture book with no text layer.`,
      )
    }

    const text = pages.map((p) => `--- Chapter ${p.no} ---\n${p.text}`).join('\n\n')

    return Promise.resolve({
      text: title ? `${title}\n\n${text}` : text,
      pages,
      meta: {
        title: title || undefined,
        chapters: pages.length,
        // Recorded because it changes how much the chapter numbers can be
        // trusted, and a citation that says "chapter 4" should not be quietly
        // built on a filename sort.
        spineOrder: spineFound,
      },
    })
  },
}
