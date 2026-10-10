import { createHash } from 'node:crypto';
import PDFDocument from 'pdfkit';
import { fontBytes } from './fonts.js';
import { BULLET, CONTACT_SEPARATOR, contactTokens, modelText, type Block, type DocModel } from './model.js';

/**
 * PDF rendering with pdfkit (Task 10). Trusted render library: agent code may call it (G-CONTAINMENT allow-list), it
 * touches no network or clock and reads only the vendored fonts (`fonts.ts`); it returns bytes. The renderer writes
 * them through `ctx.files`.
 *
 * Layout: A4, 54 pt margins, one column, embedded Noto Sans (fix round 1; a subset, CID TrueType with a ToUnicode map,
 * so the text layer extracts), 10.5 pt body, bold name and headings, headings in capitals, a literal "•" bullet with a
 * hanging indent. No header or footer: contact details are the first lines of the body.
 *
 * Determinism (identical model → identical bytes, across processes):
 * - `info.CreationDate` is the plan's firstSeen at 00:00 UTC, never now; no ModDate is written;
 * - the trailer `/ID` is derived from the content (the first 16 bytes of sha256 over the document text and metadata),
 *   replacing pdfkit's ID, which hashes the info dictionary only (two plans with the same title and date would share it);
 * - compression is off, so the bytes do not depend on the zlib build, and content streams are plain text;
 * - the font subset tag comes from pdfkit's font id ("F1", "F2"), not from randomness, and the subset is built from
 *   the glyphs used, in order.
 *
 * Coverage: `uncoveredGlyph` names the first character the fonts have no glyph for; the renderer refuses such a
 * document (`unrenderable-glyph:U+XXXX`) before writing anything, since a missing glyph would print as a blank.
 */

export const PAGE = { size: 'A4', margin: 54 } as const;
export const FONT = { regular: 'Body', bold: 'Body-Bold', body: 10.5, name: 16, heading: 11 } as const;

/** The embedded fonts' glyph tables, opened once through pdfkit's fontkit. */
interface GlyphFont {
  hasGlyphForCodePoint(cp: number): boolean;
}
let glyphFonts: readonly GlyphFont[] | undefined;
function fontsForCoverage(): readonly GlyphFont[] {
  if (glyphFonts === undefined) {
    const doc = new PDFDocument({ autoFirstPage: false });
    const fonts = fontBytes();
    const out: GlyphFont[] = [];
    for (const [name, bytes] of [[FONT.regular, fonts.regular], [FONT.bold, fonts.bold]] as const) {
      doc.registerFont(name, Buffer.from(bytes));
      doc.font(name);
      // pdfkit keeps the fontkit font on its private `_font`; its glyph table is the coverage truth.
      out.push((doc as unknown as { _font: { font: GlyphFont } })._font.font);
    }
    glyphFonts = out;
  }
  return glyphFonts;
}

/** The first character of `texts` some embedded font has no glyph for, as "U+XXXX", or null. Newlines are not drawn. */
export function uncoveredGlyph(texts: readonly string[]): string | null {
  const fonts = fontsForCoverage();
  for (const t of texts) {
    for (const ch of t) {
      const cp = ch.codePointAt(0) ?? 0;
      if (cp === 0x0a) continue;
      if (!fonts.every((f) => f.hasGlyphForCodePoint(cp))) return `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;
    }
  }
  return null;
}
const BULLET_INDENT = 14;
/** The smallest size a contact line is shrunk to when one token alone is wider than the line. */
const MIN_CONTACT_SIZE = 6;

/**
 * The contact line's lines (L4): tokens placed greedily, each whole, joined by " | "; a line that continues on the next
 * keeps its trailing " |", so the text layer still reads "a | b | c" once whitespace is collapsed. A token wider than
 * `maxWidth` gets a line of its own (the renderer shrinks that line to fit). Pure; `width` measures a string.
 */
export function wrapContact(tokens: readonly string[], width: (s: string) => number, maxWidth: number): string[] {
  const sep = CONTACT_SEPARATOR.trimEnd();
  const lines: string[] = [];
  let cur: string[] = [];
  const fits = (xs: readonly string[]): boolean => width(`${xs.join(CONTACT_SEPARATOR)}${sep}`) <= maxWidth || xs.length === 1;
  for (const t of tokens) {
    if (cur.length === 0 || fits([...cur, t])) cur.push(t);
    else {
      lines.push(cur.join(CONTACT_SEPARATOR));
      cur = [t];
    }
  }
  if (cur.length > 0) lines.push(cur.join(CONTACT_SEPARATOR));
  return lines.map((l, i) => (i < lines.length - 1 ? `${l}${sep}` : l));
}

export interface RenderedPdf {
  readonly bytes: Uint8Array;
  /** Pages, counted from pdfkit's `pageAdded` events (plus the first page, added before a listener can attach). */
  readonly pages: number;
}

/** The trailer ID of a model: content-derived, 16 bytes. */
export function pdfIdOf(m: DocModel): Uint8Array {
  const h = createHash('sha256').update(JSON.stringify({ kind: m.kind, title: m.title, author: m.author, date: m.date, text: modelText(m) })).digest();
  return new Uint8Array(h.subarray(0, 16));
}

export async function renderPdf(m: DocModel): Promise<RenderedPdf> {
  const doc = new PDFDocument({
    size: PAGE.size,
    margins: { top: PAGE.margin, bottom: PAGE.margin, left: PAGE.margin, right: PAGE.margin },
    compress: false,
    autoFirstPage: true,
    bufferPages: false,
    info: { Title: m.title, Author: m.author, Creator: 'jobpilot', Producer: 'jobpilot', CreationDate: new Date(`${m.date}T00:00:00.000Z`) },
  });
  const fonts = fontBytes();
  doc.registerFont(FONT.regular, Buffer.from(fonts.regular));
  doc.registerFont(FONT.bold, Buffer.from(fonts.bold));
  // pdfkit's own ID hashes only the info dictionary; this one hashes the content. Written into the trailer at end().
  (doc as unknown as { _id: Uint8Array })._id = pdfIdOf(m);
  let pages = 1;
  doc.on('pageAdded', () => {
    pages += 1;
  });
  const chunks: Uint8Array[] = [];
  doc.on('data', (c: Uint8Array) => chunks.push(c));
  const ended = new Promise<void>((resolve, reject) => {
    doc.on('end', () => resolve());
    doc.on('error', (e: unknown) => reject(e));
  });

  const left = PAGE.margin;
  const width = doc.page.width - 2 * PAGE.margin;
  const body = (font: string = FONT.regular, size: number = FONT.body) => doc.font(font).fontSize(size).fillColor('#000000');
  let prev: Block['kind'] | undefined;
  for (const b of m.blocks) {
    switch (b.kind) {
      case 'name':
        body(FONT.bold, FONT.name).text(b.text, left, doc.y, { width });
        break;
      case 'contact': {
        // L4: tokens are atomic; each line is drawn without pdfkit's own wrapping, so a URL never breaks inside.
        body();
        doc.y += 2;
        for (const line of wrapContact(contactTokens(b.text), (s) => doc.widthOfString(s), width)) {
          const natural = doc.widthOfString(line);
          const size = natural > width ? Math.max(MIN_CONTACT_SIZE, (FONT.body * width) / natural) : FONT.body;
          const y = doc.y;
          body(FONT.regular, size).text(line, left, y, { lineBreak: false });
          doc.x = left;
          doc.y = y + doc.currentLineHeight(true);
        }
        body();
        doc.moveDown(0.6);
        break;
      }
      case 'heading':
        doc.moveDown(0.5);
        body(FONT.bold, FONT.heading).text(b.text, left, doc.y, { width });
        doc.moveDown(0.15);
        break;
      case 'title':
        if (prev === 'bullet' || prev === 'meta') doc.moveDown(0.35);
        body(FONT.bold).text(b.text, left, doc.y, { width });
        break;
      case 'meta':
        body().text(b.text, left, doc.y, { width });
        doc.moveDown(0.15);
        break;
      case 'para':
        body().text(b.text, left, doc.y, { width, lineGap: 1.5 });
        doc.moveDown(0.5);
        break;
      case 'line':
        body().text(b.text, left, doc.y, { width });
        doc.moveDown(0.5);
        break;
      case 'bullet': {
        body();
        // The glyph and the first line of its text share a line, so start a page first if that line does not fit.
        if (doc.y + doc.currentLineHeight(true) > doc.page.maxY()) doc.addPage();
        const y = doc.y;
        doc.text(BULLET, left + 2, y, { lineBreak: false });
        doc.text(b.text, left + BULLET_INDENT, y, { width: width - BULLET_INDENT, lineGap: 1 });
        doc.moveDown(0.15);
        break;
      }
    }
    doc.x = left;
    prev = b.kind;
  }
  doc.end();
  await ended;
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.byteLength;
  }
  return { bytes, pages };
}
