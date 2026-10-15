import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  companySeed,
  companySeedContract,
  mergeCandidates,
  parseJobsItems,
  parsePicksItems,
  parseRemoteIntech,
  parseYc,
  readTar,
  registrableDomain,
  seedItemsFromJobs,
  REMOTEINTECH_URL,
  YC_URL,
} from '../../../src/app/coverage/seed.js';
import { CompanyCandidate, CoverageRequest } from '../../../src/app/coverage/types.js';
import { AppStore } from '../../../src/app/store/app-store.js';
import { issueContext } from '../../../src/kernel/broker.js';
import { fixedClock } from '../../../src/kernel/clock.js';
import { KernelError } from '../../../src/kernel/errors.js';
import { PRODUCT_POLICY_V1 } from '../../../src/kernel/policy.js';
import type { FetchLike } from '../../../src/kernel/providers.js';
import { offlineProviders } from '../../../src/app/offline.js';
import { jobRow } from '../../support/app-fixtures.js';
import { buildTar } from '../../support/tar.js';

const fixture = (name: string): Buffer => readFileSync(new URL(`../../fixtures/coverage/seed/${name}`, import.meta.url));
const RUN = '2026-10-13';
const cand = (over: Partial<CompanyCandidate>): CompanyCandidate => ({
  companyKey: 'a.com',
  name: 'A',
  website: 'https://a.com',
  careersUrl: null,
  source: 'jobs',
  runDate: RUN,
  ...over,
});

/** A fake fetch serving exact URLs; the body is a stream so binary bytes survive. */
function serve(routes: Record<string, Uint8Array | string>, maxResponseBytes?: number) {
  const calls: string[] = [];
  const fetch: FetchLike = async (url) => {
    calls.push(url);
    const body = routes[url];
    if (body === undefined) return { status: 404, text: async () => 'Not Found' };
    const bytes = typeof body === 'string' ? Buffer.from(body) : body;
    return {
      status: 200,
      body: new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(bytes);
          c.close();
        },
      }),
      text: async () => Buffer.from(bytes).toString('utf8'),
    };
  };
  return { fetch, calls, policy: maxResponseBytes === undefined ? PRODUCT_POLICY_V1 : { ...PRODUCT_POLICY_V1, maxResponseBytes } };
}

async function seed(req: Omit<CoverageRequest, 'runDate'>, s: ReturnType<typeof serve>) {
  const ctx = issueContext({
    contract: companySeedContract,
    policy: s.policy,
    inputClass: 'P0',
    providers: { fetch: s.fetch },
    clock: fixedClock('2026-10-13T00:00:00Z'),
    signal: new AbortController().signal,
  });
  const out = await companySeed.run({ runDate: RUN, ...req }, ctx);
  return { out, skips: ctx.skips() };
}

const codeOf = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (e) {
    return e instanceof KernelError ? `${e.code}: ${e.message}` : `other: ${String(e)}`;
  }
  return 'no error';
};

describe('registrableDomain', () => {
  it('takes the last two labels, three under a known multi-part suffix', () => {
    expect(registrableDomain('www.okta.com')).toBe('okta.com');
    expect(registrableDomain('Careers.Foo.co.in')).toBe('foo.co.in');
    expect(registrableDomain('x.github.io')).toBe('x.github.io');
    expect(registrableDomain('www.x.github.io')).toBe('x.github.io');
    expect(registrableDomain('app.vercel.app')).toBe('app.vercel.app');
    expect(registrableDomain('jobs.bbc.co.uk')).toBe('bbc.co.uk');
    expect(registrableDomain('okta.com.')).toBe('okta.com');
  });
  it('applies the ccTLD rule and the hosting suffixes', () => {
    expect(registrableDomain('www.foo.co.za')).toBe('foo.co.za');
    expect(registrableDomain('a.b.bar.com.mx')).toBe('bar.com.mx');
    expect(registrableDomain('www.x.org.au')).toBe('x.org.au');
    expect(registrableDomain('jobs.hmrc.gov.uk')).toBe('hmrc.gov.uk');
    expect(registrableDomain('www.ox.ac.uk')).toBe('ox.ac.uk');
    expect(registrableDomain('careers.y.com.hk')).toBe('y.com.hk');
    expect(registrableDomain('acme.herokuapp.com')).toBe('acme.herokuapp.com');
    for (const h of ['a.netlify.app', 'a.pages.dev', 'a.web.app', 'a.firebaseapp.com', 'a.azurewebsites.net', 'a.onrender.com']) expect(registrableDomain(h)).toBe(h);
    expect(registrableDomain('www.foo.com')).toBe('foo.com');
    expect(registrableDomain('careers.bar.co.in')).toBe('bar.co.in');
    expect(registrableDomain('example.co')).toBe('example.co');
  });
  it('refuses IPs, localhost, single labels and bare suffixes', () => {
    for (const h of ['127.0.0.1', '10.1.2.3', '[::1]', '::1', 'localhost', 'intranet', 'co.uk', 'github.io', 'co.za', 'com.mx', 'gov.uk', 'herokuapp.com', '']) {
      expect(registrableDomain(h)).toBeNull();
    }
  });
});

describe('readTar', () => {
  it('reads regular files and skips directories, global pax headers and other types', () => {
    const tar = buildTar([
      { name: 'r/', type: '5' },
      { name: 'pax_global_header', type: 'g', data: '52 comment=abc\n'.padEnd(20, ' ') },
      { name: 'r/a.md', data: 'hello' },
      { name: 'r/link', type: '2' },
      { name: 'r/b.md', data: 'x'.repeat(600) },
    ]);
    const files = readTar(tar, () => true);
    expect(files.map((f) => f.name)).toEqual(['r/a.md', 'r/b.md']);
    expect(Buffer.from(files[0]?.data ?? []).toString()).toBe('hello');
    expect(files[1]?.data.length).toBe(600);
  });
  it('honours GNU long names (typeflag L) and a pax path record', () => {
    const long = `r/src/companies/${'very-long-name-'.repeat(12)}.md`;
    expect(long.length).toBeGreaterThan(100);
    const gnu = buildTar([{ name: long, data: 'g', longName: 'gnu' }]);
    expect(readTar(gnu, () => true).map((f) => f.name)).toEqual([long]);
    const pax = buildTar([{ name: long, data: 'p', longName: 'pax' }]);
    expect(readTar(pax, () => true).map((f) => f.name)).toEqual([long]);
  });
  it('uses the ustar prefix field', () => {
    const t = buildTar([{ name: 'r/a/b.md', data: 'z', prefix: 'r/a', short: 'b.md' }]);
    expect(readTar(t, () => true).map((f) => f.name)).toEqual(['r/a/b.md']);
  });
  it('only returns names the filter keeps', () => {
    const t = buildTar([{ name: 'r/a.md', data: '1' }, { name: 'r/b.txt', data: '2' }]);
    expect(readTar(t, (n) => n.endsWith('.md')).map((f) => f.name)).toEqual(['r/a.md']);
  });
  it('rejects a bad checksum and a truncated archive', () => {
    const t = Buffer.from(buildTar([{ name: 'r/a.md', data: 'hello' }]));
    const bad = Buffer.from(t);
    bad[0] = bad[0] === 0x7a ? 0x79 : 0x7a;
    expect(() => readTar(bad, () => true)).toThrow(/checksum/);
    expect(() => readTar(t.subarray(0, 512), () => true)).toThrow(/truncated/);
  });
});

describe('remoteintech fixture', () => {
  it('yields 20 companies and skips the 2 malformed files', () => {
    const p = parseRemoteIntech(fixture('remoteintech.tar.gz'), RUN);
    expect(p.candidates).toHaveLength(20);
    expect(p.skipped).toHaveLength(2);
    expect(p.skipped.join('\n')).toMatch(/zz-no-frontmatter\.md/);
    expect(p.skipped.join('\n')).toMatch(/zz-no-website\.md/);
    const first = p.candidates.find((c) => c.companyKey === '10up.com');
    expect(first).toEqual({ companyKey: '10up.com', name: '10up', website: 'https://10up.com', careersUrl: 'https://10up.com/careers/', source: 'remoteintech', runDate: RUN });
    for (const c of p.candidates) CompanyCandidate.schema.parse(c);
    const keys = p.candidates.map((c) => c.companyKey);
    expect(keys).toEqual([...keys].sort());
    expect(new Set(keys).size).toBe(20);
  });
  it('is byte-identical across parses', () => {
    const a = JSON.stringify(parseRemoteIntech(fixture('remoteintech.tar.gz'), RUN));
    expect(JSON.stringify(parseRemoteIntech(fixture('remoteintech.tar.gz'), RUN))).toBe(a);
  });
  it('reads a company with a long file name inside the real layout', () => {
    const name = `${'x'.repeat(110)}`;
    const md = `---\ntitle: "Long Co"\nwebsite: https://www.long.example.co.uk/\n---\n`;
    const tar = gzipSync(buildTar([{ name: 'repo-main/src/companies/', type: '5' }, { name: `repo-main/src/companies/${name}.md`, data: md, longName: 'gnu' }]));
    const p = parseRemoteIntech(tar, RUN);
    expect(p.candidates).toMatchObject([{ companyKey: 'example.co.uk', name: 'Long Co', careersUrl: null }]);
  });
  it('skips a bad website, an IP and a non-string title with notes', () => {
    const f = (t: string, w: string): string => `---\ntitle: ${t}\nwebsite: ${w}\n---\n`;
    const tar = gzipSync(
      buildTar([
        { name: 'r/src/companies/ok.md', data: f('Ok', 'https://ok.io') },
        { name: 'r/src/companies/ip.md', data: f('Ip', 'http://10.0.0.1/') },
        { name: 'r/src/companies/local.md', data: f('Local', 'http://localhost:3000') },
        { name: 'r/src/companies/nohost.md', data: f('NoHost', '"not a url ::"') },
        { name: 'r/src/companies/list.md', data: '---\n- a\n- b\n---\n' },
        { name: 'r/src/companies/yaml.md', data: '---\ntitle: [unclosed\n---\n' },
        { name: 'r/src/other/x.md', data: f('Other', 'https://other.io') },
      ]),
    );
    const p = parseRemoteIntech(tar, RUN);
    expect(p.candidates.map((c) => c.name)).toEqual(['Ok']);
    expect(p.skipped).toHaveLength(5);
  });
  it('treats an archive with no company files as a layout change', () => {
    const tar = gzipSync(buildTar([{ name: 'r/README.md', data: 'x' }]));
    expect(() => parseRemoteIntech(tar, RUN)).toThrow(/no company files/);
  });
});

describe('yc fixture', () => {
  const json = JSON.parse(fixture('yc-hiring.json').toString('utf8')) as unknown;
  it('keeps Active, hiring companies with a website', () => {
    const p = parseYc(json, RUN);
    expect(p.candidates).toHaveLength(24);
    // 2 Active entries with an empty website and 1 entry with no name or website are skipped; Public and not-hiring are filtered, not skipped.
    expect(p.skipped).toHaveLength(3);
    expect(p.candidates.map((c) => c.name)).not.toContain('Idle Co');
    expect(p.candidates.find((c) => c.name === 'Alpha Vantage')).toEqual({
      companyKey: 'alphavantage.co',
      name: 'Alpha Vantage',
      website: 'https://www.alphavantage.co',
      careersUrl: null,
      source: 'yc',
      runDate: RUN,
    });
    const keys = p.candidates.map((c) => c.companyKey);
    expect(keys).toEqual([...keys].sort());
  });
  it('rejects a non-array body', () => {
    expect(() => parseYc({ companies: [] }, RUN)).toThrow(/array/);
  });
});

describe('picks and jobs items', () => {
  it('maps picks, with a note for a pick that has no usable website', () => {
    const p = parsePicksItems(
      [
        { name: 'Okta', website: 'https://www.okta.com', careersUrl: 'https://www.okta.com/company/careers/' },
        { name: 'NameOnly' },
        { name: 'BadSite', website: 'http://192.168.0.1' },
        { name: 'NoScheme', website: 'foo.co.in' },
      ],
      RUN,
    );
    expect(p.candidates.map((c) => [c.companyKey, c.name, c.careersUrl, c.source])).toEqual([
      ['foo.co.in', 'NoScheme', null, 'pick'],
      ['okta.com', 'Okta', 'https://www.okta.com/company/careers/', 'pick'],
    ]);
    expect(p.notes).toHaveLength(2);
    expect(p.skipped).toHaveLength(0);
  });
  it('treats malformed pick items as skipped and a non-array as invalid', () => {
    const p = parsePicksItems([{ name: 'A', website: 'https://a.com' }, 7, { website: 'https://b.com' }], RUN);
    expect(p.candidates).toHaveLength(1);
    expect(p.skipped).toHaveLength(2);
    expect(() => parsePicksItems('nope', RUN)).toThrow(/array/);
    expect(() => parsePicksItems(undefined, RUN)).toThrow(/array/);
  });
  it('maps jobs pairs; a null website is unkeyed, not malformed', () => {
    const p = parseJobsItems([{ name: 'Acme', website: 'https://careers.acme.co.uk' }, { name: 'Nowhere', website: null }], RUN);
    expect(p.candidates).toMatchObject([{ companyKey: 'acme.co.uk', name: 'Acme', source: 'jobs', careersUrl: null }]);
    expect(p.notes).toHaveLength(1);
  });
  it('seedItemsFromJobs selects distinct companies sorted, with the careers host only for careers jobs off shared ATS domains', () => {
    const app = AppStore.open(':memory:');
    try {
      const add = (n: string, source: string, ats: string, url: string, company: string): void => {
        app.upsertJob(jobRow({ jobKey: `${source}:${n}`, dedupeKey: `d${n}`, source, sourceId: n, company, ats, url }));
      };
      add('1', 'careers', 'careers', 'https://careers.zeta.com/jobs/1', 'Zeta');
      add('2', 'careers', 'careers', 'https://careers.zeta.com/jobs/2', 'Zeta');
      add('3', 'greenhouse', 'greenhouse', 'https://boards.greenhouse.io/acme/jobs/3', 'Acme');
      add('4', 'careers', 'careers', 'https://www.beta.io/careers/4', 'Beta');
      add('5', 'greenhouse', 'greenhouse', 'https://boards.greenhouse.io/beta/jobs/5', 'Beta');
      add('6', 'careers', 'careers', 'https://jobs.lever.co/gamma/6', 'Gamma');
      expect(seedItemsFromJobs(app)).toEqual([
        { name: 'Acme', website: null },
        { name: 'Beta', website: 'https://www.beta.io' },
        { name: 'Gamma', website: null },
        { name: 'Zeta', website: 'https://careers.zeta.com' },
      ]);
    } finally {
      app.close();
    }
  });
});

describe('collisions are never silent', () => {
  it('a source reports a company dropped for a shared key, naming both', async () => {
    const s = serve({ [YC_URL]: JSON.stringify([
      { name: 'Beta Inc', status: 'Active', isHiring: true, website: 'https://www.shared.io' },
      { name: 'Alpha', status: 'Active', isHiring: true, website: 'https://shared.io/x' },
    ]) });
    const { out, skips } = await seed({ source: 'yc' }, s);
    expect(out.map((c) => c.name)).toEqual(['Alpha']);
    expect(skips).toHaveLength(1);
    expect(skips[0]).toMatch(/"Beta Inc".*shared\.io.*"Alpha"/);
  });
  it('mergeCandidates reports every loser', () => {
    const notes: string[] = [];
    const out = mergeCandidates([cand({ name: 'J', source: 'jobs' }), cand({ name: 'Y', source: 'yc' }), cand({ name: 'P', source: 'pick' })], (n) => notes.push(n));
    expect(out.map((c) => c.name)).toEqual(['P']);
    expect(notes).toHaveLength(2);
    expect(notes.join('\n')).toMatch(/"J"[^\n]*"P"/);
    expect(notes.join('\n')).toMatch(/"Y"[^\n]*"P"/);
  });
});

describe('offline provider', () => {
  it('serves the binary tar.gz fixture and the JSON fixture through seed', async () => {
    const dir = new URL('../../fixtures/coverage/seed/', import.meta.url).pathname;
    const off = offlineProviders(dir);
    const run = async (source: 'remoteintech' | 'yc') => {
      const ctx = issueContext({ contract: companySeedContract, policy: PRODUCT_POLICY_V1, inputClass: 'P0', providers: { fetch: off.fetch }, clock: fixedClock('2026-10-13T00:00:00Z'), signal: new AbortController().signal });
      return companySeed.run({ runDate: RUN, source }, ctx);
    };
    expect(await run('remoteintech')).toHaveLength(20);
    expect(await run('yc')).toHaveLength(24);
    expect(off.fetch.calls).toEqual([REMOTEINTECH_URL, YC_URL]);
  });
});

describe('mergeCandidates', () => {
  it('keeps one per companyKey with precedence pick > remoteintech > yc > jobs, sorted', () => {
    const out = mergeCandidates([
      cand({ companyKey: 'z.com', name: 'Z jobs', source: 'jobs' }),
      cand({ companyKey: 'a.com', name: 'A jobs', source: 'jobs', careersUrl: 'https://a.com/j' }),
      cand({ companyKey: 'a.com', name: 'A yc', source: 'yc' }),
      cand({ companyKey: 'a.com', name: 'A ri', source: 'remoteintech', careersUrl: 'https://a.com/careers' }),
      cand({ companyKey: 'm.com', name: 'M yc', source: 'yc' }),
      cand({ companyKey: 'm.com', name: 'M jobs', source: 'jobs' }),
      cand({ companyKey: 'a.com', name: 'A pick', source: 'pick', careersUrl: null }),
    ]);
    expect(out.map((c) => [c.companyKey, c.name, c.source, c.careersUrl])).toEqual([
      ['a.com', 'A pick', 'pick', null],
      ['m.com', 'M yc', 'yc', null],
      ['z.com', 'Z jobs', 'jobs', null],
    ]);
  });
  it('is independent of input order', () => {
    const xs = [cand({ name: 'B', source: 'yc' }), cand({ name: 'A', source: 'yc' }), cand({ name: 'C', source: 'jobs' })];
    expect(mergeCandidates(xs)).toEqual(mergeCandidates([...xs].reverse()));
    expect(mergeCandidates(xs)[0]?.name).toBe('A');
  });
});

describe('company-seed agent', () => {
  it('has the contract the plan needs', () => {
    expect(companySeedContract.kind).toBe('io');
    expect(companySeedContract.egress).toEqual(['codeload.github.com', 'yc-oss.github.io']);
  });
  it('remoteintech: one request, 20 sorted candidates, skips reported', async () => {
    const s = serve({ [REMOTEINTECH_URL]: fixture('remoteintech.tar.gz') });
    const { out, skips } = await seed({ source: 'remoteintech' }, s);
    expect(s.calls).toEqual([REMOTEINTECH_URL]);
    expect(REMOTEINTECH_URL).toBe('https://codeload.github.com/remoteintech/remote-jobs/tar.gz/refs/heads/main');
    expect(out).toHaveLength(20);
    expect(skips).toHaveLength(2);
    expect(out.every((c) => c.source === 'remoteintech' && c.runDate === RUN)).toBe(true);
  });
  it('yc: 24 candidates, 3 skips', async () => {
    const s = serve({ [YC_URL]: fixture('yc-hiring.json') });
    const { out, skips } = await seed({ source: 'yc' }, s);
    expect(YC_URL).toBe('https://yc-oss.github.io/api/companies/hiring.json');
    expect(out).toHaveLength(24);
    expect(skips).toHaveLength(3);
  });
  it('picks and jobs come from items, with no request', async () => {
    const s = serve({});
    const picks = await seed({ source: 'picks', items: [{ name: 'Okta', website: 'https://www.okta.com' }, { name: 'NameOnly' }] }, s);
    expect(picks.out.map((c) => [c.companyKey, c.source])).toEqual([['okta.com', 'pick']]);
    expect(picks.skips).toHaveLength(1);
    const jobs = await seed({ source: 'jobs', items: [{ name: 'Acme', website: 'https://acme.io' }, { name: 'X', website: null }] }, s);
    expect(jobs.out.map((c) => [c.companyKey, c.source])).toEqual([['acme.io', 'jobs']]);
    expect(jobs.skips).toHaveLength(1);
    expect(s.calls).toEqual([]);
  });
  it('an all-malformed source is invalid_output', async () => {
    const yc = serve({ [YC_URL]: JSON.stringify([{ slug: 'a' }, 3, null]) });
    expect(await codeOf(seed({ source: 'yc' }, yc))).toMatch(/^invalid_output: .*yc.*3/);
    const ri = serve({ [REMOTEINTECH_URL]: gzipSync(buildTar([{ name: 'r/src/companies/a.md', data: 'no front matter' }, { name: 'r/src/companies/b.md', data: '---\ntitle: B\n---\n' }])) });
    expect(await codeOf(seed({ source: 'remoteintech' }, ri))).toMatch(/^invalid_output: .*remoteintech/);
    expect(await codeOf(seed({ source: 'picks', items: [1, 2] }, serve({})))).toMatch(/^invalid_output/);
  });
  it('a missing source answer is invalid_output', async () => {
    expect(await codeOf(seed({ source: 'yc' }, serve({})))).toMatch(/^invalid_output: .*404/);
  });
  it('refuses a compressed body over 20 MB', async () => {
    const big = Buffer.alloc(20_000_001, 7);
    const s = serve({ [REMOTEINTECH_URL]: big }, 30_000_000);
    expect(await codeOf(seed({ source: 'remoteintech' }, s))).toMatch(/^invalid_output: .*20 MB/);
  });
  it('refuses an archive that expands past 80 MB', async () => {
    const bomb = gzipSync(Buffer.alloc(81 * 1024 * 1024));
    expect(bomb.length).toBeLessThan(1024 * 1024);
    const s = serve({ [REMOTEINTECH_URL]: bomb });
    expect(await codeOf(seed({ source: 'remoteintech' }, s))).toMatch(/^invalid_output: .*80 MB/);
  });
  it('refuses a body that is not gzip', async () => {
    const s = serve({ [REMOTEINTECH_URL]: Buffer.from('<html>blocked</html>') });
    expect(await codeOf(seed({ source: 'remoteintech' }, s))).toMatch(/^invalid_output/);
  });
});

describe('final review N1: the seed never retries around a 429', () => {
  it('retries a network failure, an overloaded server or a timeout, never a rate limit (Retry-After is never read either)', () => {
    expect(companySeed.contract.retry.on).toEqual(['overloaded', 'network', 'timeout']);
    expect(companySeed.contract.version).toBe('1.2.0');
  });
});
