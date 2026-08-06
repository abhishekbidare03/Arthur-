/**
 * Extractor tests.
 *
 * The PDF and PPTX are built here rather than committed as fixtures, so the
 * suite stays self-contained and the inputs are readable as source. Both are
 * genuine files — pdf.js and the zip reader parse them the same way they parse
 * anything else.
 *
 * Run:  npx tsx extractors.test.mts
 */

import { zipSync, strToU8 } from 'fflate'
import { extract, UnreadableFileError, UnsupportedFileError } from './src/documents/extractors/index.ts'

const failures: string[] = []
const check = (ok: boolean, message: string) => {
  if (!ok) failures.push(message)
}

/* -- A minimal but valid two-page PDF --------------------------------------- */

function buildPdf(pages: string[]): Buffer {
  const objects: string[] = []
  const kids = pages.map((_, i) => `${4 + i * 2} 0 R`).join(' ')

  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>'
  objects[2] = `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'

  pages.forEach((text, i) => {
    const pageNo = 4 + i * 2
    const streamNo = pageNo + 1
    // Tj draws a string; Td positions it. One line is all this needs to prove
    // that page boundaries and text both survive extraction.
    const stream = `BT /F1 24 Tf 72 700 Td (${text.replace(/([()\\])/g, '\\$1')}) Tj ET`
    objects[pageNo] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
      `/Resources << /Font << /F1 3 0 R >> >> /Contents ${streamNo} 0 R >>`
    objects[streamNo] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`
  })

  let pdf = '%PDF-1.4\n'
  const offsets: number[] = []
  for (let i = 1; i < objects.length; i++) {
    offsets[i] = pdf.length
    pdf += `${i} 0 obj\n${objects[i]}\nendobj\n`
  }

  const xrefAt = pdf.length
  pdf += `xref\n0 ${objects.length}\n0000000000 65535 f \n`
  for (let i = 1; i < objects.length; i++) {
    pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`
  }
  pdf += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`

  return Buffer.from(pdf, 'latin1')
}

const pdfBytes = buildPdf(['Rotation window is Thursday', 'Owned by the Platform team'])
const pdf = await extract(pdfBytes, 'runbook.pdf')

check(pdf.pages.length === 2, `PDF: expected 2 pages, got ${pdf.pages.length}`)
check(pdf.pages[0]?.no === 1 && pdf.pages[1]?.no === 2, 'PDF: page numbers are wrong')
check(
  pdf.pages[0]?.text.includes('Rotation window is Thursday') === true,
  `PDF: page 1 text missing — got ${JSON.stringify(pdf.pages[0]?.text)}`,
)
check(
  pdf.pages[1]?.text.includes('Platform team') === true,
  `PDF: page 2 text missing — got ${JSON.stringify(pdf.pages[1]?.text)}`,
)
check(pdf.meta.pageCount === 2, `PDF: meta.pageCount is ${String(pdf.meta.pageCount)}`)

/* -- A minimal but valid PPTX ----------------------------------------------- */

const slideXml = (lines: string[]) =>
  `<?xml version="1.0" encoding="UTF-8"?>` +
  `<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"` +
  ` xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree>` +
  lines.map((l) => `<p:sp><p:txBody><a:p><a:r><a:t>${l}</a:t></a:r></a:p></p:txBody></p:sp>`).join('') +
  `</p:spTree></p:cSld></p:sld>`

const pptxBytes = Buffer.from(
  zipSync({
    '[Content_Types].xml': strToU8('<?xml version="1.0"?><Types/>'),
    // Deliberately out of order: zip entries are not slide order, and sorting
    // by the filename number is what keeps slide 10 from landing after slide 1.
    'ppt/slides/slide2.xml': strToU8(slideXml(['Q2 Results', 'Revenue up 12%'])),
    'ppt/slides/slide1.xml': strToU8(slideXml(['Title Slide', 'Operating Review'])),
    'ppt/notesSlides/notesSlide1.xml': strToU8(slideXml(['Remember to thank the team'])),
  }),
)

const pptx = await extract(pptxBytes, 'review.pptx')

check(pptx.pages.length === 2, `PPTX: expected 2 slides, got ${pptx.pages.length}`)
check(
  pptx.pages[0]?.no === 1 && pptx.pages[0]?.text.includes('Title Slide'),
  `PPTX: slides not sorted by number — first is ${JSON.stringify(pptx.pages[0])}`,
)
check(pptx.text.includes('--- Slide 2 ---'), 'PPTX: slide markers missing from flattened text')
check(pptx.text.includes('Revenue up 12%'), 'PPTX: slide 2 body missing')
check(
  pptx.text.includes('[Speaker notes] Remember to thank the team'),
  'PPTX: speaker notes missing or unlabelled',
)
check(
  JSON.stringify(pptx.meta.slidesWithNotes) === '[1]',
  `PPTX: meta.slidesWithNotes is ${JSON.stringify(pptx.meta.slidesWithNotes)}`,
)

/* -- Refusals --------------------------------------------------------------- */

async function refusal(bytes: Buffer, name: string): Promise<Error | null> {
  try {
    await extract(bytes, name)
    return null
  } catch (e) {
    return e as Error
  }
}

const legacyPpt = await refusal(Buffer.from('\xD0\xCF\x11\xE0legacy', 'latin1'), 'deck.ppt')
check(legacyPpt instanceof UnsupportedFileError, 'legacy .ppt was not refused')
check(
  /re-save as \.pptx/i.test(legacyPpt?.message ?? ''),
  `legacy .ppt message should say what to do: ${legacyPpt?.message}`,
)

const notAZip = await refusal(Buffer.from('this is not a zip archive at all'), 'broken.pptx')
check(notAZip instanceof UnreadableFileError, 'a non-zip .pptx was not refused')

const notAPdf = await refusal(Buffer.from('nowhere near a PDF'), 'broken.pdf')
check(notAPdf instanceof UnreadableFileError, 'a non-PDF .pdf was not refused')

// A PDF with no text layer and no images either — neither extractable nor
// OCR-able. Before Phase 10 this said "OCR arrives in Phase 10"; now OCR does
// run, finds no image to read, and the message has to be honest about the fact
// that this particular file cannot be read at all rather than promising a
// feature that already exists.
const emptyPdf = await refusal(buildPdf(['']), 'scan.pdf')
check(emptyPdf instanceof UnreadableFileError, 'a text-free PDF was not refused')
check(
  /no readable text/i.test(emptyPdf?.message ?? '') && !/Phase 10/.test(emptyPdf?.message ?? ''),
  `a PDF with neither text nor images should say so plainly, not defer to a shipped phase: ${emptyPdf?.message}`,
)

// `.docx` was refused through Phase 9 with "arrives in Phase 8". It works now,
// so the assertion is inverted: the refusal path must NOT fire. Kept rather
// than deleted, because "a format quietly stopped working" is exactly the
// regression this file exists to catch.
const docxRefusal = await refusal(Buffer.from('x'), 'notes.docx')
check(
  !(docxRefusal instanceof UnsupportedFileError),
  '.docx is refused as unsupported again — the extractor is no longer registered',
)
check(
  docxRefusal instanceof UnreadableFileError,
  'a .docx that is not a zip should be refused as unreadable, naming the likely cause',
)
check(
  /zip archive/i.test(docxRefusal?.message ?? ''),
  `a corrupt .docx should say what it expected: ${docxRefusal?.message}`,
)

// Legacy binary formats are still refused, and still say to re-save rather
// than to wait — they are not a matter of scheduling.
const legacyDoc = await refusal(Buffer.from('x'), 'notes.doc')
check(legacyDoc instanceof UnsupportedFileError, 'legacy .doc was not refused')
check(
  /re-save/i.test(legacyDoc?.message ?? ''),
  `legacy .doc should say what to do: ${legacyDoc?.message}`,
)

/* -- Report ----------------------------------------------------------------- */

console.log('\n--- extracted -----------------------------------------------')
console.log(`PDF   ${pdf.pages.length} pages · ${pdf.text.length} chars`)
console.log(pdf.text.replace(/^/gm, '  | '))
console.log(`PPTX  ${pptx.pages.length} slides · ${pptx.text.length} chars`)
console.log(pptx.text.replace(/^/gm, '  | '))
console.log('-------------------------------------------------------------\n')

if (failures.length > 0) {
  console.error('FAIL')
  for (const f of failures) console.error('  - ' + f)
  process.exit(1)
}

console.log('PASS  pdf and pptx extract with page/slide numbers; refusals are specific')
process.exit(0)
