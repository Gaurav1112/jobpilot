import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CAPABILITY_ALLOW_LIST, capabilityProblems } from '../../src/app/allow-list.js';
import { ATS_PROFILES, atsOfUrl, profileFor } from '../../src/app/ats-profiles.js';
import { writingAgents } from '../../src/app/agents/writing/index.js';
import { hyphenProblems, qaChecks, qaGate, type QaPack } from '../../src/app/agents/writing/qa-gate.js';
import { renderer, rendererContract } from '../../src/app/agents/writing/renderer.js';
import { COVER_P4, noticePhrase } from '../../src/app/agents/writing/templates.js';
import { appGuardrails, G_FILL, G_GROUND, G_NAMING } from '../../src/app/guardrails.js';
import { docxText, readZip, renderDocx } from '../../src/app/render/docx.js';
import { fillCover, fillP4 } from '../../src/app/render/fill.js';
import { htmlAttributeText, htmlText, renderHtml } from '../../src/app/render/html.js';
import { cleanText, contactLine, contactTokens, coverModel, modelText, monthYear, normText, resumeModel } from '../../src/app/render/model.js';
import { pdfIdOf, renderPdf, uncoveredGlyph, wrapContact } from '../../src/app/render/pdf.js';
import type { Pack } from '../../src/app/pack/schema.js';
import { CoverPlan, QaReport, Rendered } from '../../src/app/types.js';
import { defineAgent, type AnyAgent } from '../../src/kernel/agent.js';
import { freezePack, issueContext } from '../../src/kernel/broker.js';
import { fixedClock } from '../../src/kernel/clock.js';
import { contractHash, defineContract } from '../../src/kernel/contract.js';
import { type Envelope, ZERO_COST } from '../../src/kernel/envelope.js';
import { KernelError } from '../../src/kernel/errors.js';
import { executeStep } from '../../src/kernel/executor.js';
import type { GuardrailContext } from '../../src/kernel/guardrails/index.js';
import { PRODUCT_POLICY_V1, policyHash } from '../../src/kernel/policy.js';
import { pdftotextProvider, type PdfTextProvider, type Providers } from '../../src/kernel/providers.js';
import { Store } from '../../src/kernel/store/store.js';
import { commitPending, openPending, type PendingFiles } from '../../src/kernel/files.js';
import { BUILTIN_GUARDRAILS } from '../../src/kernel/guardrails/builtin.js';
import { GuardrailRegistry } from '../../src/kernel/guardrails/index.js';
import { coverPlanOf, fullPack, posting, publicPackOf, tempOut } from '../support/render-fixtures.js';

const PDFTOTEXT = ['/opt/homebrew/bin/pdftotext', '/usr/local/bin/pdftotext', '/usr/bin/pdftotext'].find((p) => existsSync(p));
const realPdfText: PdfTextProvider | undefined = PDFTOTEXT === undefined ? undefined : pdftotextProvider(PDFTOTEXT);
const withPdftotext = PDFTOTEXT === undefined ? it.skip : it;
if (PDFTOTEXT === undefined) console.warn('render.test: pdftotext (poppler) not found; the real text-layer tests are skipped. Install it with `brew install poppler`.');

const FILLED = "I'm based in Pune, looking for a fully remote role, and available after a 30-day notice period. Thank you for considering my application.";
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const providersFor = (out: string, extra: Partial<Providers> = {}): Providers => ({
  fetch: async () => ({ status: 404, text: async () => '' }),
  fileRoots: { out },
  ...(realPdfText ? { pdfText: realPdfText } : {}),
  ...extra,
});
/** The step key direct renderer runs stage under; `render` commits it the way the executor does after the out guardrails. */
const KEY = 'b'.repeat(64);
const stages = new Map<string, PendingFiles>();
const stageFor = (out: string): PendingFiles => {
  const p = openPending(out, KEY);
  stages.set(out, p);
  return p;
};
const ctxFor = (agent: AnyAgent, out: string, pack: unknown, extra: Partial<Providers> = {}, inputClass: 'P0' | 'P1' = 'P0') =>
  issueContext({
    ...(agent.contract.capabilities.files?.access === 'read-write' ? { pendingFiles: stageFor(out) } : {}),
    contract: agent.contract,
    policy: PRODUCT_POLICY_V1,
    inputClass,
    providers: providersFor(out, extra),
    clock: fixedClock('2026-10-09T00:00:00Z'),
    signal: AbortSignal.timeout(60_000),
    pack: freezePack(pack),
  });

async function render(cover: CoverPlan = coverPlanOf(), pack: Pack = fullPack(), out = tempOut()): Promise<{ rendered: Rendered; out: string }> {
  const [rendered] = await renderer.run(cover, ctxFor(renderer, out, pack));
  await stages.get(out)?.markFinal();
  await commitPending(out, KEY, PRODUCT_POLICY_V1.maxResponseBytes);
  return { rendered: Rendered.schema.parse(rendered), out };
}
const fileOf = (out: string, r: Rendered, kind: 'resume' | 'cover', format: 'pdf' | 'docx' | 'html') =>
  readFileSync(join(out, r.files.find((f) => f.kind === kind && f.format === format)!.path));
const bulletsOf = (c: CoverPlan) => [...c.resume.roles.flatMap((r) => r.bullets), ...c.resume.certs, ...c.resume.education].map((b) => b.text);
const pdftotext = (path: string) => execFileSync(PDFTOTEXT as string, ['-layout', path, '-'], { encoding: 'utf8' });

describe('render model', () => {
  it('formats dates, the contact line and the document text', () => {
    expect(monthYear('2022-03')).toBe('Mar 2022');
    expect(monthYear('present')).toBe('Present');
    expect(() => monthYear('2022-13')).toThrow();
    expect(contactLine({ name: 'A', email: 'a@example.com', phone: '', city: 'Pune', links: ['https://example.com/a'] })).toBe('a@example.com | Pune | https://example.com/a');
  });

  it('lays the resume out as header, headline, summary, skills, experience, certifications, education', () => {
    const cover = coverPlanOf();
    const m = resumeModel(cover.resume, fullPack().contact);
    const lines = modelText(m).split('\n');
    expect(lines[0]).toBe('Asha Rao');
    expect(lines[1]).toBe('asha.rao@example.com | +91 90000 00000 | Pune | https://example.com/asha-rao');
    expect(lines[2]).toBe(cover.resume.headline);
    const headings = m.blocks.filter((b) => b.kind === 'heading').map((b) => b.text);
    expect(headings).toEqual(['SUMMARY', 'SKILLS', 'EXPERIENCE', ...(cover.resume.certs.length ? ['CERTIFICATIONS'] : []), ...(cover.resume.education.length ? ['EDUCATION'] : [])]);
    expect(lines).toContain('Senior Backend Engineer | Northwind Labs');
    expect(lines).toContain('Pune, India (Remote) | Mar 2022 – Present');
    expect(lines).toContain('Bengaluru, India | Jun 2018 – Feb 2022');
    for (const b of cover.resume.roles[0]!.bullets) expect(lines).toContain(`• ${b.text}`);
  });

  it('lays the cover out as header, salutation, paragraphs, sign-off: no date line (L5)', () => {
    const cover = fillCover(coverPlanOf(), fullPack().answers, fullPack().contact.city);
    const lines = modelText(coverModel(cover, fullPack().contact)).split('\n');
    expect(lines.slice(2, 3)).toEqual(['Dear Hiring Team,']);
    expect(lines.slice(3, 3 + cover.paragraphs.length)).toEqual(cover.paragraphs.map((p) => p.text));
    expect(lines.slice(-2)).toEqual(['Sincerely,', 'Asha Rao']);
    expect(lines).toHaveLength(2 + 1 + cover.paragraphs.length + 2);
    for (const l of lines) expect(l).not.toMatch(/^\d{1,2} [A-Z][a-z]+ \d{4}$/);
  });

  it('normalises text for comparison: whitespace, page breaks, a line break after a hyphen', () => {
    expect(normText('  a\n\n  b\tc\f d ')).toBe('a b c d');
    expect(normText('event-\n   driven')).toBe('event-driven');
    expect(normText('a -\nb')).toBe('a - b');
  });

  it('names the first character the embedded font cannot draw: Latin Extended, Greek, Cyrillic and ₹ are covered; CJK and Devanagari are not', () => {
    expect(uncoveredGlyph(['Łódź Systems', '₹ 12 LPA', 'Αθηνά Ράο', 'Café – “quoted” • €5 ™ Ж', 'line\nbreak'])).toBeNull();
    expect(uncoveredGlyph(['A → B'])).toBe('U+2192');
    expect(uncoveredGlyph(['ok', '山田 太郎'])).toBe('U+5C71');
    expect(uncoveredGlyph(['पुणे'])).toBe('U+092A');
  });

  it('removes soft hyphens and other format characters from the plan text before rendering', () => {
    expect(cleanText('read\u00ADthrough cache\u200B')).toBe('readthrough cache');
    const cover = coverPlanOf();
    const shy = { ...cover.resume, roles: cover.resume.roles.map((r, i) => (i === 0 ? { ...r, bullets: r.bullets.map((b, j) => (j === 0 ? { ...b, text: b.text.replace('event-driven', 'event\u00ADdriven') } : b)) } : r)) };
    const text = modelText(resumeModel(shy, fullPack().contact));
    expect(text).not.toContain('\u00AD');
    expect(text).toContain('eventdriven');
    expect(normText('a\u00ADb')).toBe('ab');
  });
});

describe('cover p4 fill', () => {
  const THANKS = 'Thank you for considering my application.';
  it('fills the city from contact.yaml and the notice from answers.yaml notice_period', () => {
    expect(fillP4(COVER_P4, { notice_period: '30 days' }, 'Pune')).toBe(`I'm based in Pune, looking for a fully remote role, and available after a 30-day notice period. ${THANKS}`);
  });

  it('(e) turns "N day|week|month[s]" into an "N-unit notice period"; any other shape reads "a notice period of ..."', () => {
    const cases: [unknown, string][] = [
      ['30 days', 'a 30-day notice period'],
      ['1 day', 'a 1-day notice period'],
      ['2 weeks', 'a 2-week notice period'],
      ['1 Month', 'a 1-month notice period'],
      ['3 months', 'a 3-month notice period'],
      ['90 DAYS', 'a 90-day notice period'],
      ['30days', 'a 30-day notice period'],
      ['30-day', 'a 30-day notice period'],
      ['30 days.', 'a 30-day notice period'], // one trailing "." or "," is dropped first
      ['30 working days', 'a notice period of 30 working days'],
      ['one month', 'a notice period of one month'],
      ['2-3 weeks', 'a notice period of 2-3 weeks'],
      [30, 'a notice period of 30'],
    ];
    for (const [notice, phrase] of cases) {
      expect(noticePhrase(String(notice).trim().replace(/[.,]$/, '')), String(notice)).toBe(phrase);
      expect(fillP4(COVER_P4, { notice_period: notice as string }, 'Pune'), String(notice)).toBe(`I'm based in Pune, looking for a fully remote role, and available after ${phrase}. ${THANKS}`);
    }
  });

  it('an immediate notice reads "available to start immediately", with no "after" and no notice period', () => {
    const NOW = `I'm based in Pune, looking for a fully remote role, and available to start immediately. ${THANKS}`;
    expect(fillP4(COVER_P4, { notice_period: 'immediately' }, 'Pune')).toBe(NOW);
    expect(fillP4(COVER_P4, { notice_period: '0' }, 'Pune')).toBe(NOW);
    expect(fillP4(COVER_P4, { notice_period: 0 }, 'Pune')).toBe(NOW);
    for (const n of ['Immediately', 'immediate', 'IMMEDIATE', 'Immediate.', 'none', 'None', '0 days', '0 day', '0 Days', 'nil', 'NIL', 'n/a', 'N/A', ' immediately ']) {
      expect(fillP4(COVER_P4, { notice_period: n }, 'Pune'), n).toBe(NOW);
    }
    expect(fillP4(COVER_P4, { notice_period: 'immediately' }, '')).toBe(`I'm looking for a fully remote role and available to start immediately. ${THANKS}`);
    // every other value as today
    expect(fillP4(COVER_P4, { notice_period: '30 days' }, 'Pune')).toBe(FILLED);
    for (const [n, phrase] of [['00 days', 'a 00-day notice period'], ['immediately after notice', 'a notice period of immediately after notice'], ['not immediate', 'a notice period of not immediate'], ['10', 'a notice period of 10']] as const) {
      expect(fillP4(COVER_P4, { notice_period: n }, 'Pune'), n).toBe(`I'm based in Pune, looking for a fully remote role, and available after ${phrase}. ${THANKS}`);
    }
  });

  it('with office cities the role clause reads "a remote role, or an office or hybrid role in ..."; with none it is as today', () => {
    const N = 'available after a 30-day notice period';
    expect(fillP4(COVER_P4, { notice_period: '30 days' }, 'Pune', [])).toBe(FILLED);
    // a home city that is not the only office city: the remote-or-office form
    expect(fillP4(COVER_P4, { notice_period: '30 days' }, 'Mumbai', ['pune'])).toBe(`I'm based in Mumbai, looking for a remote role, or an office or hybrid role in Pune, and ${N}. ${THANKS}`);
    // the home city is the only office city: named once
    expect(fillP4(COVER_P4, { notice_period: '30 days' }, 'Pune', ['pune'])).toBe(`I'm based in Pune and open to remote, office or hybrid roles, and ${N}. ${THANKS}`);
    expect(fillP4(COVER_P4, { notice_period: '30 days' }, 'Bangalore', ['bengaluru'])).toBe(`I'm based in Bangalore and open to remote, office or hybrid roles, and ${N}. ${THANKS}`);
    expect(fillP4(COVER_P4, { notice_period: '30 days' }, 'pune', ['Pune'])).toBe(`I'm based in pune and open to remote, office or hybrid roles, and ${N}. ${THANKS}`);
    expect(fillP4(COVER_P4, { notice_period: '30 days' }, 'Pune', ['pune', 'bangalore', 'bengaluru'])).toBe(
      `I'm based in Pune, looking for a remote role, or an office or hybrid role in Pune, Bangalore or Bengaluru, and ${N}. ${THANKS}`,
    );
    expect(fillP4(COVER_P4, { notice_period: '30 days' }, 'Pune', ['pune', 'Bengaluru'])).toBe(`I'm based in Pune, looking for a remote role, or an office or hybrid role in Pune or Bengaluru, and ${N}. ${THANKS}`);
    expect(fillP4(COVER_P4, { notice_period: '30 days' }, 'Pune', ['pune', 'mumbai', 'delhi ncr'])).toBe(
      `I'm based in Pune, looking for a remote role, or an office or hybrid role in Pune, Mumbai or Delhi NCR, and ${N}. ${THANKS}`,
    );
    // a repeated city is named once
    expect(fillP4(COVER_P4, { notice_period: '30 days' }, 'Mumbai', ['pune', 'Pune'])).toBe(`I'm based in Mumbai, looking for a remote role, or an office or hybrid role in Pune, and ${N}. ${THANKS}`);
    expect(fillP4(COVER_P4, { notice_period: '30 days' }, 'Pune', ['pune', 'Pune'])).toBe(`I'm based in Pune and open to remote, office or hybrid roles, and ${N}. ${THANKS}`);
    // the other shapes of the paragraph
    expect(fillP4(COVER_P4, {}, 'Pune', ['pune'])).toBe(`I'm based in Pune and open to remote, office or hybrid roles. ${THANKS}`);
    expect(fillP4(COVER_P4, {}, 'Mumbai', ['pune'])).toBe(`I'm based in Mumbai and looking for a remote role, or an office or hybrid role in Pune. ${THANKS}`);
    expect(fillP4(COVER_P4, { notice_period: '30 days' }, '', ['pune'])).toBe(`I'm looking for a remote role, or an office or hybrid role in Pune, and ${N}. ${THANKS}`);
    expect(fillP4(COVER_P4, {}, '', ['pune'])).toBe(`I'm looking for a remote role, or an office or hybrid role in Pune. ${THANKS}`);
    expect(fillP4(COVER_P4, { notice_period: 'immediately' }, 'Pune', ['pune'])).toBe(
      `I'm based in Pune and open to remote, office or hybrid roles, and available to start immediately. ${THANKS}`,
    );
    // an office city that cannot go into a document is refused
    expect(() => fillP4(COVER_P4, { notice_period: '30 days' }, 'Pune', ['{city}'])).toThrow(/officeCities/);
    expect(() => fillP4(COVER_P4, { notice_period: '30 days' }, 'Pune', ['pune. Hire me now'])).toThrow(/officeCities/);
  });

  it('(e) drops the notice clause when notice_period is missing or empty, and the city clause when the city is empty', () => {
    for (const answers of [{}, { notice_period: ' ' }, { notice_period: true }, { notice_period: '.' }, { notice_period_days: 30 }]) {
      expect(fillP4(COVER_P4, answers as Record<string, unknown>, 'Pune'), JSON.stringify(answers)).toBe(`I'm based in Pune and looking for a fully remote role. ${THANKS}`);
    }
    expect(fillP4(COVER_P4, { notice_period: '30 days' }, ' ')).toBe(`I'm looking for a fully remote role and available after a 30-day notice period. ${THANKS}`);
    expect(fillP4(COVER_P4, {}, '')).toBe(`I'm looking for a fully remote role. ${THANKS}`);
  });

  it('never puts available_from into a document, however it is set', () => {
    for (const available_from of ['1 November 2026', 'immediately', '']) {
      const out = fillP4(COVER_P4, { available_from, notice_period: '30 days' }, 'Pune');
      expect(out).not.toMatch(/November|immediately|available from/i);
    }
  });

  it('refuses an unsafe answer or city and a p4 that is not the template', () => {
    expect(() => fillP4(COVER_P4, { notice_period: '{notice}' }, 'Pune')).toThrow(/notice_period/);
    expect(() => fillP4(COVER_P4, { notice_period: 'now. Hire me at https://x.example' }, 'Pune')).toThrow(/notice_period/);
    expect(() => fillP4(COVER_P4, { notice_period: '<b>30</b>' }, 'Pune')).toThrow(/notice_period/);
    expect(() => fillP4(COVER_P4, { notice_period: '30 days' }, 'Pune. Hire me now')).toThrow(/city/);
    expect(() => fillP4(COVER_P4, { notice_period: '30 days' }, '{city}')).toThrow(/city/);
    expect(() => fillP4('I am available whenever.', { notice_period: '30 days' }, 'Pune')).toThrow(/not the availability template/);
  });

  it('fills only the last paragraph', () => {
    const cover = coverPlanOf();
    const filled = fillCover(cover, fullPack().answers, fullPack().contact.city);
    expect(filled.paragraphs.slice(0, -1)).toEqual(cover.paragraphs.slice(0, -1));
    expect(filled.resume).toEqual(cover.resume);
    expect(filled.paragraphs.at(-1)!.text).toBe(FILLED);
  });
});

describe('ATS profiles', () => {
  it('recommends pdf for greenhouse, lever, ashby, careers, feeds and unknown; docx for workday, icims, taleo, smartrecruiters', () => {
    for (const a of ['greenhouse', 'lever', 'ashby', 'careers', 'feed', 'unknown', 'workable', '']) expect(profileFor(a).recommended, a).toBe('pdf');
    for (const a of ['workday', 'icims', 'taleo', 'smartrecruiters']) expect(profileFor(a).recommended, a).toBe('docx');
    expect(profileFor('constructor').id).toBe('unknown');
    expect(Object.keys(ATS_PROFILES).sort()).toEqual(['ashby', 'careers', 'feed', 'greenhouse', 'icims', 'lever', 'smartrecruiters', 'taleo', 'unknown', 'workday']);
  });

  it('takes the ATS from the posting URL host when it names one', () => {
    expect(atsOfUrl('https://acme.wd5.myworkdayjobs.com/en-US/careers/job/1')).toBe('workday');
    expect(atsOfUrl('https://careers-acme.icims.com/jobs/1')).toBe('icims');
    expect(atsOfUrl('https://acme.taleo.net/careersection/1')).toBe('taleo');
    expect(atsOfUrl('https://jobs.smartrecruiters.com/Acme/1')).toBe('smartrecruiters');
    expect(atsOfUrl('https://evilmyworkdayjobs.com/x')).toBeUndefined();
    expect(atsOfUrl('not a url')).toBeUndefined();
    expect(profileFor('feed', 'https://acme.wd1.myworkdayjobs.com/x').recommended).toBe('docx');
    expect(profileFor('careers', 'https://careers.acme.example/jobs/1').recommended).toBe('pdf');
  });
});

describe('renderer', () => {
  it('declares the full pack, writable files and P1 outputs, and passes the allow-list', () => {
    expect(rendererContract.kind).toBe('io');
    expect(rendererContract.team).toBe('writing');
    expect(rendererContract.capabilities).toEqual({ pack: 'full', files: { root: 'out', access: 'read-write' } });
    expect(rendererContract.emits).toBe('P1');
    expect(rendererContract.guardrails.out).toEqual(['G-GROUND', 'G-FILL', 'G-NAMING']);
    expect(writingAgents.map((a) => a.contract.id)).toEqual(['evidence-matcher', 'resume-planner', 'cover-writer', 'renderer', 'qa-gate']);
    expect(capabilityProblems(writingAgents.map((a) => a.contract))).toEqual([]);
  });

  it('writes the six files under <jobKey>/ and lists them with their sha256 and page counts', async () => {
    const { rendered, out } = await render();
    expect(rendered.files.map((f) => f.path)).toEqual(['resume.pdf', 'resume.docx', 'resume.html', 'cover.pdf', 'cover.docx', 'cover.html'].map((n) => `0123456789abcdef/${n}`));
    for (const f of rendered.files) {
      const bytes = readFileSync(join(out, f.path));
      expect(sha(bytes), f.path).toBe(f.sha256);
      expect(f.pages, f.path).toEqual(f.format === 'pdf' ? expect.any(Number) : null);
    }
    expect(rendered.recommended).toBe('pdf');
    expect(rendered.plan.paragraphs.at(-1)!.text).toBe(FILLED);
    expect(rendered.text.resume.split('\n')[0]).toBe('Asha Rao');
  });

  it('writes no date line into the cover PDF, DOCX or HTML (L5: the posting date is not the letter date)', async () => {
    const { rendered, out } = await render();
    const date = '1 October 2026'; // the fixture posting's date (firstSeen), which the old date line printed
    expect(rendered.text.cover).not.toContain(date);
    expect(docxText(new Uint8Array(fileOf(out, rendered, 'cover', 'docx')))).not.toContain(date);
    expect(htmlText(fileOf(out, rendered, 'cover', 'html').toString('utf8'))).not.toContain(date);
    if (PDFTOTEXT !== undefined) expect(pdftotext(join(out, rendered.files.find((f) => f.kind === 'cover' && f.format === 'pdf')!.path))).not.toContain(date);
    expect(rendered.text.cover.split('\n')[2]).toBe('Dear Hiring Team,');
  });

  it('recommends docx for a Workday posting', async () => {
    const cover = coverPlanOf(posting({ url: 'https://acme.wd5.myworkdayjobs.com/en-US/External/job/1' }));
    expect((await render(cover)).rendered.recommended).toBe('docx');
  });

  it('is deterministic: two renders give byte-identical PDF, DOCX and HTML', async () => {
    const a = await render();
    const b = await render();
    expect(a.out).not.toBe(b.out);
    expect(b.rendered.files.map((f) => f.sha256)).toEqual(a.rendered.files.map((f) => f.sha256));
    for (const f of a.rendered.files) expect(Buffer.compare(readFileSync(join(a.out, f.path)), readFileSync(join(b.out, f.path))), f.path).toBe(0);
  });

  it('fixes the PDF metadata to firstSeen and derives the trailer ID from the content', async () => {
    const { rendered, out } = await render();
    const pdf = fileOf(out, rendered, 'resume', 'pdf').toString('latin1');
    expect(pdf).toContain('(D:20261001000000Z)');
    expect(pdf).toContain('/Producer');
    expect(pdf).not.toMatch(/\/ModDate/);
    const id = Buffer.from(pdfIdOf(resumeModel(rendered.plan.resume, fullPack().contact))).toString('hex');
    expect(pdf).toContain(`/ID [<${id}> <${id}>]`);
    const other = resumeModel(rendered.plan.resume, { ...fullPack().contact, phone: '+91 90000 00001' });
    expect(Buffer.from(pdfIdOf(other)).toString('hex')).not.toBe(id);
  });

  it('builds a plain DOCX: paragraphs only, Arial, numbered bullets, contact in the body, fixed dates', async () => {
    const { rendered, out } = await render();
    const zip = readZip(new Uint8Array(fileOf(out, rendered, 'resume', 'docx')));
    const names = zip.map((e) => e.name);
    expect(names).toContain('word/document.xml');
    expect(names.some((n) => /header|footer/.test(n))).toBe(false);
    const xml = new TextDecoder().decode(zip.find((e) => e.name === 'word/document.xml')!.data);
    for (const tag of ['<w:tbl', '<w:txbxContent', '<w:drawing', '<w:pict', '<w:cols w:num=', '<w:headerReference', '<w:footerReference']) expect(xml, tag).not.toContain(tag);
    expect(xml).toContain('Asha Rao');
    expect(xml).toContain('asha.rao@example.com');
    for (const b of bulletsOf(rendered.plan)) expect(xml).toContain(b.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'));
    const numbering = new TextDecoder().decode(zip.find((e) => e.name === 'word/numbering.xml')!.data);
    expect(numbering).toContain('w:val="•"');
    // m5: every bullet paragraph's numId maps, through its abstractNum, to a level-0 lvlText of a literal "•"
    const numIds = new Set([...xml.matchAll(/<w:numId w:val="(\d+)"\/>/g)].map((m) => m[1]));
    expect(numIds.size).toBe(1);
    for (const id of numIds) {
      const abstract = new RegExp(`<w:num w:numId="${id}"[^>]*>\\s*<w:abstractNumId w:val="(\\d+)"`).exec(numbering)?.[1];
      expect(abstract, `numId ${id}`).toBeDefined();
      const def = new RegExp(`<w:abstractNum [^>]*w:abstractNumId="${abstract}"[^>]*>([\\s\\S]*?)</w:abstractNum>`).exec(numbering)?.[1] ?? '';
      const lvl0 = /<w:lvl w:ilvl="0"[^>]*>([\s\S]*?)<\/w:lvl>/.exec(def)?.[1] ?? '';
      expect(lvl0).toMatch(/<w:numFmt w:val="bullet"\/>/);
      expect(lvl0).toMatch(/<w:lvlText w:val="•"\/>/);
    }
    const core = new TextDecoder().decode(zip.find((e) => e.name === 'docProps/core.xml')!.data);
    expect(core).toMatch(/<dcterms:created[^>]*>2026-10-01T00:00:00Z<\/dcterms:created>/);
    expect(core).toMatch(/<dcterms:modified[^>]*>2026-10-01T00:00:00Z<\/dcterms:modified>/);
    expect(core).toContain('<dc:creator>jobpilot</dc:creator>');
    const styles = new TextDecoder().decode(zip.find((e) => e.name === 'word/styles.xml')!.data);
    expect(styles).toContain('w:ascii="Arial"');
    // every zip entry carries the fixed DOS date (1980-01-01 00:00)
    const bytes = new Uint8Array(fileOf(out, rendered, 'resume', 'docx'));
    for (let i = 0; i + 4 <= bytes.length; i++) {
      if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 0x03 && bytes[i + 3] === 0x04) {
        expect([bytes[i + 10], bytes[i + 11], bytes[i + 12], bytes[i + 13]]).toEqual([0, 0, 0x21, 0]);
      }
    }
    expect(docxText(bytes)).toBe(rendered.text.resume);
  });

  it('renders an escaped HTML preview with data-fact on every bullet, both colour schemes, system fonts only', async () => {
    const { rendered, out } = await render();
    const html = fileOf(out, rendered, 'resume', 'html').toString('utf8');
    const facts = [...html.matchAll(/<li data-fact="([^"]+)">• /g)].map((m) => m[1]);
    const plan = rendered.plan.resume;
    expect(facts).toEqual([...plan.roles.flatMap((r) => r.bullets), ...plan.certs, ...plan.education].map((b) => b.factId));
    expect(html).toContain('color-scheme:light dark');
    expect(html).toContain('prefers-color-scheme:dark');
    expect(html).toContain('system-ui');
    for (const bad of ['<script', '::before', '::after', 'float', '@import', 'url(', '<link', 'http-equiv']) expect(html, bad).not.toContain(bad);
    const m = { ...resumeModel(plan, fullPack().contact), blocks: [{ kind: 'bullet' as const, text: '<img src=x onerror=alert(1)> & "q"', factId: 'f"1' }] };
    const escaped = renderHtml(m);
    expect(escaped).toContain('<li data-fact="f&quot;1">• &lt;img src=x onerror=alert(1)&gt; &amp; &quot;q&quot;</li>');
    expect(fileOf(out, rendered, 'cover', 'html').toString('utf8')).toMatch(/<p data-facts="[^"]+">/);
  });

  withPdftotext('has a real text layer: pdftotext shows the contact block, every bullet and every paragraph, within the page limits', async () => {
    const { rendered, out } = await render();
    const resume = pdftotext(join(out, '0123456789abcdef/resume.pdf'));
    const cover = pdftotext(join(out, '0123456789abcdef/cover.pdf'));
    const r = normText(resume);
    expect(r.startsWith('Asha Rao asha.rao@example.com | +91 90000 00000 | Pune | https://example.com/asha-rao')).toBe(true);
    for (const b of bulletsOf(rendered.plan)) expect(r, b).toContain(`• ${normText(b)}`);
    for (const p of rendered.plan.paragraphs) expect(normText(cover)).toContain(normText(p.text));
    expect(normText(resume)).toBe(normText(rendered.text.resume));
    expect(normText(cover)).toBe(normText(rendered.text.cover));
    expect((resume.match(/\f/g) ?? []).length).toBeLessThanOrEqual(2);
    expect((cover.match(/\f/g) ?? []).length).toBe(1);
    expect(rendered.files.find((f) => f.path.endsWith('cover.pdf'))!.pages).toBe(1);
  });

  it('drops the notice clause when answers.yaml lacks notice_period', async () => {
    const { notice_period: _n, ...answers } = fullPack().answers;
    const { rendered } = await render(coverPlanOf(), fullPack({ answers }));
    expect(rendered.plan.paragraphs.at(-1)!.text).toBe("I'm based in Pune and looking for a fully remote role. Thank you for considering my application.");
    expect(rendered.text.cover).not.toMatch(/[{}]/);
  });

  it('blocks a character the embedded font cannot draw with the named reason unrenderable-glyph, before any write', async () => {
    const out = tempOut();
    const pack = fullPack({ contact: { ...fullPack().contact, name: '山田 太郎' } });
    const err = await render(coverPlanOf(), pack, out).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KernelError);
    expect((err as Error).message).toMatch(/^renderer: unrenderable-glyph:U\+5C71 /);
    expect(existsSync(join(out, '0123456789abcdef'))).toBe(false);
    expect(existsSync(join(out, '.pending', KEY))).toBe(false);
  });

  it('a glyph the font lacks in the posting title is input_rejected; the same glyph in the pack contact is invalid_output (I4)', async () => {
    const fromPosting = await render(coverPlanOf(posting({ company: 'Acme 山田' })), fullPack(), tempOut()).catch((e: unknown) => e);
    expect(fromPosting).toMatchObject({ code: 'input_rejected', message: expect.stringMatching(/^renderer: unrenderable-glyph:U\+5C71 \(in the posting/) });
    const fromPack = await render(coverPlanOf(), fullPack({ contact: { ...fullPack().contact, name: '山田 太郎' } }), tempOut()).catch((e: unknown) => e);
    expect(fromPack).toMatchObject({ code: 'invalid_output' });
    const named = await render(coverPlanOf(posting({ company: 'Initech Payments' })), fullPack(), tempOut()).catch((e: unknown) => e);
    expect(named).toMatchObject({ code: 'input_rejected', message: 'renderer: G-NAMING: forbidden term #1 appears in the posting title or company' });
  });

  withPdftotext('renders Łódź Systems, ₹ 12 LPA and a Greek name through the embedded font, with a text layer that passes QA', async () => {
    const pack = fullPack({ contact: { ...fullPack().contact, name: 'Αθηνά Ράο', city: 'Pune ₹ 12 LPA' } });
    const { rendered, out } = await render(coverPlanOf(posting({ company: 'Łódź Systems' })), pack);
    const resume = pdftotext(join(out, '0123456789abcdef/resume.pdf'));
    const cover = pdftotext(join(out, '0123456789abcdef/cover.pdf'));
    expect(resume.split('\n')[0]).toBe('Αθηνά Ράο');
    expect(resume).toContain('₹ 12 LPA');
    expect(cover).toContain('role at Łódź Systems');
    const pdf = fileOf(out, rendered, 'cover', 'pdf').toString('latin1');
    expect(pdf).toMatch(/\/BaseFont \/[A-Z]{6}\+NotoSans/);
    expect(pdf).toContain('/FontFile2');
    expect(pdf).toContain('/ToUnicode');
    expect(pdf).not.toMatch(/\/BaseFont \/Helvetica/);
    const [report] = await qaGate.run(rendered, ctxFor(qaGate, out, publicPackOf(fullPack()), {}, 'P1'));
    expect(report!.checks.filter((c) => !c.ok)).toEqual([]);
  });

  it('strips one trailing "." or "," from a filled answer', () => {
    expect(fillP4(COVER_P4, { notice_period: 'One month.' }, 'Pune')).toBe("I'm based in Pune, looking for a fully remote role, and available after a notice period of One month. Thank you for considering my application.");
    expect(fillP4(COVER_P4, { notice_period: '30 days,' }, 'Pune')).toBe(FILLED);
  });

  it('refuses a forbidden term anywhere in the documents, contact block included, without naming it', async () => {
    const pack = fullPack({ contact: { ...fullPack().contact, links: ['https://example.com/initech-alumni'] } });
    const err = await render(coverPlanOf(), pack).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KernelError);
    expect((err as Error).message).toMatch(/G-NAMING: forbidden term #1 appears in the resume/);
    expect((err as Error).message.toLowerCase()).not.toContain('initech');
  });

  it('cannot be steered outside the out root: a symlinked job folder is a policy denial', async () => {
    const out = tempOut();
    const elsewhere = tempOut();
    symlinkSync(elsewhere, join(out, '0123456789abcdef'));
    const ctx = ctxFor(renderer, out, fullPack());
    await expect(renderer.run(coverPlanOf(), ctx)).rejects.toThrow(/G-FILES: .*symlink/);
    expect(ctx.denials()[0]).toMatch(/^G-FILES/);
  });

  it('never writes into an applied-* snapshot (the kernel refuses the path)', async () => {
    const out = tempOut();
    mkdirSync(join(out, '0123456789abcdef', 'applied-2026-10-09'), { recursive: true });
    writeFileSync(join(out, '0123456789abcdef', 'applied-2026-10-09', 'resume.pdf'), 'snapshot');
    const ctx = ctxFor(renderer, out, fullPack());
    await expect(ctx.files!.write!('0123456789abcdef/applied-2026-10-09/resume.pdf', new Uint8Array([1]))).rejects.toThrow(/applied-/);
    await render(coverPlanOf(), fullPack(), out);
    expect(readFileSync(join(out, '0123456789abcdef', 'applied-2026-10-09', 'resume.pdf'), 'utf8')).toBe('snapshot');
  });
});

describe('G-FILL', () => {
  const gctx = (input: CoverPlan, payload: unknown, pack: unknown = fullPack()): GuardrailContext => ({ // pack null: no full pack
    side: 'out',
    contract: rendererContract,
    policy: PRODUCT_POLICY_V1,
    policyHash: 'p',
    contractHashOf: () => undefined,
    input: { envelopeId: 'e', stepKey: 's', index: 0, type: 'CoverPlan@1', producer: { agentId: 'cover-writer', version: '1.0.0', contractHash: 'h' }, parents: [], payload: input, handoff: { guarantees: [], dataClass: 'P0', obligations: [], pins: { policyHash: 'p' } }, guardrails: [], cost: ZERO_COST },
    output: { payload, dataClass: 'P1' },
    pack: publicPackOf(fullPack()),
    ...(pack === null ? {} : { fullPack: freezePack(pack) as Readonly<unknown> }),
  });

  it('passes the real output and trips on every way it could be wrong', async () => {
    const cover = coverPlanOf();
    const { rendered } = await render(cover);
    expect(G_FILL.check(gctx(cover, rendered))).toEqual({ id: 'G-FILL', verdict: 'pass' });
    const last = rendered.plan.paragraphs.length - 1;
    const withPara = (i: number, text: string): Rendered => ({ ...rendered, plan: { ...rendered.plan, paragraphs: rendered.plan.paragraphs.map((p, j) => (j === i ? { ...p, text } : p)) } });
    const cases: [string, unknown, RegExp, unknown?][] = [
      ['another paragraph changed', withPara(0, `${rendered.plan.paragraphs[0]!.text} Extra.`), /paragraphs\[0\] changed/],
      ['a wrong fill', withPara(last, "I'm based in Pune, looking for a fully remote role, and available after a 1-day notice period. Thank you for considering my application."), /not the p4 fill/],
      ['a placeholder left', withPara(last, COVER_P4), /placeholder brace/],
      ['a changed resume', { ...rendered, plan: { ...rendered.plan, resume: { ...rendered.plan.resume, headline: 'CTO' } } }, /plan\.resume differs/],
      ['tampered text', { ...rendered, text: { ...rendered.text, resume: rendered.text.resume.replace('Asha Rao', 'Asha R.') } }, /text\.resume is not the document/],
      ['a brace in the text', { ...rendered, text: { ...rendered.text, cover: `${rendered.text.cover}\n{notice}` } }, /text\.cover still holds a placeholder brace/],
      ['a wrong format', { ...rendered, recommended: 'docx' }, /recommended is docx, the greenhouse profile gives pdf/],
      ['a missing file', { ...rendered, files: rendered.files.slice(1) }, /files are not the six expected documents/],
      ['pages on html', { ...rendered, files: rendered.files.map((f) => ({ ...f, pages: 1 })) }, /must be null/],
      ['no full pack', rendered, /no full pack/, null],
    ];
    for (const [what, payload, why, pack] of cases) {
      const v = G_FILL.check(gctx(cover, payload, pack === null ? null : fullPack()));
      expect(v.verdict, what).toBe('trip');
      expect(v.detail, what).toMatch(why);
      expect(v.detail, what).not.toContain('30-day');
    }
  });

  it('re-derives the fill from the full pack with office cities and an immediate notice, verbatim', async () => {
    const cover = coverPlanOf();
    const pack = fullPack({ answers: { ...fullPack().answers, notice_period: 'immediately' }, eligibility: { ...fullPack().eligibility, officeCities: ['pune'] } });
    const { rendered } = await render(cover, pack);
    const P4 = "I'm based in Pune and open to remote, office or hybrid roles, and available to start immediately. Thank you for considering my application.";
    expect(rendered.plan.paragraphs.at(-1)!.text).toBe(P4);
    expect(rendered.text.cover.split('\n')).toContain(P4);
    expect(G_FILL.check(gctx(cover, rendered, pack))).toEqual({ id: 'G-FILL', verdict: 'pass' });
    // the same output checked against the pack without office cities trips: the sentence is compared verbatim
    const v = G_FILL.check(gctx(cover, rendered, fullPack({ answers: pack.answers })));
    expect(v.verdict).toBe('trip');
    expect(v.detail).toMatch(/not the p4 fill/);
  });

  it('checks the fill against answers.yaml as it is now', async () => {
    const cover = coverPlanOf();
    const { rendered } = await render(cover);
    const v = G_FILL.check(gctx(cover, rendered, fullPack({ answers: { ...fullPack().answers, notice_period: '60 days' } })));
    expect(v.verdict).toBe('trip');
    expect(v.detail).toMatch(/not the p4 fill/);
  });

  it('G-NAMING covers the rendered text and the plan, but not the embedded source posting', async () => {
    const cover = coverPlanOf(posting({ descriptionText: `${posting().descriptionText} Formerly Initech.` }));
    const { rendered } = await render(cover);
    const ok = G_NAMING.check(gctx(cover, rendered));
    expect(ok.verdict).toBe('pass');
    const bad = G_NAMING.check(gctx(cover, { ...rendered, text: { ...rendered.text, resume: `${rendered.text.resume}\nInitech` } }));
    expect(bad).toMatchObject({ verdict: 'trip', detail: 'forbidden term #1 appears in text.resume' });
  });
});

describe('G-GROUND on the rendered letter', () => {
  const gctx = (input: CoverPlan, payload: unknown, full: unknown = fullPack(), pub: unknown = publicPackOf(fullPack())): GuardrailContext => ({
    side: 'out',
    contract: rendererContract,
    policy: PRODUCT_POLICY_V1,
    policyHash: 'p',
    contractHashOf: () => undefined,
    input: { envelopeId: 'e', stepKey: 's', index: 0, type: 'CoverPlan@1', producer: { agentId: 'cover-writer', version: '1.1.0', contractHash: 'h' }, parents: [], payload: input, handoff: { guarantees: [], dataClass: 'P0', obligations: [], pins: { policyHash: 'p' } }, guardrails: [], cost: ZERO_COST },
    output: { payload, dataClass: 'P1' },
    ...(pub === null ? {} : { pack: freezePack(pub) as Readonly<unknown> }),
    ...(full === null ? {} : { fullPack: freezePack(full) as Readonly<unknown> }),
  });

  it('passes the real output, and its letter is the expected text', async () => {
    const cover = coverPlanOf();
    const { rendered } = await render(cover);
    expect(G_GROUND.check(gctx(cover, rendered))).toEqual({ id: 'G-GROUND', verdict: 'pass' });
    expect(rendered.text.cover.split('\n').slice(2)).toEqual([
      'Dear Hiring Team,',
      "I'm applying for the Senior Backend Engineer (Java) role at Acme Payments. I'm a Senior Backend Engineer with 10+ years of experience. The role asks for Java, Spring and Kafka, and I've used all three in my work. Three examples follow.",
      'At Contoso Retail, I built the payments reconciliation service in Java and Postgres, processing 2M transactions nightly. At Northwind Labs, where I work now, I led the design of an event-driven order pipeline on Kafka handling 40M events a day.',
      'At Fabrikam, I built REST services in Java with Spring and MySQL for the store-locator product.',
      FILLED,
      'Sincerely,',
      'Asha Rao',
    ]);
  });

  it('re-renders p4 from the full pack with office cities and an immediate notice, and trips on the old sentence', async () => {
    const cover = coverPlanOf();
    const pack = fullPack({ answers: { ...fullPack().answers, notice_period: '0' }, eligibility: { ...fullPack().eligibility, officeCities: ['pune', 'mumbai'] } });
    const { rendered } = await render(cover, pack);
    const P4 = "I'm based in Pune, looking for a remote role, or an office or hybrid role in Pune or Mumbai, and available to start immediately. Thank you for considering my application.";
    expect(rendered.text.cover.split('\n').slice(2).at(-3)).toBe(P4);
    expect(G_GROUND.check(gctx(cover, rendered, pack))).toEqual({ id: 'G-GROUND', verdict: 'pass' });
    const v = G_GROUND.check(gctx(cover, rendered, fullPack({ answers: pack.answers })));
    expect(v.verdict).toBe('trip');
    expect(v.detail).not.toContain('Mumbai');
  });

  it('re-renders a letter with a signature sentence, and trips when it is tampered with', async () => {
    const pack = fullPack({ writing: { signatureFacts: ['f-nw-03'] } });
    const pub = publicPackOf(pack);
    const cover = coverPlanOf(posting(), pack);
    const { rendered } = await render(cover, pack);
    const SIG = 'Beyond the stack this role lists, at Northwind Labs: Migrated a multi-tenant SaaS billing module from a monolith to three microservices on Kubernetes.';
    expect(rendered.plan.paragraphs.at(-2)).toEqual({ text: SIG, factIds: ['f-nw-03'] });
    const lines = rendered.text.cover.split('\n');
    expect(lines[lines.indexOf(FILLED) - 1]).toBe(SIG);
    expect(G_GROUND.check(gctx(cover, rendered, pack, pub))).toEqual({ id: 'G-GROUND', verdict: 'pass' });
    expect(G_FILL.check({ ...gctx(cover, rendered, pack, pub) })).toEqual({ id: 'G-FILL', verdict: 'pass' });
    const tampered = { ...rendered, text: { ...rendered.text, cover: rendered.text.cover.replace('three microservices', 'four microservices') } };
    expect(G_GROUND.check(gctx(cover, tampered, pack, pub)).verdict).toBe('trip');
    // the same letter under a pack without signature facts trips: the plan's extra paragraph is not re-derived
    expect(G_GROUND.check(gctx(cover, rendered)).verdict).toBe('trip');
  });

  it('(a) trips when any one word of the rendered letter changes: text, paragraphs, verb, employer, notice or city', async () => {
    const cover = coverPlanOf();
    const { rendered } = await render(cover);
    const textSwap = (from: string, to: string): Rendered => {
      expect(rendered.text.cover, from).toContain(from);
      return { ...rendered, text: { ...rendered.text, cover: rendered.text.cover.replace(from, to) } };
    };
    const paraSwap = (i: number, from: string, to: string): Rendered => {
      expect(rendered.plan.paragraphs[i]!.text, from).toContain(from);
      return { ...rendered, plan: { ...rendered.plan, paragraphs: rendered.plan.paragraphs.map((p, j) => (j === i ? { ...p, text: p.text.replace(from, to) } : p)) } };
    };
    const both = (i: number, from: string, to: string): Rendered => {
      const x = paraSwap(i, from, to);
      return { ...x, text: { ...x.text, cover: x.text.cover.replace(from, to) } };
    };
    const cases: [string, Rendered][] = [
      ['a verb in the text', textSwap('I built the payments', 'I designed the payments')],
      ['the verb form', both(1, 'At Contoso Retail, I built the', 'At Contoso Retail: Built the')],
      ['the employer', both(1, 'At Contoso Retail,', 'At Northwind Labs,')],
      ['where I work now', both(1, ', where I work now,', ',')],
      ['the covered list', both(0, 'Java, Spring and Kafka', 'Java, Spring and Rust')],
      ['the notice', both(3, '30-day', '60-day')],
      ['the city', both(3, 'based in Pune', 'based in Mumbai')],
      ['the years', both(0, '10+ years', '12+ years')],
      ['the sign-off', textSwap('Sincerely,', 'Regards,')],
      ['one trailing space', textSwap('nightly.', 'nightly. ')],
    ];
    for (const [what, payload] of cases) {
      const v = G_GROUND.check(gctx(cover, payload));
      expect(v.verdict, what).toBe('trip');
      expect(v.detail, what).toMatch(/is not the letter re-rendered from recomputed slots/);
      expect(v.detail, what).not.toMatch(/Pune|30-day|Contoso/);
    }
  });

  it('re-derives the cover plan from the resume plan: a changed input paragraph trips even when the output matches it', async () => {
    const cover = coverPlanOf();
    const forged: CoverPlan = { ...cover, paragraphs: cover.paragraphs.map((p, i) => (i === 2 ? { ...p, text: p.text.replace('I built', 'I single-handedly built') } : p)) };
    const { rendered } = await render(forged);
    const v = G_GROUND.check(gctx(forged, rendered));
    expect(v.verdict).toBe('trip');
    expect(v.detail).toMatch(/paragraphs\[2\] is not the template rendering/);
  });

  it('fails closed without the public pack or the full pack', async () => {
    const cover = coverPlanOf();
    const { rendered } = await render(cover);
    expect(G_GROUND.check(gctx(cover, rendered, null)).detail).toMatch(/no full pack/);
    expect(G_GROUND.check(gctx(cover, rendered, fullPack(), null)).detail).toMatch(/no pack/);
  });
});

describe('(d) determinism from a fresh pack load', () => {
  it('plans and renders twice from scratch: byte-identical PDF, DOCX and HTML, and the same letter text', async () => {
    const run = async () => render(coverPlanOf(posting(), fullPack()), fullPack());
    const a = await run();
    const b = await run();
    expect(b.rendered.text).toEqual(a.rendered.text);
    expect(JSON.stringify(b.rendered.plan)).toBe(JSON.stringify(a.rendered.plan));
    for (const f of a.rendered.files) expect(Buffer.compare(readFileSync(join(a.out, f.path)), readFileSync(join(b.out, f.path))), f.path).toBe(0);
    // a different notice changes the cover bytes and nothing else
    const c = await render(coverPlanOf(), fullPack({ answers: { ...fullPack().answers, notice_period: '2 weeks' } }));
    const shaOf = (r: Rendered, name: string) => r.files.find((f) => f.path.endsWith(name))!.sha256;
    for (const n of ['resume.pdf', 'resume.docx', 'resume.html']) expect(shaOf(c.rendered, n), n).toBe(shaOf(a.rendered, n));
    for (const n of ['cover.pdf', 'cover.docx', 'cover.html']) expect(shaOf(c.rendered, n), n).not.toBe(shaOf(a.rendered, n));
    expect(c.rendered.text.cover).toContain('available after a 2-week notice period.');
  });
});

describe('M7: the kernel labels the renderer outputs P1', () => {
  it('runs the renderer through executeStep with the app guardrails: done, P1, G-FILL and G-NAMING passed', async () => {
    const out = tempOut();
    const cover = coverPlanOf();
    const store = Store.open(':memory:');
    const pHash = policyHash(PRODUCT_POLICY_V1);
    const input: Envelope = {
      envelopeId: 'cover-env', stepKey: 'cover-step', index: 0, type: 'CoverPlan@1',
      producer: { agentId: 'cover-writer', version: '1.0.0', contractHash: 'cw' }, parents: [], payload: cover,
      handoff: { guarantees: [], dataClass: 'P0', obligations: [], pins: { policyHash: pHash } }, guardrails: [], cost: ZERO_COST,
    };
    const full = fullPack();
    const res = await executeStep(
      {
        store, policy: PRODUCT_POLICY_V1, policyHash: pHash, providers: providersFor(out), clock: fixedClock('2026-10-09T00:00:00Z'), guardrails: appGuardrails(),
        contractHashOf: (id) => (id === 'cover-writer' ? 'cw' : contractHash(rendererContract)), sleep: async () => {},
        pack: freezePack(publicPackOf(full)), packHash: 'pub', fullPack: freezePack(full), fullPackHash: 'full',
      },
      'run', renderer, input,
    );
    expect(res.kind).toBe('done');
    if (res.kind !== 'done') return;
    expect(res.outputs).toHaveLength(1);
    expect(res.outputs[0]!.handoff.dataClass).toBe('P1');
    expect(res.outputs[0]!.guardrails.map((g) => `${g.id}:${g.verdict}`)).toEqual(expect.arrayContaining(['G-GROUND:pass', 'G-FILL:pass', 'G-NAMING:pass', 'G-DATACLASS:pass']));
    // committed after the guardrails: every listed file is at its final path with its recorded sha256
    const rendered = res.outputs[0]!.payload as Rendered;
    for (const f of rendered.files) expect(sha(readFileSync(join(out, f.path))), f.path).toBe(f.sha256);
    expect(readdirSync(join(out, '.pending'))).toEqual([]);
  });

  it('writes nothing under <jobKey>/ when an out guardrail trips', async () => {
    const out = tempOut();
    const store = Store.open(':memory:');
    const pHash = policyHash(PRODUCT_POLICY_V1);
    const input: Envelope = {
      envelopeId: 'cover-env', stepKey: 'cover-step', index: 0, type: 'CoverPlan@1',
      producer: { agentId: 'cover-writer', version: '1.0.0', contractHash: 'cw' }, parents: [], payload: coverPlanOf(),
      handoff: { guarantees: [], dataClass: 'P0', obligations: [], pins: { policyHash: pHash } }, guardrails: [], cost: ZERO_COST,
    };
    const guardrails = new GuardrailRegistry([...BUILTIN_GUARDRAILS, G_NAMING, { id: 'G-FILL', sides: ['out'], check: () => ({ id: 'G-FILL', verdict: 'trip', detail: 'refused for the test' }) }]);
    const full = fullPack();
    const res = await executeStep(
      {
        store, policy: PRODUCT_POLICY_V1, policyHash: pHash, providers: providersFor(out), clock: fixedClock('2026-10-09T00:00:00Z'), guardrails,
        contractHashOf: (id) => (id === 'cover-writer' ? 'cw' : contractHash(rendererContract)), sleep: async () => {},
        pack: freezePack(publicPackOf(full)), packHash: 'pub', fullPack: freezePack(full), fullPackHash: 'full',
      },
      'run', renderer, input,
    );
    expect(res.kind).toBe('quarantined');
    expect(existsSync(join(out, '0123456789abcdef'))).toBe(false);
    expect(readdirSync(join(out, '.pending'))).toEqual([]);
  });
});

describe('capability allow-list', () => {
  const base = { ...rendererContract, id: 'sneaky', description: 'Tries to read the full pack' };
  it("allows 'full', writable files and pdfText only to their agents (the daily and gig renderers, the qa-gate and gig-qa)", () => {
    expect(CAPABILITY_ALLOW_LIST).toEqual({
      fullPack: ['renderer', 'gig-renderer'],
      filesWrite: ['renderer', 'gig-renderer'],
      pdfText: ['qa-gate', 'gig-qa'],
      careersEgress: ['src-careers-list', 'src-careers-job'],
    });
    const sneaky = defineContract({ ...base });
    const { emits: _e, ...noEmits } = base;
    const reader = defineContract({ ...noEmits, id: 'peeker', kind: 'deterministic', capabilities: { files: { root: 'out', access: 'read' }, pdfText: true }, dataClasses: { in: ['P0'], out: ['P0'] } });
    expect(capabilityProblems([reader, sneaky, rendererContract])).toEqual([
      'peeker declares capabilities.pdfText; only qa-gate, gig-qa may run pdftotext',
      "sneaky declares capabilities.pack 'full'; only renderer, gig-renderer may read contact details",
      'sneaky declares writable files; only renderer, gig-renderer may write documents',
    ]);
    expect(capabilityProblems([rendererContract, qaGate.contract])).toEqual([]);
    // an agent object is checked by its contract
    expect(capabilityProblems([defineAgent(sneaky, async () => []).contract])).toHaveLength(2);
  });
});

describe('qa-gate', () => {
  const qaPack = (): QaPack => publicPackOf(fullPack()) as unknown as QaPack;
  const runQa = async (rendered: Rendered, out: string, extra: Partial<Providers> = {}) => {
    const [report] = await qaGate.run(rendered, ctxFor(qaGate, out, publicPackOf(fullPack()), extra, 'P1'));
    return QaReport.schema.parse(report);
  };

  it('declares read-only files, pdfText and the public pack', () => {
    expect(qaGate.contract.kind).toBe('deterministic');
    expect(qaGate.contract.capabilities).toEqual({ pack: true, files: { root: 'out', access: 'read' }, pdfText: true });
    expect(qaGate.contract.dataClasses).toEqual({ in: ['P1'], out: ['P1'] });
  });

  withPdftotext('passes every check on the real renderer output', async () => {
    const { rendered, out } = await render();
    const report = await runQa(rendered, out);
    expect(report.checks.map((c) => c.id)).toEqual(['qa.files', 'qa.pages', 'qa.terms', 'qa.hyphen', 'qa.docx-text', 'qa.pdf-text', 'qa.naming', 'qa.contact-intact']);
    expect(report.checks.filter((c) => !c.ok)).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.files).toEqual(rendered.files);
  });

  withPdftotext('fails qa.terms when a planned term is missing from the PDF text, by its display name', async () => {
    const { rendered, out } = await render();
    const strip: PdfTextProvider = async (abs, signal) => (await realPdfText!(abs, signal)).replaceAll('PostgreSQL', 'Postgres DB');
    const report = await runQa(rendered, out, { pdfText: strip });
    expect(rendered.plan.resume.covered).toContain('postgres');
    expect(report.ok).toBe(false);
    expect(report.checks.find((c) => c.id === 'qa.terms')).toEqual({ id: 'qa.terms', ok: false, detail: 'PostgreSQL is not in the resume PDF text' });
  });

  it('fails qa.pages, qa.hyphen, qa.pdf-text and qa.naming from a fake text layer', async () => {
    const { rendered, out } = await render();
    const fake: PdfTextProvider = async (abs) => (abs.endsWith('resume.pdf') ? `${rendered.text.resume}\fx\fy\fInitech multi-\nproduct\n` : `${rendered.text.cover}\f`);
    const report = await runQa(rendered, out, { pdfText: fake });
    const by = new Map(report.checks.map((c) => [c.id, c]));
    expect(by.get('qa.pages')!.detail).toMatch(/resume has 3 pages, the limit is 2/);
    expect(by.get('qa.hyphen')!.detail).toMatch(/resume\.pdf line \d+ ends in "-"/);
    expect(by.get('qa.pdf-text')!.detail).toMatch(/resume\.pdf text differs/);
    expect(by.get('qa.naming')!.detail).toBe('forbidden term #1 appears in 0123456789abcdef/resume.pdf');
    expect(by.get('qa.docx-text')!.ok).toBe(true);
    expect(report.ok).toBe(false);
  });

  it('fails qa.files and qa.docx-text when a file was changed or removed after rendering', async () => {
    const { rendered, out } = await render();
    const docxPath = join(out, '0123456789abcdef/resume.docx');
    const tampered = await renderDocx({ ...resumeModel(rendered.plan.resume, fullPack().contact), blocks: [{ kind: 'line', text: 'Someone else' }] });
    writeFileSync(docxPath, tampered);
    const fake: PdfTextProvider = async (abs) => (abs.endsWith('resume.pdf') ? `${rendered.text.resume}\f` : `${rendered.text.cover}\f`);
    const report = await runQa(rendered, out, { pdfText: fake });
    const by = new Map(report.checks.map((c) => [c.id, c]));
    expect(by.get('qa.files')!.detail).toBe('0123456789abcdef/resume.docx sha256 differs from the recorded one');
    expect(by.get('qa.docx-text')!.detail).toBe('0123456789abcdef/resume.docx text differs from the document text');
    const { rmSync } = await import('node:fs');
    rmSync(join(out, '0123456789abcdef/cover.html'));
    const again = await runQa(rendered, out, { pdfText: fake });
    expect(again.checks.find((c) => c.id === 'qa.files')!.detail).toMatch(/cover\.html cannot be read \(file 0123456789abcdef\/cover\.html does not exist\)/);
  });

  it('judges a line-end hyphen by the source text at that wrap point', () => {
    expect(hyphenProblems('built event-\ndriven systems\n', 'built event-driven systems')).toEqual([]);
    expect(hyphenProblems('built event-\ndriven systems\n', 'built event driven systems')).toEqual(['line 1 ends in "-"']);
    expect(hyphenProblems('  • Architect -\n    Associate.\n', '• Architect - Associate.')).toEqual([]);
    expect(hyphenProblems('Archi-\ntect - Associate.\n', 'Architect - Associate.')).toEqual(['line 1 ends in "-"']);
    expect(hyphenProblems('no hyphen\n', 'no hyphen')).toEqual([]);
    // the same words earlier in the text do not excuse an inserted hyphen later
    expect(hyphenProblems('a - b\nc d-\ne\n', 'a - b c d e')).toEqual(['line 2 ends in "-"']);
  });

  withPdftotext('passes a spaced hyphen from the source wherever the PDF wraps it ("Architect - Associate" at several widths)', async () => {
    const claim = 'AWS Certified Solutions Architect - Associate.';
    let wrappedAtHyphen = 0;
    for (let n = 0; n < 40; n++) {
      const text = `${'word '.repeat(n)}${'x'.repeat(n % 7)} ${claim}`.trim();
      const m = { kind: 'resume' as const, title: 't', author: 'a', date: '2026-10-01', blocks: [{ kind: 'bullet' as const, text, factId: 'f' }] };
      const pdf = await renderPdf(m);
      const out = tempOut();
      writeFileSync(join(out, 'h.pdf'), pdf.bytes);
      const layer = pdftotext(join(out, 'h.pdf'));
      if (layer.split('\n').some((l) => l.trimEnd().endsWith(' -'))) wrappedAtHyphen += 1;
      expect(hyphenProblems(layer, modelText(m)), text).toEqual([]);
    }
    expect(wrappedAtHyphen).toBeGreaterThan(0);
  });

  it('qaChecks is the AND of its checks and never names a forbidden term', async () => {
    const { rendered } = await render();
    const checks = qaChecks(rendered, qaPack(), { files: new Map(), pdfText: new Map() });
    expect(checks.every((c) => !c.ok || c.id === 'qa.hyphen' || c.id === 'qa.naming')).toBe(true);
    expect(JSON.stringify(checks).toLowerCase()).not.toContain('initech');
  });

  it('I8: fails qa.naming on a glued or look-alike term in a text layer (the strict check)', async () => {
    const { rendered, out } = await render();
    for (const t of ['InitechPay', 'I\u0578itech', 'Ini-\ntech']) {
      const fake: PdfTextProvider = async (abs) => (abs.endsWith('resume.pdf') ? `${rendered.text.resume}\n${t}\n` : rendered.text.cover);
      const report = await runQa(rendered, out, { pdfText: fake });
      expect(report.checks.find((c) => c.id === 'qa.naming'), JSON.stringify(t)).toEqual({ id: 'qa.naming', ok: false, detail: 'forbidden term #1 appears in 0123456789abcdef/resume.pdf' });
    }
  });

  it('fails qa.naming when an HTML preview names a forbidden term (tags stripped, entities decoded)', async () => {
    const { rendered, out } = await render();
    const htmlPath = join(out, '0123456789abcdef/cover.html');
    writeFileSync(htmlPath, readFileSync(htmlPath, 'utf8').replace('</main>', '<p>I<b></b>ni&#116;ech</p></main>'));
    const fake: PdfTextProvider = async (abs) => (abs.endsWith('resume.pdf') ? `${rendered.text.resume}\f` : `${rendered.text.cover}\f`);
    const report = await runQa(rendered, out, { pdfText: fake });
    expect(report.checks.find((c) => c.id === 'qa.naming')).toEqual({ id: 'qa.naming', ok: false, detail: 'forbidden term #1 appears in 0123456789abcdef/cover.html' });
    expect(htmlText('<p>a&amp;b &lt;x&gt; &#39;q&#39;</p>')).toBe(" a&b <x> 'q' ");
  });

  it('fails qa.naming when an HTML attribute value (data-fact) names a forbidden term', async () => {
    const { rendered, out } = await render();
    const htmlPath = join(out, '0123456789abcdef/resume.html');
    writeFileSync(htmlPath, readFileSync(htmlPath, 'utf8').replace('</main>', '<ul><li data-fact="initech-orders-01">x</li></ul></main>'));
    const fake: PdfTextProvider = async (abs) => (abs.endsWith('resume.pdf') ? `${rendered.text.resume}\f` : `${rendered.text.cover}\f`);
    const report = await runQa(rendered, out, { pdfText: fake });
    expect(report.checks.find((c) => c.id === 'qa.naming')).toEqual({ id: 'qa.naming', ok: false, detail: 'forbidden term #1 appears in 0123456789abcdef/resume.html (attributes)' });
    expect(htmlAttributeText('<li data-fact="a-b" class=\'x &amp; y\'>t</li>')).toBe('a-b\nx & y');
  });

  it('a renderer page count that disagrees with the text layer fails qa.pages', async () => {
    const { rendered, out } = await render();
    const lying: Rendered = { ...rendered, files: rendered.files.map((f) => (f.path.endsWith('resume.pdf') ? { ...f, pages: 2 } : f)) };
    const fake: PdfTextProvider = async (abs) => (abs.endsWith('resume.pdf') ? `${rendered.text.resume}\f` : `${rendered.text.cover}\f`);
    const report = await runQa(lying, out, { pdfText: fake });
    expect(report.checks.find((c) => c.id === 'qa.pages')!.detail).toBe('0123456789abcdef/resume.pdf has 1 pages, the renderer recorded 2');
  });
});

describe('render libraries', () => {
  it('render the same model to the same bytes in one process (no global counters)', async () => {
    const m = resumeModel(coverPlanOf().resume, fullPack().contact);
    const [a, b] = [await renderDocx(m), await renderDocx(m)];
    expect(sha(a)).toBe(sha(b));
    const [p, q] = [await renderPdf(m), await renderPdf(m)];
    expect(sha(p.bytes)).toBe(sha(q.bytes));
    expect(p.pages).toBeGreaterThanOrEqual(1);
  });

  it('count pages from pageAdded events', async () => {
    const m = resumeModel(coverPlanOf().resume, fullPack().contact);
    const long = { ...m, blocks: [...m.blocks, ...Array.from({ length: 80 }, (_, i) => ({ kind: 'bullet' as const, text: `Filler bullet number ${i} that is long enough to wrap onto a second line of the page.`, factId: `f${i}` }))] };
    const pdf = await renderPdf(long);
    expect(pdf.pages).toBeGreaterThan(2);
    if (PDFTOTEXT !== undefined) {
      const out = tempOut();
      writeFileSync(join(out, 'long.pdf'), pdf.bytes);
      expect((pdftotext(join(out, 'long.pdf')).match(/\f/g) ?? []).length).toBe(pdf.pages);
    }
  });
});

describe('contact line (L4): wraps only between " | " separators', () => {
  /** A fictional profile URL long enough that pdfkit used to break it inside, after "senior-". */
  const LONG = 'https://www.linkedin.com/in/asha-rao-senior-backend-engineer-distributed-systems-0a1b2c3d';
  const longPack = (): Pack => fullPack({ contact: { ...fullPack().contact, links: [LONG, 'https://github.com/asha-rao-example'] } });
  const tokens = (p: Pack) => contactTokens(contactLine(p.contact));

  it('splits the contact line into its tokens, and lays tokens out greedily, separators kept at the line end', () => {
    expect(contactTokens('a@example.com | +91 1 | Pune | https://x.test/a-b')).toEqual(['a@example.com', '+91 1', 'Pune', 'https://x.test/a-b']);
    expect(contactTokens('')).toEqual([]);
    const width = (s: string) => s.length;
    expect(wrapContact(['aaaa', 'bbbb', 'cccc'], width, 13)).toEqual(['aaaa | bbbb |', 'cccc']);
    expect(wrapContact(['aaaa', 'bbbb', 'cccc'], width, 100)).toEqual(['aaaa | bbbb | cccc']);
    // a token wider than the line stays whole on a line of its own
    expect(wrapContact(['a', 'x'.repeat(30), 'b'], width, 10)).toEqual(['a |', `${'x'.repeat(30)} |`, 'b']);
    expect(normText(wrapContact(['aaaa', 'bbbb', 'cccc'], width, 13).join('\n'))).toBe('aaaa | bbbb | cccc');
  });

  withPdftotext('keeps every contact token, URLs included, on one line of the PDF text layer (resume and cover)', async () => {
    const pack = longPack();
    const { rendered, out } = await render(coverPlanOf(posting(), pack), pack);
    for (const kind of ['resume', 'cover'] as const) {
      const lines = pdftotext(join(out, rendered.files.find((f) => f.kind === kind && f.format === 'pdf')!.path)).split('\n').map((l) => l.replace(/\s+/g, ' '));
      for (const t of tokens(pack)) expect(lines.some((l) => l.includes(t)), `${kind}: ${t}`).toBe(true);
    }
  });

  withPdftotext('passes qa.contact-intact on the real output and fails it when a URL is split across lines', async () => {
    const pack = longPack();
    const { rendered, out } = await render(coverPlanOf(posting(), pack), pack);
    const ok = await (async () => {
      const [r] = await qaGate.run(rendered, ctxFor(qaGate, out, publicPackOf(pack), {}, 'P1'));
      return QaReport.schema.parse(r);
    })();
    expect(ok.checks.find((c) => c.id === 'qa.contact-intact')).toEqual({ id: 'qa.contact-intact', ok: true, detail: 'ok' });
    expect(ok.ok).toBe(true);
    const split: PdfTextProvider = async (abs, signal) => (await realPdfText!(abs, signal)).replace('senior-backend', 'senior-\nbackend');
    const [bad] = await qaGate.run(rendered, ctxFor(qaGate, out, publicPackOf(pack), { pdfText: split }, 'P1'));
    const check = QaReport.schema.parse(bad).checks.find((c) => c.id === 'qa.contact-intact')!;
    expect(check.ok).toBe(false);
    expect(check.detail).toBe('0123456789abcdef/resume.pdf: contact item 4 is broken across lines; 0123456789abcdef/cover.pdf: contact item 4 is broken across lines');
    expect(check.detail).not.toContain('linkedin');
  });

  it('makes each DOCX contact token unbreakable (no-break spaces and hyphens), with the text layer unchanged', async () => {
    const pack = longPack();
    const m = resumeModel(coverPlanOf(posting(), pack).resume, pack.contact);
    const docx = await renderDocx(m);
    const xml = new TextDecoder().decode(readZip(docx).find((e) => e.name === 'word/document.xml')!.data);
    const contactPara = [...xml.matchAll(/<w:p\b[\s\S]*?<\/w:p>/g)].map((x) => x[0]).find((p) => p.includes('linkedin'))!;
    expect(contactPara).toContain('<w:noBreakHyphen/>');
    expect(contactPara).toContain('+91\u00A090000\u00A000000');
    expect(contactPara).not.toMatch(/linkedin[^<]*-/);
    expect(normText(docxText(docx))).toBe(normText(modelText(m)));
  });

  it('keeps each HTML contact token on one line (white-space: nowrap)', () => {
    const pack = longPack();
    const html = renderHtml(resumeModel(coverPlanOf(posting(), pack).resume, pack.contact));
    expect(html).toContain(`<span class="tok">${LONG}</span>`);
    expect(html).toMatch(/\.tok\{white-space:nowrap\}/);
    expect(htmlText(html)).toContain(contactLine(pack.contact));
  });
});

describe('determinism across processes and module boundaries', () => {
  it('renders byte-identical files in two separate processes (different TZ and locale)', () => {
    const script = join(import.meta.dirname, '../support/render-sample.ts');
    const run = (env: Record<string, string>) =>
      execFileSync(process.execPath, ['--import', 'tsx', script], { encoding: 'utf8', env: { ...process.env, ...env }, cwd: join(import.meta.dirname, '../..') }).trim();
    const a = run({ TZ: 'UTC', LANG: 'en_US.UTF-8' });
    const b = run({ TZ: 'America/Los_Angeles', LANG: 'ja_JP.UTF-8' });
    expect(JSON.parse(a)).toHaveLength(6);
    expect(b).toBe(a);
  }, 60_000);

  it('keeps the guardrail module free of render libraries (no pdfkit or docx behind G-FILL)', () => {
    const src = join(import.meta.dirname, '../../src');
    const seen = new Set<string>();
    const visit = (file: string): void => {
      if (seen.has(file)) return;
      seen.add(file);
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(/^(?:import|export)[^'"]*from\s+'([^']+)'/gm)) {
        const spec = m[1] as string;
        if (spec.startsWith('.')) visit(join(file, '..', spec.replace(/\.js$/, '.ts')));
        else seen.add(spec);
      }
    };
    visit(join(src, 'app/guardrails.ts'));
    const reached = [...seen].map((f) => f.replace(src, 'src'));
    expect(reached).not.toContain('pdfkit');
    expect(reached).not.toContain('docx');
    expect(reached.filter((f) => /render\/(pdf|docx|fonts)\.ts$/.test(f))).toEqual([]);
    expect(reached).toContain('src/app/render/fill.ts');
  });
});

describe('final fix L3: the newly allowed posting characters render and pass QA', () => {
  withPdftotext('LIVE RUN 1 titles go through the writing team, the renderer and every qa check', async () => {
    for (const title of [
      'Senior Full Stack Developer [Java, Angular]',
      'Principal Software Engineer_Fullstack',
      'Technical Lead - GPU Infrastructure (100% Remote - Worldwide)',
      'Senior PHP Backend Engineer (Remote, Full-Time) [AR025]',
      'Senior Backend Engineer "Core" @ Scale ‐ Payments*',
    ]) {
      const { rendered, out } = await render(coverPlanOf(posting({ title })));
      const [report] = await qaGate.run(rendered, ctxFor(qaGate, out, publicPackOf(fullPack()), {}, 'P1'));
      const qa = QaReport.schema.parse(report);
      expect(qa.checks.filter((c) => !c.ok), title).toEqual([]);
      expect(rendered.text.cover, title).toContain(title);
    }
  }, 120_000);
});
