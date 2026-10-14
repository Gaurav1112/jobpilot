import { z } from 'zod';
import { defineAgent } from '../../../kernel/agent.js';
import { defineContract } from '../../../kernel/contract.js';
import { KernelError } from '../../../kernel/errors.js';
import { htmlAttributeText, htmlText } from '../../render/html.js';
import { normText, PAGE_LIMITS, RENDER_FILES, renderedPath } from '../../render/model.js';
import { QaReport, qaRan, Rendered } from '../../types.js';
import { check, type Check, contactProblems, hasTerm, hyphenProblems, namingProblem, pdfPages, readDocxText, sameText } from './qa-checks.js';

/**
 * qa-gate (spec §5.4, Task 10): checks the files the renderer wrote, from their bytes, never from the renderer's word.
 * It reads them through `ctx.files.read` (read-only) and gets each PDF's text layer through `ctx.pdfText`
 * (`pdftotext -layout`). `ok` is the AND of every check:
 *
 * | id | rule |
 * |---|---|
 * | qa.files | exactly the six expected files, each readable, each sha256 equal to the one recorded |
 * | qa.pages | from the pdftotext page breaks: resume ≤ 2 pages, cover ≤ 1, and equal to the recorded counts |
 * | qa.terms | every planned covered term, by its lexicon display name (as documents show it), is in the resume PDF text |
 * | qa.hyphen | no PDF line ends in "-" unless the source text has that hyphen (" -" or "-") at that wrap point |
 * | qa.docx-text | each DOCX `word/document.xml` text equals the document text (`Rendered.text`) |
 * | qa.pdf-text | each PDF text layer equals the document text |
 * | qa.naming | no forbidden term in any PDF or DOCX text layer, nor in the HTML previews' text (tags stripped) or attribute values (data-fact ids) |
 * | qa.contact-intact | each contact token (email, phone, city, each link) is whole on one line of each PDF's text layer: never split inside a URL (L4) |
 *
 * Every text comparison uses `normText` (render/model.ts): NFC, format characters (soft hyphens U+00AD, zero-width
 * characters) removed, a line break after a word's hyphen joined, whitespace runs collapsed, ends trimmed. The renderer
 * removes format characters from the plan text before rendering (`cleanText`), so a soft hyphen in a fact can never
 * surface as a visible "-" at a wrap. Details name files, ids and lexicon display names only, never a forbidden term.
 */
export const qaGateContract = defineContract({
  id: 'qa-gate',
  version: '1.5.0',
  description: 'Checks the rendered documents of one job against their plan',
  skills: ['document-qa'],
  team: 'writing',
  kind: 'deterministic',
  consumes: Rendered,
  produces: QaReport,
  guarantees: [qaRan],
  capabilities: { pack: true, files: { root: 'out', access: 'read' }, pdfText: true },
  dataClasses: { in: ['P1'], out: ['P1'] },
  budget: { usdPerCall: 0, usdPerRun: 0 },
  timeoutMs: 120_000,
  guardrails: { in: [], out: ['G-NAMING'] },
});

const Group = z.object({ key: z.string(), display: z.string().optional() });
const QaPack = z.object({
  lexicon: z.object({ strong: z.array(Group), medium: z.array(Group), gap: z.array(Group) }),
  naming: z.object({ forbiddenTerms: z.array(z.string()) }),
});
export type QaPack = z.infer<typeof QaPack>;

/** What the qa-gate read: each file's bytes and sha256 (or why it could not be read), and each PDF's text layer. */
export interface QaInputs {
  readonly files: ReadonlyMap<string, { readonly bytes: Uint8Array; readonly sha256: string } | { readonly error: string }>;
  readonly pdfText: ReadonlyMap<string, string>;
}

export { contactProblems, hyphenProblems } from './qa-checks.js';

/** The QA checks of one Rendered, from what was read. Pure, so tests can drive every branch. */
export function qaChecks(rendered: Rendered, pack: QaPack, read: QaInputs): Check[] {
  const expected = RENDER_FILES.map((f) => ({ ...f, path: renderedPath(rendered.jobKey, f.kind, f.format) }));
  const byPath = new Map(rendered.files.map((f) => [f.path, f]));

  const fileProblems: string[] = [];
  if (rendered.files.length !== expected.length) fileProblems.push(`expected ${expected.length} files, the renderer listed ${rendered.files.length}`);
  for (const e of expected) {
    const f = byPath.get(e.path);
    if (f === undefined || f.kind !== e.kind || f.format !== e.format) {
      fileProblems.push(`${e.path} is not listed as the ${e.kind} ${e.format}`);
      continue;
    }
    const got = read.files.get(e.path);
    if (got === undefined || 'error' in got) fileProblems.push(`${e.path} cannot be read${got && 'error' in got ? ` (${got.error})` : ''}`);
    else if (got.sha256 !== f.sha256) fileProblems.push(`${e.path} sha256 differs from the recorded one`);
  }

  const bytesOf = (path: string): Uint8Array | undefined => {
    const got = read.files.get(path);
    return got === undefined || 'error' in got ? undefined : got.bytes;
  };
  const pdfOf = (kind: 'resume' | 'cover') => read.pdfText.get(renderedPath(rendered.jobKey, kind, 'pdf'));

  const pageProblems: string[] = [];
  const hyphen: string[] = [];
  const pdfTextProblems: string[] = [];
  const naming: string[] = [];
  const docxProblems: string[] = [];
  const contact: string[] = [];
  const scan = (where: string, text: string) => {
    const p = namingProblem(where, text, pack.naming);
    if (p !== undefined) naming.push(p);
  };
  for (const kind of ['resume', 'cover'] as const) {
    const pdfPath = renderedPath(rendered.jobKey, kind, 'pdf');
    const docxPath = renderedPath(rendered.jobKey, kind, 'docx');
    const source = rendered.text[kind];
    const pdf = pdfOf(kind);
    if (pdf === undefined) {
      pageProblems.push(`${pdfPath} has no text layer`);
      pdfTextProblems.push(`${pdfPath} has no text layer`);
      contact.push(`${pdfPath} has no text layer`);
    } else {
      const pages = pdfPages(pdf);
      if (pages > PAGE_LIMITS[kind]) pageProblems.push(`${kind} has ${pages} pages, the limit is ${PAGE_LIMITS[kind]}`);
      const recorded = byPath.get(pdfPath)?.pages;
      if (recorded !== pages) pageProblems.push(`${pdfPath} has ${pages} pages, the renderer recorded ${String(recorded)}`);
      hyphen.push(...hyphenProblems(pdf, source).map((p) => `${pdfPath} ${p}`));
      if (!sameText(pdf, source)) pdfTextProblems.push(`${pdfPath} text differs from the document text`);
      contact.push(...contactProblems(pdf, source).map((p) => `${pdfPath}: ${p}`));
      scan(pdfPath, pdf);
    }
    const htmlPath = renderedPath(rendered.jobKey, kind, 'html');
    const html = bytesOf(htmlPath);
    if (html !== undefined) {
      const source = new TextDecoder().decode(html);
      scan(htmlPath, htmlText(source));
      scan(`${htmlPath} (attributes)`, htmlAttributeText(source));
    }
    const docx = bytesOf(docxPath);
    if (docx === undefined) docxProblems.push(`${docxPath} cannot be read`);
    else {
      const read = readDocxText(docxPath, docx);
      if ('problem' in read) docxProblems.push(read.problem);
      else {
        if (!sameText(read.text, source)) docxProblems.push(`${docxPath} text differs from the document text`);
        scan(docxPath, read.text);
      }
    }
  }

  const groups = [...pack.lexicon.strong, ...pack.lexicon.medium, ...pack.lexicon.gap];
  const resumePdf = pdfOf('resume');
  const resumeText = resumePdf === undefined ? undefined : normText(resumePdf);
  const termProblems = rendered.plan.resume.covered.flatMap((key) => {
    const display = groups.find((g) => g.key === key)?.display ?? key;
    if (resumeText === undefined) return [`${display}: the resume has no text layer`];
    return hasTerm(resumeText, display) ? [] : [`${display} is not in the resume PDF text`];
  });

  return [
    check('qa.files', fileProblems),
    check('qa.pages', pageProblems),
    check('qa.terms', termProblems),
    check('qa.hyphen', hyphen),
    check('qa.docx-text', docxProblems),
    check('qa.pdf-text', pdfTextProblems),
    check('qa.naming', naming),
    check('qa.contact-intact', contact),
  ];
}

export const qaGate = defineAgent(qaGateContract, async (rendered, ctx) => {
  const parsed = QaPack.safeParse(ctx.pack);
  if (!parsed.success) throw new KernelError('invalid_output', 'qa-gate: the pack is missing or lacks lexicon or naming');
  const files = ctx.files;
  const pdfText = ctx.pdfText;
  if (files === undefined || pdfText === undefined) throw new KernelError('policy_denied', 'qa-gate: no files or pdfText capability');
  const read = new Map<string, { bytes: Uint8Array; sha256: string } | { error: string }>();
  const texts = new Map<string, string>();
  // Only the expected paths are read, so a listed path outside the job's folder is never opened.
  for (const f of RENDER_FILES) {
    const path = renderedPath(rendered.jobKey, f.kind, f.format);
    try {
      read.set(path, await files.read(path));
    } catch (e) {
      if (!(e instanceof KernelError) || e.code !== 'invalid_output') throw e;
      read.set(path, { error: e.message });
      continue;
    }
    if (f.format === 'pdf') texts.set(path, await pdfText(path));
  }
  const checks = qaChecks(rendered, parsed.data, { files: read, pdfText: texts });
  return [{ jobKey: rendered.jobKey, ok: checks.every((c) => c.ok), checks, files: rendered.files }];
});
