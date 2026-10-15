import { createHash } from 'node:crypto';
import { chmodSync, cpSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppStore, type Doc, type JobUpsert } from '../../src/app/store/app-store.js';
import { compText, inr, inrRange } from '../../src/app/web/format.js';
import { html } from '../../src/app/web/html.js';
import { createDashboard, serveDashboard } from '../../src/app/web/server.js';
import { createTestDashboard } from '../../src/app/web/server-testing.js';
import { Sessions } from '../../src/app/web/security.js';
import * as htmlModule from '../../src/app/web/html.js';
import Database from 'better-sqlite3';
import { jobRow } from '../support/app-fixtures.js';
import { attrsOf, elementsWith, linksOf, rowOf, textOf } from '../support/dom.js';
import { coverPlanOf, fullPack, posting } from '../support/render-fixtures.js';
import { fillCover } from '../../src/app/render/fill.js';
import { coverNoteShort } from '../../src/app/agents/writing/grounded.js';
import type { CoverPlan } from '../../src/app/types.js';
import { Store as KernelStore } from '../../src/kernel/store/store.js';
import { CHAIN_CHECKPOINT_KEY, fullChainCheck, readCheckpoint } from '../../src/app/chain-status.js';

/**
 * The dashboard (Task 13) through Hono's `app.request()`: a temp JOBPILOT_HOME with the fictional fixture pack, rows
 * written through the app store and document files written under out/.
 */
const root = join(import.meta.dirname, '../..');
const NOW = '2026-10-09T06:30:00.000Z'; // 12:00 IST
const DAY = '2026-10-09';
const K1 = '1111111111111111';
const K2 = '2222222222222222';
const K3 = '3333333333333333';
const K4 = '4444444444444444';
const K5 = '5555555555555555';
const K6 = '6666666666666666';
const K7 = '7777777777777777';
const K8 = '8888888888888888';
const K9 = '9999999999999999';
const K10 = 'aaaaaaaaaaaaaaaa';
const K11 = 'bbbbbbbbbbbbbbbb';

const sha = (b: Uint8Array | string): string => createHash('sha256').update(b).digest('hex');

/** Snapshot folders are read-only (0555); make them writable again so the temp home can be removed. */
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
let now = NOW;
/** Every request carries the Host a browser sends to the dashboard (`localhost`, no port in these tests). */
const wrap = (raw: ReturnType<typeof createDashboard>): App => ({
  request: async (path, init = {}) => raw.request(path, { ...init, headers: { host: 'localhost', ...((init.headers as Record<string, string> | undefined) ?? {}) } }),
});

const store = (): AppStore => AppStore.open(join(home, 'jobpilot.db'));
const withStore = <T>(fn: (s: AppStore) => T): T => {
  const s = store();
  try {
    return fn(s);
  } finally {
    s.close();
  }
};

const RESUME_HTML = '<!doctype html><html><head><style>body{}</style></head><body><main data-doc="resume"><ul><li data-fact="f-nw-01">• Led the order pipeline.</li></ul></main></body></html>\n';

/** Makes `key` a ready job with its six documents. */
function writeDocsFor(key: string): void {
  withStore((s) => {
    writeDocs(s, key);
    s.setDocs(key, 'ready', null, s.getJob(key)?.docs ?? []);
  });
}

/** Writes a ready job's six documents under out/<key>/ and records them. */
function writeDocs(s: AppStore, key: string): Doc[] {
  mkdirSync(join(out, key), { recursive: true });
  const docs: Doc[] = [];
  for (const kind of ['resume', 'cover'] as const) {
    for (const format of ['pdf', 'docx', 'html'] as const) {
      const body = format === 'html' ? RESUME_HTML.replace('resume', kind) : `${kind}.${format} of ${key}`;
      writeFileSync(join(out, key, `${kind}.${format}`), body);
      docs.push({ kind, format, path: `${key}/${kind}.${format}`, sha256: sha(body), pages: format === 'html' ? null : 1, qaOk: true });
    }
  }
  s.putDocs(key, docs);
  return docs;
}

const row = (key: string, n: number, over: Partial<JobUpsert>): JobUpsert =>
  jobRow({ jobKey: key, sourceId: String(n), dedupeKey: key.replace(/./g, (c) => (c === 'f' ? 'e' : 'f')).slice(0, 15) + String(n % 10), ...over });

function seed(): void {
  withStore((s) => {
    s.upsertJob(row(K1, 1, {
      title: 'Senior Backend Engineer', company: 'Acme Robotics', score: 80, compMaxInr: 9_000_000, compMinInr: 7_000_000, compBasis: 'base',
      comp: { min: 7_000_000, max: 9_000_000, currency: 'INR', period: 'year', basis: 'base' }, docsState: 'ready', recommendedFormat: 'pdf',
      terms: { covered: ['java', 'kafka'], missing: ['distributed systems'] }, unplaced: ['f-old-01'],
      breakdown: [{ label: 'base', points: 30 }, { label: 'strong:java', points: 4 }, { label: 'gap:php', points: -4 }],
      dedupeKey: '1d1d1d1d1d1d1d1d',
    }));
    writeDocs(s, K1);
    s.upsertJob(row(K2, 2, {
      title: 'Staff Engineer', company: 'Globex', score: 70, compMinInr: 10_437_500, compMaxInr: 12_525_000, compBasis: 'base',
      comp: { min: 125_000, max: 150_000, currency: 'USD', period: 'year', basis: 'base' }, notes: ['office/hybrid: Pune'],
    }));
    s.upsertJob(row(K3, 3, { title: 'Platform Engineer', company: 'Hooli', score: 90 }));
    s.upsertJob(row(K4, 4, { title: 'Backend Developer', company: 'Vandelay', score: 85, verdict: 'review' }));
    s.upsertJob(row(K5, 5, { title: 'Frontend Engineer', company: 'Umbrella', score: null, verdict: 'rejected', reasons: ['role:front[- ]?end'], breakdown: null }));
    s.upsertJob(row(K6, 6, { title: 'Junior Engineer', company: 'Soylent', score: 75, compMaxInr: 1_000_000, compMinInr: 400_000, comp: { min: 400_000, max: 1_000_000, currency: 'INR', period: 'year', basis: 'base' } }));
    s.upsertJob(row(K7, 7, { title: '<script>alert("x")</script>" onmouseover="y', company: "O'Reilly & Sons", score: 60 }));
    // a feed listing of K1: hidden from the list, K1 shows "also listed on himalayas"
    s.upsertJob(row(K8, 8, { title: 'Senior Backend Engineer', company: 'Acme Robotics', source: 'himalayas', dedupeKey: '1d1d1d1d1d1d1d1d', score: 80 }));
    // a Desk row
    s.importJob({ ...row(K9, 9, { title: 'Data Engineer', company: 'Initrode', score: 65 }), status: 'applied', note: 'from the desk', appliedAt: '2026-09-12T05:00:00.000Z', statusAt: '2026-09-12T05:00:00.000Z' });
    s.upsertJob(row(K10, 10, { title: 'Backend Engineer', company: '山 Systems', score: 66, docsState: 'blocked', docsDetail: 'renderer failed: invalid_output (unrenderable-glyph:U+5C71)' }));
    s.upsertJob(row(K11, 11, { title: 'Backend Engineer', company: 'Initech Labs', score: 50, notes: ['B2B contractor: no PF/benefits'] }));
    s.recordRun({
      runId: 'daily-2026-10-09', at: '2026-10-09T01:30:00.000Z',
      counts: { byAgent: { normalizer: { done: 3, failed: 0, gone: 1, inputRejected: 0, quarantined: 0, skipped: 0, pending: 0, replayed: 2 }, 'evidence-matcher': { done: 1, failed: 0, gone: 0, inputRejected: 0, quarantined: 1, skipped: 0, pending: 0, replayed: 0 } }, totals: { done: 4, failed: 0, gone: 1, inputRejected: 0, quarantined: 1, skipped: 0, pending: 0, replayed: 2 } },
      packHash: 'a'.repeat(64), policyHash: 'b'.repeat(64),
      warnings: ['the notification could not be posted: osascript missing'],
      problems: [{ kind: 'quarantined', agent: 'evidence-matcher', item: 'Hooli — Platform Engineer', reason: 'G-GROUND: bullet 2 is not a fact claim' }],
    });
  });
}

let cookie = '';
let token = '';
async function startSession(): Promise<void> {
  const res = await app.request(`/jobs/${K1}`);
  const set = res.headers.get('set-cookie') ?? '';
  cookie = /jp_sid=[0-9a-f]{32}/.exec(set)?.[0] ?? '';
  token = /name="_csrf" value="([0-9a-f]{64})"/.exec(await res.text())?.[1] ?? '';
  expect(cookie).not.toBe('');
  expect(token).not.toBe('');
}

/** No Origin is set here: an htmx request adds it (`hx`), a no-JS form post sends only what `nojs` says. */
const post = (path: string, form: Record<string, string>, headers: Record<string, string> = {}) =>
  app.request(path, {
    method: 'POST',
    body: new URLSearchParams(form).toString(),
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie, ...headers },
  });
/** htmx posts with XMLHttpRequest, which always sends the page's Origin. */
const hx = { 'hx-request': 'true', origin: 'http://localhost' };
/** A plain form post with JS off, under `Referrer-Policy: same-origin`: the page's Referer (the real-browser test covers Origin). */
const nojs = (page: string) => ({ referer: `http://localhost${page}` });
/** A download link clicked on a dashboard page. */
const dl = { 'sec-fetch-site': 'same-origin' };
const get = async (path: string): Promise<{ status: number; body: string; headers: Headers }> => {
  const r = await app.request(path, { headers: { cookie } });
  return { status: r.status, body: await r.text(), headers: r.headers };
};
const order = (body: string): string[] => [...body.matchAll(/data-job="([0-9a-f]{16})"/g)].map((m) => m[1] as string);

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'jobpilot-web-'));
  cpSync(join(root, 'tests/fixtures/pack'), join(home, 'pack'), { recursive: true });
  out = join(home, 'out');
  mkdirSync(out);
  seed();
  now = NOW;
  app = wrap(createDashboard({ home, clock: { now: () => now }, sessions: new Sessions(Buffer.alloc(32, 7)) }));
  await startSession();
});
afterEach(() => removeHome(home));

describe('I2: stale documents on the dashboard', () => {
  it('shows why, offers no download or preview, and refuses the files', async () => {
    withStore((s) => s.setDocs(K1, 'stale', 'cites a fact you rejected (f-nw-01)', s.getJob(K1)?.docs ?? []));
    const page = await get(`/jobs/${K1}`);
    expect(page.status).toBe(200);
    expect(page.body.replace(/&#0?39;|&apos;/g, "'")).toContain("These documents cite a fact you rejected; they'll be rebuilt next time the posting is seen");
    expect(page.body).not.toContain(`/jobs/${K1}/files/`);
    for (const name of ['resume.pdf', 'cover.docx', 'resume.html']) expect((await app.request(`/jobs/${K1}/files/${name}`, { headers: { cookie, ...dl } })).status).toBe(404);
  });
});

describe('dashboard: the short cover note', () => {
  /** Records the Rendered envelope behind K1's documents, the way the kernel stores it, with the filled letter. */
  function recordLetter(company = 'Acme Robotics'): CoverPlan {
    const plan = fillCover(coverPlanOf(posting({ jobKey: K1, title: 'Senior Backend Engineer', company })), fullPack().answers, fullPack().contact.city);
    const docs = withStore((s) => s.getJob(K1)!.docs);
    const ks = KernelStore.open(join(home, 'jobpilot.db'));
    try {
      ks.putSeed('seed-letter', {
        envelopeId: 'env-letter', stepKey: 'seed-letter', index: 0, type: 'Rendered@1', producer: { agentId: 'renderer', version: '1.1.0', contractHash: 'h' }, parents: [],
        payload: { jobKey: K1, files: docs.map((d) => ({ kind: d.kind, format: d.format, path: d.path, sha256: d.sha256, pages: d.pages })), recommended: 'pdf', plan, text: { resume: '', cover: '' } },
        handoff: { guarantees: [], dataClass: 'P1', obligations: [], pins: { policyHash: 'p' } }, guardrails: [], cost: { usd: 0, inputTokens: 0, outputTokens: 0 },
      }, '1', 'h');
    } finally {
      ks.close();
    }
    return plan;
  }
  const unescape = (b: string) => b.replace(/&#0?39;|&apos;/g, "'").replace(/&amp;/g, '&');

  it("shows the letter's opening sentence and its top fact, not the stale answers.yaml text", async () => {
    writeFileSync(join(home, 'pack', 'answers.yaml'), `${readFileSync(join(home, 'pack', 'answers.yaml'), 'utf8')}cover_note_short: I am available from 1 November and love Rust.\n`);
    const plan = recordLetter();
    const note = "I'm applying for the Senior Backend Engineer role at Acme Robotics. At Contoso Retail, I built the payments reconciliation service in Java and Postgres, processing 2M transactions nightly.";
    expect(plan.paragraphs[0]!.text.startsWith("I'm applying for the Senior Backend Engineer role at Acme Robotics. ")).toBe(true);
    expect(plan.paragraphs[1]!.text.startsWith(note.slice(note.indexOf('At Contoso')))).toBe(true);
    expect(coverNoteShort(plan)).toBe(note);
    const body = unescape((await get(`/jobs/${K1}`)).body);
    expect(body).toContain(`<dt>Cover note short</dt><dd>${note}</dd>`);
    expect(body).not.toContain('love Rust');
  });

  it('adds the row when answers.yaml has none, and keeps the answers.yaml text when no letter is on record', async () => {
    expect(unescape((await get(`/jobs/${K1}`)).body)).not.toContain('Cover note short');
    recordLetter();
    expect(unescape((await get(`/jobs/${K1}`)).body)).toContain('<dt>Cover note short</dt><dd>I&#39;m applying'.replace('&#39;', "'"));
    writeFileSync(join(home, 'pack', 'answers.yaml'), `${readFileSync(join(home, 'pack', 'answers.yaml'), 'utf8')}cover_note_short: My own note.\n`);
    expect(unescape((await get(`/jobs/${K3}`)).body)).toContain('<dt>Cover note short</dt><dd>My own note.</dd>');
  });
});

describe('dashboard: jobs list', () => {
  it('renders the rows fit-first within the eligibility tier, hiding rejected, below-floor and duplicate listings', async () => {
    const { status, body } = await get('/');
    expect(status).toBe(200);
    expect(order(body)).toEqual([K3, K1, K2, K10, K9, K7, K11, K4]);
    expect(textOf(rowOf(body, 'data-job', K1))).toContain('also listed on Himalayas');
    expect(textOf(body)).toContain('2 not-eligible or below-floor jobs are hidden');
  });

  it('formats pay in lakh and crore, foreign pay with its INR equivalent', async () => {
    const { body } = await get('/');
    expect(body).toContain('₹70–90 LPA');
    expect(body).toContain('$125k–150k');
    expect(body).toContain('≈ ₹1.04–1.25 Cr');
    expect(body).toContain('Pay not disclosed');
  });

  it('filters by status, band, minimum score and text, from the query string', async () => {
    expect(order((await get('/?status=applied')).body)).toEqual([K9]);
    expect(order((await get('/?band=rejected')).body)).toEqual([K5]);
    expect(order((await get('/?band=below-floor')).body)).toEqual([K6]);
    expect(order((await get('/?band=disclosed&band=below-floor')).body)).toEqual([K1, K2, K6]);
    expect(order((await get('/?min=85')).body)).toEqual([K3, K4]);
    expect(order((await get('/?q=reilly')).body)).toEqual([K7]);
    expect(order((await get('/?q=acme&min=70')).body)).toEqual([K1]);
    // a bad value is ignored, not an error
    expect((await get('/?status=bogus&band=nope&min=abc')).status).toBe(200);
    const f = (await get('/?status=applied&q=x')).body;
    expect(f).toMatch(/name="status" value="applied" checked/);
    expect(f).toContain('name="q" value="x"');
  });

  it('A5: one exception pill at most, none for To do, Documents ready or Pay at or above the minimum; remote as text', async () => {
    const { body } = await get('/');
    const k1 = rowOf(body, 'data-job', K1);
    expect(textOf(k1)).toContain('Remote · India');
    for (const s of ['Documents ready', 'Pay ≥ floor', 'Not started']) expect(textOf(k1), s).not.toContain(s);
    expect(elementsWith(k1, 'data-exception')).toEqual([]);
    expect(k1).not.toMatch(/\stitle="/);
    for (const k of order(body)) expect(elementsWith(rowOf(body, 'data-job', k), 'data-exception').length, k).toBeLessThanOrEqual(1);
    const pillOf = (k: string): string => textOf(elementsWith(rowOf(body, 'data-job', k), 'data-exception')[0] ?? '');
    expect(pillOf(K10)).toBe('Documents blocked');
    expect(pillOf(K4)).toBe('Check before applying');
    expect(pillOf(K11)).toBe('Contract (B2B)'); // beats "Pay not listed"
    expect(pillOf(K2)).toBe('Office: Pune'); // beats nothing: its pay is listed
    expect(pillOf(K3)).toBe('Pay not listed');
    expect(textOf(rowOf(body, 'data-job', K9))).toContain('From your Application Desk: Applied on 12 Sep 2026');
    expect(order(body)).not.toContain(K6); // below the minimum: hidden by default, so no row and no pill
    expect(textOf(elementsWith(rowOf((await get('/?band=below-floor')).body, 'data-job', K6), 'data-exception')[0] ?? '')).toBe('Pay under your minimum');
  });

  it('A5: remote shows India first, then how many more', async () => {
    withStore((s) => s.upsertJob(row('c5c5c5c5c5c5c5c5', 25, { title: 'Worldwide role', score: 61, remote: { structured: 'remote', countries: ['united states', 'canada', 'india'], signals: [] } })));
    expect(textOf(rowOf((await get('/')).body, 'data-job', 'c5c5c5c5c5c5c5c5'))).toContain('Remote · India +2');
  });

  it('the B2B and office notes stay in full on the job page', async () => {
    expect(textOf((await get(`/jobs/${K11}`)).body)).toContain('B2B contractor: no PF/benefits');
    expect(textOf((await get(`/jobs/${K2}`)).body)).toContain('office/hybrid: Pune');
  });

  it('A4: "new" is said once in the lede, and new rows get a dot, only when some but not all rows are new', async () => {
    const first = await (await app.request('/', { headers: { cookie } })).text();
    expect(textOf(first)).not.toContain('new since your last visit');
    expect(first).not.toContain('New since your last visit');
    expect(elementsWith(first, 'class', 'new-dot')).toEqual([]);
    const FRESH = 'c4c4c4c4c4c4c4c4';
    withStore((s) => s.upsertJob(row(FRESH, 24, { title: 'Fresh role', score: 79, at: '2026-10-09T05:00:00.000Z' })));
    const seen = Date.parse('2026-10-09T03:00:00.000Z'); // a visit after the first rows, before FRESH
    const r = await app.request('/', { headers: { cookie: `${cookie}; jp_visit=${seen}.${seen}` } });
    const body = await r.text();
    expect(textOf(body)).toContain('1 new since your last visit');
    expect(elementsWith(body, 'class', 'new-dot')).toHaveLength(1);
    expect(elementsWith(rowOf(body, 'data-job', FRESH), 'class', 'new-dot')).toHaveLength(1);
    expect(textOf(elementsWith(rowOf(body, 'data-job', FRESH), 'class', 'job-title')[0] ?? '')).toMatch(/^● New: Fresh role/);
    expect(r.headers.get('set-cookie')).toMatch(/jp_visit=\d+\.\d+/);
  });
});

describe('A1: the jobs list defaults and order', () => {
  it('hides Not for me and Not selected unless asked for, and links to them', async () => {
    withStore((s) => {
      s.setStatus(K3, 'skipped', 'user', NOW);
      s.setStatus(K7, 'rejected', 'user', NOW);
    });
    const { body } = await get('/');
    expect(order(body)).toEqual([K1, K2, K10, K9, K11, K4]);
    expect(textOf(body)).toContain('Not for me and Not selected are hidden: show them.');
    expect(linksOf(body).find((l) => l.text === 'show them')?.href).toBe('/?status=skipped&status=rejected');
    expect(order((await get('/?status=skipped&status=rejected')).body)).toEqual([K3, K7]);
    expect(textOf((await get('/?status=skipped')).body)).not.toContain('are hidden: show them');
    // the default shows as ticked boxes, like the band default
    for (const st of ['new', 'approved', 'applied', 'interview', 'offer']) expect(body).toMatch(new RegExp(`name="status" value="${st}" checked`));
    for (const st of ['rejected', 'skipped']) expect(body).not.toMatch(new RegExp(`name="status" value="${st}" checked`));
  });

  it('orders by eligibility tier, then fit, then INR pay, then newest, and says so', async () => {
    withStore((s) => {
      s.upsertJob(row('c1c1c1c1c1c1c1c1', 21, { title: 'Pay tie A', score: 77, compMinInr: 4_000_000, compMaxInr: 5_000_000, comp: { min: 4_000_000, max: 5_000_000, currency: 'INR', period: 'year', basis: 'base' } }));
      s.upsertJob(row('c2c2c2c2c2c2c2c2', 22, { title: 'Pay tie B', score: 77, compMinInr: 7_200_000, compMaxInr: 8_000_000, comp: { min: 7_200_000, max: 8_000_000, currency: 'INR', period: 'year', basis: 'base' } }));
      s.upsertJob(row('c3c3c3c3c3c3c3c3', 23, { title: 'Pay tie C', score: 77 }));
    });
    const { body } = await get('/');
    expect(order(body)).toEqual([K3, K1, 'c2c2c2c2c2c2c2c2', 'c1c1c1c1c1c1c1c1', 'c3c3c3c3c3c3c3c3', K2, K10, K9, K7, K11, K4]);
    expect(textOf(body)).toContain('sorted by best fit, then pay');
  });

  it('counts To decide with the U9 predicate (new, eligible or check first, first seen in the last 7 IST days)', async () => {
    expect(textOf((await get('/')).body)).toContain('8 jobs · 7 to decide');
    now = '2026-10-16T06:30:00.000Z'; // 16 Oct IST: the rows first seen on 9 Oct (IST) have left the window
    expect(textOf((await get('/')).body)).toContain('8 jobs · 0 to decide');
  });
});

describe('A8: filters fold away; a job remembers its list and the next row', () => {
  it('the filters are a <details>, open only when a filter is not the default, with the count in the summary', async () => {
    const closed = elementsWith((await get('/')).body, 'class', 'filter-more')[0] as string;
    expect(closed).toMatch(/^<details class="filter-more">/);
    expect(textOf(closed)).toMatch(/^Filters Min score/);
    const open = elementsWith((await get('/?band=rejected&min=60')).body, 'class', 'filter-more')[0] as string;
    expect(open).toMatch(/^<details class="filter-more" open>/);
    expect(textOf(open)).toMatch(/^Filters · 2 active/);
    expect(elementsWith(closed, 'name', 'q')).toEqual([]); // search and Apply stay outside
  });

  it('a row links to its job with from= and next=, and is its own anchor', async () => {
    const body = (await get('/?q=engineer')).body;
    const [a, b] = order(body) as [string, string];
    expect(linksOf(rowOf(body, 'data-job', a)).find((l) => l.href.startsWith('/jobs/'))?.href).toBe(`/jobs/${a}?from=%2F%3Fq%3Dengineer&next=${b}`);
    expect(attrsOf(rowOf(body, 'data-job', a))['id']).toBe(`job-${a}`);
  });

  it('the job page links back to its row; any other from is ignored', async () => {
    const crumb = (b: string): string | undefined => linksOf(elementsWith(b, 'class', 'crumbs')[0] ?? '')[0]?.href;
    expect(crumb((await get(`/jobs/${K1}?from=%2F%3Fq%3Dacme&next=${K2}`)).body)).toBe(`/?q=acme#job-${K1}`);
    for (const bad of ['%2F%2Fevil.example', 'https%3A%2F%2Fevil.example%2F', '%2Fjobs%2Fx', '%2F%5Cevil', 'javascript%3Aalert(1)', '%2F%3Fq%3Da%23x']) {
      expect(crumb((await get(`/jobs/${K1}?from=${bad}`)).body), bad).toBe(`/#job-${K1}`);
    }
  });

  it('without JS, a status that takes the job out of its list lands on the next row; any other stays on the job', async () => {
    const leave = await post(`/jobs/${K1}/status`, { _csrf: token, to: 'skipped', from: '/?q=e', next: K2 }, nojs(`/jobs/${K1}`));
    expect(leave.status).toBe(303);
    expect(leave.headers.get('location')).toBe(`/?q=e#job-${K2}`);
    const stay = await post(`/jobs/${K2}/status`, { _csrf: token, to: 'approved', from: '/?q=e', next: K3 }, nojs(`/jobs/${K2}`));
    expect(stay.headers.get('location')).toBe(`/jobs/${K2}?from=%2F%3Fq%3De&next=${K3}#status`);
    const kept = await post(`/jobs/${K3}/status`, { _csrf: token, to: 'skipped', from: '/?status=skipped', next: K4 }, nojs(`/jobs/${K3}`));
    expect(kept.headers.get('location')).toBe(`/jobs/${K3}?from=%2F%3Fstatus%3Dskipped&next=${K4}#status`);
    const last = await post(`/jobs/${K4}/status`, { _csrf: token, to: 'rejected', from: '/' }, nojs(`/jobs/${K4}`));
    expect(last.headers.get('location')).toBe('/#jobs');
    const bad = await post(`/jobs/${K7}/status`, { _csrf: token, to: 'skipped', from: '//evil.example', next: 'zz' }, nojs(`/jobs/${K7}`));
    expect(bad.headers.get('location')).toBe(`/jobs/${K7}#status`);
  });

  it('the status form carries from and next, so the plain POST knows them', async () => {
    const form = elementsWith((await get(`/jobs/${K1}?from=%2F%3Fq%3Dacme&next=${K2}`)).body, 'class', 'status-form')[0] as string;
    expect(attrsOf(elementsWith(form, 'name', 'from')[0] ?? '')['value']).toBe('/?q=acme');
    expect(attrsOf(elementsWith(form, 'name', 'next')[0] ?? '')['value']).toBe(K2);
  });
});

describe('dashboard: job page', () => {
  it('shows the header, why it matched, eligibility, documents, answers, status and note', async () => {
    const { status, body } = await get(`/jobs/${K1}`);
    expect(status).toBe(200);
    const t = textOf(body);
    expect(elementsWith(body, 'id', 'main').length).toBe(1);
    expect(textOf(body.slice(body.indexOf('<h1'), body.indexOf('</h1>') + 5))).toBe('Senior Backend Engineer');
    expect(linksOf(body).find((l) => l.href === 'https://boards.example.test/acme/jobs/1001')?.attrs['rel']).toBe('noopener noreferrer');
    for (const s of ['Why it matched', 'Core skill: Java', "Asks for PHP, which you don't list", 'Eligibility', 'Recommended for Greenhouse: PDF.', 'Missing terms are never added to your resume', 'distributed systems', 'Screening answers', 'Notice period days', 'Also listed on Himalayas', 'via Greenhouse']) expect(t).toContain(s);
    expect(attrsOf(elementsWith(body, 'src', `/jobs/${K1}/files/resume.html`)[0] ?? '')).toMatchObject({ class: 'preview preview-resume', sandbox: '' });
    expect(linksOf(body).filter((l) => l.href === `/jobs/${K1}/files/resume.pdf`).map((l) => l.text)).toEqual(['Download PDF of the resume (recommended)']);
    expect(linksOf(body).filter((l) => l.href === `/jobs/${K1}/files/resume.docx`).map((l) => l.text)).toEqual(['Download Word (DOCX) of the resume']);
    expect(body).toMatch(/name="to" value="applied"/);
    expect(elementsWith(body, 'id', 'note')).toHaveLength(1);
  });

  it('warns about unplaced facts, with their ids', async () => {
    const { body } = await get(`/jobs/${K1}`);
    expect(body).toContain("Some of your facts don&#39;t fall inside any role&#39;s dates — fix the dates in your pack: f-old-01");
    expect((await get(`/jobs/${K3}`)).body).not.toContain('fall inside any role');
  });

  it('says plainly why documents are blocked', async () => {
    const { body } = await get(`/jobs/${K10}`);
    expect(body).toContain('documents blocked: unrenderable character U+5C71 in the company name');
    expect(body).not.toContain('<iframe');
  });

  it('a duplicate listing points at the preferred one', async () => {
    expect((await get(`/jobs/${K8}`)).body).toContain(`<a href="/jobs/${K1}">the same job on Greenhouse</a>`);
  });

  it('404s an unknown or malformed job key', async () => {
    expect((await get('/jobs/ffffffffffffffff')).status).toBe(404);
    expect((await get('/jobs/..%2F..')).status).toBe(404);
  });
});

describe('dashboard: HTML escaping', () => {
  it('escapes a title with <script> and attribute-breaking quotes, and a company with & and an apostrophe', async () => {
    for (const path of ['/', `/jobs/${K7}`]) {
      const { body } = await get(path);
      expect(body).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&quot; onmouseover=&quot;y');
      expect(body).not.toContain('<script>alert');
      expect(body).not.toContain('" onmouseover="y');
      expect(body).toContain('O&#39;Reilly &amp; Sons');
    }
  });

  it('the html helper escapes values, nests fragments, and refuses objects', () => {
    expect(html`<a title="${'"><x>'}">${html`<b>${'&'}</b>`}${['<', 1]}${null}${false}</a>`.value).toBe('<a title="&quot;&gt;&lt;x&gt;"><b>&amp;</b>&lt;1</a>');
    expect(() => html`${{} as unknown as string}`).toThrow(TypeError);
  });

  it('no view interpolates outside the html helper', () => {
    const dir = join(root, 'src/app/web/views');
    const offenders: string[] = [];
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.ts'))) {
      const src = readFileSync(join(dir, f), 'utf8');
      // Every template literal must be tagged `html`; a `${` in an untagged one is raw interpolation.
      for (const where of untaggedTemplates(src)) offenders.push(`${f}:${where}`);
      if (/new\s+Html\s*\(/.test(src)) offenders.push(`${f}: new Html`);
      if (/\.innerHTML|dangerouslySetInnerHTML/.test(src)) offenders.push(`${f}: innerHTML`);
    }
    expect(offenders).toEqual([]);
    // the scanner itself catches an untagged interpolation
    expect(untaggedTemplates('const a = html`<p>${x}</p>`; const b = `<p>${y}</p>`;')).toHaveLength(1);
    expect(untaggedTemplates('const a = html`<p>${c ? html`<b>${d}</b>` : ""}</p>`;')).toHaveLength(0);
  });
});

/** Positions (line numbers) of template literals not tagged `html` that contain `${`. Skips strings and comments. */
function untaggedTemplates(src: string): number[] {
  const found: number[] = [];
  // stack of open template literals: whether tagged, and the brace depth when `${` opened
  const stack: { tagged: boolean; braces: number[]; hasExpr: boolean; line: number }[] = [];
  let i = 0;
  let line = 1;
  let depth = 0; // brace depth in code
  const inTemplate = () => stack.length > 0 && (stack.at(-1) as { braces: number[] }).braces.length === 0;
  while (i < src.length) {
    const ch = src[i] as string;
    if (ch === '\n') line += 1;
    if (inTemplate()) {
      const t = stack.at(-1) as (typeof stack)[number];
      if (ch === '\\') { i += 2; continue; }
      if (ch === '`') {
        stack.pop();
        if (!t.tagged && t.hasExpr) found.push(t.line);
        i += 1;
        continue;
      }
      if (ch === '$' && src[i + 1] === '{') {
        t.hasExpr = true;
        t.braces.push(depth);
        depth += 1;
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    if (ch === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i += 1; continue; }
    if (ch === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); line += src.slice(i, e).split('\n').length - 1; i = e + 2; continue; }
    if (ch === "'" || ch === '"') {
      i += 1;
      while (i < src.length && src[i] !== ch) i += src[i] === '\\' ? 2 : 1;
      i += 1;
      continue;
    }
    if (ch === '`') {
      const before = src.slice(0, i).trimEnd();
      stack.push({ tagged: /(^|[^\w$])html$/.test(before), braces: [], hasExpr: false, line });
      i += 1;
      continue;
    }
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      const t = stack.at(-1);
      if (t && t.braces.at(-1) === depth) t.braces.pop();
    }
    i += 1;
  }
  return found;
}

describe('dashboard: POST security', () => {
  it('a status POST without the HX header or the token is 403, and so is one from another origin', async () => {
    expect((await post(`/jobs/${K1}/status`, { to: 'approved' })).status).toBe(403);
    expect((await post(`/jobs/${K1}/status`, { to: 'approved' }, hx)).status).toBe(403);
    expect((await post(`/jobs/${K1}/status`, { to: 'approved', _csrf: token }, { ...hx, origin: 'http://evil.example' })).status).toBe(403);
    expect((await post(`/jobs/${K1}/status`, { to: 'approved', _csrf: token }, { ...hx, origin: '' })).status).toBe(403);
    expect((await post(`/jobs/${K1}/status`, { to: 'approved', _csrf: 'f'.repeat(64) }, hx)).status).toBe(403);
    expect((await post(`/jobs/${K1}/status`, { to: 'approved', _csrf: token }, { ...hx, cookie: 'jp_sid=' + '0'.repeat(32) })).status).toBe(403);
    expect(withStore((s) => s.getJob(K1)?.status)).toBe('new');
  });

  it('a valid htmx status POST updates the status, writes history and returns the status fragment', async () => {
    const r = await post(`/jobs/${K1}/status`, { to: 'approved', _csrf: token }, hx);
    expect(r.status).toBe(200);
    const body = await r.text();
    expect(body).toMatch(/^<section id="status"/);
    expect(body).toContain('Shortlisted');
    expect(body).not.toContain('<html');
    expect(withStore((s) => s.getJob(K1))).toMatchObject({ status: 'approved', history: [{ from: 'new', to: 'approved', at: NOW, by: 'user' }] });
  });

  it('the token may come in the X-CSRF-Token header; the Referer stands in for a missing Origin', async () => {
    const r = await post(`/jobs/${K1}/status`, { to: 'skipped' }, { ...hx, 'x-csrf-token': token, origin: '', referer: `http://localhost/jobs/${K1}` });
    expect(r.status).toBe(200);
    expect(withStore((s) => s.getJob(K1)?.status)).toBe('skipped');
  });

  it('without JavaScript a form POST with the token redirects back (303)', async () => {
    const r = await post(`/jobs/${K1}/status`, { to: 'approved', _csrf: token }, nojs(`/jobs/${K1}`));
    expect(r.status).toBe(303);
    expect(r.headers.get('location')).toBe(`/jobs/${K1}#status`);
    const n = await post(`/jobs/${K1}/note`, { note: 'ask about the team', _csrf: token }, nojs(`/jobs/${K1}`));
    expect(n.status).toBe(303);
    expect(withStore((s) => s.getJob(K1)?.note)).toBe('ask about the team');
  });

  it('refuses an invalid status and requests for any non-loopback host', async () => {
    expect((await post(`/jobs/${K1}/status`, { to: 'hired', _csrf: token }, hx)).status).toBe(400);
    expect((await app.request('http://evil.example/', { headers: { host: 'evil.example' } })).status).toBe(403);
    expect((await app.request('/', { headers: { host: 'localhost.evil.example' } })).status).toBe(403);
    expect((await app.request('/', { headers: { host: '' } })).status).toBe(403);
    // absolute-form target: the URL names a host other than the Host header
    expect((await app.request('http://127.0.0.1/', { headers: { host: 'evil.example' } })).status).toBe(403);
    expect((await app.request('http://127.0.0.1/', { headers: { host: '127.0.0.1', cookie } })).status).toBe(200);
  });

  it('pages work with JavaScript off: no inline script or handler, every form posts with a token', async () => {
    for (const path of ['/', `/jobs/${K1}`, '/facts', '/runs']) {
      const { body } = await get(path);
      expect(body.match(/<script\b[^>]*>/g)).toEqual(['<script src="/static/htmx.min.js" defer>', '<script src="/static/app.js" defer>']);
      expect(body).not.toMatch(/<[^>]*\son[a-z]+=/i);
      expect(body).not.toMatch(/<[^>]*\sstyle=/i);
      for (const form of body.match(/<form[^>]*method="post"[\s\S]*?<\/form>/g) ?? []) expect(form).toContain(`name="_csrf" value="${token}"`);
    }
  });
});

describe('dashboard: applied snapshots', () => {
  it('applying copies the current documents read-only into applied-<day>/, records them and serves them', async () => {
    const before = statSync(join(out, K1, 'resume.pdf'));
    const r = await post(`/jobs/${K1}/status`, { to: 'applied', _csrf: token }, hx);
    expect(r.status).toBe(200);
    const fragment = await r.text();
    expect(fragment).toContain('<section id="sent" class="card wide" hx-swap-oob="true"');
    const dir = join(out, K1, `applied-${DAY}`);
    expect(readdirSync(dir).sort()).toEqual(['cover.docx', 'cover.html', 'cover.pdf', 'resume.docx', 'resume.html', 'resume.pdf']);
    for (const f of readdirSync(dir)) {
      const st = lstatSync(join(dir, f));
      expect(st.isFile()).toBe(true);
      expect(st.mode & 0o777).toBe(0o444);
      expect(st.nlink).toBe(1);
    }
    expect(statSync(join(dir, 'resume.pdf')).ino).not.toBe(before.ino);
    const snaps = withStore((s) => s.snapshots(K1));
    expect(snaps).toHaveLength(1);
    expect(snaps[0]?.files.map((f) => f.path)).toContain(`${K1}/applied-${DAY}/resume.pdf`);
    for (const f of snaps[0]?.files ?? []) expect(f.sha256).toBe(sha(readFileSync(join(out, f.path))));
    expect(withStore((s) => s.getJob(K1)?.appliedAt)).toBe(NOW);

    const page = (await get(`/jobs/${K1}`)).body;
    expect(page).toContain('Documents you sent');
    expect(page).toContain('Applied 9 Oct 2026');
    expect(page).toContain(`href="/jobs/${K1}/sent/${DAY}/resume.pdf" download`);
    const served = await app.request(`/jobs/${K1}/sent/${DAY}/resume.pdf`, { headers: { cookie } });
    expect(served.status).toBe(200);
    expect(Buffer.from(await served.arrayBuffer()).toString()).toBe(`resume.pdf of ${K1}`);
    expect(served.headers.get('content-disposition')).toBe('attachment; filename="resume-acme-robotics-sent-2026-10-09.pdf"');
  });

  /** A re-render: the current resume changes on disk and in job_docs. */
  const rerender = (text: string): void => {
    writeFileSync(join(out, K1, 'resume.pdf'), text);
    withStore((s) => s.putDocs(K1, s.getJob(K1)?.docs.map((d) => (d.kind === 'resume' && d.format === 'pdf' ? { ...d, sha256: sha(text) } : d)) ?? []));
  };

  it('applied → applied on a later day: no new snapshot (it is not a transition into applied)', async () => {
    await post(`/jobs/${K1}/status`, { to: 'applied', _csrf: token }, hx);
    rerender('a newer resume');
    now = '2026-10-12T06:30:00.000Z';
    const r = await post(`/jobs/${K1}/status`, { to: 'applied', _csrf: token }, hx);
    expect(r.status).toBe(200);
    const snaps = withStore((s) => s.snapshots(K1));
    expect(snaps.map((x) => x.day)).toEqual([DAY]);
    expect(existsSync(join(out, K1, 'applied-2026-10-12'))).toBe(false);
    expect(readFileSync(join(out, K1, `applied-${DAY}`, 'resume.pdf'), 'utf8')).toBe(`resume.pdf of ${K1}`);
  });

  it('applied → interview → applied (same day or later): the job keeps its one snapshot, and later renders never touch it', async () => {
    await post(`/jobs/${K1}/status`, { to: 'applied', _csrf: token }, hx);
    await post(`/jobs/${K1}/status`, { to: 'interview', _csrf: token }, hx);
    await post(`/jobs/${K1}/status`, { to: 'applied', _csrf: token }, hx);
    rerender('a newer resume');
    now = '2026-10-16T06:30:00.000Z';
    await post(`/jobs/${K1}/status`, { to: 'interview', _csrf: token }, hx);
    await post(`/jobs/${K1}/status`, { to: 'applied', _csrf: token }, hx);
    const snaps = withStore((s) => s.snapshots(K1));
    expect(snaps.map((x) => x.day)).toEqual([DAY]);
    expect(snaps[0]?.files).toHaveLength(6);
    expect(readdirSync(join(out, K1)).filter((f) => f.startsWith('applied-'))).toEqual([`applied-${DAY}`]);
    const served = await app.request(`/jobs/${K1}/sent/${DAY}/resume.pdf`, { headers: { cookie } });
    expect(Buffer.from(await served.arrayBuffer()).toString()).toBe(`resume.pdf of ${K1}`);
  });

  it('the snapshot folder is read-only (0555) once written', async () => {
    await post(`/jobs/${K1}/status`, { to: 'applied', _csrf: token }, hx);
    expect(statSync(join(out, K1, `applied-${DAY}`)).mode & 0o777).toBe(0o555);
  });

  it('a sent preview is served byte-exact (no tooltips added)', async () => {
    await post(`/jobs/${K1}/status`, { to: 'applied', _csrf: token }, hx);
    const r = await app.request(`/jobs/${K1}/sent/${DAY}/resume.html`, { headers: { cookie } });
    expect(Buffer.from(await r.arrayBuffer()).toString('utf8')).toBe(readFileSync(join(out, K1, `applied-${DAY}`, 'resume.html'), 'utf8'));
    expect(r.headers.get('content-disposition')).toBe('inline');
  });

  it('a job without ready documents is marked applied with no snapshot, and says so', async () => {
    const r = await post(`/jobs/${K3}/status`, { to: 'applied', _csrf: token }, hx);
    expect(await r.text()).toContain('No documents were kept');
    const n = await post(`/jobs/${K4}/status`, { to: 'applied', _csrf: token }, nojs(`/jobs/${K4}`));
    expect(n.headers.get('location')).toBe(`/jobs/${K4}?notice=nodocs#status`);
    expect((await get(`/jobs/${K4}?notice=nodocs`)).body).toContain('No documents were kept');
    expect(withStore((s) => s.snapshots(K3))).toEqual([]);
    expect(withStore((s) => s.getJob(K3)?.status)).toBe('applied');
  });

  it('refuses to snapshot through a symlinked job folder', async () => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'jobpilot-else-'));
    try {
      cpSync(join(out, K1), elsewhere, { recursive: true });
      rmSync(join(out, K1), { recursive: true });
      symlinkSync(elsewhere, join(out, K1));
      const r = await post(`/jobs/${K1}/status`, { to: 'applied', _csrf: token }, hx);
      expect(await r.text()).toContain('could not be kept');
      expect(withStore((s) => s.snapshots(K1))).toEqual([]);
      expect(existsSync(join(elsewhere, `applied-${DAY}`))).toBe(false);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});

describe('dashboard: file route', () => {
  const fetchFile = (path: string) => app.request(path, { headers: { cookie } });

  it('serves recorded documents: downloads as attachments, previews inline with fact tooltips and a locked-down CSP', async () => {
    const pdf = await fetchFile(`/jobs/${K1}/files/resume.pdf`);
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get('content-type')).toBe('application/pdf');
    expect(pdf.headers.get('content-disposition')).toBe('attachment; filename="resume-acme-robotics.pdf"');
    expect(pdf.headers.get('x-content-type-options')).toBe('nosniff');
    const prev = await fetchFile(`/jobs/${K1}/files/resume.html`);
    expect(prev.headers.get('content-disposition')).toBe('inline');
    expect(prev.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(prev.headers.get('content-security-policy')).toContain('sandbox');
    expect(await prev.text()).toContain('<li data-fact="f-nw-01" title="Fact f-nw-01">');
  });

  it('rejects names not recorded in job_docs or job_snapshots for that job, traversal and other jobs\' files', async () => {
    writeFileSync(join(out, K1, 'notes.txt'), 'private');
    expect((await fetchFile(`/jobs/${K1}/files/notes.txt`)).status).toBe(404);
    mkdirSync(join(out, K3));
    writeFileSync(join(out, K3, 'resume.pdf'), 'not recorded');
    expect((await fetchFile(`/jobs/${K3}/files/resume.pdf`)).status).toBe(404);
    for (const p of [`/jobs/${K1}/files/..%2F..%2Fjobpilot.db`, `/jobs/${K1}/files/%2e%2e`, `/jobs/${K1}/files/..%2Fresume.pdf`, `/jobs/${K1}/sent/..%2F..%2F/resume.pdf`, `/jobs/${K1}/sent/${DAY}/resume.pdf`, `/jobs/${K1}/files/resume.pdf%00.txt`]) {
      expect((await fetchFile(p)).status, p).toBe(404);
    }
  });

  it('refuses a recorded file that became a symlink or a hard link, and one changed on disk', async () => {
    const elsewhere = join(home, 'cover-copy.pdf');
    writeFileSync(elsewhere, readFileSync(join(out, K1, 'cover.pdf')));
    unlinkSync(join(out, K1, 'cover.pdf'));
    symlinkSync(elsewhere, join(out, K1, 'cover.pdf'));
    expect((await fetchFile(`/jobs/${K1}/files/cover.pdf`)).status).toBe(403);
    linkSync(join(out, K1, 'cover.docx'), join(home, 'cover-hardlink.docx'));
    expect((await fetchFile(`/jobs/${K1}/files/cover.docx`)).status).toBe(403);
    writeFileSync(join(out, K1, 'resume.docx'), 'edited');
    expect((await fetchFile(`/jobs/${K1}/files/resume.docx`)).status).toBe(409);
    unlinkSync(join(out, K1, 'resume.pdf'));
    expect((await fetchFile(`/jobs/${K1}/files/resume.pdf`)).status).toBe(404);
  });
});

describe('dashboard: facts', () => {
  it('lists every fact with its status, kind, employer (display name) and period, never a forbidden term', async () => {
    const { body } = await get('/facts');
    expect(body).toContain('f-nw-01');
    expect(body).toContain('Led the design of an event-driven order pipeline');
    expect(body).toContain('Mar 2022 – present');
    expect(body).toContain('Northwind Labs');
    expect(body).toMatch(/fact-unverified[^>]*id="fact-f-nw-05"/);
    expect(body).toContain('Not used in documents until you verify it.');
    expect(body).toContain('The next run makes the affected documents again.');
    expect(body).not.toMatch(/initech/i);
  });

  it('Verify writes a fact override (htmx: the row; no JS: a redirect), Reject too', async () => {
    expect((await post('/facts/f-nw-05/verify', {})).status).toBe(403);
    const r = await post('/facts/f-nw-05/verify', { _csrf: token }, hx);
    expect(r.status).toBe(200);
    const row = await r.text();
    expect(row).toMatch(/^<li class="fact"/);
    expect(row).toContain('Verified');
    expect(row).toContain('your change (facts.yaml says Not verified)');
    expect(withStore((s) => s.factOverrides())).toEqual({ 'f-nw-05': 'verified' });
    const n = await post('/facts/f-nw-01/reject', { _csrf: token }, nojs('/facts'));
    expect(n.status).toBe(303);
    expect(n.headers.get('location')).toBe('/facts#fact-f-nw-01');
    expect(withStore((s) => s.factOverrides())).toEqual({ 'f-nw-01': 'rejected', 'f-nw-05': 'verified' });
    expect((await post('/facts/no-such-fact/verify', { _csrf: token }, hx)).status).toBe(404);
  });
});

describe('dashboard: runs', () => {
  it('shows the counts per agent, problems with reasons, warnings, hashes and the audit chain status', async () => {
    const { body } = await get('/runs');
    expect(body).toContain('daily-2026-10-09');
    expect(body).toContain('G-GROUND: bullet 2 is not a fact claim');
    expect(body).toContain('Quarantined');
    expect(body).toContain('Input rejected');
    expect(body).toContain('the notification could not be posted: osascript missing');
    expect(elementsWith(body, 'title', 'a'.repeat(64)).map(textOf)).toEqual(['a'.repeat(12)]);
    expect(body).toContain('Audit log intact');
    expect(body).toContain('9 Oct 2026, 07:00 IST');
  });

  it('reports a broken audit chain', async () => {
    withStore((s) => {
      s.kernel.appendEvent('r1', NOW, 'run_started', { n: 1 }, 'h');
      s.kernel.appendEvent('r1', NOW, 'run_finished', { n: 2 }, 'h');
      s.kernel.db.prepare(`UPDATE events SET data = '{"n":99}' WHERE seq = 1`).run();
    });
    const { body } = await get('/runs');
    expect(body).toContain('Audit log broken: at event 1: hash does not match the event contents');
  });
});

describe('dashboard: runs, audit chain checkpoint (dashboard-perf fix 1)', () => {
  const T_FULL = '2026-10-08T03:30:00.000Z'; // 9:00 IST
  const append = (n: number): void => withStore((s) => {
    for (let i = 0; i < n; i++) s.kernel.appendEvent('r1', NOW, 'step_done', { i }, 'h');
  });

  it('with no checkpoint: a full check now, recorded, and the next view checks only newer events', async () => {
    append(3);
    const first = (await get('/runs')).body;
    expect(first).toContain('Audit log intact: <span class="num">3</span> events');
    expect(first).toContain('Full check: just now.');
    expect(withStore((s) => readCheckpoint(s.kernel.db))).toMatchObject({ seq: 3, count: 3, verifiedAt: NOW, fullSeq: 3 });
    append(2);
    const next = (await get('/runs')).body;
    expect(next).toContain('Audit log intact: <span class="num">5</span> events');
    expect(next).toContain('Last full check: 9 Oct 2026, 12:00 IST, through event <span class="num">3</span> (it runs weekly with coverage, or run <code>jobpilot audit verify</code>); the <span class="num">2</span> newer events were checked against it.');
    expect(next).not.toContain('Full check: just now');
  });

  it('shows when the last full check ran (jobpilot audit)', async () => {
    append(2);
    withStore((s) => fullChainCheck(s.kernel, T_FULL));
    const { body } = await get('/runs');
    expect(body).toContain('Last full check: 8 Oct 2026, 09:00 IST, through event <span class="num">2</span>');
  });

  it('tampering after the checkpoint is shown loudly: the line and a critical banner', async () => {
    append(2);
    withStore((s) => fullChainCheck(s.kernel, T_FULL));
    append(2);
    withStore((s) => s.kernel.db.prepare(`UPDATE events SET data = '{"i":99}' WHERE seq = 4`).run());
    const { body } = await get('/runs');
    expect(body).toContain('Audit log broken: at event 4: hash does not match the event contents');
    expect(body).toMatch(/class="banner[^"]*critical[^"]*"[^>]*>[^<]*The audit log is broken/);
    expect(body).not.toContain('Audit log intact');
  });

  it('tampering before the checkpoint: /runs never claims a fresh full check', async () => {
    append(3);
    withStore((s) => fullChainCheck(s.kernel, T_FULL));
    withStore((s) => s.kernel.db.prepare(`UPDATE events SET data = '{"i":99}' WHERE seq = 1`).run());
    const { body } = await get('/runs');
    expect(body).not.toContain('Full check: just now');
    expect(body).toContain('Last full check: 8 Oct 2026, 09:00 IST');
    expect(withStore((s) => fullChainCheck(s.kernel, NOW))).toMatchObject({ ok: false, brokenAt: 1 });
  });

  it('a failed full check (audit verify, weekly coverage) turns /runs red until a later full check passes', async () => {
    append(3);
    withStore((s) => fullChainCheck(s.kernel, T_FULL));
    withStore((s) => s.kernel.db.prepare(`UPDATE events SET data = '{"i":99}' WHERE seq = 1`).run());
    expect((await get('/runs')).body).toContain('Audit log intact'); // before the edit is seen by a full check
    withStore((s) => fullChainCheck(s.kernel, NOW));
    const red = (await get('/runs')).body;
    expect(red).toContain('Audit log broken: at event 1: hash does not match the event contents (found by the full check at 2026-10-09T06:30:00.000Z)');
    expect(red).toMatch(/banner-critical[^>]*>[^<]*The audit log is broken/);
    expect(red).not.toContain('Audit log intact');
    withStore((s) => s.kernel.db.prepare(`UPDATE events SET data = '{"i":0}' WHERE seq = 1`).run());
    expect((await get('/runs')).body).toContain('Audit log broken');
    withStore((s) => fullChainCheck(s.kernel, NOW));
    expect((await get('/runs')).body).toContain('Audit log intact');
  });

  it('a checkpoint that does not match the chain falls back to the full check', async () => {
    append(3);
    withStore((s) => {
      fullChainCheck(s.kernel, T_FULL);
      s.kernel.db.prepare(`UPDATE events SET data = '{"i":99}' WHERE seq = 2`).run();
      s.kernel.db.prepare(`UPDATE app_settings SET value = ? WHERE key = ?`).run(JSON.stringify({ seq: 3, hash: 'f'.repeat(64), count: 3, verifiedAt: T_FULL }), CHAIN_CHECKPOINT_KEY);
    });
    const { body } = await get('/runs');
    expect(body).toContain('Audit log broken: at event 2: hash does not match the event contents');
  });

  it('warns when the last full check is more than 8 days old', async () => {
    append(1);
    withStore((s) => fullChainCheck(s.kernel, '2026-10-01T03:30:00.000Z')); // 8 days before 9 Oct: no warning yet
    const fresh = (await get('/runs')).body;
    expect(fresh).not.toContain('last full check was');
    withStore((s) => fullChainCheck(s.kernel, '2026-09-30T03:30:00.000Z')); // 9 days
    const { body } = await get('/runs');
    expect(body).toMatch(/class="banner banner-warn"[^>]*>The audit log&#39;s last full check was 9 days ago \(30 Sept? 2026\)\. Coverage runs it weekly; run &quot;jobpilot audit verify&quot; now\./);
    expect(body).toContain('Last full check: 30 Sep 2026');
  });
});

describe('dashboard: banners and headers', () => {
  it('warns when the exchange rates are more than 30 days old', async () => {
    expect((await get('/')).body).not.toContain('Exchange rates are');
    writeFileSync(join(home, 'pack/fx.yaml'), 'asOf: "2026-08-01"\ntoINR: { USD: 83.5, EUR: 90.2, GBP: 106.4, INR: 1 }\n');
    for (const p of ['/', `/jobs/${K1}`, '/facts', '/runs']) expect((await get(p)).body, p).toContain('Exchange rates are 69 days old — update fx.yaml');
  });

  it('sets the CSP and nosniff on every page', async () => {
    for (const p of ['/', `/jobs/${K1}`, '/facts', '/runs', '/static/app.css', '/nope']) {
      const { headers } = await get(p);
      const csp = headers.get('content-security-policy') ?? '';
      for (const d of ["default-src 'self'", "script-src 'self'", "frame-src 'self'", "object-src 'none'"]) expect(csp, p).toContain(d);
      expect(headers.get('x-content-type-options'), p).toBe('nosniff');
    }
  });

  it('serves htmx vendored from the installed package, never a CDN', async () => {
    const r = await get('/static/htmx.min.js');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('javascript');
    expect(r.body).toContain('htmx');
    expect((await get('/')).body).not.toMatch(/https?:\/\/[^"]*\.(js|css)/);
  });

  it('hides any shown text that names a forbidden term', async () => {
    const list = (await get('/')).body;
    expect(list).not.toMatch(/initech/i);
    expect(list).toContain('[hidden: contains a forbidden term]');
    expect((await get(`/jobs/${K11}`)).body).not.toMatch(/initech/i);
  });

  it('binds 127.0.0.1 only', async () => {
    const server = serveDashboard({ home, clock: { now: () => NOW }, port: 0 });
    try {
      await new Promise<void>((resolve) => (server.listening ? resolve() : server.once('listening', () => resolve())));
      expect((server.address() as AddressInfo).address).toBe('127.0.0.1');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('A13: static files carry an ETag', () => {
  it('a matching If-None-Match gets 304 with no body; anything else gets the file', async () => {
    const first = await get('/static/app.css');
    const etag = first.headers.get('etag') as string;
    expect(etag).toMatch(/^"[0-9a-f]{32}"$/);
    expect(etag).toBe(`"${createHash('sha256').update(first.body).digest('hex').slice(0, 32)}"`);
    expect(first.headers.get('cache-control')).toBe('no-cache');
    const again = await app.request('/static/app.css', { headers: { cookie, 'if-none-match': etag } });
    expect(again.status).toBe(304);
    expect(await again.text()).toBe('');
    expect(again.headers.get('etag')).toBe(etag);
    expect(again.headers.get('content-security-policy')).toContain("default-src 'self'");
    expect((await app.request('/static/app.css', { headers: { cookie, 'if-none-match': `"0", ${etag}` } })).status).toBe(304);
    expect((await app.request('/static/app.css', { headers: { cookie, 'if-none-match': '"0"' } })).status).toBe(200);
    expect((await get('/static/app.js')).headers.get('etag')).not.toBe(etag);
  });
});

describe('dashboard: fix round 1', () => {
  it('C1: Referrer-Policy is same-origin in the header and the meta tag, so browsers send a same-origin Origin on form posts', async () => {
    const { headers, body } = await get('/');
    expect(headers.get('referrer-policy')).toBe('same-origin');
    expect(body).toContain('<meta name="referrer" content="same-origin">');
    expect(body).not.toContain('no-referrer"');
    expect((await post(`/jobs/${K1}/status`, { to: 'approved', _csrf: token }, { origin: 'null' })).status).toBe(403);
  });

  it('I2: htmx errors are shown: app.js is served from the dashboard and the page has a live region for them', async () => {
    const js = await get('/static/app.js');
    expect(js.status).toBe(200);
    expect(js.headers.get('content-type')).toContain('javascript');
    expect(js.body).toContain('htmx:responseError');
    expect(js.body).toContain('Your session expired, reload the page');
    expect((await get('/')).body).toMatch(/<p id="htmx-error" class="toast" role="alert" aria-live="assertive" hidden><\/p>/);
  });

  it('I2: the CSRF secret is kept in app_settings, so a token survives a restart', async () => {
    const a = wrap(createDashboard({ home, clock: { now: () => now } }));
    const first = await a.request(`/jobs/${K1}`);
    const sid = /jp_sid=[0-9a-f]{32}/.exec(first.headers.get('set-cookie') ?? '')?.[0] ?? '';
    const tok = /name="_csrf" value="([0-9a-f]{64})"/.exec(await first.text())?.[1] ?? '';
    const secret = withStore((s) => s.getSetting('dashboard.csrf_secret'));
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    const restarted = wrap(createDashboard({ home, clock: { now: () => now } }));
    const r = await restarted.request(`/jobs/${K1}/status`, {
      method: 'POST', body: new URLSearchParams({ to: 'approved', _csrf: tok }).toString(),
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: sid, ...hx },
    });
    expect(r.status).toBe(200);
    expect(withStore((s) => s.getSetting('dashboard.csrf_secret'))).toBe(secret);
  });

  it('I3: while a run holds the write lock, pages still read and a POST answers 503 with a plain message', async () => {
    const busy = wrap(createDashboard({ home, clock: { now: () => now }, sessions: new Sessions(Buffer.alloc(32, 7)), busyTimeoutMs: 100 }));
    const lock = new Database(join(home, 'jobpilot.db'));
    lock.pragma('busy_timeout = 0');
    lock.exec('BEGIN IMMEDIATE');
    try {
      expect((await busy.request('/', { headers: { cookie } })).status).toBe(200);
      const r = await busy.request(`/jobs/${K1}/status`, {
        method: 'POST', body: new URLSearchParams({ to: 'applied', _csrf: token }).toString(),
        headers: { 'content-type': 'application/x-www-form-urlencoded', cookie, ...hx },
      });
      expect(r.status).toBe(503);
      expect(await r.text()).toBe("jobpilot is busy finishing today's run — try again in a moment");
    } finally {
      lock.exec('ROLLBACK');
      lock.close();
    }
    expect(withStore((s) => s.getJob(K1)?.status)).toBe('new');
    expect(existsSync(join(out, K1, `applied-${DAY}`))).toBe(false);
  });

  it('M1: with a port, only 127.0.0.1:<port>, localhost:<port> and [::1]:<port> are accepted', async () => {
    const p = wrap(createDashboard({ home, clock: { now: () => now }, port: 4317 }));
    expect((await p.request('http://127.0.0.1:4317/', { headers: { host: '127.0.0.1:4317' } })).status).toBe(200);
    expect((await p.request('http://localhost:4317/', { headers: { host: 'localhost:4317' } })).status).toBe(200);
    expect((await p.request('http://[::1]:4317/', { headers: { host: '[::1]:4317' } })).status).toBe(200);
    expect((await p.request('http://127.0.0.1:1/', { headers: { host: '127.0.0.1:1' } })).status).toBe(403);
    expect((await p.request('http://127.0.0.1/', { headers: { host: '127.0.0.1' } })).status).toBe(403);
  });

  it('M2: the built-in fx defaults get their own banner', async () => {
    writeFileSync(join(home, 'pack/fx.yaml'), 'asOf: "1970-01-01"\ntoINR: { USD: 83, EUR: 90, GBP: 105, INR: 1 }\n');
    const { body } = await get('/');
    expect(body).toContain('Exchange rates are the built-in defaults; add fx.yaml');
    expect(body).not.toContain('days old');
  });

  it('M4: the list is paginated, 100 a page, with the page in the query string', async () => {
    withStore((s) => {
      for (let i = 0; i < 205; i++) {
        const key = (0xc000000000000000n + BigInt(i)).toString(16);
        s.upsertJob(row(key, 1000 + i, { title: `Bulk ${i}`, company: 'Bulk Co', score: 40, dedupeKey: key }));
      }
    });
    const p1 = await get('/');
    expect(order(p1.body)).toHaveLength(100);
    expect(p1.body).toContain('Page 1 of 3');
    expect(p1.body).toContain('href="/?page=2"');
    const p3 = await get('/?page=3&q=bulk');
    expect(order(p3.body)).toHaveLength(5);
    expect(p3.body).toContain('href="/?q=bulk&amp;page=2"');
    expect(order((await get('/?page=99')).body)).toHaveLength(13);
  });

  it('M5: Html has no public factory', () => {
    expect(Object.keys(htmlModule).sort()).toEqual(['Html', 'externalUrl', 'html']);
    expect((htmlModule.Html as unknown as Record<string, unknown>)['of']).toBeUndefined();
  });

  it('names sources and ATSs properly and shows "New" once per row', async () => {
    const { body } = await get('/');
    const k3 = rowOf(body, 'data-job', K3);
    expect(k3.match(/>New</g) ?? []).toHaveLength(0);
    expect(textOf(k3)).not.toContain('Not started'); // A5: To do has no pill
    expect(textOf(k3)).not.toContain('New since your last visit');
  });
});

describe('dashboard: fix round 2 (keep a copy, downloads)', () => {
  const rerender = (text: string): void => {
    writeFileSync(join(out, K1, 'resume.pdf'), text);
    withStore((s) => s.putDocs(K1, s.getJob(K1)?.docs.map((d) => (d.kind === 'resume' && d.format === 'pdf' ? { ...d, sha256: sha(text) } : d)) ?? []));
  };

  it('an applied job with ready docs and no snapshot offers "Keep a copy of these documents now", once', async () => {
    withStore((s) => s.setStatus(K1, 'applied', 'user', NOW)); // applied outside the dashboard (e.g. the Desk): no snapshot
    const page = (await get(`/jobs/${K1}`)).body;
    expect(page).toContain('Keep a copy of these documents now');
    expect(page).toContain(`action="/jobs/${K1}/keep"`);
    expect((await post(`/jobs/${K1}/keep`, {}, hx)).status).toBe(403);
    const r = await post(`/jobs/${K1}/keep`, { _csrf: token }, hx);
    expect(r.status).toBe(200);
    expect(await r.text()).toContain('Documents you sent');
    const snaps = withStore((s) => s.snapshots(K1));
    expect(snaps.map((x) => x.day)).toEqual([DAY]);
    expect(snaps[0]?.files).toHaveLength(6);
    expect(statSync(join(out, K1, `applied-${DAY}`, 'resume.pdf')).mode & 0o777).toBe(0o444);
    expect((await get(`/jobs/${K1}`)).body).not.toContain('Keep a copy of these documents now');
    // the one-snapshot rule: a second keep (even on a later day) is refused and writes nothing
    now = '2026-10-12T06:30:00.000Z';
    expect((await post(`/jobs/${K1}/keep`, { _csrf: token }, hx)).status).toBe(409);
    expect(withStore((s) => s.snapshots(K1))).toHaveLength(1);
    expect(existsSync(join(out, K1, 'applied-2026-10-12'))).toBe(false);
    // no-JS: a redirect back
    withStore((s) => s.setStatus(K2, 'applied', 'user', NOW));
    expect((await get(`/jobs/${K2}`)).body).not.toContain('Keep a copy'); // no ready docs
  });

  it('keep is refused for a job that is not applied or whose docs are not ready', async () => {
    expect((await post(`/jobs/${K1}/keep`, { _csrf: token }, hx)).status).toBe(409);
    withStore((s) => s.setStatus(K3, 'applied', 'user', NOW));
    expect((await post(`/jobs/${K3}/keep`, { _csrf: token }, hx)).status).toBe(409);
    expect(withStore((s) => s.snapshots(K1).length + s.snapshots(K3).length)).toBe(0);
  });

  it('records each download (job, file, sha256, time); previews are not downloads', async () => {
    await app.request(`/jobs/${K1}/files/resume.pdf`, { headers: { cookie, ...dl } });
    await app.request(`/jobs/${K1}/files/cover.docx`, { headers: { cookie, ...dl } });
    await app.request(`/jobs/${K1}/files/resume.html`, { headers: { cookie, ...dl } });
    expect(withStore((s) => s.downloads(K1))).toEqual([
      { file: 'resume.pdf', sha256: sha(`resume.pdf of ${K1}`), at: NOW },
      { file: 'cover.docx', sha256: sha(`cover.docx of ${K1}`), at: NOW },
    ]);
  });

  it('warns when the kept copy differs from what was downloaded before applying', async () => {
    await app.request(`/jobs/${K1}/files/resume.pdf`, { headers: { cookie, ...dl } });
    now = '2026-10-10T06:30:00.000Z';
    rerender('a re-rendered resume');
    await post(`/jobs/${K1}/status`, { to: 'applied', _csrf: token }, hx);
    const page = (await get(`/jobs/${K1}`)).body;
    expect(page).toContain('These documents changed after you downloaded them on 9 Oct 2026: the copy kept here is the current version.');
  });

  it('no warning when the downloaded files are the ones kept', async () => {
    await app.request(`/jobs/${K1}/files/resume.pdf`, { headers: { cookie, ...dl } });
    await post(`/jobs/${K1}/status`, { to: 'applied', _csrf: token }, hx);
    expect((await get(`/jobs/${K1}`)).body).not.toContain('changed after you downloaded');
  });
});

describe('dashboard: fix round 3', () => {
  it('I4: a copy made on the apply day is "Applied <day>"; a later one says when it was made, never "exactly as they were"', async () => {
    await post(`/jobs/${K1}/status`, { to: 'applied', _csrf: token }, hx);
    const same = (await get(`/jobs/${K1}`)).body;
    expect(same).toContain('<h3>Applied 9 Oct 2026</h3>');
    expect(same).toContain('exactly as they were that day');

    withStore((s) => s.setStatus(K2, 'applied', 'user', '2026-10-01T06:30:00.000Z'));
    writeDocsFor(K2);
    const before = (await get(`/jobs/${K2}`)).body;
    expect(before).toContain("A copy made now is today's version, which may differ from what you sent.");
    await post(`/jobs/${K2}/keep`, { _csrf: token }, hx);
    const later = (await get(`/jobs/${K2}`)).body;
    expect(later).toContain('<h3>Copy kept 9 Oct 2026 (made after you applied on 1 Oct 2026)</h3>');
    expect(later).not.toContain('exactly as they were that day');
  });

  it('M8: a download is recorded only from the dashboard itself (Sec-Fetch-Site, else a same-origin Referer)', async () => {
    const fetchPdf = (headers: Record<string, string>) => app.request(`/jobs/${K1}/files/resume.pdf`, { headers: { cookie, ...headers } });
    expect((await fetchPdf({ 'sec-fetch-site': 'cross-site' })).status).toBe(200);
    expect((await fetchPdf({ 'sec-fetch-site': 'same-site' })).status).toBe(200);
    expect((await fetchPdf({})).status).toBe(200);
    expect((await fetchPdf({ referer: 'http://evil.example/x' })).status).toBe(200);
    expect(withStore((s) => s.downloads(K1))).toHaveLength(0);
    await fetchPdf({ 'sec-fetch-site': 'same-origin' });
    await fetchPdf({ 'sec-fetch-site': 'none' });
    await fetchPdf({ referer: `http://localhost/jobs/${K1}` });
    expect(withStore((s) => s.downloads(K1))).toHaveLength(3);
  });

  it('M9: a busy store never blocks or fails a download; the record is skipped', async () => {
    const lock = new Database(join(home, 'jobpilot.db'));
    lock.exec('BEGIN IMMEDIATE');
    try {
      const t0 = Date.now();
      const r = await app.request(`/jobs/${K1}/files/resume.pdf`, { headers: { cookie, ...dl } });
      expect(r.status).toBe(200);
      expect(Buffer.from(await r.arrayBuffer()).toString()).toBe(`resume.pdf of ${K1}`);
      expect(Date.now() - t0).toBeLessThan(2000);
    } finally {
      lock.exec('ROLLBACK');
      lock.close();
    }
    expect(withStore((s) => s.downloads(K1))).toHaveLength(0);
  });

  it('M11: status saved but the snapshot hit a busy lock: a success answer that points at Keep a copy', async () => {
    let lock: InstanceType<typeof Database> | undefined;
    const hooked = wrap(createTestDashboard({ home, clock: { now: () => now }, sessions: new Sessions(Buffer.alloc(32, 7)), busyTimeoutMs: 100 }, {
      beforeSnapshot: () => {
        lock = new Database(join(home, 'jobpilot.db'));
        lock.exec('BEGIN IMMEDIATE');
      },
    }));
    try {
      const r = await hooked.request(`/jobs/${K1}/status`, {
        method: 'POST', body: new URLSearchParams({ to: 'applied', _csrf: token }).toString(),
        headers: { 'content-type': 'application/x-www-form-urlencoded', cookie, ...hx },
      });
      expect(r.status).toBe(200);
      expect(await r.text()).toContain('Status saved. Couldn&#39;t keep a copy of the documents just now; use &#39;Keep a copy&#39; below.');
    } finally {
      lock?.exec('ROLLBACK');
      lock?.close();
    }
    expect(withStore((s) => s.getJob(K1)?.status)).toBe('applied');
    expect(withStore((s) => s.snapshots(K1))).toEqual([]);
    // the files a failed attempt left are accepted by Keep a copy
    expect((await post(`/jobs/${K1}/keep`, { _csrf: token }, hx)).status).toBe(200);
    expect(withStore((s) => s.snapshots(K1)[0]?.files)).toHaveLength(6);
  });

  it('M12: test hooks are not part of the production deps or entry points', () => {
    const server = readFileSync(join(root, 'src/app/web/server.ts'), 'utf8');
    const deps = server.slice(server.indexOf('export interface DashboardDeps'), server.indexOf('}', server.indexOf('export interface DashboardDeps')));
    expect(deps).not.toContain('testHooks');
    for (const f of ['src/cli.ts', 'src/app/web/server.ts']) expect(readFileSync(join(root, f), 'utf8')).not.toMatch(/from '[^']*server-testing/);
  });

  it('an over-long note tells htmx why', async () => {
    const r = await post(`/jobs/${K1}/note`, { note: 'x'.repeat(4001), _csrf: token }, hx);
    expect(r.status).toBe(400);
    expect(await r.text()).toBe('Your note is longer than 4,000 characters');
  });
});

describe('dashboard: number formatting', () => {
  it('writes INR in lakh and crore and foreign pay with an INR equivalent', () => {
    expect(inr(1_200_000)).toBe('₹12 LPA');
    expect(inr(4_250_000)).toBe('₹42.5 LPA');
    expect(inr(12_000_000)).toBe('₹1.2 Cr');
    expect(inr(85_000)).toBe('₹85,000');
    expect(inrRange(1_000_000, 1_200_000)).toBe('₹10–12 LPA');
    expect(inrRange(8_000_000, 12_000_000)).toBe('₹80 LPA – ₹1.2 Cr');
    expect(inrRange(null, 1_200_000)).toBe('up to ₹12 LPA');
    expect(compText({ min: 150_000, max: 180_000, currency: 'USD', period: 'year', basis: 'unknown' }, 12_525_000, 15_030_000)).toEqual({
      main: '$150k–180k', inr: '≈ ₹1.25–1.5 Cr', caveat: 'may include bonus or equity',
    });
    expect(compText(null, null, null).main).toBe('Pay not disclosed');
  });
});

describe('I9: pack-load errors on the dashboard never show a forbidden term', () => {
  const typo = () => {
    const p = join(home, 'pack/facts.yaml');
    writeFileSync(p, readFileSync(p, 'utf8').replace('employer: Initech India (GCC for Northwind)', 'employer: Initech India (GCC for Northwind): oops'));
  };
  const lateRole = () => {
    const p = join(home, 'pack/roles.yaml');
    writeFileSync(p, `${readFileSync(p, 'utf8')}  - employer: Initech India (GCC for Northwind)\n    title: Staff Engineer\n    location: Pune, India\n    start: "2026-12"\n    end: present\n`);
  };

  it('a YAML typo next to an employer line: /facts shows file:line:col: message only', async () => {
    typo();
    const { body } = await get('/facts');
    expect(body).toContain('Your pack could not be read: facts.yaml:29:15: Nested mappings are not allowed in compact mappings');
    expect(body).not.toMatch(/initech/i);
  });

  it('a role dated after asOf: /facts names the role by index', async () => {
    lateRole();
    const { body } = await get('/facts');
    expect(body).toContain('Your pack could not be read: roles.yaml: role 3 starts 2026-12, after experience.asOf 2026-10');
    expect(body).not.toMatch(/initech/i);
  });

  it('a pack error that names a term (a glued duplicate id) is redacted on /facts', async () => {
    const p = join(home, 'pack/facts.yaml');
    writeFileSync(p, readFileSync(p, 'utf8').replace('- id: f-nw-02', '- id: InitechPay-01').replace('- id: f-nw-03', '- id: InitechPay-01'));
    const { body } = await get('/facts');
    expect(body).toContain('Your pack could not be read: facts.yaml: duplicate fact id [hidden]');
    expect(body).not.toMatch(/initech/i);
  });

  it('the error page redacts the message through the same helper', async () => {
    const hooked = wrap(createTestDashboard({ home, clock: { now: () => now }, sessions: new Sessions(Buffer.alloc(32, 7)) }, {
      beforeRoute: () => {
        throw new Error('roles.yaml: role 0 (Initech India) is odd\nsecond line at InitechPay');
      },
    }));
    const r = await hooked.request('/facts', { headers: { cookie } });
    expect(r.status).toBe(500);
    const body = await r.text();
    expect(body).toContain('roles.yaml: role 0 [hidden] India) is odd');
    expect(body).not.toMatch(/initech/i);
  });
});

describe('A7: the fit score is labelled and scaled; the title is read first', () => {
  it('a job row reads title, then pay, then "Fit score 80 out of 100"', async () => {
    const r = rowOf((await get('/')).body, 'data-job', K1);
    expect(textOf(r)).toMatch(/^Senior Backend Engineer .*₹70–90 LPA.*fit Fit score 80 out of 100/);
    expect(r).not.toContain('title="Fit score"');
    expect(textOf(rowOf((await get('/?band=rejected')).body, 'data-job', K5))).toContain('Not scored');
  });
  it('the job page states the scale', async () => {
    expect(textOf((await get(`/jobs/${K1}`)).body)).toMatch(/Fit score 80 out of 100/);
  });
});

describe('A2: the job page follows the apply sequence', () => {
  it('status and the downloads come before the previews; answers before the score details', async () => {
    const body = (await get(`/jobs/${K1}`)).body;
    const at = (needle: string): number => body.indexOf(needle);
    expect(at('id="status"')).toBeGreaterThan(-1);
    expect(at('id="status"')).toBeLessThan(at('id="send"'));
    expect(at(`/jobs/${K1}/files/resume.pdf`)).toBeGreaterThan(at('id="send"'));
    expect(at(`/jobs/${K1}/files/resume.pdf`)).toBeLessThan(at('<iframe'));
    expect(at('id="ans"')).toBeLessThan(at('id="why"'));
  });
  it('"Open the posting" is the only primary button, also when a copy can be kept', async () => {
    for (const setup of [() => undefined, () => withStore((s) => s.setStatus(K1, 'applied', 'user', NOW))]) {
      setup();
      const body = (await get(`/jobs/${K1}`)).body;
      const primaries = [...body.matchAll(/class="btn btn-primary"/g)];
      expect(primaries).toHaveLength(1);
      expect(linksOf(body).find((l) => l.attrs['class'] === 'btn btn-primary')).toMatchObject({ href: 'https://boards.example.test/acme/jobs/1001', attrs: { rel: 'noopener noreferrer', target: '_blank' } });
    }
    expect(textOf((await get(`/jobs/${K1}`)).body)).toContain('Keep a copy of these documents now');
  });
  it('a job with blocked documents still says why, in the send card', async () => {
    expect(textOf(elementsWith((await get(`/jobs/${K10}`)).body, 'id', 'send')[0] ?? '')).toContain('documents blocked: unrenderable character U+5C71 in the company name');
  });
});
