import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { COVER_P4_THANKS } from '../../../src/app/agents/writing/templates.js';
import { gigQa, gigQaChecks } from '../../../src/app/freelance/writing/gig-qa.js';
import { gigPath, gigRenderer, gigRendererContract } from '../../../src/app/freelance/writing/gig-renderer.js';
import { coverPasteText, gigFilesOf, gigTexts } from '../../../src/app/freelance/writing/gig-text.js';
import { planGigDocs } from '../../../src/app/freelance/writing/proposal-planner.js';
import { GigDocsPlan, GigQaReport, GigRendered } from '../../../src/app/freelance/types.js';
import { G_FILL, G_GROUND } from '../../../src/app/guardrails.js';
import type { Pack } from '../../../src/app/pack/schema.js';
import { coverModel, modelText } from '../../../src/app/render/model.js';
import type { AnyAgent } from '../../../src/kernel/agent.js';
import { freezePack, issueContext } from '../../../src/kernel/broker.js';
import { fixedClock } from '../../../src/kernel/clock.js';
import type { Envelope } from '../../../src/kernel/envelope.js';
import { commitPending, openPending, type PendingFiles } from '../../../src/kernel/files.js';
import type { GuardrailContext } from '../../../src/kernel/guardrails/index.js';
import { PRODUCT_POLICY_V1 } from '../../../src/kernel/policy.js';
import { pdftotextProvider } from '../../../src/kernel/providers.js';
import { boardRole, fixturePack, scoredGig } from '../../support/gig-fixtures.js';

/** freelance-v2 Feature 2: the gig cover letter rendered like the daily one (PDF, DOCX, HTML) plus a paste-ready .txt. */

const PDFTOTEXT = ['/opt/homebrew/bin/pdftotext', '/usr/local/bin/pdftotext', '/usr/bin/pdftotext'].find((p) => existsSync(p));
const withPdftotext = PDFTOTEXT === undefined ? it.skip : it;
const { full, pub } = fixturePack();
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const planOf = (s = boardRole(), pack: unknown = pub): GigDocsPlan => planGigDocs(s, pack)!;

const KEY = 'd'.repeat(64);
const stages = new Map<string, PendingFiles>();
function ctxFor(agent: AnyAgent, out: string, pack: unknown) {
  const pending = agent.contract.capabilities.files?.access === 'read-write' ? openPending(out, KEY) : undefined;
  if (pending !== undefined) stages.set(out, pending);
  return issueContext({
    ...(pending !== undefined ? { pendingFiles: pending } : {}),
    contract: agent.contract,
    policy: PRODUCT_POLICY_V1,
    inputClass: agent === gigQa ? 'P1' : 'P0',
    providers: { fetch: async () => ({ status: 404, text: async () => '' }), fileRoots: { out }, ...(PDFTOTEXT ? { pdfText: pdftotextProvider(PDFTOTEXT) } : {}) },
    clock: fixedClock('2026-10-12T00:00:00Z'),
    signal: AbortSignal.timeout(60_000),
    pack: freezePack(pack),
  });
}
async function render(plan: GigDocsPlan, pack: Pack = full): Promise<{ r: GigRendered; out: string }> {
  const out = mkdtempSync(join(tmpdir(), 'jobpilot-gigcover-'));
  const [r] = await gigRenderer.run(plan, ctxFor(gigRenderer, out, pack));
  await stages.get(out)?.markFinal();
  await commitPending(out, KEY, PRODUCT_POLICY_V1.maxResponseBytes);
  return { r: GigRendered.schema.parse(r), out };
}
const qa = async (r: GigRendered, out: string, pack: unknown = pub): Promise<GigQaReport> => GigQaReport.schema.parse((await gigQa.run(r, ctxFor(gigQa, out, pack)))[0]);
const guard = (g: typeof G_GROUND, plan: GigDocsPlan, payload: unknown, fullPack: unknown = full): GuardrailContext => ({
  side: 'out', contract: gigRendererContract, policy: PRODUCT_POLICY_V1, policyHash: 'p', contractHashOf: () => undefined,
  input: { payload: plan, type: GigDocsPlan.id } as unknown as Envelope, output: { payload, dataClass: 'P1' }, pack: freezePack(pub), fullPack: freezePack(fullPack),
});

describe('the gig cover letter files', () => {
  it('a plan with a cover lists the pitch and CV first, then cover.txt, cover.pdf, cover.docx and cover.html; others are unchanged', () => {
    const p = planOf();
    expect(gigFilesOf(p).map((f) => f.path)).toEqual([
      gigPath(p.gigKey, 'pitch', 'txt'), gigPath(p.gigKey, 'resume', 'pdf'), gigPath(p.gigKey, 'resume', 'docx'),
      gigPath(p.gigKey, 'cover', 'txt'), gigPath(p.gigKey, 'cover', 'pdf'), gigPath(p.gigKey, 'cover', 'docx'), gigPath(p.gigKey, 'cover', 'html'),
    ]);
    const other = planOf(scoredGig({ kind: 'contract' }));
    expect(gigFilesOf(other).map((f) => `${f.kind}.${f.format}`)).toEqual(['pitch.txt', 'resume.pdf', 'resume.docx']);
    expect('cover' in gigTexts(other, full)).toBe(false);
  });

  it('the cover text is the daily cover model with the city filled; the paste text runs from the salutation to the name', () => {
    const p = planOf();
    const t = gigTexts(p, full);
    expect(t.cover).toBeDefined();
    const lines = t.cover!.split('\n');
    expect(lines[0]).toBe(full.contact.name);
    expect(lines[2]).toBe('Dear Hiring Team,');
    // the fixture answers.yaml notice_period is "30 days": the daily phrasing (noticePhrase)
    expect(t.cover).toContain(`I'm based in Pune, available after a 30-day notice period, and can work up to 20 hours a week alongside my current role, mostly 18:00-00:00 IST. ${COVER_P4_THANKS}`);
    expect(t.cover).not.toMatch(/[{}]/);
    const paste = coverPasteText(t.cover!);
    expect(paste.split('\n')[0]).toBe('Dear Hiring Team,');
    expect(paste.split('\n').at(-1)).toBe(full.contact.name);
    expect(paste).not.toContain(full.contact.email);
    // the same document model the daily renderer draws
    const filled = { ...p.cover!, paragraphs: p.cover!.paragraphs.map((x, i, a) => (i === a.length - 1 ? { ...x, text: x.text.replace('{city}', 'Pune').replace('{notice}', 'available after a 30-day notice period') } : x)) };
    expect(t.cover).toBe(modelText(coverModel(filled, full.contact)));
  });

  it('the availability clause follows answers.yaml notice_period like the job letters: immediate, a notice, none; and the city', () => {
    const p = planOf();
    const tail = 'can work up to 20 hours a week alongside my current role, mostly 18:00-00:00 IST.';
    const with_ = (answers: Record<string, string>, city = 'Pune') => gigTexts(p, { ...full, answers: { ...answers }, contact: { ...full.contact, city } }).cover ?? '';
    expect(with_({ notice_period: 'Immediately' })).toContain(`I'm based in Pune, available to start immediately, and ${tail}`);
    expect(with_({ notice_period: '0' })).toContain(`I'm based in Pune, available to start immediately, and ${tail}`);
    expect(with_({ notice_period: '30 days' })).toContain(`I'm based in Pune, available after a 30-day notice period, and ${tail}`);
    expect(with_({ notice_period: 'two months' })).toContain(`I'm based in Pune, available after a notice period of two months, and ${tail}`);
    expect(with_({})).toContain(`I'm based in Pune and ${tail}`);
    expect(with_({ notice_period: '30 days' }, '')).toContain(`I'm available after a 30-day notice period and ${tail}`);
    expect(with_({}, '')).toContain(`I ${tail}`);
    for (const t of [with_({}), with_({}, ''), with_({ notice_period: '30 days' }, '')]) {
      expect(t).not.toMatch(/[{}]|right away/);
      expect(t).not.toMatch(/based in ,|available after ,/);
    }
  });

  it('an unsafe city or notice blocks only the cover letter, with a named reason; the pitch and CV texts stay', () => {
    const p = planOf();
    const city = gigTexts(p, { ...full, contact: { ...full.contact, city: 'Pune {notice}' } });
    expect(city.cover).toBeUndefined();
    expect(city.coverBlocked).toMatch(/contact\.yaml city cannot go into the cover letter/);
    expect(city.pitch).not.toBeNull();
    expect(city.resume).not.toBe('');
    const notice = gigTexts(p, { ...full, answers: { notice_period: 'see https://x.example' } });
    expect(notice.coverBlocked).toMatch(/notice_period cannot go into a document/);
  });
});

describe('gig-renderer and gig-qa with a cover letter', () => {
  withPdftotext('renders the cover PDF (1 page), DOCX and HTML like the job letters and the .txt, and gig-qa passes every check', async () => {
    const plan = planOf();
    const { r, out } = await render(plan);
    expect(r.files.map((f) => `${f.kind}.${f.format}`)).toEqual(['pitch.txt', 'resume.pdf', 'resume.docx', 'cover.txt', 'cover.pdf', 'cover.docx', 'cover.html']);
    for (const f of r.files) expect(sha(readFileSync(join(out, f.path))), f.path).toBe(f.sha256);
    expect(r.files.find((f) => f.kind === 'cover' && f.format === 'pdf')?.pages).toBe(1);
    expect(readFileSync(join(out, gigPath(plan.gigKey, 'cover', 'txt')), 'utf8')).toBe(`${coverPasteText(r.text.cover!)}\n`);
    expect(r.text.cover).toBe(gigTexts(plan, full).cover);
    const rep = await qa(r, out);
    expect(rep.checks.filter((c) => !c.ok)).toEqual([]);
    expect(rep.checks.map((c) => c.id)).toEqual(expect.arrayContaining(['cover.text']));
    // byte-identical on a second render
    const again = await render(plan);
    expect(again.r.files).toEqual(r.files);
    // G-GROUND and G-FILL pass the real output
    expect(G_GROUND.check(guard(G_GROUND, plan, r)).verdict).toBe('pass');
    expect(G_FILL.check(guard(G_FILL, plan, r)).verdict).toBe('pass');
  });

  withPdftotext('gig-qa fails a cover .txt that is not the letter, a missing cover file, and a forbidden term in the cover', async () => {
    const plan = planOf();
    const { r, out } = await render(plan);
    const read = async () => {
      const files = new Map<string, { bytes: Uint8Array; sha256: string }>();
      const pdfText = new Map<string, string>();
      for (const f of gigFilesOf(plan)) {
        const bytes = new Uint8Array(readFileSync(join(out, f.path)));
        files.set(f.path, { bytes, sha256: sha(bytes) });
        if (f.format === 'pdf') pdfText.set(f.path, await pdftotextProvider(PDFTOTEXT!)(join(out, f.path), AbortSignal.timeout(30_000)));
      }
      return { files, pdfText };
    };
    const base = await read();
    const ok = gigQaChecks(r, pub, base);
    expect(ok.filter((c) => !c.ok)).toEqual([]);
    const txtPath = gigPath(plan.gigKey, 'cover', 'txt');
    const edited = new TextEncoder().encode('Dear Hiring Team,\nPlease pay me more.\n');
    const changed = new Map(base.files);
    changed.set(txtPath, { bytes: edited, sha256: sha(edited) });
    const c1 = gigQaChecks({ ...r, files: r.files.map((f) => (f.path === txtPath ? { ...f, sha256: sha(edited) } : f)) }, pub, { files: changed, pdfText: base.pdfText });
    expect(c1.find((c) => c.id === 'cover.text')?.ok).toBe(false);
    const gone = new Map(base.files);
    gone.delete(gigPath(plan.gigKey, 'cover', 'docx'));
    const c2 = gigQaChecks(r, pub, { files: gone, pdfText: base.pdfText });
    expect(c2.find((c) => c.id === 'qa.files')?.ok).toBe(false);
    expect(c2.find((c) => c.id === 'qa.docx-text')?.ok).toBe(false);
    const named = { ...r, text: { ...r.text, cover: `${r.text.cover!}\nInitech` } };
    const c3 = gigQaChecks(named, pub, base);
    expect(c3.find((c) => c.id === 'gig.naming')?.ok).toBe(false);
    const pdfPath = gigPath(plan.gigKey, 'cover', 'pdf');
    const twoPages = new Map(base.pdfText);
    twoPages.set(pdfPath, `${base.pdfText.get(pdfPath)!}\f${base.pdfText.get(pdfPath)!}`);
    expect(gigQaChecks(r, pub, { files: base.files, pdfText: twoPages }).find((c) => c.id === 'qa.pages')?.detail).toMatch(/the cover letter has \d+ pages, the limit is 1/);
  });

  it('G-GROUND and G-FILL trip on a cover text that is not the plan re-rendered with the contact city, and on dropped cover files', async () => {
    const plan = planOf();
    const t = gigTexts(plan, full);
    const files = gigFilesOf(plan).map((f) => ({ ...f, sha256: 'a'.repeat(64), pages: f.format === 'pdf' ? 1 : null }));
    const good: GigRendered = { gigKey: plan.gigKey, files, plan, text: t };
    expect(G_GROUND.check(guard(G_GROUND, plan, good))).toEqual({ id: 'G-GROUND', verdict: 'pass' });
    expect(G_FILL.check(guard(G_FILL, plan, good)).verdict).toBe('pass');
    const moved = { ...good, text: { ...t, cover: t.cover!.replace('Pune', 'Mumbai') } };
    expect(G_GROUND.check(guard(G_GROUND, plan, moved)).detail).toMatch(/text\.cover line \d+ is not the document re-rendered/);
    expect(G_FILL.check(guard(G_FILL, plan, moved)).detail).toMatch(/text\.cover is not the letter filled from contact\.yaml/);
    const held = { ...good, text: { ...t, cover: t.cover!.replace('Pune', '{city}') } };
    expect(G_FILL.check(guard(G_FILL, plan, held)).detail).toMatch(/placeholder/);
    const dropped = { ...good, files: files.slice(0, 3), text: { ...t, cover: undefined } };
    const { cover: _x, ...noCoverText } = dropped.text;
    expect(G_GROUND.check(guard(G_GROUND, plan, { ...dropped, text: noCoverText })).verdict).toBe('trip');
    // a gig without a cover: G-FILL has nothing to fill and passes
    const other = planOf(scoredGig({ kind: 'contract' }));
    const ot = gigTexts(other, full);
    const otherOut: GigRendered = { gigKey: other.gigKey, files: gigFilesOf(other).map((f) => ({ ...f, sha256: 'a'.repeat(64), pages: f.format === 'pdf' ? 1 : null })), plan: other, text: ot };
    expect(G_FILL.check(guard(G_FILL, other, otherOut)).verdict).toBe('pass');
  });

  it('the gig renderer names G-FILL among its guardrails', () => {
    expect(gigRendererContract.guardrails.out).toEqual(expect.arrayContaining(['G-GROUND', 'G-FILL', 'G-NAMING']));
  });
});

describe('cover failures stay contained (freelance-v2 review)', () => {
  withPdftotext('an unsafe city blocks only the letter: the pitch and CV are written, the reason is named, G-GROUND, G-FILL and gig-qa pass', async () => {
    const plan = planOf();
    const bad = { ...full, contact: { ...full.contact, city: 'Pune www.example.com' } };
    const { r, out } = await render(plan, bad);
    expect(r.files.map((f) => `${f.kind}.${f.format}`)).toEqual(['pitch.txt', 'resume.pdf', 'resume.docx']);
    expect(r.coverBlocked).toMatch(/contact\.yaml city cannot go into the cover letter/);
    expect(r.text.cover).toBeUndefined();
    expect(G_GROUND.check(guard(G_GROUND, plan, r, bad))).toEqual({ id: 'G-GROUND', verdict: 'pass' });
    expect(G_FILL.check(guard(G_FILL, plan, r, bad)).verdict).toBe('pass');
    expect((await qa(r, out)).checks.filter((c) => !c.ok)).toEqual([]);
  });

  withPdftotext('a letter over one page is blocked at render time, named; the rest of the gig renders and passes', async () => {
    // fictional long claims (verbatim facts may be long): the top facts fill more than one page
    const long = (c: string) => `${c} ${'Designed, built and ran the service end to end with careful testing, reviews and on-call ownership. '.repeat(40)}`.trim();
    const facts = full.facts.map((f) => (f.kind === 'experience' && f.employer === 'Northwind Labs' ? { ...f, claim: long(f.claim) } : f));
    const bigFull = { ...full, facts };
    const { contact: _c, answers: _a, ...bigPub } = bigFull;
    const plan = planGigDocs(boardRole(), bigPub)!;
    expect(plan.cover).toBeDefined();
    const { r, out } = await render(plan, bigFull);
    expect(r.coverBlocked).toMatch(/^the cover letter has [2-9] pages, the limit is 1$/);
    expect(r.files.map((f) => f.kind)).toEqual(['pitch', 'resume', 'resume']);
    expect(G_GROUND.check({ ...guard(G_GROUND, plan, r, bigFull), pack: freezePack(bigPub) })).toEqual({ id: 'G-GROUND', verdict: 'pass' });
    expect((await qa(r, out, bigPub)).ok).toBe(true);
    // a blocked reason that is neither re-derived nor a render-time one trips
    const lied = { ...r, coverBlocked: 'the employer did not ask for one' };
    expect(G_GROUND.check({ ...guard(G_GROUND, plan, lied, bigFull), pack: freezePack(bigPub) }).detail).toMatch(/coverBlocked names no render-time reason/);
  });

  it('G-FILL trips on a cover whose notice clause is not answers.yaml filled and phrased', () => {
    const plan = planOf();
    const t = gigTexts(plan, full);
    const files = gigFilesOf(plan).map((f) => ({ ...f, sha256: 'a'.repeat(64), pages: f.format === 'pdf' ? 1 : null }));
    const changed = { gigKey: plan.gigKey, files, plan, text: { ...t, cover: t.cover!.replace('a 30-day notice period', 'a 7-day notice period') } } as GigRendered;
    expect(G_FILL.check(guard(G_FILL, plan, changed)).detail).toMatch(/not the letter filled from contact\.yaml and answers\.yaml/);
  });

  it('gig-qa cover.no-terms fails a letter whose opening states pay or hours', () => {
    const plan = planOf();
    const p1 = plan.cover!.paragraphs[0]!;
    const tampered = { ...plan, cover: { ...plan.cover!, paragraphs: [{ ...p1, text: p1.text.replace('role at', 'role ($60/hr) at') }, ...plan.cover!.paragraphs.slice(1)] } };
    const t = gigTexts(plan, full);
    const checks = gigQaChecks({ gigKey: plan.gigKey, files: [], plan: tampered, text: t }, pub, { files: new Map(), pdfText: new Map() });
    expect(checks.find((c) => c.id === 'cover.no-terms')?.ok).toBe(false);
    expect(gigQaChecks({ gigKey: plan.gigKey, files: [], plan, text: t }, pub, { files: new Map(), pdfText: new Map() }).find((c) => c.id === 'cover.no-terms')?.ok).toBe(true);
  });
});
