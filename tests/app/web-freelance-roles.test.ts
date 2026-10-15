import { createHash } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Gig, GigRendered } from '../../src/app/freelance/types.js';
import { AppStore, type GigDoc, type GigUpsert } from '../../src/app/store/app-store.js';
import { createDashboard } from '../../src/app/web/server.js';
import { Sessions } from '../../src/app/web/security.js';
import { Store as KernelStore } from '../../src/kernel/store/store.js';

/**
 * freelance-v2 Feature 1: "Contract roles matching your stack" at the top of the Freelance tab (UI only, no rule
 * change), and the gig page's cover letter card (Feature 2). A temp JOBPILOT_HOME with the fictional pack; gig rows
 * through the app store, Gig@1 and GigRendered@1 envelopes as a run leaves them, documents under out/gigs/<key>/.
 */
const root = join(import.meta.dirname, '../..');
const NOW = '2026-10-15T09:30:00.000Z'; // 15:00 IST
const B1 = 'b1b1b1b1b1b1b1b1'; // boards, review (pay & hours unstated), fit 72, posted 11 Oct, documents with a cover
const H2 = 'b2b2b2b2b2b2b2b2'; // himalayas, review (hours unstated), fit 72, posted 13 Oct, no documents yet
const B3 = 'b3b3b3b3b3b3b3b3'; // boards, review, fit 90: a re-read of H7's posting, so it yields to H7 (duplicate_of)
const B4 = 'b4b4b4b4b4b4b4b4'; // boards, review, fit 40: under the fit floor (45)
const B5 = 'b5b5b5b5b5b5b5b5'; // boards, contracts list, fit 80: not a review item
const F6 = 'f6f6f6f6f6f6f6f6'; // freelancer contract, review, fit 80: a marketplace, not an employer board
const H7 = 'b7b7b7b7b7b7b7b7'; // himalayas, review, fit 85, the direct listing of B3's posting; markup in title and company
const COVER = 'Dear Hiring Team,\nI\'m applying for the Senior Backend Engineer role at Example Robotics.\n\nSincerely,\nAsha Rao';
const PITCH = 'Backend engineer for your payments team.\nAvailable 20 h a week.';

const sha = (b: string): string => createHash('sha256').update(b).digest('hex');
let home: string;
let out: string;
type App = { request: (path: string, init?: RequestInit) => Promise<Response> };
let app: App;
let cookie = '';

function removeHome(dir: string): void {
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory() && !e.isSymbolicLink()) {
        chmodSync(join(d, e.name), 0o755);
        walk(join(d, e.name));
      }
    }
  };
  if (existsSync(dir)) walk(dir);
  rmSync(dir, { recursive: true, force: true });
}
const withStore = <T>(fn: (s: AppStore) => T): T => {
  const s = AppStore.open(join(home, 'jobpilot.db'));
  try {
    return fn(s);
  } finally {
    s.close();
  }
};
let seq = 0;
function seedEnvelope(type: string, payload: unknown): void {
  const ks = KernelStore.open(join(home, 'jobpilot.db'));
  try {
    seq += 1;
    const id = `seed-${type}-${seq}`;
    ks.putSeed(id, {
      envelopeId: id, stepKey: id, index: 0, type, producer: { agentId: 'test', version: '1.0.0', contractHash: 'h' }, parents: [], payload,
      handoff: { guarantees: [], dataClass: 'P1', obligations: [], pins: { policyHash: 'p' } }, guardrails: [], cost: { usd: 0, inputTokens: 0, outputTokens: 0 },
    }, '1', 'h');
  } finally {
    ks.close();
  }
}

const NO_CLIENT = { name: null, country: null, paymentVerified: null, hireRate: null, spendUsd: null, reviews: null, since: null };
function gigOf(key: string, over: Partial<Gig> = {}): Gig {
  return {
    gigKey: key, dedupeKey: key, platform: 'boards', sourceId: key, url: `https://jobs.example.com/roles/${key}`, title: `Backend Engineer ${key}`,
    description: 'Contract backend role in Java with Kafka on AWS.', client: { ...NO_CLIENT, name: 'Example Robotics' }, kind: 'contract',
    budget: { type: 'unknown', min: null, max: null, currency: null, usdPerUnit: null }, hoursPerWeek: { min: null, max: null, source: null },
    duration: { weeks: null, text: null }, timezone: { required: null, overlapText: null }, location: { countries: ['india'], worldwide: false, text: 'India' },
    skills: [], postedAt: '2026-10-11T09:00:00.000Z', bids: null, ...over,
  };
}
function upsert(s: AppStore, g: Gig, over: Partial<GigUpsert>): void {
  s.upsertGig({
    gigKey: g.gigKey, dedupeKey: g.dedupeKey, platform: g.platform, sourceId: g.sourceId, url: g.url, title: g.title, description: g.description,
    client: g.client, kind: g.kind, budget: g.budget, rate: { minUsdH: null, maxUsdH: null, method: 'unknown', fxDate: null, fxSource: null, budgetUsd: null },
    hours: g.hoursPerWeek, verdict: 'review', reasons: ['rate-unclear', 'hours-unclear'], notes: ['rate not stated - ask', 'hours not stated - ask'], flags: [],
    fit: 72, breakdown: { base: 30, 'strong:java': 4 }, list: 'review', docsState: 'none', docsDetail: null, postedAt: g.postedAt, at: '2026-10-15T02:00:00.000Z', ...over,
  });
}
/** Writes a contract's pitch, contract CV and cover letter under out/gigs/<key>/ and records them ready. */
function writeDocs(s: AppStore, key: string): GigDoc[] {
  mkdirSync(join(out, 'gigs', key), { recursive: true });
  const files: [GigDoc['kind'], GigDoc['format'], string][] = [
    ['pitch', 'txt', `${PITCH}\n`], ['resume', 'pdf', `cv pdf ${key}`], ['resume', 'docx', `cv docx ${key}`],
    ['cover', 'txt', `${COVER}\n`], ['cover', 'pdf', `cover pdf ${key}`], ['cover', 'docx', `cover docx ${key}`], ['cover', 'html', `<p>cover ${key}</p>`],
  ];
  const docs = files.map(([k, f, body]) => {
    writeFileSync(join(out, 'gigs', key, `${k}.${f}`), body);
    return { kind: k, format: f, path: `gigs/${key}/${k}.${f}`, sha256: sha(body), pages: f === 'pdf' ? 1 : null };
  });
  s.putGigDocs(key, docs);
  return docs;
}
const renderedOf = (key: string, docs: GigDoc[], covered: string[]): GigRendered =>
  ({
    gigKey: key, files: docs,
    plan: { gigKey: key, scored: {} as never, platform: 'boards', proposal: null, pitch: { lines: [{ text: 'Backend engineer for your payments team.', factIds: [] }] }, resume: {} as never, covered, missing: ['kubernetes'], cover: {} as never },
    text: { proposal: null, pitch: PITCH, resume: '', cover: '' },
  }) as GigRendered;

function seed(): void {
  const b1 = gigOf(B1, { title: 'Senior Backend Engineer - Java (6-month contract)', location: { countries: ['india'], worldwide: false, text: 'India' } });
  const h2 = gigOf(H2, { platform: 'himalayas', title: 'Platform Engineer (Go)', postedAt: '2026-10-13T09:00:00.000Z', client: { ...NO_CLIENT, name: 'Example Payments' }, location: { countries: [], worldwide: true, text: null } });
  const b3 = gigOf(B3, { title: 'Same role elsewhere' });
  const b4 = gigOf(B4, { title: 'Low fit contract' });
  const b5 = gigOf(B5, { title: 'Paid contract' });
  const f6 = gigOf(F6, { platform: 'freelancer', title: 'Marketplace contract' });
  const h7 = gigOf(H7, { platform: 'himalayas', dedupeKey: B3, title: '<img src=x onerror=alert(1)> Lead "Engineer"', client: { ...NO_CLIENT, name: '<b>Evil</b> & Co' } });
  withStore((s) => {
    upsert(s, b1, { docsState: 'ready' });
    upsert(s, h2, { reasons: ['hours-unclear'], notes: ['hours not stated - ask'], rate: { minUsdH: 60, maxUsdH: 60, method: 'stated', fxDate: null, fxSource: null, budgetUsd: null } });
    upsert(s, b3, { fit: 90 });
    upsert(s, b4, { fit: 40, list: 'below-floor' });
    upsert(s, b5, { fit: 80, list: 'contracts', verdict: 'eligible', reasons: [], notes: [] });
    upsert(s, f6, { fit: 80 });
    upsert(s, h7, { fit: 85, at: '2026-10-15T02:10:00.000Z' });
    const docs = writeDocs(s, B1);
    return docs;
  });
  const docs = withStore((s) => s.getGig(B1)!.docs);
  for (const g of [b1, h2, b3, b4, b5, f6, h7]) seedEnvelope('Gig@1', g);
  seedEnvelope('GigRendered@1', renderedOf(B1, docs, ['java', 'kafka', 'aws', 'postgres', 'redis']));
}

const get = async (path: string): Promise<{ status: number; body: string }> => {
  const r = await app.request(path, { headers: { host: 'localhost', cookie } });
  return { status: r.status, body: await r.text() };
};
const text = (b: string): string => b.replace(/<[^>]*>/g, ' ').replace(/&#0?39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const rolesOf = (body: string): string[] => [...body.matchAll(/data-role="([0-9a-f]{16})"/g)].map((m) => m[1] as string);
const sectionOf = (body: string): string => /<section[^>]*id="contract-roles"[\s\S]*?<\/section>/.exec(body)?.[0] ?? '';

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'jobpilot-webroles-'));
  cpSync(join(root, 'tests/fixtures/pack'), join(home, 'pack'), { recursive: true });
  out = join(home, 'out');
  mkdirSync(out);
  seed();
  const raw = createDashboard({ home, clock: { now: () => NOW }, sessions: new Sessions(Buffer.alloc(32, 7)) });
  app = { request: async (path, init = {}) => raw.request(path, { ...init, headers: { host: 'localhost', ...((init.headers as Record<string, string> | undefined) ?? {}) } }) };
  const res = await app.request('/freelance');
  cookie = /jp_sid=[0-9a-f]{32}/.exec(res.headers.get('set-cookie') ?? '')?.[0] ?? '';
});
afterEach(() => removeHome(home));

describe('Contract roles matching your stack (top of the Freelance tab)', () => {
  it('sits at the top of the Freelance tab, before the Contracts list', async () => {
    const { status, body } = await get('/freelance');
    expect(status).toBe(200);
    const at = body.indexOf('id="contract-roles"');
    expect(at).toBeGreaterThan(0);
    expect(at).toBeLessThan(body.indexOf('<ol class="gigs"') < 0 ? body.indexOf('class="empty"') : body.indexOf('<ol class="gigs"'));
    expect(text(sectionOf(body))).toContain('Contract roles matching your stack');
  });

  it('lists only review contracts from employer job boards at or above the fit floor, by fit then newest posted', async () => {
    const { body } = await get('/freelance');
    // B3 (boards) is another listing of H7 (Himalayas, the direct source): duplicate listings are left out, as on every list
    expect(rolesOf(sectionOf(body))).toEqual([H7, H2, B1]);
  });

  it('a row shows title, company, remote scope, fit and matched skills, what to ask, the documents and the apply link', async () => {
    const s = sectionOf((await get('/freelance')).body);
    const row = /<li[^>]*data-role="b1b1b1b1b1b1b1b1"[\s\S]*?<\/li>/.exec(s)?.[0] ?? '';
    const t = text(row);
    expect(row).toContain(`href="/freelance/${B1}"`);
    expect(t).toContain('Senior Backend Engineer - Java (6-month contract)');
    expect(t).toContain('Example Robotics');
    expect(t).toContain('Remote: India');
    expect(t).toMatch(/\b72\b/);
    expect(t).toContain('Java, Kafka, AWS');
    expect(t).toContain('Ask pay & hours');
    for (const f of ['resume.pdf', 'resume.docx', 'pitch.txt', 'cover.pdf', 'cover.docx', 'cover.txt']) expect(row).toContain(`href="/freelance/${B1}/files/${f}"`);
    expect(t).toContain('Cover letter (PDF)');
    expect(row).toMatch(/<a class="src-link" href="https:\/\/jobs\.example\.com\/roles\/b1b1b1b1b1b1b1b1" rel="noopener noreferrer" target="_blank">Apply on the posting/);
    const h2 = text(/<li[^>]*data-role="b2b2b2b2b2b2b2b2"[\s\S]*?<\/li>/.exec(s)?.[0] ?? '');
    expect(h2).toContain('Ask hours');
    expect(h2).not.toContain('Ask pay');
    expect(h2).toContain('Remote, worldwide');
    expect(h2).toContain('Himalayas');
    expect(h2).toContain('No documents yet');
  });

  it('escapes every value', async () => {
    const s = sectionOf((await get('/freelance')).body);
    expect(s).not.toContain('<img src=x');
    expect(s).not.toContain('<b>Evil</b>');
    expect(s).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(s).toContain('&lt;b&gt;Evil&lt;/b&gt; &amp; Co');
  });

  it('the tab summary counts the roles on every Freelance page', async () => {
    for (const path of ['/freelance', '/freelance?tab=review', '/freelance/networks', '/freelance/sources']) {
      const nav = /<nav class="tabs"[\s\S]*?<\/nav>/.exec((await get(path)).body)?.[0] ?? '';
      expect(nav, path).toMatch(/<a href="\/freelance#contract-roles">Contract roles <span class="num tab-count">3<\/span><\/a>/);
    }
  });

  it('changes no rule: the rows stay in Review (marked as also listed above) and Contracts is unchanged', async () => {
    const review = (await get('/freelance?tab=review')).body;
    const reviewRows = [...review.matchAll(/data-gig="([0-9a-f]{16})"/g)].map((m) => m[1]);
    for (const k of [B1, H2, H7]) expect(reviewRows).toContain(k);
    const b1 = /<li class="gig" data-gig="b1b1b1b1b1b1b1b1"[\s\S]*?<div class="gig-status">/.exec(review)?.[0] ?? '';
    expect(text(b1)).toContain('Also in Contract roles');
    const f6 = /<li class="gig" data-gig="f6f6f6f6f6f6f6f6"[\s\S]*?<div class="gig-status">/.exec(review)?.[0] ?? '';
    expect(text(f6)).not.toContain('Also in Contract roles');
    const contracts = (await get('/freelance')).body.split('id="contract-roles"')[1]!.split('</section>').slice(1).join('</section>');
    expect([...contracts.matchAll(/data-gig="([0-9a-f]{16})"/g)].map((m) => m[1])).toEqual([B5]);
    const g = withStore((s) => s.getGig(B1)!);
    expect([g.list, g.verdict]).toEqual(['review', 'review']);
  });

  it('with no such role it says so, and the section stays', async () => {
    withStore((s) => {
      for (const k of [B1, H2, H7]) s.kernel.db.prepare(`UPDATE gigs SET fit = 10 WHERE gig_key = ?`).run(k);
    });
    const s = sectionOf((await get('/freelance')).body);
    expect(rolesOf(s)).toEqual([]);
    expect(text(s)).toContain('No contract role from an employer job board is at or above your fit floor yet.');
  });
});

describe('review minors: fit at the floor, a cover.txt naming a forbidden term, the HTML link, why there is no letter', () => {
  it('a role with fit exactly at the fit floor (45) is listed', async () => {
    withStore((s) => s.kernel.db.prepare(`UPDATE gigs SET fit = 45 WHERE gig_key = ?`).run(H2));
    expect(rolesOf(sectionOf((await get('/freelance')).body))).toContain(H2);
    withStore((s) => s.kernel.db.prepare(`UPDATE gigs SET fit = 44.9 WHERE gig_key = ?`).run(H2));
    expect(rolesOf(sectionOf((await get('/freelance')).body))).not.toContain(H2);
  });

  it('the card hides a cover.txt that names a forbidden term: no text, no Copy, and its files are refused', async () => {
    const named = `${COVER}\nInitech\n`;
    writeFileSync(join(out, 'gigs', B1, 'cover.txt'), named);
    withStore((s) => s.putGigDocs(B1, s.getGig(B1)!.docs.map((d) => (d.path.endsWith('cover.txt') ? { ...d, sha256: sha(named) } : d))));
    const { body } = await get(`/freelance/${B1}`);
    const card = /<section class="card wide" aria-labelledby="cover-h">[\s\S]*?<\/section>/.exec(body)?.[0] ?? '';
    expect(text(card)).toContain('The cover letter names a forbidden term');
    expect(card).not.toContain('id="cover-text"');
    expect(card).not.toContain('data-copy-src');
    expect(body).not.toContain('Initech');
    expect((await get(`/freelance/${B1}/files/cover.pdf`)).status).toBe(403);
  });

  it('the card links the HTML letter as well as PDF, DOCX and .txt', async () => {
    const card = /<section class="card wide" aria-labelledby="cover-h">[\s\S]*?<\/section>/.exec((await get(`/freelance/${B1}`)).body)?.[0] ?? '';
    expect(card).toContain(`href="/freelance/${B1}/files/cover.html"`);
    expect(text(card)).toContain('Cover letter (web page, HTML)');
  });

  it('a gig with no letter says why: the planner note, or the reason the renderer blocked it', async () => {
    const h2Docs = withStore((s) => {
      mkdirSync(join(out, 'gigs', H2), { recursive: true });
      const files: GigDoc[] = (['pitch.txt', 'resume.pdf'] as const).map((f) => {
        writeFileSync(join(out, 'gigs', H2, f), `${f}\n`);
        const [kind, format] = f.split('.') as [GigDoc['kind'], GigDoc['format']];
        return { kind, format, path: `gigs/${H2}/${f}`, sha256: sha(`${f}\n`), pages: format === 'pdf' ? 1 : null };
      });
      s.putGigDocs(H2, files);
      s.kernel.db.prepare(`UPDATE gigs SET docs_state = 'ready' WHERE gig_key = ?`).run(H2);
      return files;
    });
    seedEnvelope('GigRendered@1', { gigKey: H2, files: h2Docs, plan: { gigKey: H2, platform: 'himalayas', proposal: null, pitch: { lines: [] }, covered: [], missing: [], coverNote: 'title states pay or hours' }, text: { proposal: null, pitch: 'pitch.txt', resume: '' } });
    expect(text((await get(`/freelance/${H2}`)).body)).toContain('No cover letter: title states pay or hours');
    const docs = withStore((s) => s.getGig(B1)!.docs.filter((d) => d.kind !== 'cover'));
    withStore((s) => s.putGigDocs(B1, docs));
    seedEnvelope('GigRendered@1', { gigKey: B1, files: docs, plan: { gigKey: B1, platform: 'boards', proposal: null, pitch: { lines: [] }, covered: ['java'], missing: [], cover: {} }, text: { proposal: null, pitch: PITCH, resume: '' }, coverBlocked: 'the cover letter has 2 pages, the limit is 1' });
    expect(text((await get(`/freelance/${B1}`)).body)).toContain('Cover letter blocked: the cover letter has 2 pages, the limit is 1');
  });
});

describe('the gig page: the cover letter card', () => {
  it('shows the letter in a <pre> with Copy (cover.txt) and downloads; the pitch card keeps the pitch and CV files', async () => {
    const { body } = await get(`/freelance/${B1}`);
    const card = /<section class="card wide" aria-labelledby="cover-h">[\s\S]*?<\/section>/.exec(body)?.[0] ?? '';
    expect(card).toContain('Your cover letter');
    expect(card).toContain(`data-copy-src="/freelance/${B1}/files/cover.txt"`);
    const pre = /<pre class="paste" id="cover-text">([\s\S]*?)<\/pre>/.exec(card)?.[1] ?? '';
    expect(text(pre).trim()).toBe(text(COVER).trim());
    for (const f of ['cover.pdf', 'cover.docx', 'cover.txt']) expect(card).toContain(`href="/freelance/${B1}/files/${f}"`);
    const paste = /<section class="card wide" aria-labelledby="paste-h">[\s\S]*?<\/section>/.exec(body)?.[0] ?? '';
    expect(paste).toContain(`data-copy-src="/freelance/${B1}/files/pitch.txt"`);
    expect(paste).not.toContain('cover.');
  });

  it('serves the cover files as recorded; a tampered cover.txt refuses every file of the gig', async () => {
    const r = await app.request(`/freelance/${B1}/files/cover.txt`, { headers: { host: 'localhost', cookie } });
    expect(r.status).toBe(200);
    expect(Buffer.from(await r.arrayBuffer()).toString('utf8')).toBe(`${COVER}\n`);
    expect((await get(`/freelance/${B1}/files/cover.html`)).status).toBe(200);
    expect((await get(`/freelance/${B1}/files/cover.rtf`)).status).toBe(404);
    writeFileSync(join(out, 'gigs', B1, 'cover.txt'), 'tampered\n');
    for (const f of ['cover.txt', 'cover.pdf', 'pitch.txt', 'resume.pdf']) expect((await get(`/freelance/${B1}/files/${f}`)).status, f).toBe(403);
    expect(text((await get(`/freelance/${B1}`)).body)).toContain('The cover letter file changed on disk');
  });

  it('a tampered pitch.txt refuses the cover letter files too (every .txt of the gig is checked)', async () => {
    writeFileSync(join(out, 'gigs', B1, 'pitch.txt'), 'tampered\n');
    for (const f of ['cover.txt', 'cover.pdf', 'cover.docx', 'pitch.txt']) expect((await get(`/freelance/${B1}/files/${f}`)).status, f).toBe(403);
  });

  it('a gig with no cover shows no cover card', async () => {
    expect((await get(`/freelance/${H2}`)).body).not.toContain('aria-labelledby="cover-h"');
  });
});
