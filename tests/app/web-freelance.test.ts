import { createHash } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Gig, GigRendered } from '../../src/app/freelance/types.js';
import { AppStore, type GigDoc, type GigUpsert } from '../../src/app/store/app-store.js';
import { rateLabel } from '../../src/app/web/copy.js';
import { NETWORK_CATALOGUE } from '../../src/app/freelance/network-catalogue.js';
import { presetTierUsd } from '../../src/app/freelance/gig-eligibility.js';
import { createDashboard } from '../../src/app/web/server.js';
import { createTestDashboard } from '../../src/app/web/server-testing.js';
import { NOTE_ONE_SKILL } from '../../src/app/freelance/project.js';
import { Sessions } from '../../src/app/web/security.js';
import { Store as KernelStore } from '../../src/kernel/store/store.js';

/**
 * The freelance tab (Task 10, spec §8) through Hono's `app.request()`: a temp JOBPILOT_HOME with the fictional pack,
 * gig rows written through the app store, their Gig@1 and GigRendered@1 envelopes seeded into the kernel store the way
 * a run leaves them, and the documents written under out/gigs/<key>/.
 */
const root = join(import.meta.dirname, '../..');
const NOW = '2026-10-12T14:30:00.000Z'; // 20:00 IST
const DAY = '2026-10-12';
const C1 = 'c1c1c1c1c1c1c1c1'; // contract, pitch, stated $70/h
const G2 = 'a2a2a2a2a2a2a2a2'; // gig, red flag, $50/h from ~60 hours stated, proposal ready
const G3 = 'a3a3a3a3a3a3a3a3'; // gig, derived from 2 weeks x 20 h, amber flag
const G4 = 'a4a4a4a4a4a4a4a4'; // gig, rate unknown, fixed budget $750
const R5 = 'b5b5b5b5b5b5b5b5'; // review, stated via platform FX, two notes
const F6 = 'f6f6f6f6f6f6f6f6'; // below the fit floor
const X7 = 'e7e7e7e7e7e7e7e7'; // rejected
const D8 = 'd8d8d8d8d8d8d8d8'; // another listing of G2 (duplicate_of)
const SRC = (k: string): string => `https://www.freelancer.example/projects/${k}`;

const sha = (b: Uint8Array | string): string => createHash('sha256').update(b).digest('hex');

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

let home: string;
let out: string;
type App = { request: (path: string, init?: RequestInit) => Promise<Response> };
let app: App;
const wrap = (raw: ReturnType<typeof createDashboard>): App => ({
  request: async (path, init = {}) => raw.request(path, { ...init, headers: { host: 'localhost', ...((init.headers as Record<string, string> | undefined) ?? {}) } }),
});
const withStore = <T>(fn: (s: AppStore) => T): T => {
  const s = AppStore.open(join(home, 'jobpilot.db'));
  try {
    return fn(s);
  } finally {
    s.close();
  }
};

const CLIENT = { name: 'Acme Labs', country: 'US', paymentVerified: true, hireRate: 0.8, spendUsd: 25_000, reviews: 12, since: '2019-01-01' };
const NO_CLIENT = { name: null, country: null, paymentVerified: null, hireRate: null, spendUsd: null, reviews: null, since: null };

function gigOf(key: string, over: Partial<Gig> = {}): Gig {
  return {
    gigKey: key, dedupeKey: key, platform: 'freelancer', sourceId: key, url: SRC(key), title: `Gig ${key}`, description: 'Build a service.',
    client: NO_CLIENT, kind: 'gig', budget: { type: 'fixed', min: null, max: 3000, currency: 'USD', usdPerUnit: null },
    hoursPerWeek: { min: null, max: null, source: null }, duration: { weeks: null, text: null }, timezone: { required: null, overlapText: null },
    location: { countries: [], worldwide: true, text: null }, skills: [], postedAt: '2026-10-12T09:30:00.000Z', bids: 7, ...over,
  };
}

function upsert(s: AppStore, g: Gig, over: Partial<GigUpsert>): void {
  s.upsertGig({
    gigKey: g.gigKey, dedupeKey: g.dedupeKey, platform: g.platform, sourceId: g.sourceId, url: g.url, title: g.title, description: g.description,
    client: g.client, kind: g.kind, budget: g.budget, rate: null, hours: g.hoursPerWeek, verdict: 'eligible', reasons: [], notes: [], flags: [],
    fit: 60, breakdown: { base: 30, 'strong:java': 4, 'gap:php': -4, client: 15, fresh: 5, ...(g.bids !== null ? { bids: g.bids } : {}) }, list: 'gigs', docsState: 'none',
    docsDetail: null, postedAt: g.postedAt, at: '2026-10-12T14:00:00.000Z', ...over,
  });
}

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

/** Writes a gig's documents (the text file and the contract CV) under out/gigs/<key>/ and records them ready. */
function writeGigDocs(s: AppStore, key: string, kind: 'proposal' | 'pitch', text: string): GigDoc[] {
  mkdirSync(join(out, 'gigs', key), { recursive: true });
  const files: [GigDoc['kind'], GigDoc['format'], string][] = [[kind, 'txt', `${text}\n`], ['resume', 'pdf', `pdf of ${key}`], ['resume', 'docx', `docx of ${key}`]];
  const docs = files.map(([k, f, body]) => {
    writeFileSync(join(out, 'gigs', key, `${k}.${f}`), body);
    return { kind: k, format: f, path: `gigs/${key}/${k}.${f}`, sha256: sha(body), pages: f === 'pdf' ? 1 : null };
  });
  s.putGigDocs(key, docs);
  return docs;
}

const EVIDENCE = 'At Contoso Retail I built the payments reconciliation service in Java.';
/** A proposal of exactly 1,214 characters, one evidence line citing f-nw-01. */
const PROPOSAL = (() => {
  const head = `Your order service needs a careful hand.\n\nHere is what I have done:\n${EVIDENCE}\n\nMy plan:\n1. Read the code.\n\nI send updates every two days.\n\n`;
  return `${head}${'Q'.repeat(1214 - [...head].length - 1)}?`;
})();
const PITCH = `Backend engineer for your platform team.\n${EVIDENCE}\nAvailable 15 h a week.`;

function rendered(key: string, docs: GigDoc[], kind: 'proposal' | 'pitch', covered: string[], missing: string[]): GigRendered {
  const line = { text: EVIDENCE, factIds: ['f-nw-01'] };
  return {
    gigKey: key,
    files: docs,
    plan: {
      gigKey: key, scored: {} as never, platform: 'freelancer',
      proposal: kind === 'proposal' ? { hook: { text: 'Your order service needs a careful hand.', quote: null, title: null }, evidenceIntro: 'Here is what I have done:', evidence: [line], planIntro: 'My plan:', plan: ['Read the code.'], availability: 'I send updates every {cadence}.', question: '' } : null,
      pitch: kind === 'pitch' ? { lines: [{ text: 'Backend engineer for your platform team.', factIds: [] }, line, { text: 'Available 15 h a week.', factIds: [] }] } : null,
      resume: {} as never, covered, missing,
    },
    text: { proposal: kind === 'proposal' ? PROPOSAL : null, pitch: kind === 'pitch' ? PITCH : null, resume: '' },
  } as GigRendered;
}

function seed(): void {
  const c1 = gigOf(C1, { platform: 'hn-freelancer', kind: 'contract', title: 'Contract backend engineer', client: CLIENT, budget: { type: 'hourly', min: 70, max: 70, currency: 'USD', usdPerUnit: null }, hoursPerWeek: { min: 15, max: 15, source: 'text' }, timezone: { required: null, overlapText: '4 hours overlap with US Eastern' }, bids: null });
  const g2 = gigOf(G2, { title: '<script>alert("x")</script>" onmouseover="y', description: 'About 60 hours of work. Contact me on WhatsApp.' });
  const g3 = gigOf(G3, { title: 'Two week sprint', duration: { weeks: 2, text: '2 weeks' } });
  const g4 = gigOf(G4, { title: 'Small fix', budget: { type: 'fixed', min: 250, max: 750, currency: 'USD', usdPerUnit: null } });
  const r5 = gigOf(R5, { title: 'Hourly in CAD', budget: { type: 'hourly', min: 60, max: 68, currency: 'CAD', usdPerUnit: 0.73 } });
  const f6 = gigOf(F6, { title: 'Low fit gig' });
  const x7 = gigOf(X7, { title: 'Rejected gig' });
  const d8 = gigOf(D8, { platform: 'remotive', sourceId: 'r8', dedupeKey: G2, title: 'Same gig elsewhere' });
  withStore((s) => {
    upsert(s, c1, { list: 'contracts', fit: 54, rate: { minUsdH: 70, maxUsdH: 70, method: 'stated', fxDate: null, fxSource: null, budgetUsd: null }, docsState: 'ready' });
    upsert(s, g2, { fit: 70, rate: { minUsdH: 50, maxUsdH: 50, method: 'fixed÷stated-hours', fxDate: null, fxSource: null, budgetUsd: 3000 }, flags: [{ id: 'off-platform', detail: 'asks to continue contact or payment outside the platform' }], docsState: 'ready' });
    upsert(s, g3, { fit: 50, rate: { minUsdH: 75, maxUsdH: 75, method: 'derived-from-duration', fxDate: null, fxSource: null, budgetUsd: 3000 }, flags: [{ id: 'thin-brief', detail: 'no client history and a very short description' }] });
    upsert(s, g4, { fit: 65, rate: { minUsdH: null, maxUsdH: null, method: 'unknown', fxDate: null, fxSource: null, budgetUsd: 750 } });
    upsert(s, r5, { list: 'review', verdict: 'review', reasons: ['budget-preset'], fit: 48, rate: { minUsdH: 43.8, maxUsdH: 49.64, method: 'stated', fxDate: null, fxSource: 'platform', budgetUsd: null }, notes: ['preset bracket - bids may exceed it', 'rate negotiable - verify'] });
    upsert(s, f6, { list: 'below-floor', fit: 30, docsDetail: 'below the fit floor' });
    upsert(s, x7, { list: null, verdict: 'rejected', reasons: ['budget-below-floor'], fit: null, breakdown: null });
    upsert(s, d8, { fit: 70, at: '2026-10-12T14:10:00.000Z' });
    const c1Docs = writeGigDocs(s, C1, 'pitch', PITCH);
    const g2Docs = writeGigDocs(s, G2, 'proposal', PROPOSAL);
    s.recordGigRun({
      runId: 'freelance-2026-10-12-pm', at: '2026-10-12T14:00:00.000Z', counts: { byAgent: {}, totals: {} }, packHash: 'a'.repeat(64), policyHash: 'b'.repeat(64), warnings: [],
      problems: [
        ...[1, 2, 3, 4, 5].map((i) => ({ kind: 'failed', agent: 'src-freelancer', item: `freelancer q${i}`, reason: 'http_error: 503' })),
        ...[6, 7, 8].map((i) => ({ kind: 'skipped', agent: 'src-freelancer', item: `freelancer q${i}`, reason: 'skipped: a breaker was open after earlier failures' })),
        { kind: 'source-dead', agent: 'source-health', item: 'source remotive', reason: 'source remotive looks dead: 3 runs in a row failed every fetch' },
      ],
    });
    s.addSourceHealth('freelance-2026-10-12-pm', 'freelancer', '2026-W42', { fetched: 46, eligible: 7, aboveFloor: 5, shortlisted: 2, failed: true, probeFailures: 0 });
    s.addSourceHealth('freelance-2026-10-05-am', 'freelancer', '2026-W41', { fetched: 30, eligible: 4, aboveFloor: 3, shortlisted: 1, failed: false, probeFailures: 0 });
    return { c1Docs, g2Docs };
  });
  const docs = withStore((s) => ({ c1: s.getGig(C1)!.docs, g2: s.getGig(G2)!.docs }));
  for (const g of [c1, g2, g3, g4, r5]) seedEnvelope('Gig@1', g);
  seedEnvelope('GigRendered@1', rendered(C1, docs.c1, 'pitch', ['java', 'kafka', 'aws', 'postgres', 'redis', 'go'], ['kubernetes', 'terraform']));
  seedEnvelope('GigRendered@1', rendered(G2, docs.g2, 'proposal', ['java'], []));
  // network packs on disk, as `jobpilot networks pack` leaves them
  for (const id of ['arc', 'contra']) {
    mkdirSync(join(out, 'networks', id), { recursive: true });
    for (const f of ['resume.pdf', 'resume.docx', 'profile.txt']) writeFileSync(join(out, 'networks', id, f), `${f} of ${id}`);
    writeFileSync(join(out, 'networks', id, 'checklist.md'), `# ${id} vetting prep\n\n- [ ] Live coding\n`);
  }
}

let cookie = '';
let token = '';
async function startSession(): Promise<void> {
  const res = await app.request(`/freelance/${G2}`);
  cookie = /jp_sid=[0-9a-f]{32}/.exec(res.headers.get('set-cookie') ?? '')?.[0] ?? '';
  token = /name="_csrf" value="([0-9a-f]{64})"/.exec(await res.text())?.[1] ?? '';
  expect(cookie).not.toBe('');
  expect(token).not.toBe('');
}
const post = (path: string, form: Record<string, string>, headers: Record<string, string> = {}) =>
  app.request(path, { method: 'POST', body: new URLSearchParams(form).toString(), headers: { 'content-type': 'application/x-www-form-urlencoded', cookie, ...headers } });
const hx = { 'hx-request': 'true', origin: 'http://localhost' };
const get = async (path: string): Promise<{ status: number; body: string; headers: Headers }> => {
  const r = await app.request(path, { headers: { cookie } });
  return { status: r.status, body: await r.text(), headers: r.headers };
};
const order = (body: string): string[] => [...body.matchAll(/data-gig="([0-9a-f]{16})"/g)].map((m) => m[1] as string);
const decode = (b: string): string => b.replace(/&#0?39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const text = (b: string): string => b.replace(/<[^>]*>/g, '').replace(/&#0?39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/\s+/g, ' ');

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'jobpilot-webfl-'));
  cpSync(join(root, 'tests/fixtures/pack'), join(home, 'pack'), { recursive: true });
  out = join(home, 'out');
  mkdirSync(out);
  seed();
  app = wrap(createDashboard({ home, clock: { now: () => NOW }, sessions: new Sessions(Buffer.alloc(32, 7)) }));
  await startSession();
});
afterEach(() => removeHome(home));

describe('freelance tabs: the rows', () => {
  it('contracts is the default tab and shows the contract row', async () => {
    const { status, body } = await get('/freelance');
    expect(status).toBe(200);
    expect(order(body)).toEqual([C1]);
    expect(body).toContain('aria-current="page">Freelance</a>');
    const t = text(body);
    expect(t).toContain('$70/h stated');
    expect(t).toContain('15 h/week');
    expect(t).toContain('IST overlap: 4 hours overlap with US Eastern');
    expect(t).toContain('covered 6/8 · missing: Kubernetes, terraform');
    expect(t).toMatch(/Payment verified/);
  });

  it('gigs: rankGigs order (red flag last), duplicates, below-floor and rejected rows left out and counted', async () => {
    const { body } = await get('/freelance?tab=gigs');
    expect(order(body)).toEqual([G3, G4, G2]);
    const t = text(body);
    expect(t).toContain('1 below the fit floor and 1 not eligible are not shown');
    expect(t).toContain('posted 5 h ago');
    expect(t).toContain('7 bids');
  });

  it('review shows its rows with each note as a muted line', async () => {
    const { body } = await get('/freelance?tab=review');
    expect(order(body)).toEqual([R5]);
    expect(body).toContain('<li class="gig-note muted">preset bracket - bids may exceed it</li>');
    expect(body).toContain('<li class="gig-note muted">rate negotiable - verify</li>');
  });

  it('red flags are a red badge in plain words, amber flags amber', async () => {
    const { body } = await get('/freelance?tab=gigs');
    expect(body).toMatch(/<span class="pill pill-critical"[^>]*>asks to move off the platform<\/span>/);
    expect(body).toMatch(/<span class="pill pill-warn"[^>]*>very short brief, client has no history<\/span>/);
  });

  it('the rate label always names its method (exact text)', async () => {
    const t = text((await get('/freelance?tab=gigs')).body) + text((await get('/freelance?tab=review')).body);
    expect(t).toContain('$75/h derived from 2 weeks (the basis is not on record)');
    expect(t).toContain('$50/h from ~60 hours stated');
    expect(t).toContain('rate unknown - fixed budget $750');
    expect(t).toContain('$43.80–49.64/h stated · via platform FX');
  });

  it('rateLabel: every method, and a derived rate is never shown bare', () => {
    const r = (o: Record<string, unknown>) => ({ minUsdH: null, maxUsdH: null, method: 'unknown', fxDate: null, fxSource: null, budgetUsd: null, ...o });
    expect(rateLabel(r({ minUsdH: 50, maxUsdH: 50, method: 'stated' }), { description: '', weeks: null, hours: null, budgetType: 'hourly' })).toBe('$50/h stated');
    // the hours cap the run used is not stored: never recomputed from the rate
    expect(rateLabel(r({ minUsdH: 75, maxUsdH: 75, method: 'derived-from-duration', budgetUsd: 3000 }), { description: '', weeks: 2, hours: null, budgetType: 'fixed' })).toBe('$75/h derived from 2 weeks (the basis is not on record)');
    expect(rateLabel(r({ minUsdH: 50, maxUsdH: 50, method: 'fixed÷stated-hours', budgetUsd: 3000 }), { description: 'About 60 hours of work.', weeks: null, hours: null, budgetType: 'fixed' })).toBe('$50/h from ~60 hours stated');
    expect(rateLabel(r({ minUsdH: 25, maxUsdH: 25, method: 'fixed÷stated-hours', budgetUsd: 1500 }), { description: '', weeks: 3, hours: 20, budgetType: 'fixed' })).toBe('$25/h from 3 weeks × 20 h stated');
    expect(rateLabel(r({ minUsdH: 46.19, maxUsdH: 46.19, method: 'monthly÷hours', budgetUsd: 4000 }), { description: '', weeks: null, hours: 20, budgetType: 'monthly' })).toBe('$46.19/h from a monthly $4,000 at 20 h/week stated');
    expect(rateLabel(r({ budgetUsd: 750 }), { description: '', weeks: null, hours: null, budgetType: 'fixed' })).toBe('rate unknown - fixed budget $750');
    expect(rateLabel(r({ budgetUsd: 1500, fxSource: 'platform' }), { description: '', weeks: null, hours: null, budgetType: 'fixed' })).toBe('rate unknown - fixed budget $1,500 · via platform FX');
    // a preset tier is labelled as one (final review I1)
    expect(rateLabel(r({ budgetUsd: 1500 }), { description: '', weeks: null, hours: null, budgetType: 'fixed', presetTier: { lo: 750, hi: 1500 } })).toBe('preset tier $750–1,500 (client picked a range; bids may exceed it)');
    const preset = { notes: ['preset bracket - bids may exceed it'], budget: { type: 'fixed', min: 750, max: 1500, currency: 'USD' }, rate: r({ budgetUsd: 1500 }) };
    expect(presetTierUsd(preset)).toEqual({ lo: 750, hi: 1500 });
    expect(presetTierUsd({ ...preset, notes: [] })).toBeNull(); // only a gig the eligibility agent labelled
    expect(presetTierUsd({ ...preset, budget: { type: 'hourly', min: 60, max: 68, currency: 'CAD' } })).toBeNull();
    expect(rateLabel(null, { description: '', weeks: null, hours: null, budgetType: 'unknown' })).toBe('rate unknown');
    // a derived rate whose basis cannot be shown is not shown at all
    expect(rateLabel(r({ minUsdH: 75, maxUsdH: 75, method: 'derived-from-duration', budgetUsd: 3000 }), { description: '', weeks: null, hours: null, budgetType: 'fixed' })).toBe('$75/h derived from the duration (the basis is not on record)');
  });

  it('escapes a title with markup and quotes', async () => {
    for (const path of ['/freelance?tab=gigs', `/freelance/${G2}`]) {
      const { body } = await get(path);
      expect(body).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&quot; onmouseover=&quot;y');
      expect(body).not.toContain('<script>alert');
    }
  });

  it('the jobs pages keep working and gain the Freelance nav link', async () => {
    const { status, body } = await get('/');
    expect(status).toBe(200);
    expect(body).toContain('<a href="/freelance">Freelance</a>');
  });
});

describe('freelance: the gig page', () => {
  it('the proposal in a <pre> with a Copy button, its files, the count against the limit and fact provenance', async () => {
    const { status, body } = await get(`/freelance/${G2}`);
    expect(status).toBe(200);
    expect(body).toMatch(/<pre class="paste" id="paste">/);
    expect(body).toContain(`data-copy-src="/freelance/${G2}/files/proposal.txt"`);
    expect(body).toContain('1,214 / 1,500 characters');
    expect(body).toContain(`<span class="fact-src" data-fact="f-nw-01" title="Fact f-nw-01">${EVIDENCE}</span>`);
    for (const f of ['proposal.txt', 'resume.pdf', 'resume.docx']) expect(body).toContain(`href="/freelance/${G2}/files/${f}"`);
    // the <pre> holds exactly the file text
    const pre = /<pre class="paste" id="paste">([\s\S]*?)<\/pre>/.exec(body)?.[1] ?? '';
    expect(decode(pre.replace(/<[^>]*>/g, ''))).toBe(`${PROPOSAL}\n`);
  });

  it('serves the recorded files byte for byte, and nothing else', async () => {
    const r = await app.request(`/freelance/${G2}/files/proposal.txt`, { headers: { cookie } });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(Buffer.from(await r.arrayBuffer()).toString('utf8')).toBe(`${PROPOSAL}\n`);
    expect((await get(`/freelance/${G2}/files/pitch.txt`)).status).toBe(404);
    expect((await get(`/freelance/${G2}/files/..%2Fsecret.txt`)).status).toBe(404);
    // fail closed: a changed or missing .txt refuses every file of the gig
    writeFileSync(join(out, 'gigs', G2, 'proposal.txt'), 'tampered\n');
    for (const f of ['proposal.txt', 'resume.pdf', 'resume.docx']) expect((await get(`/freelance/${G2}/files/${f}`)).status, f).toBe(403);
    rmSync(join(out, 'gigs', G2, 'proposal.txt'));
    for (const f of ['proposal.txt', 'resume.pdf', 'resume.docx']) expect((await get(`/freelance/${G2}/files/${f}`)).status, f).toBe(403);
  });

  it('a contract shows its pitch; a gig with no documents says why', async () => {
    const c = await get(`/freelance/${C1}`);
    expect(c.body).toContain(`data-copy-src="/freelance/${C1}/files/pitch.txt"`);
    const f = text((await get(`/freelance/${F6}`)).body);
    expect(f).toContain('No documents: this gig scored under your minimum fit, so none were made.');
    expect((await get('/freelance/0000000000000000')).status).toBe(404);
  });
});

describe('freelance: status', () => {
  it('every transition is logged; applied keeps a read-only snapshot that later runs cannot change', async () => {
    for (const to of ['shortlisted', 'applied']) expect((await post(`/freelance/${G2}/status`, { to, _csrf: token }, hx)).status).toBe(200);
    const g = withStore((s) => ({ gig: s.getGig(G2)!, history: s.gigHistory(G2), snaps: s.gigSnapshots(G2) }));
    expect(g.gig.status).toBe('applied');
    expect(g.gig.appliedAt).toBe(NOW);
    expect(g.history.map((h) => [h.from, h.to, h.by])).toEqual([['new', 'shortlisted', 'user'], ['shortlisted', 'applied', 'user']]);
    expect(g.snaps).toHaveLength(1);
    expect(g.snaps[0]!.day).toBe(DAY);
    expect(g.snaps[0]!.files.map((f) => f.path)).toEqual([`gigs/${G2}/applied-${DAY}/proposal.txt`, `gigs/${G2}/applied-${DAY}/resume.docx`, `gigs/${G2}/applied-${DAY}/resume.pdf`]);
    const kept = join(out, 'gigs', G2, `applied-${DAY}`, 'proposal.txt');
    expect(readFileSync(kept, 'utf8')).toBe(`${PROPOSAL}\n`);
    expect(statSync(kept).mode & 0o222).toBe(0);
    // a later run rewrites the current proposal: the kept copy is unchanged and still served
    writeFileSync(join(out, 'gigs', G2, 'proposal.txt'), 'a newer proposal\n');
    const sent = await app.request(`/freelance/${G2}/sent/${DAY}/proposal.txt`, { headers: { cookie } });
    expect(sent.status).toBe(200);
    expect(await sent.text()).toBe(`${PROPOSAL}\n`);
    // replied, then back to applied: logged, no second snapshot
    for (const to of ['replied', 'applied']) await post(`/freelance/${G2}/status`, { to, _csrf: token }, hx);
    expect(withStore((s) => [s.gigHistory(G2).length, s.gigSnapshots(G2).length])).toEqual([4, 1]);
    expect(text((await get(`/freelance/${G2}`)).body)).toContain('Documents you sent');
  });

  it('a plain form post (JS off) ends in a 303; an unknown status is a 400', async () => {
    const r = await post(`/freelance/${G3}/status`, { to: 'skipped', _csrf: token }, { referer: `http://localhost/freelance/${G3}` });
    expect(r.status).toBe(303);
    expect(r.headers.get('location')).toBe(`/freelance/${G3}#status`);
    expect((await post(`/freelance/${G3}/status`, { to: 'approved', _csrf: token }, hx)).status).toBe(400);
    expect(withStore((s) => s.getGig(G3)!.status)).toBe('skipped');
  });

  it('refuses a POST without the CSRF token, or from another origin, and changes nothing', async () => {
    expect((await post(`/freelance/${G2}/status`, { to: 'won' }, hx)).status).toBe(403);
    expect((await post(`/freelance/${G2}/status`, { to: 'won', _csrf: token }, { ...hx, origin: 'http://evil.example' })).status).toBe(403);
    expect((await post('/freelance/networks/arc/status', { to: 'applied' }, hx)).status).toBe(403);
    expect(withStore((s) => [s.getGig(G2)!.status, s.gigHistory(G2).length, s.networkStatuses()['arc']])).toEqual(['new', 0, undefined]);
  });
});

describe('freelance: networks', () => {
  it('one card per network in the recommended order (freelance-boost), the pack files, the checklist and "check before use"', async () => {
    writeFileSync(join(home, 'pack', 'networks', 'contra.yaml'), readFileSync(join(home, 'pack', 'networks', 'contra.yaml'), 'utf8').replace('checkedByUser: false', 'checkedByUser: true'));
    for (const path of ['/freelance/networks', '/freelance?tab=networks']) {
      const { status, body } = await get(path);
      expect(status).toBe(200);
      const ids = [...body.matchAll(/data-network="([a-z0-9-]+)"/g)].map((m) => m[1]);
      // The catalogue's order (micro1, Mercor, Alignerr, then Arc, Braintrust, Toptal, Proxify, ...), the pack's own
      // files joined by id, and Lemon.io (not open to India) last.
      expect(ids).toEqual(['micro1', 'mercor', 'alignerr', 'arc', 'braintrust', 'toptal', 'proxify', 'a-team', 'turing', 'contra', 'flexiple', 'gunio', 'lemon']);
      expect(text(body)).toContain('Recommended order');
      const card = (id: string): string => {
        const i = body.indexOf(`data-network="${id}"`);
        const j = body.indexOf('data-network="', i + 1);
        return body.slice(i, j === -1 ? undefined : j);
      };
      expect(card('arc')).toContain('check before use');
      expect(card('contra')).not.toContain('check before use');
      expect(card('arc')).toContain('href="/freelance/networks/arc/files/resume.pdf"');
      expect(card('arc')).toContain('Live coding');
      expect(text(card('braintrust'))).toContain('No pack yet');
      // What the research verified, the application link (out of the dashboard, new tab), and one-click "mark applied".
      expect(card('micro1')).toContain('href="https://www.micro1.ai/experts/opportunities" rel="noopener noreferrer" target="_blank"');
      expect(text(card('micro1'))).toContain('$50–100/h for software engineering');
      expect(text(card('micro1'))).toContain('15–20 h/week typical');
      expect(text(card('micro1'))).toContain('Open to India');
      expect(text(card('micro1'))).toContain('No network file');
      expect(card('micro1')).toMatch(/<form[^>]*action="\/freelance\/networks\/micro1\/status"[^>]*>\s*<input type="hidden" name="_csrf"[^]*?<button[^>]*name="to" value="applied"[^>]*>Mark applied<\/button>/);
      expect(text(card('lemon'))).toContain('Not open to India');
      expect(card('lemon')).not.toContain('Mark applied');
      expect(text(card('arc'))).toContain('Not applied');
    }
  });

  it('serves a pack file and refuses names outside the four', async () => {
    const r = await app.request('/freelance/networks/arc/files/profile.txt', { headers: { cookie } });
    expect(r.status).toBe(200);
    expect(await r.text()).toBe('profile.txt of arc');
    expect((await get('/freelance/networks/arc/files/secret.txt')).status).toBe(404);
    expect((await get('/freelance/networks/nope/files/profile.txt')).status).toBe(404);
  });

  it('POST status records the network status, for a catalogue network too, and logs the change', async () => {
    expect((await post('/freelance/networks/arc/status', { to: 'applied', _csrf: token }, hx)).status).toBe(200);
    expect(withStore((s) => s.networkStatuses()['arc']?.status)).toBe('applied');
    const r = await post('/freelance/networks/micro1/status', { to: 'applied', _csrf: token }, hx);
    expect(r.status).toBe(200);
    expect(text(await r.text())).toMatch(/Applied on \d{1,2} \w{3} \d{4}/);
    expect(withStore((s) => s.networkStatuses()['micro1']?.status)).toBe('applied');
    expect(withStore((s) => s.userActions().filter((a) => a.kind === 'network.status').map((a) => a.data))).toEqual([
      { networkId: 'arc', from: 'todo', to: 'applied' },
      { networkId: 'micro1', from: 'todo', to: 'applied' },
    ]);
    // Lemon.io (not open to India) is refused on the server too, and nothing is stored or logged.
    expect((await post('/freelance/networks/lemon/status', { to: 'applied', _csrf: token }, hx)).status).toBe(409);
    expect(withStore((s) => s.networkStatuses()['lemon'])).toBeUndefined();
    // Accepted later: the applied date stays on the card.
    const later = await post('/freelance/networks/micro1/status', { to: 'passed', _csrf: token }, hx);
    expect(text(await later.text())).toMatch(/Accepted.*applied on \d{1,2} \w{3} \d{4}/i);
    expect((await post('/freelance/networks/arc/status', { to: 'won', _csrf: token }, hx)).status).toBe(400);
    expect((await post('/freelance/networks/nope/status', { to: 'applied', _csrf: token }, hx)).status).toBe(404);
  });

  it('the applied date shown is the LATEST "applied" action, not the first', async () => {
    withStore((s) => {
      s.logUserAction('network.status', { networkId: 'mercor', from: 'todo', to: 'applied' }, '2026-10-01T06:00:00.000Z');
      s.logUserAction('network.status', { networkId: 'mercor', from: 'applied', to: 'todo' }, '2026-10-02T06:00:00.000Z');
      s.logUserAction('network.status', { networkId: 'mercor', from: 'todo', to: 'applied' }, '2026-10-05T06:00:00.000Z');
      s.setNetworkStatus('mercor', 'applied', '2026-10-05T06:00:00.000Z');
    });
    const { body } = await get('/freelance/networks');
    const i = body.indexOf('data-network="mercor"');
    const card = body.slice(i, body.indexOf('data-network="', i + 1));
    expect(text(card)).toContain('Applied on 5 Oct 2026');
    expect(text(card)).not.toContain('1 Oct 2026');
  });
});

describe('freelance: sources', () => {
  it('source health per platform, the disabled sources and why, and breaker skips collapsed to one line', async () => {
    for (const path of ['/freelance/sources', '/freelance?tab=sources']) {
      const { status, body } = await get(path);
      expect(status).toBe(200);
      const t = text(body);
      expect(t).toContain('2026-W42');
      expect(t).toContain('2026-W41');
      expect(t).toContain('Upwork API key pending approval');
      expect(t).toContain('Reddit needs your OAuth script app');
      // freelance-boost: Remotive is off, with its named reason.
      expect(t).toContain('Remotive robots.txt disallows /api (2026-10-15)');
      expect(t).toContain('Gmail not connected - run jobpilot gmail connect');
      expect(t).toContain('freelancer: 3 requests skipped after 5 failures');
      expect(t).not.toContain('freelancer q6');
      expect(t).toContain('source remotive looks dead');
      // final review M8: per-run sums and distinct status counts are labelled apart
      expect(body).toContain('<th scope="colgroup" colspan="4">Shortlisted and the rest: summed per run</th>');
      expect(body).toContain('<th scope="colgroup" colspan="3">Applied and the rest: distinct gigs, from your status changes</th>');
      expect(t).toContain('a gig seen in two runs counts twice');
    }
  });

  it('connected Gmail with no alert parser yet says to send one alert email per sender', async () => {
    app = wrap(createDashboard({ home, clock: { now: () => NOW }, sessions: new Sessions(Buffer.alloc(32, 7)), gmailConnected: () => true }));
    const t = text((await get('/freelance/sources')).body);
    expect(t).not.toContain('Gmail not connected');
    expect(t).toContain('Gmail reads the label jobpilot/gigs; alert parsers: none yet - send one alert email per sender to enable');
  });
});

describe('freelance: no external assets', () => {
  it('the only http(s) links on any freelance page are gig source links and (freelance-boost) the catalogue networks\' application pages, each in a new tab', async () => {
    const pages = ['/freelance', '/freelance?tab=gigs', '/freelance?tab=review', '/freelance/networks', '/freelance/sources', `/freelance/${G2}`, `/freelance/${C1}`, `/freelance/${R5}`];
    const sources = new Set([...[C1, G2, G3, G4, R5].map(SRC), ...NETWORK_CATALOGUE.map((n) => n.applyUrl)]);
    let links = 0;
    for (const p of pages) {
      const { body } = await get(p);
      for (const m of body.matchAll(/\b(?:href|src|action|srcset|poster|data)\s*=\s*["']?\s*(https?:|\/\/)/gi)) {
        const tag = body.slice(body.lastIndexOf('<', m.index), body.indexOf('>', m.index) + 1);
        const url = /href="([^"]*)"/.exec(tag)?.[1] ?? '';
        expect(tag.startsWith('<a '), `${p}: ${tag}`).toBe(true);
        expect(sources.has(url), `${p}: ${url}`).toBe(true);
        expect(tag).toContain('rel="noopener noreferrer"');
        expect(tag).toContain('target="_blank"');
        links += 1;
      }
      expect(body).not.toMatch(/url\(\s*['"]?(https?:)?\/\//i);
    }
    expect(links).toBeGreaterThan(5);
  });
});

describe('fix round 1', () => {
  const G9 = '9a9a9a9a9a9a9a9a';
  /** A ready gig with its own proposal; `plan` adds the GigRendered envelope behind it. */
  function readyGig(key: string, proposal: string, over: Partial<GigUpsert> = {}, plan?: { covered: string[]; cited: boolean }): void {
    const g = gigOf(key, { title: `Extra ${key}` });
    const docs = withStore((s) => {
      upsert(s, g, { list: 'below-floor', fit: 40, docsState: 'ready', ...over });
      return writeGigDocs(s, key, 'proposal', proposal);
    });
    seedEnvelope('Gig@1', g);
    if (plan !== undefined) {
      const r = rendered(key, docs, 'proposal', plan.covered, []);
      if (!plan.cited) r.plan.proposal!.evidence = [{ text: EVIDENCE, factIds: [] }];
      r.text.proposal = proposal;
      seedEnvelope('GigRendered@1', r);
    }
  }

  it('keep-now: a failed snapshot is offered again and made once; a second keep makes no second copy', async () => {
    let fail = true;
    const raw = createTestDashboard({ home, clock: { now: () => NOW }, sessions: new Sessions(Buffer.alloc(32, 7)) }, { beforeSnapshot: () => { if (fail) throw new Error('disk full'); } });
    app = wrap(raw);
    const r = await post(`/freelance/${G2}/status`, { to: 'applied', _csrf: token }, hx);
    expect(r.status).toBe(200);
    expect(decode(await r.text())).toContain("use 'Keep a copy' below");
    expect(withStore((s) => s.gigSnapshots(G2))).toHaveLength(0);
    expect((await get(`/freelance/${G2}`)).body).toContain(`action="/freelance/${G2}/keep"`);
    fail = false;
    const k = await post(`/freelance/${G2}/keep`, { _csrf: token }, hx);
    expect(k.status).toBe(200);
    expect(withStore((s) => s.gigSnapshots(G2))).toHaveLength(1);
    expect((await post(`/freelance/${G2}/keep`, { _csrf: token }, hx)).status).toBe(409);
    expect(withStore((s) => s.gigSnapshots(G2))).toHaveLength(1);
    expect((await get(`/freelance/${G2}`)).body).not.toContain(`action="/freelance/${G2}/keep"`);
    expect((await post(`/freelance/${G3}/keep`, { _csrf: token }, hx)).status).toBe(409);
    expect((await post(`/freelance/${G2}/keep`, {}, hx)).status).toBe(403);
  });

  it('a .txt naming a forbidden term refuses every file of the gig by direct URL (403)', async () => {
    readyGig(G9, 'I worked at Initech on payments.');
    for (const f of ['proposal.txt', 'resume.pdf', 'resume.docx']) expect((await get(`/freelance/${G9}/files/${f}`)).status, f).toBe(403);
    const page = await get(`/freelance/${G9}`);
    expect(page.body).not.toContain(`/freelance/${G9}/files/`);
    expect(page.body).not.toContain('Initech on payments');
  });

  it('the hover hint shows only when a line cites a fact', async () => {
    expect((await get(`/freelance/${G2}`)).body).toContain('Hover an underlined line');
    readyGig(G9, 'A proposal with no cited line.', {}, { covered: ['java', 'kafka'], cited: false });
    const b = (await get(`/freelance/${G9}`)).body;
    expect(b).toContain('Copy pastes exactly the .txt file.');
    expect(b).not.toContain('Hover an underlined line');
  });

  it('a skill row the facts do not back says so; the one-skill note is amber', async () => {
    readyGig(G9, 'Short proposal.', { breakdown: { base: 30, 'strong:java': 4, 'medium:react': 1.5 }, notes: [NOTE_ONE_SKILL] }, { covered: ['java'], cited: true });
    const b = decode((await get(`/freelance/${G9}`)).body);
    expect(b).toContain('<td>Skill: React (not backed by your facts)</td>');
    expect(b).toContain('<td>Core skill: Java</td>');
    expect(b).toContain(`<li class="gig-note warn-note">${NOTE_ONE_SKILL}</li>`);
  });

  it('review says the fit floor does not apply to it', async () => {
    const t = text((await get('/freelance?tab=review')).body);
    expect(t).toContain('Review holds gigs that need your judgement; the fit floor applies to Contracts and Gigs only.');
    expect(t).not.toContain('Fit floor 45');
    expect(text((await get('/freelance?tab=gigs')).body)).toContain('Fit floor 45');
  });
});
