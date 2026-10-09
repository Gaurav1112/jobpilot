import type { CoverPlan, ResumePlan } from '../types.js';

/**
 * The document model every format is drawn from (Task 10). A document is a flat list of blocks in reading order, one
 * column, no tables: the PDF, DOCX and HTML renderers only choose fonts and spacing for each block kind, so the three
 * formats carry the same text. Pure: agent code (the renderer), the G-FILL guardrail and the qa-gate all build it.
 *
 * Layout (user's resume v5 ATS rules): contact details in the body, never a header or footer; section headings in
 * capitals; literal "•" bullets; dates "Mon YYYY – Mon YYYY" or "– Present".
 */

/** The P1 contact block, as `contact.yaml` holds it. */
export interface ContactDetails {
  readonly name: string;
  readonly email: string;
  readonly phone: string;
  readonly city: string;
  readonly links: readonly string[];
}

export type Block =
  /** The candidate's name, large and bold. */
  | { readonly kind: 'name'; readonly text: string }
  /** The contact line: email | phone | city | links. */
  | { readonly kind: 'contact'; readonly text: string }
  /** A section heading, already in capitals. */
  | { readonly kind: 'heading'; readonly text: string }
  /** A bold line: the headline, or a role's "Title | Employer". */
  | { readonly kind: 'title'; readonly text: string }
  /** A role's "Location | Mon YYYY – Mon YYYY". */
  | { readonly kind: 'meta'; readonly text: string }
  /** A paragraph; `factIds` names the facts it cites (cover paragraphs). */
  | { readonly kind: 'para'; readonly text: string; readonly factIds: readonly string[] }
  /** A bullet: a fact's claim verbatim, drawn after a literal "•". */
  | { readonly kind: 'bullet'; readonly text: string; readonly factId: string }
  /** A plain line (the cover's date, salutation and sign-off). */
  | { readonly kind: 'line'; readonly text: string };

export interface DocModel {
  readonly kind: 'resume' | 'cover';
  /** Document title metadata. */
  readonly title: string;
  readonly author: string;
  /** `plan.firstSeen` (YYYY-MM-DD): the fixed creation date of every format. */
  readonly date: string;
  readonly blocks: readonly Block[];
}

export const BULLET = '•';
export const SALUTATION = 'Dear Hiring Team,';
export const SIGN_OFF = 'Sincerely,';
export const HEADINGS = { summary: 'SUMMARY', skills: 'SKILLS', experience: 'EXPERIENCE', certifications: 'CERTIFICATIONS', education: 'EDUCATION' } as const;

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** "2022-01" → "Jan 2022"; "present" → "Present". */
export function monthYear(ym: string): string {
  if (ym === 'present') return 'Present';
  const m = /^(\d{4})-(\d{2})$/.exec(ym);
  const name = m ? MONTHS[Number(m[2]) - 1] : undefined;
  if (!m || name === undefined) throw new Error(`not a YYYY-MM month: ${ym}`);
  return `${name.slice(0, 3)} ${m[1]}`;
}

/** "2026-10-01" → "1 October 2026". */
export function longDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  const name = m ? MONTHS[Number(m[2]) - 1] : undefined;
  if (!m || name === undefined) throw new Error(`not a YYYY-MM-DD date: ${iso}`);
  return `${Number(m[3])} ${name} ${m[1]}`;
}

/** email | phone | city | links, skipping empty fields. */
export function contactLine(c: ContactDetails): string {
  return [c.email, c.phone, c.city, ...c.links].map((s) => s.trim()).filter((s) => s !== '').join(' | ');
}

const head = (c: ContactDetails): Block[] => [
  { kind: 'name', text: c.name.trim() },
  { kind: 'contact', text: contactLine(c) },
];

/** The resume: header, headline, summary, skills, experience, certifications, education. Empty sections are left out. */
export function resumeModel(plan: ResumePlan, c: ContactDetails): DocModel {
  const blocks: Block[] = [...head(c), { kind: 'title', text: plan.headline }];
  blocks.push({ kind: 'heading', text: HEADINGS.summary }, { kind: 'para', text: plan.summary.text, factIds: [] });
  if (plan.skills.length > 0) blocks.push({ kind: 'heading', text: HEADINGS.skills }, { kind: 'para', text: plan.skills.join(', '), factIds: [] });
  if (plan.roles.length > 0) {
    blocks.push({ kind: 'heading', text: HEADINGS.experience });
    for (const r of plan.roles) {
      blocks.push({ kind: 'title', text: `${r.title} | ${r.employer}` });
      const dates = `${monthYear(r.start)} – ${monthYear(r.end)}`;
      blocks.push({ kind: 'meta', text: r.location.trim() === '' ? dates : `${r.location.trim()} | ${dates}` });
      for (const b of r.bullets) blocks.push({ kind: 'bullet', text: b.text, factId: b.factId });
    }
  }
  if (plan.certs.length > 0) {
    blocks.push({ kind: 'heading', text: HEADINGS.certifications });
    for (const b of plan.certs) blocks.push({ kind: 'bullet', text: b.text, factId: b.factId });
  }
  if (plan.education.length > 0) {
    blocks.push({ kind: 'heading', text: HEADINGS.education });
    for (const b of plan.education) blocks.push({ kind: 'bullet', text: b.text, factId: b.factId });
  }
  return { kind: 'resume', title: `${c.name.trim()} - Resume`, author: c.name.trim(), date: plan.firstSeen, blocks };
}

/** The cover letter: header, date line, "Dear Hiring Team,", the paragraphs, "Sincerely," and the name. */
export function coverModel(cover: CoverPlan, c: ContactDetails): DocModel {
  const blocks: Block[] = [
    ...head(c),
    { kind: 'line', text: longDate(cover.resume.firstSeen) },
    { kind: 'line', text: SALUTATION },
    ...cover.paragraphs.map((p): Block => ({ kind: 'para', text: p.text, factIds: [...p.factIds] })),
    { kind: 'line', text: SIGN_OFF },
    { kind: 'line', text: c.name.trim() },
  ];
  return { kind: 'cover', title: `${c.name.trim()} - Cover Letter`, author: c.name.trim(), date: cover.resume.firstSeen, blocks };
}

/** One block's text as a line of the document text: a bullet is "• claim", every other block its text. */
export const blockLine = (b: Block): string => (b.kind === 'bullet' ? `${BULLET} ${b.text}` : b.text);

/** The document text (`Rendered.text`): one line per block, in order. */
export const modelText = (m: DocModel): string => m.blocks.map(blockLine).join('\n');

/**
 * The normalisation every text comparison uses (qa-gate, renderer self-check). Documented rule:
 * 1. NFC; form feeds (pdftotext page breaks) and CR become newlines;
 * 2. a line break right after a hyphen that follows a letter or digit is removed ("event-\n driven" → "event-driven"),
 *    since a PDF line may break after a hyphen of the source text;
 * 3. every run of whitespace (spaces, tabs, newlines, NBSP) becomes one space, and the ends are trimmed.
 * Layout spacing (pdftotext -layout indents, DOCX paragraph boundaries) therefore never counts, and words never merge.
 */
export function normText(s: string): string {
  return s
    .normalize('NFC')
    .replace(/[\f\r]/g, '\n')
    .replace(/(?<=[\p{L}\p{N}]-)[ \t]*\n\s*/gu, '')
    .replace(/[\s ]+/gu, ' ')
    .trim();
}

/** Characters Helvetica (WinAnsi) can set beyond Latin-1: the 0x80-0x9F row of Windows-1252. */
const WIN_ANSI_EXTRA = '€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ';

/**
 * The first character the standard PDF fonts cannot set (anything outside Windows-1252), as "U+XXXX", or null. The
 * renderer refuses such text rather than ship a garbled glyph in a verbatim claim.
 */
export function unencodable(text: string): string | null {
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    const ok = cp === 0x0a || (cp >= 0x20 && cp <= 0x7e) || (cp >= 0xa0 && cp <= 0xff) || WIN_ANSI_EXTRA.includes(ch);
    if (!ok) return `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;
  }
  return null;
}

/** The six files of one job, in the order the renderer writes and lists them. */
export const RENDER_FILES: readonly { readonly kind: 'resume' | 'cover'; readonly format: 'pdf' | 'docx' | 'html' }[] = [
  { kind: 'resume', format: 'pdf' },
  { kind: 'resume', format: 'docx' },
  { kind: 'resume', format: 'html' },
  { kind: 'cover', format: 'pdf' },
  { kind: 'cover', format: 'docx' },
  { kind: 'cover', format: 'html' },
];

/** `<jobKey>/resume.pdf` and so on, relative to the out root. */
export const renderedPath = (jobKey: string, kind: 'resume' | 'cover', format: 'pdf' | 'docx' | 'html'): string => `${jobKey}/${kind}.${format}`;

/** The page limits the qa-gate enforces. */
export const PAGE_LIMITS = { resume: 2, cover: 1 } as const;
