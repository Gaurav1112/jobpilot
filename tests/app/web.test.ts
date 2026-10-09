import { createHash } from 'node:crypto';
import { cpSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppStore, type Doc, type JobUpsert } from '../../src/app/store/app-store.js';
import { compText, inr, inrRange } from '../../src/app/web/format.js';
import { html } from '../../src/app/web/html.js';
import { createDashboard, serveDashboard } from '../../src/app/web/server.js';
import { Sessions } from '../../src/app/web/security.js';
import { jobRow } from '../support/app-fixtures.js';

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

let home: string;
let out: string;
let app: ReturnType<typeof createDashboard>;

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
      comp: { min: 125_000, max: 150_000, currency: 'USD', period: 'year', basis: 'base' },
    }));
    s.upsertJob(row(K3, 3, { title: 'Platform Engineer', company: 'Hooli', score: 90 }));
    s.upsertJob(row(K4, 4, { title: 'Backend Developer', company: 'Vandelay', score: 85, verdict: 'review' }));
    s.upsertJob(row(K5, 5, { title: 'Frontend Engineer', company: 'Umbrella', score: null, verdict: 'rejected', reasons: ['role:front[- ]?end'], breakdown: null }));
    s.upsertJob(row(K6, 6, { title: 'Junior Engineer', company: 'Soylent', score: 75, compMaxInr: 3_000_000, compMinInr: 2_000_000, comp: { min: 2_000_000, max: 3_000_000, currency: 'INR', period: 'year', basis: 'base' } }));
    s.upsertJob(row(K7, 7, { title: '<script>alert("x")</script>" onmouseover="y', company: "O'Reilly & Sons", score: 60 }));
    // a feed listing of K1: hidden from the list, K1 shows "also listed on himalayas"
    s.upsertJob(row(K8, 8, { title: 'Senior Backend Engineer', company: 'Acme Robotics', source: 'himalayas', dedupeKey: '1d1d1d1d1d1d1d1d', score: 80 }));
    // a Desk row
    s.importJob({ ...row(K9, 9, { title: 'Data Engineer', company: 'Initrode', score: 65 }), status: 'applied', note: 'from the desk', appliedAt: '2026-09-12T05:00:00.000Z', statusAt: '2026-09-12T05:00:00.000Z' });
    s.upsertJob(row(K10, 10, { title: 'Backend Engineer', company: '山 Systems', score: 66, docsState: 'blocked', docsDetail: 'renderer failed: invalid_output (unrenderable-glyph:U+5C71)' }));
    s.upsertJob(row(K11, 11, { title: 'Backend Engineer', company: 'Initech Labs', score: 50 }));
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

const post = (path: string, form: Record<string, string>, headers: Record<string, string> = {}) =>
  app.request(path, {
    method: 'POST',
    body: new URLSearchParams(form).toString(),
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'http://localhost', cookie, ...headers },
  });
const hx = { 'hx-request': 'true' };
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
  app = createDashboard({ home, clock: { now: () => NOW }, sessions: new Sessions(Buffer.alloc(32, 7)) });
  await startSession();
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe('dashboard: jobs list', () => {
  it('renders the rows comp-first (disclosed by max INR, then undisclosed, then review), hiding rejected, below-floor and duplicate listings', async () => {
    const { status, body } = await get('/');
    expect(status).toBe(200);
    expect(order(body)).toEqual([K2, K1, K3, K10, K9, K7, K11, K4]);
    expect(body).toContain('also listed on himalayas');
    expect(body).toMatch(/2<\/span> not-eligible or below-floor jobs are hidden/);
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
    expect(order((await get('/?band=disclosed&band=below-floor')).body)).toEqual([K2, K1, K6]);
    expect(order((await get('/?min=85')).body)).toEqual([K3, K4]);
    expect(order((await get('/?q=reilly')).body)).toEqual([K7]);
    expect(order((await get('/?q=acme&min=70')).body)).toEqual([K1]);
    // a bad value is ignored, not an error
    expect((await get('/?status=bogus&band=nope&min=abc')).status).toBe(200);
    const f = (await get('/?status=applied&q=x')).body;
    expect(f).toMatch(/name="status" value="applied" checked/);
    expect(f).toContain('name="q" value="x"');
  });

  it('shows pills for remote, status, documents and band, and the Desk history of imported rows', async () => {
    const { body } = await get('/');
    expect(body).toContain('Remote · India');
    expect(body).toContain('Documents ready');
    expect(body).toContain('Pay ≥ floor');
    expect(body).toContain('From your Application Desk: Applied on 12 Sep 2026');
  });

  it('marks rows first seen since the previous visit as new', async () => {
    // first visit: everything is new
    const first = await app.request('/', { headers: { cookie } });
    expect((await first.text()).match(/New since your last visit/g)?.length).toBe(8);
    // a visit cookie from after the rows were seen: nothing new
    const later = Date.parse('2026-10-09T03:00:00.000Z');
    const r = await app.request('/', { headers: { cookie: `${cookie}; jp_visit=${later}.${later}` } });
    expect(await r.text()).not.toContain('New since your last visit');
    expect(r.headers.get('set-cookie')).toMatch(/jp_visit=\d+\.\d+/);
  });
});

describe('dashboard: job page', () => {
  it('shows the header, why it matched, eligibility, documents, answers, status and note', async () => {
    const { status, body } = await get(`/jobs/${K1}`);
    expect(status).toBe(200);
    expect(body).toContain('<h1>Senior Backend Engineer</h1>');
    expect(body).toContain('href="https://boards.example.test/acme/jobs/1001" rel="noopener noreferrer"');
    expect(body).toContain('Why it matched');
    expect(body).toContain('Core skill: Java');
    expect(body).toContain('Asks for PHP, which you don');
    expect(body).toContain('Eligibility');
    expect(body).toContain('Greenhouse reads PDF best');
    expect(body).toMatch(/<iframe class="preview preview-resume" sandbox="" src="\/jobs\/1111111111111111\/files\/resume.html"/);
    expect(body).toContain('href="/jobs/1111111111111111/files/resume.pdf" download>Download PDF <span class="rec">recommended</span>');
    expect(body).toContain('href="/jobs/1111111111111111/files/resume.docx" download>Download Word (DOCX)');
    expect(body).toContain('Missing terms are never added to your resume');
    expect(body).toContain('<span class="term term-muted">distributed systems</span>');
    expect(body).toContain('Screening answers');
    expect(body).toContain('Notice period days');
    expect(body).toContain('Also listed on himalayas');
    expect(body).toMatch(/name="to" value="applied"/);
    expect(body).toContain('<textarea id="note" name="note"');
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
    expect((await get(`/jobs/${K8}`)).body).toContain(`<a href="/jobs/${K1}">the same job on greenhouse</a>`);
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
      if (/Html\.of\(/.test(src)) offenders.push(`${f}: Html.of`);
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
    const r = await post(`/jobs/${K1}/status`, { to: 'approved', _csrf: token });
    expect(r.status).toBe(303);
    expect(r.headers.get('location')).toBe(`/jobs/${K1}#status`);
    const n = await post(`/jobs/${K1}/note`, { note: 'ask about the team', _csrf: token });
    expect(n.status).toBe(303);
    expect(withStore((s) => s.getJob(K1)?.note)).toBe('ask about the team');
  });

  it('refuses an invalid status and requests for any non-loopback host', async () => {
    expect((await post(`/jobs/${K1}/status`, { to: 'hired', _csrf: token }, hx)).status).toBe(400);
    expect((await app.request('http://evil.example/')).status).toBe(403);
    expect((await app.request('http://127.0.0.1:4317/', { headers: { cookie } })).status).toBe(200);
  });

  it('pages work with JavaScript off: no inline script or handler, every form posts with a token', async () => {
    for (const path of ['/', `/jobs/${K1}`, '/facts', '/runs']) {
      const { body } = await get(path);
      expect(body.match(/<script\b[^>]*>/g)).toEqual(['<script src="/static/htmx.min.js" defer>']);
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

  it('is idempotent: applying again the same day keeps one snapshot, and later renders never touch it', async () => {
    await post(`/jobs/${K1}/status`, { to: 'applied', _csrf: token }, hx);
    await post(`/jobs/${K1}/status`, { to: 'interview', _csrf: token }, hx);
    await post(`/jobs/${K1}/status`, { to: 'applied', _csrf: token }, hx);
    // a re-render replaces the current resume
    writeFileSync(join(out, K1, 'resume.pdf'), 'a newer resume');
    withStore((s) => s.putDocs(K1, s.getJob(K1)?.docs.map((d) => (d.kind === 'resume' && d.format === 'pdf' ? { ...d, sha256: sha('a newer resume') } : d)) ?? []));
    await post(`/jobs/${K1}/status`, { to: 'interview', _csrf: token }, hx);
    await post(`/jobs/${K1}/status`, { to: 'applied', _csrf: token }, hx);
    const snaps = withStore((s) => s.snapshots(K1));
    expect(snaps).toHaveLength(1);
    expect(snaps[0]?.files).toHaveLength(6);
    expect(readFileSync(join(out, K1, `applied-${DAY}`, 'resume.pdf'), 'utf8')).toBe(`resume.pdf of ${K1}`);
    const served = await app.request(`/jobs/${K1}/sent/${DAY}/resume.pdf`, { headers: { cookie } });
    expect(Buffer.from(await served.arrayBuffer()).toString()).toBe(`resume.pdf of ${K1}`);
  });

  it('a job without ready documents is marked applied with no snapshot, and says so', async () => {
    const r = await post(`/jobs/${K3}/status`, { to: 'applied', _csrf: token }, hx);
    expect(await r.text()).toContain('No documents were kept');
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
    const n = await post('/facts/f-nw-01/reject', { _csrf: token });
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
    expect(body).toContain(`<code title="${'a'.repeat(64)}">${'a'.repeat(12)}</code>`);
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

describe('dashboard: number formatting', () => {
  it('writes INR in lakh and crore and foreign pay with an INR equivalent', () => {
    expect(inr(1_200_000)).toBe('₹12 LPA');
    expect(inr(4_250_000)).toBe('₹42.5 LPA');
    expect(inr(12_000_000)).toBe('₹1.2 Cr');
    expect(inr(85_000)).toBe('₹85,000');
    expect(inrRange(4_500_000, 1_200_000)).toBe('₹45–12 LPA');
    expect(inrRange(8_000_000, 12_000_000)).toBe('₹80 LPA – ₹1.2 Cr');
    expect(inrRange(null, 1_200_000)).toBe('up to ₹12 LPA');
    expect(compText({ min: 150_000, max: 180_000, currency: 'USD', period: 'year', basis: 'unknown' }, 12_525_000, 15_030_000)).toEqual({
      main: '$150k–180k', inr: '≈ ₹1.25–1.5 Cr', caveat: 'may include bonus or equity',
    });
    expect(compText(null, null, null).main).toBe('Pay not disclosed');
  });
});
