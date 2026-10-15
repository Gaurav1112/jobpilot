import { createHash } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fullChainCheck } from '../../src/app/chain-status.js';
import type { CompanyVerdict } from '../../src/app/coverage/types.js';
import type { Gig, GigRendered } from '../../src/app/freelance/types.js';
import { AppStore, type Doc, type GigDoc, type GigUpsert } from '../../src/app/store/app-store.js';
import { createDashboard } from '../../src/app/web/server.js';
import { Sessions } from '../../src/app/web/security.js';
import { Store as KernelStore } from '../../src/kernel/store/store.js';
import { AT, jobRow } from './app-fixtures.js';

/**
 * One fictional dashboard home for the UX upgrade's golden HTML, 400 px checks and screenshots (A0): every page has
 * content, and every case Phase A changes is present. The fixture pack is "Asha Rao" (Pune); companies are fictional.
 */
const root = join(import.meta.dirname, '../..');
export const FIXTURE_NOW = '2026-10-15T06:30:00.000Z'; // 12:00 IST
export const FIXTURE_SID = 'ab'.repeat(16);

export const JOB = {
  ready: '1111111111111111', usd: '2222222222222222', top: '3333333333333333', review: '4444444444444444',
  rejected: '5555555555555555', below: '6666666666666666', xss: '7777777777777777', dup: '8888888888888888',
  applied: '9999999999999999', blocked: 'aaaaaaaaaaaaaaaa', b2b: 'bbbbbbbbbbbbbbbb', old: 'cccccccccccccccc',
  skipped: 'dddddddddddddddd', noLocation: 'eeeeeeeeeeeeeeee',
} as const;
export const GIG = {
  contract: 'c1c1c1c1c1c1c1c1', proposal: 'a2a2a2a2a2a2a2a2', review: 'b5b5b5b5b5b5b5b5', role: 'b1b1b1b1b1b1b1b1',
  below: 'f6f6f6f6f6f6f6f6', rejected: 'e7e7e7e7e7e7e7e7',
} as const;

export interface WebHome {
  readonly home: string;
  readonly out: string;
}

export const GOLDEN_ROUTES: readonly (readonly [name: string, path: string, status: number])[] = [
  ['jobs', '/', 200],
  ['jobs-applied', '/?status=applied', 200],
  ['jobs-all-bands', '/?band=disclosed&band=undisclosed&band=review&band=below-floor&band=rejected', 200],
  ['job-ready', `/jobs/${JOB.ready}`, 200],
  ['job-blocked', `/jobs/${JOB.blocked}`, 200],
  ['job-applied', `/jobs/${JOB.applied}`, 200],
  ['facts', '/facts', 200],
  ['runs', '/runs', 200],
  ['freelance', '/freelance', 200],
  ['freelance-gigs', '/freelance?tab=gigs', 200],
  ['freelance-review', '/freelance?tab=review', 200],
  ['freelance-networks', '/freelance/networks', 200],
  ['freelance-sources', '/freelance/sources', 200],
  ['gig-proposal', `/freelance/${GIG.proposal}`, 200],
  ['gig-contract', `/freelance/${GIG.contract}`, 200],
  ['companies', '/companies', 200],
  ['not-found', '/nope', 404],
];

/** Pages the 400 px check visits besides the golden routes: variants whose layout differs (long lists, flashes). */
export const NARROW_ONLY: readonly (readonly [name: string, path: string])[] = [
  ['jobs-company', '/?companyKey=acme.example&band=rejected&band=disclosed'],
  ['job-duplicate', `/jobs/${JOB.dup}`],
  ['job-xss', `/jobs/${JOB.xss}`],
  ['companies-flash', '/companies?done=approved&key=acme.example'],
  ['freelance-tab-networks', '/freelance?tab=networks'],
  ['gig-review', `/freelance/${GIG.review}`],
  ['gig-role', `/freelance/${GIG.role}`],
];

const sha = (b: string): string => createHash('sha256').update(b).digest('hex');
const PREVIEW = (kind: string): string =>
  `<!doctype html><html><head><style>body{}</style></head><body><main data-doc="${kind}"><ul><li data-fact="f-nw-01">• Led the order pipeline.</li></ul></main></body></html>\n`;

function withStore<T>(home: string, fn: (s: AppStore) => T): T {
  const s = AppStore.open(join(home, 'jobpilot.db'));
  try {
    return fn(s);
  } finally {
    s.close();
  }
}

function jobDocs(out: string, key: string): Doc[] {
  mkdirSync(join(out, key), { recursive: true });
  return (['resume', 'cover'] as const).flatMap((kind) =>
    (['pdf', 'docx', 'html'] as const).map((format) => {
      const body = format === 'html' ? PREVIEW(kind) : `${kind}.${format} of ${key}`;
      writeFileSync(join(out, key, `${kind}.${format}`), body);
      return { kind, format, path: `${key}/${kind}.${format}`, sha256: sha(body), pages: format === 'html' ? null : 1, qaOk: true };
    }),
  );
}

const NO_CLIENT = { name: null, country: null, paymentVerified: null, hireRate: null, spendUsd: null, reviews: null, since: null };
const CONTRACT_GIG: Partial<Gig> = { platform: 'hn-freelancer', kind: 'contract', title: 'Contract backend engineer', budget: { type: 'hourly', min: 70, max: 70, currency: 'USD', usdPerUnit: null }, hoursPerWeek: { min: 15, max: 15, source: 'text' }, timezone: { required: null, overlapText: '4 hours overlap with US Eastern' }, bids: null };
function gigOf(key: string, over: Partial<Gig> = {}): Gig {
  return {
    gigKey: key, dedupeKey: key, platform: 'freelancer', sourceId: key, url: `https://www.freelancer.example/projects/${key}`, title: `Gig ${key}`,
    description: 'Build a service.', client: NO_CLIENT, kind: 'gig', budget: { type: 'fixed', min: null, max: 3000, currency: 'USD', usdPerUnit: null },
    hoursPerWeek: { min: null, max: null, source: null }, duration: { weeks: null, text: null }, timezone: { required: null, overlapText: null },
    location: { countries: [], worldwide: true, text: null }, skills: [], postedAt: '2026-10-14T09:30:00.000Z', bids: 7, ...over,
  };
}
function gigUpsert(g: Gig, over: Partial<GigUpsert>): GigUpsert {
  return {
    gigKey: g.gigKey, dedupeKey: g.dedupeKey, platform: g.platform, sourceId: g.sourceId, url: g.url, title: g.title, description: g.description,
    client: g.client, kind: g.kind, budget: g.budget, rate: null, hours: g.hoursPerWeek, verdict: 'eligible', reasons: [], notes: [], flags: [],
    fit: 60, breakdown: { base: 30, 'strong:java': 4, 'gap:php': -4, client: 15, fresh: 5, bids: 7 }, list: 'gigs', docsState: 'none',
    docsDetail: null, postedAt: g.postedAt, at: '2026-10-15T02:00:00.000Z', ...over,
  };
}

function verdict(key: string, name: string, status: CompanyVerdict['status'], reasons: string[], platform: CompanyVerdict['guess']['platform']): CompanyVerdict {
  return {
    guess: {
      site: { candidate: { companyKey: key, name, website: `https://${key}`, careersUrl: null, source: 'remoteintech', runDate: '2026-10-11' }, careersUrl: `https://${key}/careers`, method: 'listed', evidence: null },
      platform, slug: platform === null ? null : `${key.split('.')[0]}/External`, boardUrl: platform === null ? null : `https://${key}/board`, signature: null, routedFrom: null, evidence: [],
    },
    status, reasons, boardName: null, jobsSeen: 3,
  };
}

let seq = 0;
function seedEnvelope(home: string, type: string, payload: unknown): void {
  const ks = KernelStore.open(join(home, 'jobpilot.db'));
  try {
    seq += 1;
    const id = `fixture-${type}-${seq}`;
    ks.putSeed(id, {
      envelopeId: id, stepKey: id, index: 0, type, producer: { agentId: 'test', version: '1.0.0', contractHash: 'h' }, parents: [], payload,
      handoff: { guarantees: [], dataClass: 'P1', obligations: [], pins: { policyHash: 'p' } }, guardrails: [], cost: { usd: 0, inputTokens: 0, outputTokens: 0 },
    }, '1', 'h');
  } finally {
    ks.close();
  }
}

export function buildWebHome(): WebHome {
  const home = mkdtempSync(join(tmpdir(), 'jobpilot-webfx-'));
  cpSync(join(root, 'tests/fixtures/pack'), join(home, 'pack'), { recursive: true });
  const out = join(home, 'out');
  mkdirSync(out);
  const j = (key: string, n: number, over: Parameters<typeof jobRow>[0]) => jobRow({ jobKey: key, sourceId: String(n), dedupeKey: `dk${String(n).padStart(14, '0')}`, ...over });
  withStore(home, (s) => {
    s.upsertJob(j(JOB.ready, 1, {
      title: 'Senior Backend Engineer', company: 'Acme Robotics', score: 80, compMinInr: 7_000_000, compMaxInr: 9_000_000, compBasis: 'base',
      comp: { min: 7_000_000, max: 9_000_000, currency: 'INR', period: 'year', basis: 'base' }, docsState: 'ready', recommendedFormat: 'pdf',
      terms: { covered: ['java', 'kafka'], missing: ['distributed systems'] }, dedupeKey: '1d1d1d1d1d1d1d1d',
      breakdown: [{ label: 'base', points: 30 }, { label: 'strong:java', points: 4 }, { label: 'gap:php', points: -4 }],
    }));
    s.putDocs(JOB.ready, jobDocs(out, JOB.ready), ['f-nw-01']);
    s.upsertJob(j(JOB.usd, 2, {
      title: 'Staff Engineer', company: 'Globex', score: 70, compMinInr: 10_437_500, compMaxInr: 12_525_000, compBasis: 'base',
      comp: { min: 125_000, max: 150_000, currency: 'USD', period: 'year', basis: 'base' }, notes: ['office/hybrid: Pune'],
      remote: { structured: 'remote', countries: ['united states', 'canada', 'india'], signals: [] },
    }));
    s.upsertJob(j(JOB.top, 3, { title: 'Platform Engineer', company: 'Hooli', score: 90 }));
    s.upsertJob(j(JOB.review, 4, { title: 'Backend Developer', company: 'Vandelay', score: 85, verdict: 'review', reasons: ['remote-unclear'] }));
    s.upsertJob(j(JOB.rejected, 5, { title: 'Frontend Engineer', company: 'Umbrella', score: null, verdict: 'rejected', reasons: ['role:front[- ]?end', 'onsite'], breakdown: null }));
    s.upsertJob(j(JOB.below, 6, { title: 'Junior Engineer', company: 'Soylent', score: 75, compMinInr: 400_000, compMaxInr: 1_000_000, comp: { min: 400_000, max: 1_000_000, currency: 'INR', period: 'year', basis: 'base' } }));
    s.upsertJob(j(JOB.xss, 7, { title: '<script>alert("x")</script>" onmouseover="y', company: "O'Reilly & Sons", score: 60 }));
    s.upsertJob(j(JOB.dup, 8, { title: 'Senior Backend Engineer', company: 'Acme Robotics', source: 'himalayas', dedupeKey: '1d1d1d1d1d1d1d1d', score: 80 }));
    s.importJob({ ...j(JOB.applied, 9, { title: 'Data Engineer', company: 'Initrode', score: 65 }), status: 'applied', note: 'from the desk', appliedAt: '2026-09-12T05:00:00.000Z', statusAt: '2026-09-12T05:00:00.000Z' });
    s.upsertJob(j(JOB.blocked, 10, { title: 'Backend Engineer', company: '山 Systems', score: 66, docsState: 'blocked', docsDetail: 'renderer failed: invalid_output (unrenderable-glyph:U+5C71)' }));
    s.upsertJob(j(JOB.b2b, 11, { title: 'Backend Engineer', company: 'Initech Labs', score: 50, notes: ['B2B contractor: no PF/benefits'] }));
    s.upsertJob(j(JOB.old, 12, { title: 'Java Engineer', company: 'Massive Dynamic', score: 72, at: '2026-09-20T01:30:00.000Z' }));
    s.upsertJob(j(JOB.skipped, 13, { title: 'Go Engineer', company: 'Cyberdyne', score: 77 }));
    s.setStatus(JOB.skipped, 'skipped', 'user', AT);
    s.upsertJob(j(JOB.noLocation, 14, { title: 'Kotlin Engineer', company: 'GitLabs Example', location: '', source: 'himalayas', ats: 'greenhouse', score: 68 }));
    s.recordRun({
      runId: 'daily-2026-10-15', at: '2026-10-15T01:30:00.000Z',
      counts: { byAgent: { normalizer: { done: 3, failed: 0, gone: 1, inputRejected: 0, quarantined: 0, skipped: 0, pending: 0, replayed: 2 }, 'evidence-matcher': { done: 1, failed: 0, gone: 0, inputRejected: 0, quarantined: 1, skipped: 0, pending: 0, replayed: 0 } }, totals: { done: 4, failed: 0, gone: 1, inputRejected: 0, quarantined: 1, skipped: 0, pending: 0, replayed: 2 } },
      packHash: 'a'.repeat(64), policyHash: 'b'.repeat(64), warnings: ['the notification could not be posted: osascript missing'],
      problems: [{ kind: 'quarantined', agent: 'evidence-matcher', item: 'Hooli — Platform Engineer', reason: 'G-GROUND: bullet 2 is not a fact claim' }],
    });

    const c1 = gigOf(GIG.contract, CONTRACT_GIG);
    const g2 = gigOf(GIG.proposal, { title: 'Order service fixes', description: 'About 60 hours of work.' });
    const r5 = gigOf(GIG.review, { title: 'Hourly in CAD', budget: { type: 'hourly', min: 60, max: 68, currency: 'CAD', usdPerUnit: 0.73 } });
    const b1 = gigOf(GIG.role, { platform: 'boards', kind: 'contract', title: 'Contract platform engineer', location: { countries: ['india'], worldwide: false, text: 'Remote - India' }, bids: null });
    s.upsertGig(gigUpsert(c1, { list: 'contracts', fit: 54, rate: { minUsdH: 70, maxUsdH: 70, method: 'stated', fxDate: null, fxSource: null, budgetUsd: null }, docsState: 'ready' }));
    s.upsertGig(gigUpsert(g2, { fit: 70, rate: { minUsdH: 50, maxUsdH: 50, method: 'fixed÷stated-hours', fxDate: null, fxSource: null, budgetUsd: 3000 }, docsState: 'ready' }));
    s.upsertGig(gigUpsert(r5, { list: 'review', verdict: 'review', reasons: ['budget-preset'], fit: 48, rate: { minUsdH: 43.8, maxUsdH: 49.64, method: 'stated', fxDate: null, fxSource: 'platform', budgetUsd: null }, notes: ['preset bracket - bids may exceed it'] }));
    s.upsertGig(gigUpsert(b1, { list: 'review', verdict: 'review', reasons: ['rate-unclear', 'hours-unclear'], fit: 70 }));
    s.upsertGig(gigUpsert(gigOf(GIG.below, { title: 'Low fit gig' }), { list: 'below-floor', fit: 30, docsDetail: 'below the fit floor' }));
    s.upsertGig(gigUpsert(gigOf(GIG.rejected, { title: 'Rejected gig' }), { list: null, verdict: 'rejected', reasons: ['budget-below-floor'], fit: null, breakdown: null }));
    for (const [key, kind, text] of [[GIG.contract, 'pitch', 'Backend engineer for your platform team.\nAt Contoso Retail I built the payments service in Java.\n'], [GIG.proposal, 'proposal', 'Your order service needs a careful hand.\nAt Contoso Retail I built the payments service in Java.\n']] as const) {
      mkdirSync(join(out, 'gigs', key), { recursive: true });
      const docs: GigDoc[] = ([[kind, 'txt', text], ['resume', 'pdf', `pdf of ${key}`], ['resume', 'docx', `docx of ${key}`]] as const).map(([k, f, body]) => {
        writeFileSync(join(out, 'gigs', key, `${k}.${f}`), body);
        return { kind: k, format: f, path: `gigs/${key}/${k}.${f}`, sha256: sha(body), pages: f === 'pdf' ? 1 : null };
      });
      s.putGigDocs(key, docs);
    }
    s.recordGigRun({
      runId: 'freelance-2026-10-15-am', at: '2026-10-15T02:00:00.000Z', counts: { byAgent: {}, totals: {} }, packHash: 'a'.repeat(64), policyHash: 'b'.repeat(64), warnings: [],
      problems: [{ kind: 'failed', agent: 'src-freelancer', item: 'freelancer q1', reason: 'http_error: 503' }],
    });
    s.addSourceHealth('freelance-2026-10-15-am', 'freelancer', '2026-W42', { fetched: 46, eligible: 7, aboveFloor: 5, shortlisted: 2, failed: false, probeFailures: 0 });

    s.upsertCompanyVerdict(verdict('acme.example', 'Acme Robotics', 'verified', [], 'workday'), '2026-10-11T01:30:00.000Z');
    s.upsertCompanyVerdict(verdict('bank.example', 'Bank of Example', 'proposed', ["board name 'Bank Careers' ≈ 'bank', please confirm"], 'oracle'), '2026-10-11T01:30:00.000Z');
    s.upsertCompanyVerdict(verdict('globodyne.example', 'Globodyne', 'verified', [], 'workday'), '2026-09-20T01:30:00.000Z');
    for (const w of ['2026-09-27', '2026-10-04', '2026-10-11']) s.upsertCompanyVerdict(verdict('globodyne.example', 'Globodyne', 'failed', ['the board answered 404'], null), `${w}T01:30:00.000Z`);
    s.kernel.startRun('coverage-2026-10-12', 'jobpilot-coverage', 'p', '2026-10-12T00:30:00.000Z');
    for (const [host, why] of [['careers.acme.example', 'http-429'], ['jobs.hooli.example', 'challenge'], ['umbrella.example', 'robots-forbidden'], ['vandelay.example', 'robots-forbidden']] as const) {
      s.disableCoverageHost('coverage-2026-10-12', host, why, '2026-10-12T00:40:00.000Z');
    }
  });
  const g2Docs = withStore(home, (s) => s.getGig(GIG.proposal)?.docs ?? []);
  for (const g of [GIG.contract, GIG.proposal, GIG.review, GIG.role]) seedEnvelope(home, 'Gig@1', gigOf(g, g === GIG.contract ? CONTRACT_GIG : {}));
  seedEnvelope(home, 'GigRendered@1', {
    gigKey: GIG.proposal, files: g2Docs,
    plan: { gigKey: GIG.proposal, scored: {}, platform: 'freelancer', proposal: { hook: { text: 'Your order service needs a careful hand.', quote: null, title: null }, evidenceIntro: '', evidence: [{ text: 'At Contoso Retail I built the payments service in Java.', factIds: ['f-nw-01'] }], planIntro: '', plan: [], availability: '', question: '' }, pitch: null, resume: {}, covered: ['java', 'kafka'], missing: ['kubernetes'] },
    text: { proposal: '', pitch: null, resume: '' },
  } as unknown as GigRendered);
  for (const id of ['arc', 'contra']) {
    mkdirSync(join(out, 'networks', id), { recursive: true });
    for (const f of ['resume.pdf', 'resume.docx', 'profile.txt']) writeFileSync(join(out, 'networks', id, f), `${f} of ${id}`);
    writeFileSync(join(out, 'networks', id, 'checklist.md'), `# ${id} vetting prep\n\n- [ ] Live coding\n`);
  }
  // the audit chain checked once, so /runs reads "Last full check" (deterministic) instead of checking on the first view
  const k = KernelStore.open(join(home, 'jobpilot.db'));
  try {
    fullChainCheck(k, '2026-10-15T03:00:00.000Z');
  } finally {
    k.close();
  }
  return { home, out };
}

/** Snapshot folders are read-only (0555); make them writable again so the temp home can be removed. */
export function removeWebHome(home: string): void {
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory() && !e.isSymbolicLink()) {
        chmodSync(join(d, e.name), 0o755);
        walk(join(d, e.name));
      }
    }
  };
  if (existsSync(home)) walk(home);
  rmSync(home, { recursive: true, force: true });
}

/** The dashboard on `home` at a fixed clock and session: same input, same bytes (but the CSRF token, see `normalise`). */
export function fixtureApp(home: string, now = FIXTURE_NOW): { request(path: string, init?: RequestInit): Promise<Response> } {
  const raw = createDashboard({ home, clock: { now: () => now }, sessions: new Sessions(Buffer.alloc(32, 7)) });
  return {
    request: async (path, init = {}) =>
      raw.request(path, { ...init, headers: { host: 'localhost', cookie: `jp_sid=${FIXTURE_SID}`, ...((init.headers as Record<string, string> | undefined) ?? {}) } }),
  };
}

export const normalise = (body: string): string => body.replace(/(name="_csrf" value=")[0-9a-f]{64}"/g, '$1x"');
