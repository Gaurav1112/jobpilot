import { crc32, inflateRawSync } from 'node:zlib';
import { AlignmentType, Document, LevelFormat, Packer, Paragraph, TextRun } from 'docx';
import { BULLET, type Block, type DocModel } from './model.js';

/**
 * DOCX rendering with `docx` (Task 10). Trusted render library: agent code may call it (G-CONTAINMENT allow-list), it
 * touches no file, network or clock, and it returns bytes.
 *
 * Layout: paragraphs only (no table, text box, image, column, header or footer), contact details in the body, Arial
 * 10.5 pt, bold name and headings, bullets through a numbering definition whose level text is a literal "•".
 *
 * Determinism (identical model → identical bytes). `docx` stamps `docProps/core.xml` with now, and JSZip dates every
 * entry with now, so the package is rebuilt: every entry is read back, `dcterms:created` and `dcterms:modified` are
 * set to the plan's firstSeen at 00:00 UTC, and the zip is written again with entries in their original order, stored
 * (no compression, so no dependence on the zlib build) and dated 1980-01-01 00:00 (the DOS epoch).
 */

const ARIAL = 'Arial';
const HALF_POINTS = { body: 21, name: 32, heading: 22 } as const;
const BULLETS_REF = 'jobpilot-bullets';
/** A4 in twips, and 54 pt (1080 twips) margins, matching the PDF. */
const A4 = { width: 11906, height: 16838, margin: 1080 } as const;

function paragraphOf(b: Block): Paragraph {
  const run = (bold: boolean, size: number = HALF_POINTS.body) => new TextRun({ text: b.text, bold, size, font: ARIAL });
  switch (b.kind) {
    case 'name':
      return new Paragraph({ children: [run(true, HALF_POINTS.name)], spacing: { after: 40 } });
    case 'contact':
      return new Paragraph({ children: [run(false)], spacing: { after: 160 } });
    case 'heading':
      return new Paragraph({ children: [run(true, HALF_POINTS.heading)], spacing: { before: 160, after: 40 } });
    case 'title':
      return new Paragraph({ children: [run(true)], spacing: { before: 80 } });
    case 'meta':
      return new Paragraph({ children: [run(false)], spacing: { after: 40 } });
    case 'para':
    case 'line':
      return new Paragraph({ children: [run(false)], spacing: { after: 120 } });
    case 'bullet':
      return new Paragraph({ children: [run(false)], numbering: { reference: BULLETS_REF, level: 0 }, spacing: { after: 30 } });
  }
}

/** The DOCX package of a model, before the deterministic rebuild. */
function documentOf(m: DocModel): Document {
  return new Document({
    creator: 'jobpilot',
    lastModifiedBy: 'jobpilot',
    title: m.title,
    revision: 1,
    styles: { default: { document: { run: { font: ARIAL, size: HALF_POINTS.body } } } },
    numbering: {
      config: [
        {
          reference: BULLETS_REF,
          levels: [
            {
              level: 0,
              format: LevelFormat.BULLET,
              text: BULLET,
              alignment: AlignmentType.LEFT,
              style: { paragraph: { indent: { left: 360, hanging: 240 } }, run: { font: ARIAL } },
            },
          ],
        },
      ],
    },
    sections: [
      {
        properties: { page: { size: { width: A4.width, height: A4.height }, margin: { top: A4.margin, bottom: A4.margin, left: A4.margin, right: A4.margin } } },
        children: m.blocks.map(paragraphOf),
      },
    ],
  });
}

export async function renderDocx(m: DocModel): Promise<Uint8Array> {
  const packed = new Uint8Array(await Packer.toBuffer(documentOf(m)));
  const stamp = `${m.date}T00:00:00Z`;
  const entries = readZip(packed).map((e) => {
    if (e.name !== 'docProps/core.xml') return e;
    const xml = new TextDecoder().decode(e.data)
      .replace(/(<dcterms:created\b[^>]*>)[^<]*(<\/dcterms:created>)/, `$1${stamp}$2`)
      .replace(/(<dcterms:modified\b[^>]*>)[^<]*(<\/dcterms:modified>)/, `$1${stamp}$2`);
    return { name: e.name, data: new TextEncoder().encode(xml) };
  });
  return writeZip(entries);
}

// ---- zip (just enough for a DOCX package) ----

export interface ZipEntry {
  readonly name: string;
  readonly data: Uint8Array;
}

const u16 = (b: Uint8Array, at: number): number => (b[at] as number) | ((b[at + 1] as number) << 8);
const u32 = (b: Uint8Array, at: number): number => (u16(b, at) | (u16(b, at + 2) << 16)) >>> 0;

/** Every entry of a zip, in central-directory order. Supports stored and deflated entries, which is all a DOCX uses. */
export function readZip(zip: Uint8Array): ZipEntry[] {
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 65_535); i--) {
    if (u32(zip, i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a zip file: no end of central directory');
  const count = u16(zip, eocd + 10);
  let at = u32(zip, eocd + 16);
  const out: ZipEntry[] = [];
  for (let n = 0; n < count; n++) {
    if (u32(zip, at) !== 0x02014b50) throw new Error('corrupt zip: bad central directory entry');
    const method = u16(zip, at + 10);
    const compSize = u32(zip, at + 20);
    const nameLen = u16(zip, at + 28);
    const extraLen = u16(zip, at + 30);
    const commentLen = u16(zip, at + 32);
    const local = u32(zip, at + 42);
    const name = new TextDecoder().decode(zip.subarray(at + 46, at + 46 + nameLen));
    if (u32(zip, local) !== 0x04034b50) throw new Error('corrupt zip: bad local header');
    const dataAt = local + 30 + u16(zip, local + 26) + u16(zip, local + 28);
    const raw = zip.subarray(dataAt, dataAt + compSize);
    let data: Uint8Array;
    if (method === 0) data = new Uint8Array(raw);
    else if (method === 8) data = new Uint8Array(inflateRawSync(raw));
    else throw new Error(`unsupported zip compression method ${method} for ${name}`);
    out.push({ name, data });
    at += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** A stored (uncompressed) zip of `entries`, in order, every entry dated 1980-01-01 00:00, UTF-8 names. */
export function writeZip(entries: readonly ZipEntry[]): Uint8Array {
  const DOS_TIME = 0;
  const DOS_DATE = (0 << 9) | (1 << 5) | 1; // 1980-01-01
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = enc.encode(e.name);
    const crc = crc32(e.data) >>> 0;
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true);
    local.setUint16(8, 0, true);
    local.setUint16(10, DOS_TIME, true);
    local.setUint16(12, DOS_DATE, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, e.data.byteLength, true);
    local.setUint32(22, e.data.byteLength, true);
    local.setUint16(26, name.byteLength, true);
    local.setUint16(28, 0, true);
    parts.push(new Uint8Array(local.buffer), name, e.data);
    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(4, 20, true);
    cd.setUint16(6, 20, true);
    cd.setUint16(8, 0x0800, true);
    cd.setUint16(10, 0, true);
    cd.setUint16(12, DOS_TIME, true);
    cd.setUint16(14, DOS_DATE, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, e.data.byteLength, true);
    cd.setUint32(24, e.data.byteLength, true);
    cd.setUint16(28, name.byteLength, true);
    cd.setUint32(42, offset, true);
    central.push(new Uint8Array(cd.buffer), name);
    offset += 30 + name.byteLength + e.data.byteLength;
  }
  const cdSize = central.reduce((n, p) => n + p.byteLength, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);
  const all = [...parts, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((n, p) => n + p.byteLength, 0));
  let at = 0;
  for (const p of all) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

// ---- text extraction (qa-gate and the renderer's self-check) ----

const XML_ENTITIES: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decodeXml = (s: string): string =>
  s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_m, e: string) =>
    e.startsWith('#x') ? String.fromCodePoint(Number.parseInt(e.slice(2), 16)) : e.startsWith('#') ? String.fromCodePoint(Number(e.slice(1))) : (XML_ENTITIES[e] as string),
  );

/**
 * The text of `word/document.xml`, one line per non-empty paragraph: the paragraph's `w:t` runs concatenated (a tab
 * or line break is a space), prefixed with "• " when the paragraph is numbered (a bullet). Same shape as
 * `modelText`, so the two compare after `normText`.
 */
export function docxText(docx: Uint8Array): string {
  const doc = readZip(docx).find((e) => e.name === 'word/document.xml');
  if (doc === undefined) throw new Error('not a DOCX: no word/document.xml');
  const xml = new TextDecoder().decode(doc.data);
  const lines: string[] = [];
  for (const p of xml.matchAll(/<w:p\b(?:[^>]*[^/])?>([\s\S]*?)<\/w:p>/g)) {
    const inner = p[1] ?? '';
    let text = '';
    for (const t of inner.matchAll(/<w:t\b[^>]*>([^<]*)<\/w:t>|<w:(?:tab|br)\b[^>]*\/>/g)) text += t[1] !== undefined ? decodeXml(t[1]) : ' ';
    if (text.trim() === '') continue;
    lines.push(/<w:numPr\b/.test(inner) ? `${BULLET} ${text}` : text);
  }
  return lines.join('\n');
}
