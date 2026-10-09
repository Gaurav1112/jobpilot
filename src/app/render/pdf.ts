import { createHash } from 'node:crypto';
import PDFDocument from 'pdfkit';
import { BULLET, modelText, type Block, type DocModel } from './model.js';

/**
 * PDF rendering with pdfkit (Task 10). Trusted render library: agent code may call it (G-CONTAINMENT allow-list), it
 * touches no file, network or clock, and it returns bytes. The renderer writes them through `ctx.files`.
 *
 * Layout: A4, 54 pt margins, one column, built-in Helvetica (a real text layer, no embedded or subset font), 10.5 pt
 * body, bold name and headings, headings in capitals, a literal "•" bullet with a hanging indent. No header or footer:
 * contact details are the first lines of the body.
 *
 * Determinism (identical model → identical bytes):
 * - `info.CreationDate` is the plan's firstSeen at 00:00 UTC, never now; no ModDate is written;
 * - the trailer `/ID` is derived from the content (the first 16 bytes of sha256 over the document text and metadata),
 *   replacing pdfkit's ID, which hashes the info dictionary only (two plans with the same title and date would share it);
 * - compression is off, so the bytes do not depend on the zlib build, and content streams are plain text;
 * - standard fonts only, so no font subset tags (which are random in some libraries).
 */

export const PAGE = { size: 'A4', margin: 54 } as const;
export const FONT = { regular: 'Helvetica', bold: 'Helvetica-Bold', body: 10.5, name: 16, heading: 11 } as const;
const BULLET_INDENT = 14;

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
      case 'contact':
        body().text(b.text, left, doc.y + 2, { width });
        doc.moveDown(0.6);
        break;
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
