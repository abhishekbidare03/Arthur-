/**
 * Phase 10 — the awkward inputs: Word, Excel, HTML, EPUB, and OCR.
 *
 * Every fixture is built in memory here, so there is nothing committed to go
 * stale and each file exercises the case it is named for.
 *
 * The failures worth guarding against in this phase are all *silent*:
 *
 *   * a table read as prose — the numbers survive, their columns do not, and
 *     the result looks like text while being unanswerable;
 *   * a spreadsheet whose empty cells are dropped, shifting every value left
 *     of a gap into the wrong column;
 *   * an HTML page whose `<script>` bodies survive tag-stripping as "prose";
 *   * an EPUB read in filename order, which puts chapter 10 before chapter 2;
 *   * a scan that OCRs to nothing and is reported as an empty document.
 *
 * Run:  npx tsx formats.test.mts
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import { zipSync, strToU8 } from 'fflate'

const failures: string[] = []
const check = (ok: boolean, message: string) => {
  if (!ok) failures.push(message)
}

const { extract } = await import('./src/documents/extractors/index.ts')
const { encodePng } = await import('./src/documents/png.ts')

/* -- Word -------------------------------------------------------------------- */

const docxXml = `<?xml version="1.0"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
  <w:p><w:r><w:t>Quarterly review</w:t></w:r></w:p>
  <w:p><w:r><w:t>Revenue </w:t></w:r><w:r><w:t>rose eight percent.</w:t></w:r></w:p>
  <w:tbl>
    <w:tr><w:tc><w:p><w:r><w:t>Region</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Revenue</w:t></w:r></w:p></w:tc></w:tr>
    <w:tr><w:tc><w:p><w:r><w:t>North</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>4,120</w:t></w:r></w:p></w:tc></w:tr>
    <w:tr><w:tc><w:p><w:r><w:t>South</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>3,880</w:t></w:r></w:p></w:tc></w:tr>
  </w:tbl>
  <w:p><w:r><w:t>Signed &amp; approved.</w:t></w:r></w:p>
</w:body></w:document>`

const docx = Buffer.from(zipSync({ 'word/document.xml': strToU8(docxXml) }))
const word = await extract(docx, 'review.docx')

check(word.text.includes('Quarterly review'), 'the Word heading did not survive')
check(
  word.text.includes('Revenue rose eight percent.'),
  `runs split by formatting were not rejoined: ${JSON.stringify(word.text.slice(0, 80))}`,
)
check(word.text.includes('Signed & approved.'), 'XML entities were not decoded')
check(
  word.text.includes('North\t4,120'),
  `the table was flattened instead of kept as columns: ${JSON.stringify(word.text)}`,
)
check(word.text.includes('[Table 1]'), 'the table is not labelled, so tabs read as prose')
check(word.meta.tables === 1, `expected 1 table in meta, got ${String(word.meta.tables)}`)
check(
  word.meta.paginated === false,
  'a .docx has no page boundaries in its XML and must not claim to be paginated',
)

/* -- Excel ------------------------------------------------------------------- */
// Row 3 deliberately has a gap: B3 is missing entirely, which is how Excel
// stores an empty cell. If cells are appended in document order rather than
// placed by their `r` reference, "9" lands in column B instead of column C.

const sheetXml = `<?xml version="1.0"?>
<worksheet><sheetData>
  <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row>
  <row r="2"><c r="A2" t="s"><v>3</v></c><c r="B2"><v>4120</v></c><c r="C2"><v>7</v></c></row>
  <row r="3"><c r="A3" t="s"><v>4</v></c><c r="C3"><v>9</v></c></row>
</sheetData></worksheet>`

const sharedXml = `<?xml version="1.0"?>
<sst><si><t>Region</t></si><si><t>Revenue</t></si><si><t>Headcount</t></si><si><t>North</t></si><si><t>South</t></si></sst>`

const workbookXml = `<?xml version="1.0"?>
<workbook><sheets><sheet name="Q2 Summary" sheetId="1" r:id="rId1"/></sheets></workbook>`

const xlsx = Buffer.from(
  zipSync({
    'xl/workbook.xml': strToU8(workbookXml),
    'xl/sharedStrings.xml': strToU8(sharedXml),
    'xl/worksheets/sheet1.xml': strToU8(sheetXml),
  }),
)
const excel = await extract(xlsx, 'numbers.xlsx')

check(
  excel.text.includes('[Sheet: Q2 Summary]'),
  `the sheet's own name was not used: ${JSON.stringify(excel.text.slice(0, 60))}`,
)
check(
  excel.text.includes('Region\tRevenue\tHeadcount'),
  `shared strings were not resolved — text cells would read as integers: ${JSON.stringify(excel.text)}`,
)
check(excel.text.includes('North\t4120\t7'), 'a full row did not survive as columns')
check(
  excel.text.includes('South\t\t9'),
  `an empty cell was dropped, shifting the row's values into the wrong columns: ${JSON.stringify(excel.text)}`,
)

/* -- HTML -------------------------------------------------------------------- */

const html = `<!doctype html><html><head><title>Runbook</title>
<style>.x{color:red}</style>
<script>const secret = "SCRIPTBODY"; console.log(secret);</script>
</head><body>
<h1>Rotation</h1>
<p>The window is <b>Thursday</b> at 03:00&nbsp;UTC.</p>
<table><tr><th>Env</th><th>Owner</th></tr><tr><td>staging</td><td>Platform</td></tr></table>
<script>const more = "ALSOSCRIPT";</script>
<p>Contact &amp; escalation follow.</p>
</body></html>`

const page = await extract(Buffer.from(html), 'runbook.html')

check(
  !page.text.includes('SCRIPTBODY') && !page.text.includes('ALSOSCRIPT'),
  `script bodies survived as prose: ${JSON.stringify(page.text)}`,
)
check(!page.text.includes('color:red'), 'stylesheet contents survived as prose')
check(page.text.includes('Runbook'), 'the page title was dropped')
check(
  page.text.includes('The window is Thursday at 03:00 UTC.'),
  `inline tags were not unwrapped cleanly: ${JSON.stringify(page.text)}`,
)
check(page.text.includes('staging\tPlatform'), `the HTML table was flattened: ${JSON.stringify(page.text)}`)
check(page.text.includes('Contact & escalation'), 'HTML entities were not decoded')
check(!/<[a-z]/i.test(page.text), `raw tags survived: ${JSON.stringify(page.text.slice(0, 120))}`)

/* -- EPUB -------------------------------------------------------------------- */
// The spine lists chapter 2 before chapter 10, while a filename sort would do
// the opposite. This is the assertion that catches a book read out of order.

const opf = `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>The Long Book</dc:title></metadata>
  <manifest>
    <item id="c2" href="text/ch2.xhtml" media-type="application/xhtml+xml"/>
    <item id="c10" href="text/ch10.xhtml" media-type="application/xhtml+xml"/>
    <item id="css" href="style.css" media-type="text/css"/>
  </manifest>
  <spine><itemref idref="c2"/><itemref idref="c10"/></spine>
</package>`

const epub = Buffer.from(
  zipSync({
    'META-INF/container.xml': strToU8(
      `<?xml version="1.0"?><container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>`,
    ),
    'OEBPS/content.opf': strToU8(opf),
    'OEBPS/text/ch2.xhtml': strToU8('<html><body><p>Chapter two begins here.</p></body></html>'),
    'OEBPS/text/ch10.xhtml': strToU8('<html><body><p>Chapter ten concludes.</p></body></html>'),
    'OEBPS/style.css': strToU8('body{margin:0}'),
  }),
)
const book = await extract(epub, 'book.epub')

check(book.meta.spineOrder === true, 'the spine was not read, so chapter order is a filename sort')
check(book.meta.chapters === 2, `expected 2 chapters, got ${String(book.meta.chapters)}`)
check(book.text.includes('The Long Book'), 'the book title was dropped')
check(
  book.text.indexOf('Chapter two') < book.text.indexOf('Chapter ten'),
  'chapters came out in filename order — chapter 10 before chapter 2',
)
check(!book.text.includes('margin:0'), 'the stylesheet was read as a chapter')

/* -- OCR --------------------------------------------------------------------- */
// A PDF whose only content is an image of text: exactly what a scanner
// produces, and what returned "no extractable text" before this phase.

function scannedPdf(png: { width: number; height: number; gray: Uint8Array }): Buffer {
  const image = deflateSync(Buffer.from(png.gray))
  const { width: W, height: H } = png

  const objects: string[] = []
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>'
  objects[2] = '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'
  objects[3] =
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] ` +
    `/Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>`
  const content = `q ${W} 0 0 ${H} 0 0 cm /Im0 Do Q`
  objects[4] = `<< /Length ${content.length} >>\nstream\n${content}\nendstream`
  objects[5] =
    `<< /Type /XObject /Subtype /Image /Width ${W} /Height ${H} /ColorSpace /DeviceGray ` +
    `/BitsPerComponent 8 /Filter /FlateDecode /Length ${image.length} >>\nstream\n@@IMG@@\nendstream`

  let pdf = '%PDF-1.4\n'
  const offsets: number[] = []
  for (let i = 1; i <= 5; i++) {
    offsets[i] = Buffer.byteLength(pdf, 'binary')
    pdf += `${i} 0 obj\n${objects[i]}\nendobj\n`
  }
  const startxref = Buffer.byteLength(pdf, 'binary')
  pdf += 'xref\n0 6\n0000000000 65535 f \n'
  for (let i = 1; i <= 5; i++) pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`
  pdf += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${startxref}\n%%EOF\n`

  const [before, after] = pdf.split('@@IMG@@')
  return Buffer.concat([
    Buffer.from(before!, 'binary'),
    image,
    Buffer.from(after!, 'binary'),
  ])
}

/**
 * Renders a sentence to a greyscale bitmap using a real font.
 *
 * A hand-drawn 5x7 bitmap font was tried first and rejected: tesseract read
 * "ROTATION" as "FOTHTION" — the R lost its leg, the A read as an H. That is a
 * fair verdict on the fixture rather than on the pipeline, because no scanner
 * produces aliased 5-pixel-wide glyphs. Rendering with an actual typeface, at
 * an actual size, with antialiasing, is what makes this a test of OCR rather
 * than a test of my drawing.
 *
 * System.Drawing via PowerShell, the same approach `tools/make-icon.ps1` uses
 * and the same pattern as `voice.test.mts` synthesizing real speech: let
 * Windows generate a realistic fixture rather than approximating one.
 */
function renderText(sentence: string): { width: number; height: number; gray: Uint8Array } {
  const scratch = mkdtempSync(join(tmpdir(), 'arthur-ocr-'))
  const output = join(scratch, 'page.raw')

  // Writes width, height (4-byte LE each) then one byte per pixel, so Node
  // needs no image decoder to read it back.
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$w = 900; $h = 200
$bmp = New-Object System.Drawing.Bitmap $w, $h
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.Clear([System.Drawing.Color]::White)
$g.TextRenderingHint = 'AntiAliasGridFit'
$font = New-Object System.Drawing.Font('Arial', 36, [System.Drawing.FontStyle]::Regular)
$g.DrawString('${sentence.replace(/'/g, "''")}', $font, [System.Drawing.Brushes]::Black, 30, 60)
$g.Dispose()
$out = New-Object System.IO.MemoryStream
$bw = New-Object System.IO.BinaryWriter $out
$bw.Write([UInt32]$w); $bw.Write([UInt32]$h)
for ($y = 0; $y -lt $h; $y++) {
  for ($x = 0; $x -lt $w; $x++) {
    $c = $bmp.GetPixel($x, $y)
    $bw.Write([Byte]([Math]::Round(0.299 * $c.R + 0.587 * $c.G + 0.114 * $c.B)))
  }
}
$bw.Flush()
[System.IO.File]::WriteAllBytes('${output.replace(/\\/g, '\\\\')}', $out.ToArray())
$bmp.Dispose()
`
  execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    stdio: 'pipe',
  })

  const raw = readFileSync(output)
  rmSync(scratch, { recursive: true, force: true })

  const width = raw.readUInt32LE(0)
  const height = raw.readUInt32LE(4)
  return { width, height, gray: new Uint8Array(raw.subarray(8, 8 + width * height)) }
}

const PHRASE = 'Rotation window Thursday'
const drawn = renderText(PHRASE)
const scan = scannedPdf(drawn)

// The PNG encoder is what carries that image to tesseract, so it is checked
// on its own too — a malformed PNG would fail as "OCR found nothing".
const png = encodePng(drawn.gray, drawn.width, drawn.height, 'gray')
check(
  png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'the PNG encoder produced a file without a PNG signature',
)
check(png.subarray(12, 16).toString('ascii') === 'IHDR', 'the first PNG chunk is not IHDR')
check(png.subarray(-8, -4).toString('ascii') === 'IEND', 'the PNG has no IEND chunk')

console.log(`OCR fixture: ${drawn.width}x${drawn.height} scan, ${scan.length} byte PDF`)

const progress: { page: number; total: number }[] = []
let scanned
try {
  scanned = await extract(scan, 'scan.pdf', (p) => progress.push(p))
} catch (error) {
  failures.push(
    `a scanned PDF still cannot be read — OCR did not run or found nothing: ${String(error).slice(0, 200)}`,
  )
}

if (scanned) {
  // Word-by-word rather than an exact match. OCR of a rendered page is very
  // good but not perfect, and asserting on the exact string would make this
  // test fail on a font-rendering difference rather than on a real regression.
  const read = scanned.text.toLowerCase()
  const missed = PHRASE.toLowerCase()
    .split(' ')
    .filter((word) => !read.includes(word))
  check(
    missed.length === 0,
    `OCR ran but missed ${JSON.stringify(missed)} — it read: ${JSON.stringify(scanned.text.slice(0, 120))}`,
  )
  check(scanned.meta.ocrPages === 1, `expected 1 OCR'd page, got ${String(scanned.meta.ocrPages)}`)
  check(
    progress.length > 0 && progress[0]!.total === 1,
    'no progress was reported, so a multi-minute scan would look like a hang',
  )
  console.log(`OCR read: ${JSON.stringify(scanned.text.trim().slice(0, 60))}`)
}

const { releaseOcr } = await import('./src/documents/ocr.ts')
await releaseOcr()

if (failures.length > 0) {
  console.error('FAIL')
  for (const f of failures) console.error('  - ' + f)
  process.exit(1)
}

console.log(
  '\nPASS  tables keep their columns, scripts stay out of prose, EPUB reads in spine order, scans OCR',
)
process.exit(0)
