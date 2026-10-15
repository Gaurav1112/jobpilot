import { z } from 'zod';
import { defineAgent } from '../../../kernel/agent.js';
import { defineContract } from '../../../kernel/contract.js';
import { KernelError } from '../../../kernel/errors.js';
import { check, type Check, contactProblems, hasTerm, hyphenProblems, namingProblem, pdfPages, readDocxText, sameText } from '../../agents/writing/qa-checks.js';
import { gigDocsProblems } from '../../guardrails.js';
import { normText } from '../../render/model.js';
import { GigQaReport, gigQaRan, GigRendered } from '../types.js';
import { gigFilesOf, txtBytes } from './gig-text.js';
import { hasNonAsciiPunct } from './phrases.js';

/**
 * gig-qa (spec §7, Task 8): checks one gig's rendered documents from their bytes, never from the renderer's word. It
 * reads the files through `ctx.files.read` and each PDF's text layer through `ctx.pdfText`. `ok` is the AND of:
 *
 * | id | rule |
 * |---|---|
 * | qa.files | exactly the expected files (`gigFilesOf`), each readable, each sha256 equal to the one recorded |
 * | gig.text | the `.txt` file is the recorded text, UTF-8, LF line ends, one final LF |
 * | gig.limits | the proposal or pitch is at most the platform's `maxChars` characters, its first line (the preview) at most `hookChars`; over **fails**, it is never cut |
 * | gig.links | no URL, web address or email in the text when the platform's `linksAllowed` is false |
 * | gig.banned | no line opening "Relevant work:" or "Relevant:", no "I am writing to express", no "to whom it may concern", no line that is only a comma-separated term list |
 * | gig.ascii | no punctuation or symbol outside ASCII in the text, except inside the client's quoted words |
 * | gig.ground | `gigDocsProblems(plan, pack)` is empty and no placeholder brace is left in the text |
 * | gig.naming | no forbidden term (strict) in the `.txt` file, the CV's PDF and DOCX text layers, or the recorded texts |
 * | qa.pages, qa.terms, qa.hyphen, qa.docx-text, qa.pdf-text, qa.contact-intact | the daily qa-gate's checks (`qa-checks.ts`) on the contract CV; its page limit is 1 (`CV_PAGES`) |
 *
 * `gig.repeat` (two proposals of one run sharing their first 60 characters, `repeatKey`) needs the whole run, so the
 * projector checks it. Details name files, lines and ids only, never a forbidden term or a P1 token.
 */
export const gigQaContract = defineContract({
  id: 'gig-qa',
  version: '1.7.0',
  description: 'Checks the rendered documents of one gig against its plan',
  skills: ['gig-document-qa'],
  team: 'writing',
  kind: 'deterministic',
  consumes: GigRendered,
  produces: GigQaReport,
  guarantees: [gigQaRan],
  capabilities: { pack: true, files: { root: 'out', access: 'read' }, pdfText: true },
  dataClasses: { in: ['P1'], out: ['P1'] },
  budget: { usdPerCall: 0, usdPerRun: 0 },
  timeoutMs: 120_000,
  guardrails: { in: [], out: ['G-NAMING'] },
});

const Group = z.object({ key: z.string(), display: z.string().optional() });
const GigQaPack = z.object({
  lexicon: z.object({ strong: z.array(Group), medium: z.array(Group), gap: z.array(Group) }),
  naming: z.object({ forbiddenTerms: z.array(z.string()) }),
  platformRules: z.record(z.string(), z.object({ maxChars: z.number().nullable(), hookChars: z.number().nullable(), linksAllowed: z.boolean() })),
});

/** The contract CV is one page (user decision, fix round 1). */
export const CV_PAGES = 1;

/** What gig-qa read: each file's bytes and sha256 (or why it could not be read), and each PDF's text layer. */
export interface GigQaInputs {
  readonly files: ReadonlyMap<string, { readonly bytes: Uint8Array; readonly sha256: string } | { readonly error: string }>;
  readonly pdfText: ReadonlyMap<string, string>;
}

/** The repeat key of a proposal (the projector flags two of one run with the same key): its first 60 characters, NFC, whitespace collapsed, lower-cased. */
export const repeatKey = (text: string): string => [...text.normalize('NFC').replace(/\s+/gu, ' ').trim().toLowerCase()].slice(0, 60).join('');

const chars = (s: string): number => [...s].length;
const LINK = [/https?:\/\//i, /\bwww\./i, /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+\.\p{L}{2,}/u, /\b[a-z0-9-]+\.(?:com|io|net|org|dev|app|ai|co)\b/];
const STOP = new Set(['i', 'we', 'you', 'my', 'our', 'your', 'at', 'the', 'a', 'an', 'with', 'for', 'to', 'of', 'in', 'on', 'from', 'by', 'is', 'was', 'and', 'or']);

/** Whether a line is only a comma-separated list of short terms ("Java, Kafka, AWS"). */
export function isTermList(line: string): boolean {
  const items = line.trim().replace(/\.$/, '').split(',').map((s) => s.trim().replace(/^(?:and|or)\s+/i, ''));
  if (items.length < 3) return false;
  return items.every((it) => {
    const ws = it.split(/\s+/).filter((w) => w !== '');
    return ws.length >= 1 && ws.length <= 3 && !/[.!?:;]/.test(it) && ws.every((w) => !STOP.has(w.toLowerCase()));
  });
}

/** The gig.banned problems of a text, as "line N ...". */
export function bannedProblems(text: string): string[] {
  return text.split('\n').flatMap((line, i) => {
    const at = `line ${i + 1}`;
    if (/^\s*Relevant(?: work)?:/i.test(line)) return [`${at} opens with "Relevant"`];
    if (/I am writing to express/i.test(line)) return [`${at} has "I am writing to express"`];
    if (/to whom it may concern/i.test(line)) return [`${at} has "to whom it may concern"`];
    if (isTermList(line)) return [`${at} is only a list of terms`];
    return [];
  });
}

/** The gig.links problems of a text, as "line N has a link". */
export const linkProblems = (text: string): string[] => text.split('\n').flatMap((l, i) => (LINK.some((re) => re.test(l)) ? [`line ${i + 1} has a link or email address`] : []));

/** The gig QA checks of one GigRendered, from what was read. Pure, so tests can drive every branch. */
export function gigQaChecks(rendered: GigRendered, rawPack: unknown, read: GigQaInputs): Check[] {
  const pack = GigQaPack.parse(rawPack);
  const plan = rendered.plan;
  const expected = gigFilesOf(plan);
  const byPath = new Map(rendered.files.map((f) => [f.path, f]));
  const bytesOf = (path: string): Uint8Array | undefined => {
    const got = read.files.get(path);
    return got === undefined || 'error' in got ? undefined : got.bytes;
  };

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

  const doc = rendered.text.proposal ?? rendered.text.pitch;
  const [txt, pdfFile, docxFile] = expected as [(typeof expected)[number], (typeof expected)[number], (typeof expected)[number]];
  const txtProblems: string[] = [];
  const txtRead = bytesOf(txt.path);
  const txtText = txtRead === undefined ? undefined : new TextDecoder('utf-8', { fatal: false }).decode(txtRead);
  if (doc === null) txtProblems.push('the rendered output has no proposal or pitch text');
  else if (txtRead === undefined) txtProblems.push(`${txt.path} cannot be read`);
  else if (Buffer.compare(Buffer.from(txtRead), Buffer.from(txtBytes(doc))) !== 0) txtProblems.push(`${txt.path} is not the recorded text (UTF-8, LF, one final LF)`);

  const rule = pack.platformRules[plan.platform];
  const limits: string[] = [];
  const hook = doc?.split('\n')[0] ?? '';
  if (doc !== null && rule !== undefined) {
    if (rule.maxChars !== null && chars(doc) > rule.maxChars) limits.push(`the ${txt.kind} has ${chars(doc)} characters, the limit is ${rule.maxChars}`);
    if (rule.hookChars !== null && chars(hook) > rule.hookChars) limits.push(`the hook has ${chars(hook)} characters, the limit is ${rule.hookChars}`);
  }
  if (rule === undefined) limits.push(`platform-rules.yaml has no rule for ${plan.platform}`);
  const links = doc === null || rule === undefined || rule.linksAllowed ? [] : linkProblems(doc);
  const banned = doc === null ? [] : bannedProblems(doc);
  const quote = plan.proposal?.hook.quote ?? null;
  const ascii = doc !== null && hasNonAsciiPunct(quote === null ? doc : doc.replace(`"${quote}"`, '""')) ? [`the ${txt.kind} has punctuation outside ASCII`] : [];

  const ground = gigDocsProblems(plan, rawPack);
  for (const [k, t] of Object.entries(rendered.text)) if (t !== null && /\{[A-Za-z0-9]+\}/.test(t)) ground.push(`text.${k} still holds a placeholder`);

  const naming: string[] = [];
  const scan = (where: string, text: string | undefined) => {
    if (text === undefined) return;
    const p = namingProblem(where, text, pack.naming);
    if (p !== undefined) naming.push(p);
  };
  scan(txt.path, txtText);
  for (const [k, t] of Object.entries(rendered.text)) scan(`text.${k}`, t ?? undefined);

  const pdf = read.pdfText.get(pdfFile.path);
  const source = rendered.text.resume;
  const pages: string[] = [];
  const hyphen: string[] = [];
  const pdfTextProblems: string[] = [];
  const contact: string[] = [];
  const terms: string[] = [];
  if (pdf === undefined) {
    for (const list of [pages, pdfTextProblems, contact]) list.push(`${pdfFile.path} has no text layer`);
  } else {
    const n = pdfPages(pdf);
    if (n > CV_PAGES) pages.push(`the contract CV has ${n} pages, the limit is ${CV_PAGES}`);
    const recorded = byPath.get(pdfFile.path)?.pages;
    if (recorded !== n) pages.push(`${pdfFile.path} has ${n} pages, the renderer recorded ${String(recorded)}`);
    hyphen.push(...hyphenProblems(pdf, source).map((p) => `${pdfFile.path} ${p}`));
    if (!sameText(pdf, source)) pdfTextProblems.push(`${pdfFile.path} text differs from the document text`);
    contact.push(...contactProblems(pdf, source).map((p) => `${pdfFile.path}: ${p}`));
    scan(pdfFile.path, pdf);
  }
  const groups = [...pack.lexicon.strong, ...pack.lexicon.medium, ...pack.lexicon.gap];
  const cv = pdf === undefined ? undefined : normText(pdf);
  for (const key of plan.resume.covered) {
    const display = groups.find((g) => g.key === key)?.display ?? key;
    if (cv === undefined) terms.push(`${display}: the contract CV has no text layer`);
    else if (!hasTerm(cv, display)) terms.push(`${display} is not in the contract CV PDF text`);
  }
  const docx: string[] = [];
  const docxBytes = bytesOf(docxFile.path);
  if (docxBytes === undefined) docx.push(`${docxFile.path} cannot be read`);
  else {
    const r = readDocxText(docxFile.path, docxBytes);
    if ('problem' in r) docx.push(r.problem);
    else {
      if (!sameText(r.text, source)) docx.push(`${docxFile.path} text differs from the document text`);
      scan(docxFile.path, r.text);
    }
  }

  return [
    check('qa.files', fileProblems),
    check('gig.text', txtProblems),
    check('gig.limits', limits),
    check('gig.links', links),
    check('gig.banned', banned),
    check('gig.ascii', ascii),
    check('gig.ground', ground),
    check('gig.naming', naming),
    check('qa.pages', pages),
    check('qa.terms', terms),
    check('qa.hyphen', hyphen),
    check('qa.docx-text', docx),
    check('qa.pdf-text', pdfTextProblems),
    check('qa.contact-intact', contact),
  ];
}

export const gigQa = defineAgent(gigQaContract, async (rendered, ctx) => {
  if (!GigQaPack.safeParse(ctx.pack).success) throw new KernelError('invalid_output', 'gig-qa: the pack is missing or lacks lexicon, naming or platform rules');
  const files = ctx.files;
  const pdfText = ctx.pdfText;
  if (files === undefined || pdfText === undefined) throw new KernelError('policy_denied', 'gig-qa: no files or pdfText capability');
  const read = new Map<string, { bytes: Uint8Array; sha256: string } | { error: string }>();
  const texts = new Map<string, string>();
  // Only the expected paths are read, so a listed path outside the gig's folder is never opened.
  for (const f of gigFilesOf(rendered.plan)) {
    try {
      read.set(f.path, await files.read(f.path));
    } catch (e) {
      if (!(e instanceof KernelError) || e.code !== 'invalid_output') throw e;
      read.set(f.path, { error: e.message });
      continue;
    }
    if (f.format === 'pdf') texts.set(f.path, await pdfText(f.path));
  }
  const checks = gigQaChecks(rendered, ctx.pack, { files: read, pdfText: texts });
  return [{ gigKey: rendered.gigKey, ok: checks.every((c) => c.ok), checks, files: rendered.files }];
});
