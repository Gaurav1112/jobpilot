import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse, stringify } from 'yaml';
import { appEvalSpecs } from '../../src/app/evals.js';
import { runEval } from '../../src/evals/runner.js';
import { PRODUCT_POLICY_V1 } from '../../src/kernel/policy.js';
import { forbiddenSubstring } from '../../src/app/pack/rules.js';
import { DEFAULT_ELIGIBILITY, DEFAULT_FILTERS, DEFAULT_LEXICON, DEFAULT_TARGETS } from '../../src/app/pack/defaults.js';
import { boardOf, formatImportReport, type ImportDeps, ImportError, importPack, type ImportOptions, parseResumeRoles, planImport, rewriteId } from '../../src/app/pack/import.js';
import { loadPack } from '../../src/app/pack/load.js';
import { compileSafePattern } from '../../src/app/pack/regex.js';
import { FiltersSchema, LexiconSchema, TargetsSchema } from '../../src/app/pack/schema.js';

const root = join(import.meta.dirname, '../..');

/**
 * Eval cases whose result differs on the defaults pack, by design (Task 12 fix I2). Any other difference fails, so
 * defaults.ts and the eval set cannot drift apart unnoticed.
 */
const KNOWN_DEFAULT_DIFFS: Record<string, unknown> = {
  // Same verdict; the defaults' `\bsupport agent\b` (Task 7 note) now names the reason before the location rule.
  'eligibility/real-levelup-philippines': { verdict: 'rejected', reasons: ['role:\\bsupport agent\\b'], notes: [] },
  // Bare "ai" no longer counts for llm in the defaults (Task 7 note), so the fixture's 39 is 35 here.
  'scorer-lexicon/ambiguous-words-in-tech-context': {
    score: 35,
    breakdown: [
      { label: 'base', points: 30 },
      { label: 'strong:spring', points: 4 },
      { label: 'medium:node', points: 1.5 },
      { label: 'medium:react', points: 1.5 },
      { label: 'medium:typescript', points: 1.5 },
      { label: 'gap:spark', points: -4 },
    ],
  },
};
const fx = join(root, 'tests/fixtures/import');
let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'jobpilot-import-'));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const CONTACT = { name: 'Asha Rao', email: 'asha.rao@example.com', phone: '+91 90000 00000', city: 'Pune', links: ['https://example.com/asha-rao'] };

function opts(over: Partial<ImportOptions> = {}): ImportOptions {
  return {
    careerOps: join(fx, 'career-ops'),
    resumeText: join(fx, 'resume.txt'),
    desk: join(fx, 'desk'),
    out: join(tmp, 'pack'),
    forbid: ['Initech'],
    employerDisplay: ['Initech India (GCC for Northwind)=Northwind Labs'],
    contact: CONTACT,
    asOf: '2026-10',
    availableFrom: '1 November 2026',
    noticePeriod: '30 days',
    floorInr: 1_200_000,
    educationText: join(fx, 'education.txt'),
    extraWatchlist: join(fx, 'extra-watchlist.yaml'),
    now: '2026-10-09T08:30:00.000Z',
    ...over,
  };
}

const y = (file: string, dir = join(tmp, 'pack')): unknown => parse(readFileSync(join(dir, file), 'utf8'));
type F = { id: string; claim: string; tech: string[]; employer: string; role?: string; period: string; kind: string; status: string };
const factsOf = (dir = join(tmp, 'pack')) => (y('facts.yaml', dir) as { facts: F[] }).facts;

/** Writes a copy of the fixture career-ops store with `edit` applied to its text. */
function careerOpsWith(edit: (text: string) => string): string {
  const dir = join(tmp, 'co');
  cpSync(join(fx, 'career-ops'), dir, { recursive: true });
  const p = join(dir, 'profile/facts.yaml');
  writeFileSync(p, edit(readFileSync(p, 'utf8')));
  return dir;
}

async function importError(o: ImportOptions, deps: ImportDeps = {}): Promise<ImportError> {
  try {
    await importPack(o, deps);
  } catch (e) {
    if (e instanceof ImportError) return e;
    throw e;
  }
  throw new Error('expected importPack to fail');
}

describe('pack import: the fictional fixtures produce a valid pack', () => {
  it('writes every pack file, and loadPack accepts the result', async () => {
    const report = await importPack(opts());
    const files = readdirSync(join(tmp, 'pack')).sort();
    expect(files).toEqual(
      ['answers.yaml', 'contact.yaml', 'eligibility.yaml', 'experience.yaml', 'facts.yaml', 'feeds.yaml', 'filters.yaml', 'fx.yaml', 'lexicon.yaml', 'naming.yaml', 'offers.yaml', 'policy.user.yaml', 'roles.yaml', 'targets.yaml', 'watchlist.yaml'].sort(),
    );
    const { pack } = loadPack(join(tmp, 'pack'));
    expect(pack.experience.asOf).toBe('2026-10');
    expect(pack.facts).toHaveLength(9);
    expect(report.out).toBe(join(tmp, 'pack'));
  });

  it('removes the forbidden term from ids and employers, keeping ids unique', async () => {
    await importPack(opts());
    const ids = factsOf().map((f) => f.id);
    expect(ids).toEqual([
      'northwind-labs-orders-01-2',
      'northwind-labs-orders-01',
      'northwind-labs-status-02',
      'northwind-labs-cost-03',
      'contoso-billing-01',
      'contoso-retry-02',
      'fabrikam-reports-01',
      'cert-aws-saa',
      'edu-01',
    ]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(factsOf()[0]?.employer).toBe('Northwind Labs');
    for (const f of readdirSync(join(tmp, 'pack')).filter((n) => n !== 'naming.yaml')) {
      expect(readFileSync(join(tmp, 'pack', f), 'utf8').toLowerCase(), f).not.toContain('initech');
    }
    expect(y('naming.yaml')).toEqual({ employerDisplay: { 'Initech India (GCC for Northwind)': 'Northwind Labs' }, forbiddenTerms: ['Initech'] });
  });

  it('copies statuses verbatim, keeps periods, and sets kinds', async () => {
    await importPack(opts());
    const by = Object.fromEntries(factsOf().map((f) => [f.id, f]));
    expect(by['northwind-labs-orders-01-2']).toMatchObject({ status: 'user-stated', period: '2025-12..present', kind: 'experience', tech: ['java', 'kafka', 'event-driven'] });
    expect(by['northwind-labs-orders-01']).toMatchObject({ status: 'verified', period: '2023-01..2025-06' });
    expect(by['northwind-labs-cost-03']?.status).toBe('derived-unverified');
    expect(by['contoso-billing-01']?.period).toBe('2020-04..2022-01');
    expect(by['fabrikam-reports-01']?.kind).toBe('project');
    expect(by['cert-aws-saa']).toMatchObject({ kind: 'cert', employer: 'Amazon Web Services' });
    expect(by['edu-01']).toEqual({
      id: 'edu-01',
      claim: 'B.E. in Computer Engineering, Savitribai Phule Pune University',
      tech: [],
      employer: 'Savitribai Phule Pune University',
      period: '2012-08..2016-05',
      kind: 'education',
      status: 'user-stated',
    });
    // the claim is the user's words, verbatim
    expect(by['northwind-labs-status-02']?.claim).toBe('Built a delivery health board with red, amber and green (RAG) status for twelve teams.');
    // provenance of the education facts is noted in the file
    expect(readFileSync(join(tmp, 'pack/facts.yaml'), 'utf8')).toMatch(/education-text/);
  });

  it('places each fact in the resume role at its display employer, and reports the unplaced', async () => {
    const report = await importPack(opts());
    const by = Object.fromEntries(factsOf().map((f) => [f.id, f]));
    expect(by['northwind-labs-orders-01-2']?.role).toBe('Senior Backend Engineer');
    expect(by['northwind-labs-orders-01']?.role).toBe('Backend Engineer');
    expect(by['contoso-billing-01']?.role).toBe('Software Engineer II');
    expect(by['fabrikam-reports-01']?.role).toBe('Associate Software Engineer, promoted to Software Engineer');
    expect(by['contoso-retry-02']?.role).toBeUndefined();
    expect(by['cert-aws-saa']?.role).toBeUndefined();
    expect(report.unplaced).toEqual(['contoso-retry-02']);
    expect(report.warnings.join('\n')).toMatch(/contoso-retry-02/);
  });

  it('writes roles from the resume headers, mapped to display employers', async () => {
    await importPack(opts());
    expect(y('roles.yaml')).toEqual({
      roles: [
        { employer: 'Northwind Labs', title: 'Senior Backend Engineer', location: 'Pune, India', start: '2025-12', end: 'present' },
        { employer: 'Northwind Labs', title: 'Backend Engineer', location: 'Pune, India', start: '2022-03', end: '2025-11' },
        { employer: 'Contoso Retail', title: 'Software Engineer II', location: 'Bengaluru, India', start: '2020-04', end: '2022-01' },
        { employer: 'Fabrikam', title: 'Associate Software Engineer, promoted to Software Engineer', location: 'Pune, India', start: '2016-07', end: '2020-03' },
      ],
    });
    expect(y('contact.yaml')).toEqual(CONTACT);
    expect(y('experience.yaml')).toEqual({ asOf: '2026-10' });
  });

  it('warns about "(RAG)" next to colour words without rewriting the claim', async () => {
    const report = await importPack(opts());
    expect(report.ragFacts).toEqual(['northwind-labs-status-02']);
    expect(report.warnings.join('\n')).toMatch(/northwind-labs-status-02/);
  });

  it('writes answers: no _ keys, no CTC, flag values, non-scalars and forbidden hits removed', async () => {
    const report = await importPack(opts());
    expect(y('answers.yaml')).toEqual({
      notice_period: '30 days',
      work_mode: 'remote',
      willing_to_relocate: 'No',
      requires_sponsorship: 'No',
      years_java: 8,
      available_from: '1 November 2026',
    });
    expect(report.answers.removedForbidden).toEqual(['reason_for_change']);
    expect(report.answers.dropped).toEqual(expect.arrayContaining(['current_ctc', 'expected_ctc', 'nested']));
  });

  it('accepts answers wrapped in a data object', async () => {
    const desk = join(tmp, 'desk');
    cpSync(join(fx, 'desk'), desk, { recursive: true });
    writeFileSync(join(desk, 'settings/answers.json'), JSON.stringify({ data: { _x: 1, work_mode: 'remote', current_ctc: '1' } }));
    await importPack(opts({ desk }));
    expect(y('answers.yaml')).toEqual({ work_mode: 'remote', available_from: '1 November 2026', notice_period: '30 days' });
  });

  it('builds the watchlist from Desk board urls, merged with the extra entries, sorted and deduplicated', async () => {
    const report = await importPack(opts());
    expect((y('watchlist.yaml') as { watchlist: unknown[] }).watchlist).toEqual([
      { company: 'Globex Systems Inc', ats: 'ashby', slug: 'globex', hiresInIndia: true, allRemote: false },
      { company: 'Umbrella', ats: 'ashby', slug: 'Umbrella', hiresInIndia: true, allRemote: false },
      { company: 'Example Careers Co', ats: 'careers', slug: 'example-careers', listUrl: 'https://careers.example.com/jobs', linkPattern: '^/jobs/[a-z0-9-]+$', hiresInIndia: true, allRemote: false },
      { company: 'Acme Robotics', ats: 'greenhouse', slug: 'acmerobotics', hiresInIndia: true, allRemote: false },
      { company: 'GitLab', ats: 'greenhouse', slug: 'gitlab', hiresInIndia: true, allRemote: true },
      { company: 'Example Lever Co', ats: 'lever', slug: 'example-lv', hiresInIndia: true, allRemote: true },
    ]);
    expect(report.watchlist).toEqual({ total: 6, fromDesk: 5, extra: 3, careers: 1, droppedForbidden: 1 });
    expect(report.warnings.join('\n')).toMatch(/1 Desk job file .*not valid JSON/);
  });

  it('writes the v2 defaults, feeds, offers, naming and fx', async () => {
    await importPack(opts());
    expect(y('lexicon.yaml')).toEqual(DEFAULT_LEXICON);
    expect(y('filters.yaml')).toEqual(DEFAULT_FILTERS);
    expect(y('targets.yaml')).toEqual(DEFAULT_TARGETS);
    expect(y('feeds.yaml')).toEqual({ enabled: ['himalayas', 'jobicy'] });
    expect(y('offers.yaml')).toEqual({ floor: { amount: 1_200_000, currency: 'INR', period: 'year', basis: 'base' } });
    expect(y('fx.yaml')).toEqual({ asOf: '1970-01-01', toINR: { USD: 83, EUR: 90, GBP: 105, INR: 1 } });
  });

  it('prints a reminder when fx is the pinned default, and uses --fx-file when given', async () => {
    const r1 = await importPack(opts());
    expect(r1.warnings.join('\n')).toMatch(/fx\.yaml.*1970-01-01/);
    const r2 = await importPack(opts({ out: join(tmp, 'pack2'), fxFile: join(fx, 'fx.yaml') }));
    expect(y('fx.yaml', join(tmp, 'pack2'))).toEqual({ asOf: '2026-10-01', toINR: { USD: 83.5, EUR: 90.2, GBP: 106.4, INR: 1 } });
    expect(r2.warnings.join('\n')).not.toMatch(/fx\.yaml/);
  });

  it('adds --claimable-title entries after the ongoing role titles, sanitised', async () => {
    await importPack(opts({ claimableTitles: ['Staff  Backend Engineer', 'Senior Backend Engineer'] }));
    expect((y('targets.yaml') as { claimableTitles?: string[] }).claimableTitles).toEqual(['Senior Backend Engineer', 'Staff Backend Engineer']);
    expect(loadPack(join(tmp, 'pack')).pack.targets.claimableTitles).toEqual(['Senior Backend Engineer', 'Staff Backend Engineer']);
    const e = await importError(opts({ out: join(tmp, 'p3'), claimableTitles: ['I am a <b>great</b> engineer, see https://x.example'] }));
    expect(e.message).toMatch(/--claimable-title 1/);
  });

  it('planImport runs the input checks and writes nothing', async () => {
    const plan = planImport(opts());
    expect(plan.facts.total).toBe(9);
    expect(existsSync(join(tmp, 'pack'))).toBe(false);
    expect(readdirSync(tmp)).toEqual([]);
  });

  it('reports counts and never prints claims, answers or contact values', async () => {
    const report = await importPack(opts());
    expect(report.facts).toEqual({
      total: 9,
      byStatus: { 'derived-unverified': 1, 'user-stated': 5, verified: 3 },
      byKind: { cert: 1, education: 1, experience: 6, project: 1 },
    });
    expect(report.roles).toBe(4);
    const text = [JSON.stringify(report), ...formatImportReport(report)].join('\n');
    for (const secret of ['pipeline', 'asha.rao@example.com', '90000', 'Asha Rao', '40 LPA', 'remote', '1 November', 'Initech', 'product company']) {
      expect(text, secret).not.toContain(secret);
    }
    expect(formatImportReport(report).join('\n')).toMatch(/facts 9/);
  });
});

describe('pack import: failures leave no output', () => {
  it('fails when a raw employer holds a forbidden term and has no mapping', async () => {
    const e = await importError(opts({ employerDisplay: [] }));
    expect(e.message).toMatch(/no --employer-display mapping/);
    expect(e.message).not.toMatch(/initech/i);
    expect(existsSync(join(tmp, 'pack'))).toBe(false);
  });

  it('fails on a forbidden term in a claim, naming the fact id and never rewriting', async () => {
    const co = careerOpsWith((t) => t.replace('Built the payments reconciliation service', 'Built the Initech reconciliation service'));
    const e = await importError(opts({ careerOps: co }));
    expect(e.message).toMatch(/fact contoso-billing-01: the claim holds forbidden term #1/);
    expect(e.message).not.toMatch(/initech/i);
    expect(existsSync(join(tmp, 'pack'))).toBe(false);
  });

  it('fails on a character the embedded font cannot draw, naming the fact and code point', async () => {
    const co = careerOpsWith((t) => t.replace('from 800 ms to 180 ms', 'from 800 ms → 180 ms'));
    const e = await importError(opts({ careerOps: co }));
    expect(e.message).toMatch(/U\+2192 in fact northwind-labs-orders-01: replace with 'to'/);
    expect(e.message).not.toContain('→');
    expect(e.message).not.toContain('180 ms');
    const e2 = await importError(opts({ contact: { ...CONTACT, city: 'Pune ✓' } }));
    expect(e2.message).toMatch(/U\+2713 in contact\.city/);
    expect(e2.message).not.toContain('✓');
    expect(existsSync(join(tmp, 'pack'))).toBe(false);
  });

  it('fails when a contact token is longer than 60 characters', async () => {
    const e = await importError(opts({ contact: { ...CONTACT, links: [`https://example.com/${'a'.repeat(60)}`] } }));
    expect(e.message).toMatch(/contact\.links\[0\].*60 characters/);
  });

  it('rejects forbidden terms that are short or common words', async () => {
    expect((await importError(opts({ forbid: ['Ini'] }))).message).toMatch(/at least 4 characters/);
    expect((await importError(opts({ forbid: ['Global Systems'] }))).message).toMatch(/common word/);
    expect((await importError(opts({ forbid: [] }))).message).toMatch(/at least one --forbid/);
  });

  it('checks extra watchlist entries for forbidden terms, naming the entry', async () => {
    const extra = join(tmp, 'extra.yaml');
    writeFileSync(extra, 'watchlist:\n  - {company: Example, ats: lever, slug: ok, hiresInIndia: true, allRemote: false}\n  - {company: InitechCareers Ltd, ats: lever, slug: ic, hiresInIndia: true, allRemote: false}\n');
    const e = await importError(opts({ extraWatchlist: extra }));
    expect(e.message).toMatch(/--extra-watchlist entry 2 holds forbidden term #1/);
    expect(existsSync(join(tmp, 'pack'))).toBe(false);
  });

  it('fails when the final scan finds a forbidden term (even glued) in a written file, and deletes the output', async () => {
    const e = await importError(opts(), { beforeWrite: (files) => void (files['lexicon.yaml'] += '# see InitechPay\n') });
    expect(e.message).toMatch(/lexicon\.yaml holds forbidden term #1/);
    expect(e.message).not.toMatch(/initech/i);
    expect(existsSync(join(tmp, 'pack'))).toBe(false);
    expect(readdirSync(tmp).filter((n) => n.startsWith('pack'))).toEqual([]);
  });

  it('fails when loadPack rejects the result (a role after asOf)', async () => {
    const e = await importError(opts({ asOf: '2025-06' }));
    expect(e.message).toMatch(/after experience\.asOf 2025-06/);
    expect(existsSync(join(tmp, 'pack'))).toBe(false);
  });

  it('fails on a career-ops fact of the wrong shape', async () => {
    const co = careerOpsWith((t) => t.replace('period: 2020-04..2022-01', 'period: April 2020'));
    expect((await importError(opts({ careerOps: co }))).message).toMatch(/facts\.yaml.*period/);
  });
});

describe('pack import: the output directory', () => {
  it('refuses to overwrite an existing pack without --force', async () => {
    mkdirSync(join(tmp, 'pack'));
    writeFileSync(join(tmp, 'pack/marker'), 'old');
    expect((await importError(opts())).message).toMatch(/already exists.*--force/);
    expect(readFileSync(join(tmp, 'pack/marker'), 'utf8')).toBe('old');
  });

  it('with --force moves the old pack to pack.bak-<timestamp> first', async () => {
    mkdirSync(join(tmp, 'pack'));
    writeFileSync(join(tmp, 'pack/marker'), 'old');
    const report = await importPack(opts({ force: true }));
    const bak = join(tmp, 'pack.bak-20261009T083000Z');
    expect(report.backup).toBe(bak);
    expect(readFileSync(join(bak, 'marker'), 'utf8')).toBe('old');
    expect(existsSync(join(tmp, 'pack/marker'))).toBe(false);
    loadPack(join(tmp, 'pack'));
  });

  it('with --force and a failing import keeps the old pack in place', async () => {
    mkdirSync(join(tmp, 'pack'));
    writeFileSync(join(tmp, 'pack/marker'), 'old');
    await importError(opts({ force: true, employerDisplay: [] }));
    expect(readFileSync(join(tmp, 'pack/marker'), 'utf8')).toBe('old');
    expect(readdirSync(tmp).sort()).toEqual(['pack']);
  });
});

describe('resume role headers', () => {
  it('parses Title | Employer | City, Country | Mon YYYY - Mon YYYY|Present', async () => {
    const r = parseResumeRoles('A | B Co | Pune, India | September 2019 – Present\nbody | text\nC, promoted to D | E | X, Y | Jan 2010 - Feb 2012\n');
    expect(r).toEqual([
      { title: 'A', employer: 'B Co', location: 'Pune, India', start: '2019-09', end: 'present', line: 1 },
      { title: 'C, promoted to D', employer: 'E', location: 'X, Y', start: '2010-01', end: '2012-02', line: 3 },
    ]);
  });

  it('fails loudly on a header whose dates it cannot read', async () => {
    expect(() => parseResumeRoles('A | B | C, D | Spring 2019 - Present')).toThrow(/resume line 1/);
  });
});

describe('pack defaults', () => {
  it('are valid pack files and carry the Task 7 corrections', async () => {
    expect(LexiconSchema.parse(DEFAULT_LEXICON)).toEqual(DEFAULT_LEXICON);
    expect(FiltersSchema.parse(DEFAULT_FILTERS)).toEqual(DEFAULT_FILTERS);
    expect(TargetsSchema.parse(DEFAULT_TARGETS)).toEqual(DEFAULT_TARGETS);
    const deny = DEFAULT_FILTERS.roleDeny.map(compileSafePattern);
    const denied = (t: string) => deny.some((re) => re.test(t));
    for (const t of ['Solution Engineer', 'Solutions Engineer', 'Quality Assurance Engineer', 'Mobile Developer', 'Hardware Engineer', 'Customer Support Agent']) expect(denied(t), t).toBe(true);
    for (const t of ['Senior Backend Engineer', 'Backend Engineer, Mobile Payments', 'Hardware Platform Software Engineer', 'Data Quality Platform Engineer']) expect(denied(t), t).toBe(false);
    expect(DEFAULT_FILTERS.companyDeny).toContain('HCLTech');
    expect(DEFAULT_TARGETS.seniority.find((s) => s.words.includes('senior'))?.words).toContain('sr');
    expect(DEFAULT_TARGETS.titleBonusWords).toContain('back end');
    const groups = [...DEFAULT_LEXICON.strong, ...DEFAULT_LEXICON.medium, ...DEFAULT_LEXICON.gap];
    const g = (k: string) => groups.find((x) => x.key === k);
    expect(g('llm')?.synonyms).toEqual(['llms', 'large language model', 'large language models']);
    expect(g('multi-tenant')?.synonyms).toEqual(expect.arrayContaining(['multi-tenancy', 'multitenancy']));
    expect(g('microservices')?.synonyms).toContain('micro-services');
    const display = Object.fromEntries(groups.map((x) => [x.key, x.display]));
    expect(display).toMatchObject({ java: 'Java', spring: 'Spring', postgres: 'PostgreSQL', aws: 'AWS', node: 'Node.js', grpc: 'gRPC', saas: 'SaaS', cqrs: 'CQRS', llm: 'LLM', rag: 'RAG', mcp: 'MCP', go: 'Go', typescript: 'TypeScript' });
    expect(groups.every((x) => x.display !== undefined)).toBe(true);
  });
});

/** A copy of the fixture Desk export with `answers` as its settings/answers.json. */
function deskWith(answers: unknown): string {
  const desk = join(tmp, 'desk');
  cpSync(join(fx, 'desk'), desk, { recursive: true });
  writeFileSync(join(desk, 'settings/answers.json'), typeof answers === 'string' ? answers : JSON.stringify(answers));
  return desk;
}

describe('fix I1: forbidden terms glued inside ids, claims, links and answers', () => {
  it('rewrites a term glued inside an id to the display slug, keeping ids unique', async () => {
    const co = careerOpsWith((t) =>
      t.replace('id: initech-orders-01', 'id: initechorders-01').replace('id: initech-status-02', 'id: northwindInitechStatus').replace('id: initech-cost-03', 'id: in1tech2026-cost'),
    );
    await importPack(opts({ careerOps: co }));
    expect(factsOf().map((f) => f.id).slice(0, 4)).toEqual(['northwind-labs-orders-01-2', 'northwind-labs-orders-01', 'northwind-northwind-labs-Status', 'northwind-labs-2026-cost']);
    for (const f of readdirSync(join(tmp, 'pack')).filter((n) => n !== 'naming.yaml')) {
      expect(forbiddenSubstring(readFileSync(join(tmp, 'pack', f), 'utf8'), { forbiddenTerms: ['Initech'] }), f).toBeUndefined();
    }
    expect(rewriteId('northwindInitechOrders', ['Initech'], 'northwind-labs')).toBe('northwind-northwind-labs-Orders');
    expect(rewriteId('initechorders-01', ['Initech'], 'northwind-labs')).toBe('northwind-labs-orders-01');
  });

  it('fails on a term glued inside a claim, naming the fact and never echoing the claim', async () => {
    const co = careerOpsWith((t) => t.replace('Cut p99 latency of the pricing service', 'Cut InitechPay p99 latency of the pricing service'));
    const e = await importError(opts({ careerOps: co }));
    expect(e.message).toMatch(/fact northwind-labs-orders-01: the claim holds forbidden term #1/);
    expect(e.message).not.toMatch(/initech|p99/i);
  });

  it('fails on a term glued inside a contact link', async () => {
    const e = await importError(opts({ contact: { ...CONTACT, links: ['https://example.com/asha-at-initechcorp'] } }));
    expect(e.message).toMatch(/contact\.links\[0\] holds forbidden term #1/);
    expect(e.message).not.toMatch(/initech|asha-at/i);
  });

  it('removes an answer whose value has the term glued in, listing the key only', async () => {
    const report = await importPack(opts({ desk: deskWith({ work_mode: 'remote via InitechPay', years_go: 3 }) }));
    expect(report.answers.removedForbidden).toEqual(['work_mode']);
    expect(y('answers.yaml')).toEqual({ years_go: 3, available_from: '1 November 2026', notice_period: '30 days' });
  });
});

describe('fix I3: pay never enters the pack', () => {
  it('drops pay-like keys and money-like values, listing keys only', async () => {
    const report = await importPack(
      opts({
        desk: deskWith({
          ctc_current: '40', expected_salary: '1', salary_expectation_inr: '2', current_compensation: '3', joining_bonus_note: 'none', stipend: 'n/a', notice_package: 'x',
          offer_note: '₹45,00,000', target_note: 'about 45 LPA', usd_note: 'USD 120000', lakh_note: '12 lakh fixed', crore_note: '1 crore', dollar_note: '$90k',
          work_mode: 'remote', years_go: 3,
        }),
      }),
    );
    expect(y('answers.yaml')).toEqual({ work_mode: 'remote', years_go: 3, available_from: '1 November 2026', notice_period: '30 days' });
    expect([...report.answers.dropped].sort()).toEqual(
      ['crore_note', 'ctc_current', 'current_compensation', 'dollar_note', 'expected_salary', 'joining_bonus_note', 'lakh_note', 'notice_package', 'offer_note', 'salary_expectation_inr', 'stipend', 'target_note', 'usd_note'].sort(),
    );
    const text = formatImportReport(report).join('\n');
    for (const v of ['45,00,000', '45 LPA', '120000', '12 lakh', '1 crore', '$90k']) expect(text).not.toContain(v);
  });
});

describe('fix I4: lock, swap, permissions and stale staging', () => {
  it('takes the daily run\'s process lock', async () => {
    writeFileSync(join(tmp, 'jobpilot.lock'), JSON.stringify({ pid: 424242, command: 'run', at: '2026-10-09T08:00:00Z', token: 't' }));
    const probe = { alive: () => true, startTime: () => undefined };
    await expect(importPack(opts(), { probe })).rejects.toThrow(/another jobpilot process \(pid 424242, run\)/);
    expect(existsSync(join(tmp, 'pack'))).toBe(false);
  });

  it('moves the old pack back when the move-in fails, naming both paths', async () => {
    mkdirSync(join(tmp, 'pack'));
    writeFileSync(join(tmp, 'pack/marker'), 'old');
    const rename = (from: string, to: string) => {
      if (from.includes('.staging-')) throw new Error('simulated EXDEV');
      renameSync(from, to);
    };
    const e = await importError(opts({ force: true }), { rename });
    expect(e.message).toContain(join(tmp, 'pack'));
    expect(e.message).toContain(join(tmp, 'pack.bak-20261009T083000Z'));
    expect(e.message).toMatch(/moved back/);
    expect(readFileSync(join(tmp, 'pack/marker'), 'utf8')).toBe('old');
    expect(readdirSync(tmp).sort()).toEqual(['pack']);
  });

  it('when the restore fails too, keeps both packs and names both paths', async () => {
    mkdirSync(join(tmp, 'pack'));
    writeFileSync(join(tmp, 'pack/marker'), 'old');
    const rename = (from: string, to: string) => {
      if (from.includes('.staging-') || from.includes('.bak-')) throw new Error('simulated EXDEV');
      renameSync(from, to);
    };
    const e = await importError(opts({ force: true }), { rename });
    const bak = join(tmp, 'pack.bak-20261009T083000Z');
    const staging = join(tmp, 'pack.staging-20261009T083000Z');
    expect(e.message).toContain(bak);
    expect(e.message).toContain(staging);
    expect(readFileSync(join(bak, 'marker'), 'utf8')).toBe('old');
    expect(existsSync(join(staging, 'facts.yaml'))).toBe(true);
  });

  it('writes the pack directory 0700 and its files 0600', async () => {
    await importPack(opts());
    expect(statSync(join(tmp, 'pack')).mode & 0o777).toBe(0o700);
    for (const f of readdirSync(join(tmp, 'pack'))) expect(statSync(join(tmp, 'pack', f)).mode & 0o777, f).toBe(0o600);
  });

  it('removes staging directories older than an hour, keeping recent ones', async () => {
    const now = Date.parse('2026-10-09T08:30:00.000Z') / 1000;
    for (const [name, age] of [['pack.staging-20261009T060000Z', 2 * 3600], ['pack.staging-20261009T082000Z', 600]] as const) {
      mkdirSync(join(tmp, name));
      writeFileSync(join(tmp, name, 'contact.yaml'), 'name: x\n');
      utimesSync(join(tmp, name), now - age, now - age);
    }
    const report = await importPack(opts());
    expect(report.staleRemoved).toBe(1);
    expect(readdirSync(tmp).sort()).toEqual(['pack', 'pack.staging-20261009T082000Z']);
  });
});

describe('fix I5: employer mismatch', () => {
  it('fails when a citeable fact fits exactly one resume role by date under another employer, suggesting the mapping', async () => {
    const co = careerOpsWith((t) => t.replace('tech: [java, postgres, fintech]\n    employer: Contoso Retail', 'tech: [java, postgres, fintech]\n    employer: Contoso Retail Pvt Ltd'));
    const e = await importError(opts({ careerOps: co }));
    expect(e.message).toContain('--employer-display "Contoso Retail Pvt Ltd=Contoso Retail"');
    expect(e.message).toMatch(/contoso-billing-01/);
    expect(e.message).toMatch(/--allow-unplaced/);
    expect(existsSync(join(tmp, 'pack'))).toBe(false);
    const report = await importPack(opts({ careerOps: co, allowUnplaced: true }));
    expect(report.unplacedByReason).toEqual({ employerMismatch: 1, outsideEveryRole: 1 });
    expect(report.unplaced).toEqual(['contoso-billing-01', 'contoso-retry-02']);
    expect(formatImportReport(report).join('\n')).toMatch(/unplaced facts 2 \(employer mismatch 1, outside every role 1\)/);
  });

  it('withholds a raw employer that holds a forbidden term, pointing at the rewritten fact ids', async () => {
    const co = careerOpsWith((t) => t.replaceAll('employer: Initech India (GCC for Northwind)', 'employer: Initech Global Services'));
    const e = await importError(opts({ careerOps: co, employerDisplay: ['Initech India (GCC for Northwind)=Northwind Labs', 'Initech Global Services=Northwind Global'] }));
    expect(e.message).toContain('--employer-display "<raw employer from career-ops fact ids northwind-global-orders-01, northwind-global-status-02>=Northwind Labs"');
    expect(e.message).not.toMatch(/initech/i);
  });

  it('keeps a fact outside every role a warning', async () => {
    const report = await importPack(opts());
    expect(report.unplacedByReason).toEqual({ employerMismatch: 0, outsideEveryRole: 1 });
  });
});

describe('fix round 1 minors', () => {
  it('m2: refuses control characters in single-line fields', async () => {
    expect((await importError(opts({ availableFrom: '1 November\n2026' }))).message).toMatch(/--available-from contains a control character/);
    expect((await importError(opts({ employerDisplay: ['Initech India (GCC for Northwind)=Northwind Labs', 'Fabrikam=Fab\nrikam'] }))).message).toMatch(/--employer-display entry 2 contains a control character/);
    expect((await importError(opts({ contact: { ...CONTACT, name: 'Asha\tRao' } }))).message).toMatch(/contact\.name contains a control character/);
  });

  it('m3: never silently loses a reserved key', async () => {
    expect((await importError(opts({ employerDisplay: ['__proto__=X'] }))).message).toMatch(/reserved name/);
    const report = await importPack(opts({ desk: deskWith('{"constructor": "x", "work_mode": "remote"}') }));
    expect(report.answers.dropped).toEqual(['constructor']);
  });

  it('m4: duplicate source ids are an error, clean or not, ignoring case', async () => {
    const clean = careerOpsWith((t) => t.replace('id: contoso-retry-02', 'id: Contoso-Billing-01'));
    expect((await importError(opts({ careerOps: clean }))).message).toMatch(/fact #6 \(Contoso-Billing-01\): duplicate id \(the same as fact #5/);
    rmSync(join(tmp, 'co'), { recursive: true });
    const dirty = careerOpsWith((t) => t.replace('id: initech-status-02', 'id: initech-orders-01'));
    const e = await importError(opts({ careerOps: dirty }));
    expect(e.message).toMatch(/fact #3 \(id withheld: it holds a forbidden term\): duplicate id/);
    expect(e.message).not.toMatch(/initech/i);
  });

  it('m9: reports every bad resume header together', () => {
    expect(() => parseResumeRoles('A | B | C | Spring 2019 - Present\nD | E | F | Jan 2020 - Soon')).toThrow(/resume line 1[\s\S]*resume line 2/);
  });

  it('m10: refuses a display name with no letters or digits', async () => {
    expect((await importError(opts({ employerDisplay: ['Initech India (GCC for Northwind)=???'] }))).message).toMatch(/no letters or digits/);
  });

  it('m11: reads the board slug from a Greenhouse API url, never "v1"', () => {
    expect(boardOf('https://boards-api.greenhouse.io/v1/boards/acme/jobs/1')).toEqual({ ats: 'greenhouse', slug: 'acme' });
    expect(boardOf('https://boards-api.greenhouse.io/v2/other')).toBeNull();
    expect(boardOf('https://job-boards.greenhouse.io/acme/jobs/1')).toEqual({ ats: 'greenhouse', slug: 'acme' });
  });
});

describe('fix I2: the defaults are eval-gated', () => {
  it('the eligibility, scorer and grounding evals pass on a pack built from the defaults, but for the known diffs', async () => {
    const dir = join(tmp, 'defaults-pack');
    cpSync(join(root, 'tests/fixtures/pack'), dir, { recursive: true });
    writeFileSync(join(dir, 'lexicon.yaml'), stringify(DEFAULT_LEXICON));
    writeFileSync(join(dir, 'targets.yaml'), stringify(DEFAULT_TARGETS));
    writeFileSync(join(dir, 'filters.yaml'), stringify(DEFAULT_FILTERS));
    writeFileSync(join(dir, 'eligibility.yaml'), stringify(DEFAULT_ELIGIBILITY));
    const failures: Record<string, unknown> = {};
    for (const spec of appEvalSpecs(join(root, 'evals/datasets'), dir)) {
      const r = await runEval(spec, { providers: { fetch: async () => ({ status: 404, text: async () => '' }) }, policy: PRODUCT_POLICY_V1 });
      for (const f of r.failures) failures[`${spec.name ?? spec.agent.contract.id}/${f.id}`] = f.actual;
    }
    // The only differences from the fixture pack's expectations, each intended:
    expect(failures).toEqual(KNOWN_DEFAULT_DIFFS);
  }, 120_000);
});

describe('jobpilot pack import (CLI)', () => {
  const cli = (home: string, ...args: string[]) =>
    spawnSync(process.execPath, ['--import', 'tsx', join(root, 'src/bin.ts'), ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, JOBPILOT_HOME: home } });
  const args = (): string[] => [
    'pack', 'import',
    '--career-ops', join(fx, 'career-ops'),
    '--resume-text', join(fx, 'resume.txt'),
    '--desk', join(fx, 'desk'),
    '--forbid', 'Initech',
    '--employer-display', 'Initech India (GCC for Northwind)=Northwind Labs',
    '--name', CONTACT.name, '--email', CONTACT.email, '--phone', CONTACT.phone, '--city', CONTACT.city,
    '--link', 'https://example.com/asha-rao', '--link', 'https://example.org/asha',
    '--as-of', '2026-10', '--available-from', '1 November 2026', '--notice-period', '30 days', '--floor-inr', '1200000',
    '--education-text', join(fx, 'education.txt'),
  ];

  it('writes the pack to $JOBPILOT_HOME/pack and prints the counts only', async () => {
    const r = cli(tmp, ...args());
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/facts 9/);
    expect(r.stdout).toMatch(/fx\.yaml/);
    for (const secret of ['asha.rao', 'Initech', 'pipeline', '1 November']) expect(r.stdout + r.stderr, secret).not.toContain(secret);
    expect((y('contact.yaml', join(tmp, 'pack')) as { links: string[] }).links).toEqual(['https://example.com/asha-rao', 'https://example.org/asha']);
    const again = cli(tmp, ...args());
    expect(again.status).toBe(1);
    expect(again.stderr).toMatch(/--force/);
  }, 60_000);

  it('--dry-run checks every input and writes nothing', async () => {
    const r = cli(tmp, ...args(), '--dry-run');
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^dry run: every input check passed; nothing was written/);
    expect(existsSync(join(tmp, 'pack'))).toBe(false);
  }, 60_000);

  it('pack check fails on an undrawable character or a glued forbidden term added after the import (m8)', async () => {
    cpSync(join(root, 'tests/fixtures/pack'), join(tmp, 'pack'), { recursive: true });
    const watch = readFileSync(join(tmp, 'pack/watchlist.yaml'), 'utf8').split('\n').filter((l) => !l.includes('ats: careers')).join('\n');
    writeFileSync(join(tmp, 'pack/watchlist.yaml'), watch);
    expect(cli(tmp, 'pack', 'check').status).toBe(0);
    const facts = readFileSync(join(tmp, 'pack/facts.yaml'), 'utf8');
    writeFileSync(join(tmp, 'pack/facts.yaml'), facts.replace('from 800 ms to 180 ms', 'from 800 ms → 180 ms').replace('Built REST services', 'Built InitechPay REST services'));
    const r = cli(tmp, 'pack', 'check');
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/U\+2192 in fact f-nw-02: replace with 'to'/);
    expect(r.stderr).toMatch(/fact f-fb-01 claim holds forbidden term #1/);
    expect(r.stderr).not.toMatch(/→|initech|REST/i);
  }, 60_000);

  it('rejects a bad --floor-inr', async () => {
    const a = args();
    a[a.indexOf('--floor-inr') + 1] = '12 lakh';
    const r = cli(tmp, ...a);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/--floor-inr/);
  }, 60_000);
});
