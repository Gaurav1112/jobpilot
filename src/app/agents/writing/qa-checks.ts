import { forbiddenTermStrict } from '../../pack/rules.js';
import { docxText } from '../../render/docx.js';
import { contactLineOf, contactTokens, normText } from '../../render/model.js';
import type { QaReport } from '../../types.js';

/**
 * The text-layer checks of the qa-gate (Task 10), factored out so other writers (the freelance network packs) run
 * exactly the same checks on the files they write. Pure: each takes text or bytes and returns problems, never naming a
 * forbidden term or a P1 token.
 */

export type Check = QaReport['checks'][number];
export const check = (id: string, problems: readonly string[]): Check => ({ id, ok: problems.length === 0, detail: problems.length === 0 ? 'ok' : problems.join('; ') });

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** The display name stands alone: not inside a longer word ("Java" is not in "JavaScript"). */
export const hasTerm = (text: string, display: string): boolean => new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(display)}(?![\\p{L}\\p{N}])`, 'u').test(text);

/**
 * Lines of the PDF text layer that end in "-" where the source text has no hyphen at that point, as "line N".
 * pdfkit never hyphenates (it breaks only at spaces and after hyphens already in the text), so each PDF line is
 * matched, in reading order, against the normalised document text: a line found there carries the source's own
 * hyphen ("event-" before "driven", or "Architect -" before "Associate"), and a line-end "-" on a line the source
 * does not contain was inserted, which is the problem this check exists for.
 */
export function hyphenProblems(pdf: string, source: string): string[] {
  const src = normText(source);
  const problems: string[] = [];
  let at = 0;
  pdf.split(/\n|\f/).forEach((raw, i) => {
    const line = raw.replace(/\p{Cf}/gu, '').replace(/\s+/gu, ' ').trim();
    if (line === '') return;
    const pos = src.startsWith(line, at) ? at : src.indexOf(line, at);
    if (pos < 0) {
      if (line.endsWith('-')) problems.push(`line ${i + 1} ends in "-"`);
      return;
    }
    at = pos + line.length;
  });
  return problems;
}

/**
 * Contact tokens of `source` (its second line, split at " | ") that no single line of the PDF text layer holds whole,
 * as "contact item N is broken across lines" (1-based; the token itself is P1 and never named). Whitespace inside a
 * line is collapsed first, since pdftotext -layout may widen it.
 */
export function contactProblems(pdf: string, source: string): string[] {
  const lines = pdf.split(/\n|\f/).map((l) => l.replace(/\p{Cf}/gu, '').replace(/\s+/gu, ' '));
  return contactTokens(contactLineOf(source)).flatMap((t, i) => {
    const token = t.replace(/\s+/gu, ' ');
    return lines.some((l) => l.includes(token)) ? [] : [`contact item ${i + 1} is broken across lines`];
  });
}

/** The page count of a pdftotext text layer: one form feed per page. */
export const pdfPages = (pdf: string): number => (pdf.match(/\f/g) ?? []).length;

/** Whether a text layer equals the document text, both through `normText`. */
export const sameText = (layer: string, source: string): boolean => normText(layer) === normText(source);

/**
 * final I8: the strict check (glued, split, plural, look-alike) on the raw and the normalised text. A hit is
 * "forbidden term #N appears in <where>" (the term's 1-based index, never the term).
 */
export function namingProblem(where: string, text: string, naming: { readonly forbiddenTerms: readonly string[] }): string | undefined {
  const t = forbiddenTermStrict(text, naming) ?? forbiddenTermStrict(normText(text), naming);
  return t === undefined ? undefined : `forbidden term #${naming.forbiddenTerms.indexOf(t) + 1} appears in ${where}`;
}

/** A DOCX's `word/document.xml` text, or why it cannot be read ("<path> is not a readable DOCX (...)"). */
export function readDocxText(path: string, docx: Uint8Array): { text: string } | { problem: string } {
  try {
    return { text: docxText(docx) };
  } catch (e) {
    return { problem: `${path} is not a readable DOCX (${e instanceof Error ? e.message : String(e)})` };
  }
}
