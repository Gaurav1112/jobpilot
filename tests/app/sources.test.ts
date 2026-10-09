import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ashbyParse, srcAshby } from '../../src/app/agents/sources/ashby.js';
import { greenhouseParse, srcGreenhouse } from '../../src/app/agents/sources/greenhouse.js';
import { HIMALAYAS_MAX_PAGES, himalayasParse, indiaEligible, srcHimalayas } from '../../src/app/agents/sources/himalayas.js';
import { JOBICY_MAX_REQUESTS, jobicyParse, srcJobicy } from '../../src/app/agents/sources/jobicy.js';
import { LEVER_MAX_PAGES, leverParse, srcLever } from '../../src/app/agents/sources/lever.js';
import type { DiscoveryRequest, RawPosting } from '../../src/app/types.js';
import { RawPosting as RawPostingType } from '../../src/app/types.js';
import type { Agent } from '../../src/kernel/agent.js';
import { HTTP_HEADERS, issueContext } from '../../src/kernel/broker.js';
import { fixedClock } from '../../src/kernel/clock.js';
import { PRODUCT_POLICY_V1 } from '../../src/kernel/policy.js';
import type { FetchLike } from '../../src/kernel/providers.js';

const fixture = (name: string): string => readFileSync(new URL(`../fixtures/sources/${name}.json`, import.meta.url), 'utf8');
const fixtureJson = (name: string): unknown => JSON.parse(fixture(name));

interface Recorder {
  fetch: FetchLike;
  urls: string[];
  headers: Readonly<Record<string, string>>[];
}

/** A fake fetch serving exact URLs; anything else is a 404. */
function serve(routes: Record<string, { status?: number; body: string }>): Recorder {
  const urls: string[] = [];
  const headers: Readonly<Record<string, string>>[] = [];
  const fetch: FetchLike = async (url, init) => {
    urls.push(url);
    headers.push(init.headers);
    const r = routes[url];
    if (!r) return { status: 404, text: async () => 'Not Found' };
    return { status: r.status ?? 200, text: async () => r.body };
  };
  return { fetch, urls, headers };
}

const req = (ats: DiscoveryRequest['ats'], slug: string, company = 'Acme'): DiscoveryRequest => ({ ats, slug, company, runDate: '2026-10-09' });

async function run(agent: Agent<DiscoveryRequest, RawPosting>, r: DiscoveryRequest, rec: Recorder): Promise<readonly RawPosting[]> {
  const ctx = issueContext({
    contract: agent.contract,
    policy: PRODUCT_POLICY_V1,
    inputClass: 'P0',
    providers: { fetch: rec.fetch },
    clock: fixedClock('2026-10-09T00:00:00Z'),
    signal: new AbortController().signal,
  });
  return agent.run(r, ctx);
}

const ids = (ps: readonly RawPosting[]): string[] => ps.map((p) => p.sourceId);
const sorted = (xs: readonly string[]): string[] => [...xs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

const GH = 'https://boards-api.greenhouse.io/v1/boards/gitlab/jobs?content=true&pay_transparency=true';
const LV = (skip: number) => `https://api.lever.co/v0/postings/veeva?mode=json&skip=${skip}&limit=100`;
const AB = 'https://api.ashbyhq.com/posting-api/job-board/confluent?includeCompensation=true';
const HM = (page: number) => `https://himalayas.app/jobs/api/search?q=backend&country=IN&employment_type=Full%20Time&sort=recent&page=${page}`;
const JB = (geo: string, cursor?: string) =>
  `https://jobicy.com/api/v2/remote-jobs?count=50&geo=${geo}&tag=backend${cursor === undefined ? '' : `&cursor=${encodeURIComponent(cursor)}`}`;
const EMPTY_HM = JSON.stringify({ jobs: [] });

describe('source contracts', () => {
  it.each([
    [srcGreenhouse, 'src-greenhouse', 'boards-api.greenhouse.io', 30_000],
    [srcLever, 'src-lever', 'api.lever.co', 900_000],
    [srcAshby, 'src-ashby', 'api.ashbyhq.com', 30_000],
    [srcHimalayas, 'src-himalayas', 'himalayas.app', 720_000],
    [srcJobicy, 'src-jobicy', 'jobicy.com', 180_000],
  ])('%#: id, team, kind, egress, timeout, retry', (agent, id, host, timeoutMs) => {
    const c = agent.contract;
    expect(c.id).toBe(id);
    expect(c.team).toBe('sourcing');
    expect(c.kind).toBe('io');
    expect(c.capabilities).toEqual({ http: true });
    expect(c.egress).toEqual([host]);
    expect(c.timeoutMs).toBe(timeoutMs);
    expect(c.retry).toEqual({ max: 2, on: ['rate_limit', 'overloaded', 'network', 'timeout'], backoffMs: [2000, 8000] });
    expect(c.consumes.name).toBe('DiscoveryRequest');
    expect(c.produces.name).toBe('RawPosting');
  });
});

describe('fix round 1', () => {
  it('a non-empty response where every job fails to parse → invalid_output, not []', async () => {
    const bad = JSON.stringify({ jobs: [{ nope: 1 }, { nope: 2 }] });
    const cases: [Agent<DiscoveryRequest, RawPosting>, DiscoveryRequest, Record<string, { body: string }>, string][] = [
      [srcGreenhouse, req('greenhouse', 'gitlab'), { [GH]: { body: bad } }, 'greenhouse: all 2 jobs failed to parse'],
      [srcLever, req('lever', 'veeva'), { [LV(0)]: { body: '[{"nope":1},{"nope":2}]' } }, 'lever: all 2 jobs failed to parse'],
      [srcAshby, req('ashby', 'confluent'), { [AB]: { body: bad } }, 'ashby: all 2 jobs failed to parse'],
      [srcHimalayas, req('feed', 'himalayas'), { [HM(1)]: { body: bad } }, 'himalayas: all 2 jobs failed to parse'],
      [srcJobicy, req('feed', 'jobicy'), { [JB('apac')]: { body: bad }, [JB('anywhere')]: { body: bad } }, 'jobicy: all 2 jobs failed to parse'],
    ];
    for (const [agent, r, routes, message] of cases) {
      await expect(run(agent, r, serve(routes)), agent.contract.id).rejects.toMatchObject({ code: 'invalid_output', message });
    }
  });

  it('an empty board is still [] (not a parse failure)', async () => {
    await expect(run(srcGreenhouse, req('greenhouse', 'gitlab'), serve({ [GH]: { body: '{"jobs":[]}' } }))).resolves.toEqual([]);
    await expect(run(srcLever, req('lever', 'veeva'), serve({ [LV(0)]: { body: '[]' } }))).resolves.toEqual([]);
  });

  it('an object-shaped board answering a top-level [] → invalid_output', async () => {
    await expect(run(srcGreenhouse, req('greenhouse', 'gitlab'), serve({ [GH]: { body: '[]' } }))).rejects.toMatchObject({ code: 'invalid_output' });
    await expect(run(srcAshby, req('ashby', 'confluent'), serve({ [AB]: { body: '[]' } }))).rejects.toMatchObject({ code: 'invalid_output' });
  });

  it('ids are trimmed; a blank id is malformed', () => {
    const parsed = greenhouseParse({ jobs: [{ id: ' 3 ', title: 't' }, { id: '   ', title: 'u' }, { id: 4, title: 'v' }] }, req('greenhouse', 'g'));
    expect(parsed.postings.map((p) => p.sourceId)).toEqual(['3', '4']);
    expect(parsed.skipped).toHaveLength(1);
  });

  it('himalayas: an error on page 2 fails the whole step (idempotent GETs, retried as a unit)', async () => {
    const rec = serve({ [HM(1)]: { body: fixture('himalayas') }, [HM(2)]: { status: 400, body: 'bad' } });
    await expect(run(srcHimalayas, req('feed', 'himalayas'), rec)).rejects.toMatchObject({ code: 'invalid_output' });
  });

  it('himalayas: worldwide or anywhere restrictions, and lower-case alpha2, are eligible', () => {
    expect(indiaEligible(['Worldwide'])).toBe(true);
    expect(indiaEligible(['Anywhere'])).toBe(true);
    expect(indiaEligible([{ alpha2: 'in' }])).toBe(true);
  });

  it('jobicy: a job in both answers keeps the apac copy', async () => {
    const job = (geo: string) => ({ id: 7, jobTitle: 'Backend Engineer', companyName: 'Acme', jobGeo: geo });
    const rec = serve({ [JB('apac')]: { body: JSON.stringify({ jobs: [job('APAC')] }) }, [JB('anywhere')]: { body: JSON.stringify({ jobs: [job('Anywhere')] }) } });
    const out = await run(srcJobicy, req('feed', 'jobicy'), rec);
    expect(out).toHaveLength(1);
    expect((out[0]!.raw as { jobGeo: string }).jobGeo).toBe('APAC');
  });
});

describe('src-greenhouse', () => {
  it('returns every fixture job, sorted by sourceId, from one request with the honest headers', async () => {
    const rec = serve({ [GH]: { body: fixture('greenhouse-gitlab') } });
    const out = await run(srcGreenhouse, req('greenhouse', 'gitlab', 'GitLab'), rec);
    const expected = (fixtureJson('greenhouse-gitlab') as { jobs: { id: number }[] }).jobs.map((j) => String(j.id));
    expect(out).toHaveLength(5);
    expect(ids(out)).toEqual(sorted(expected));
    expect(rec.urls).toEqual([GH]);
    expect(new URL(rec.urls[0]!).hostname).toBe('boards-api.greenhouse.io');
    expect(rec.headers[0]).toEqual(HTTP_HEADERS);
    for (const p of out) {
      expect(RawPostingType.schema.safeParse(p).success).toBe(true);
      expect(p).toMatchObject({ source: 'greenhouse', company: 'GitLab', slug: 'gitlab' });
      expect(p.raw).toHaveProperty('updated_at');
      expect(p.raw).toHaveProperty('content');
    }
  });

  it('another ATS → [] with no fetch', async () => {
    const rec = serve({});
    await expect(run(srcGreenhouse, req('lever', 'gitlab'), rec)).resolves.toEqual([]);
    expect(rec.urls).toEqual([]);
  });

  it('a 404 board → invalid_output naming the slug', async () => {
    const rec = serve({});
    await expect(run(srcGreenhouse, req('greenhouse', 'gitlab'), rec)).rejects.toMatchObject({ code: 'invalid_output', message: 'board not found: gitlab' });
  });

  it('another 4xx → invalid_output; a body without jobs → invalid_output', async () => {
    await expect(run(srcGreenhouse, req('greenhouse', 'gitlab'), serve({ [GH]: { status: 403, body: 'no' } }))).rejects.toMatchObject({ code: 'invalid_output' });
    await expect(run(srcGreenhouse, req('greenhouse', 'gitlab'), serve({ [GH]: { body: '{"nope":1}' } }))).rejects.toMatchObject({ code: 'invalid_output' });
  });

  it('skips a malformed job and counts it', () => {
    const json = fixtureJson('greenhouse-gitlab') as { jobs: unknown[] };
    json.jobs.push({ title: 'no id' }, 'not an object', { id: 1, title: 42 });
    const parsed = greenhouseParse(json, req('greenhouse', 'gitlab'));
    expect(parsed.postings).toHaveLength(5);
    expect(parsed.skipped).toHaveLength(3);
  });
});

describe('src-lever', () => {
  it('returns every fixture posting, sorted, from one page', async () => {
    const rec = serve({ [LV(0)]: { body: fixture('lever-veeva') } });
    const out = await run(srcLever, req('lever', 'veeva', 'Veeva'), rec);
    const expected = (fixtureJson('lever-veeva') as { id: string }[]).map((j) => j.id);
    expect(out).toHaveLength(5);
    expect(ids(out)).toEqual(sorted(expected));
    expect(rec.urls).toEqual([LV(0)]);
    expect(new URL(rec.urls[0]!).hostname).toBe('api.lever.co');
    expect(rec.headers[0]).toEqual(HTTP_HEADERS);
    for (const p of out) expect(p).toMatchObject({ source: 'lever', company: 'Veeva', slug: 'veeva' });
  });

  it('drops a salaryRange whose min and max are 0, keeps a real one', () => {
    const parsed = leverParse(
      [
        { id: 'a', text: 'x', salaryRange: { min: 0, max: 0, currency: 'INR', interval: 'per-year-salary' } },
        { id: 'b', text: 'y', salaryRange: { min: 10, max: 20, currency: 'INR', interval: 'per-year-salary' } },
      ],
      req('lever', 'veeva'),
    );
    expect(parsed.postings[0]!.raw).not.toHaveProperty('salaryRange');
    expect(parsed.postings[1]!.raw).toHaveProperty('salaryRange');
  });

  it('another ATS → [] with no fetch; 404 → invalid_output; non-array → invalid_output', async () => {
    const none = serve({});
    await expect(run(srcLever, req('ashby', 'veeva'), none)).resolves.toEqual([]);
    expect(none.urls).toEqual([]);
    await expect(run(srcLever, req('lever', 'veeva'), serve({}))).rejects.toMatchObject({ code: 'invalid_output', message: 'board not found: veeva' });
    await expect(run(srcLever, req('lever', 'veeva'), serve({ [LV(0)]: { body: '{"ok":true}' } }))).rejects.toMatchObject({ code: 'invalid_output' });
  });

  it('skips a malformed posting and counts it', () => {
    const json = fixtureJson('lever-veeva') as unknown[];
    json.push({ text: 'no id' }, null);
    const parsed = leverParse(json, req('lever', 'veeva'));
    expect(parsed.postings).toHaveLength(5);
    expect(parsed.skipped).toHaveLength(2);
  });
});

describe('src-ashby', () => {
  it('returns every fixture job, sorted, from one request', async () => {
    const rec = serve({ [AB]: { body: fixture('ashby-confluent') } });
    const out = await run(srcAshby, req('ashby', 'confluent', 'Confluent'), rec);
    const expected = (fixtureJson('ashby-confluent') as { jobs: { id: string }[] }).jobs.map((j) => j.id);
    expect(out).toHaveLength(5);
    expect(ids(out)).toEqual(sorted(expected));
    expect(rec.urls).toEqual([AB]);
    expect(new URL(rec.urls[0]!).hostname).toBe('api.ashbyhq.com');
    expect(rec.headers[0]).toEqual(HTTP_HEADERS);
    for (const p of out) {
      expect(p).toMatchObject({ source: 'ashby', company: 'Confluent', slug: 'confluent' });
      expect(p.raw).toHaveProperty('compensation');
    }
  });

  it('another ATS → [] with no fetch; 404 → invalid_output', async () => {
    const none = serve({});
    await expect(run(srcAshby, req('greenhouse', 'confluent'), none)).resolves.toEqual([]);
    expect(none.urls).toEqual([]);
    await expect(run(srcAshby, req('ashby', 'confluent'), serve({}))).rejects.toMatchObject({ code: 'invalid_output', message: 'board not found: confluent' });
  });

  it('skips a malformed job and counts it', () => {
    const json = fixtureJson('ashby-confluent') as { jobs: unknown[] };
    json.jobs.push({ id: '', title: 'blank id' });
    const parsed = ashbyParse(json, req('ashby', 'confluent'));
    expect(parsed.postings).toHaveLength(5);
    expect(parsed.skipped).toHaveLength(1);
  });
});

describe('src-himalayas', () => {
  it('keeps worldwide or India-eligible jobs, drops expiryDate, stops at an empty page', async () => {
    const rec = serve({ [HM(1)]: { body: fixture('himalayas') }, [HM(2)]: { body: EMPTY_HM } });
    const out = await run(srcHimalayas, req('feed', 'himalayas', 'ignored'), rec);
    const jobs = (fixtureJson('himalayas') as { jobs: { guid: string; locationRestrictions: string[] }[] }).jobs;
    const kept = jobs.filter((j) => j.locationRestrictions.length === 0 || j.locationRestrictions.includes('India'));
    expect(jobs).toHaveLength(5);
    expect(out).toHaveLength(4);
    expect(ids(out)).toEqual(sorted(kept.map((j) => j.guid)));
    expect(rec.urls).toEqual([HM(1), HM(2)]);
    expect(new URL(rec.urls[0]!).hostname).toBe('himalayas.app');
    expect(rec.headers[0]).toEqual(HTTP_HEADERS);
    for (const p of out) {
      expect(p.source).toBe('himalayas');
      expect(p.slug).toBe('himalayas');
      expect(p.company).toBe((p.raw as { companyName: string }).companyName);
      expect(p.raw).not.toHaveProperty('expiryDate');
      expect(p.raw).toHaveProperty('pubDate');
    }
  });

  it('accepts India, Asia or APAC restrictions as strings or {alpha2, name} objects', () => {
    expect(indiaEligible([])).toBe(true);
    expect(indiaEligible(['India'])).toBe(true);
    expect(indiaEligible(['Asia'])).toBe(true);
    expect(indiaEligible(['APAC'])).toBe(true);
    expect(indiaEligible([{ alpha2: 'IN', name: 'India', slug: 'india' }])).toBe(true);
    expect(indiaEligible(['United States'])).toBe(false);
    expect(indiaEligible([{ alpha2: 'US', name: 'United States' }])).toBe(false);
    expect(indiaEligible(['Indiana'])).toBe(false);
  });

  it('another feed or ATS → [] with no fetch', async () => {
    const rec = serve({});
    await expect(run(srcHimalayas, req('feed', 'jobicy'), rec)).resolves.toEqual([]);
    await expect(run(srcHimalayas, req('greenhouse', 'himalayas'), rec)).resolves.toEqual([]);
    expect(rec.urls).toEqual([]);
  });

  it('404 → invalid_output', async () => {
    await expect(run(srcHimalayas, req('feed', 'himalayas'), serve({}))).rejects.toMatchObject({ code: 'invalid_output', message: 'board not found: himalayas' });
  });

  it('skips a malformed job and counts it', () => {
    const json = fixtureJson('himalayas') as { jobs: unknown[] };
    json.jobs.push({ title: 'no guid', companyName: 'X', locationRestrictions: [] }, { guid: 'g', title: 't', companyName: 'X', locationRestrictions: 'India' });
    const parsed = himalayasParse(json);
    expect(parsed.postings).toHaveLength(4);
    expect(parsed.skipped).toHaveLength(2);
  });
});

describe('src-jobicy', () => {
  it('requests apac then anywhere, dedupes by id, sorts', async () => {
    const rec = serve({ [JB('apac')]: { body: fixture('jobicy-apac') }, [JB('anywhere')]: { body: fixture('jobicy-anywhere') } });
    const out = await run(srcJobicy, req('feed', 'jobicy', 'ignored'), rec);
    const all = [...(fixtureJson('jobicy-apac') as { jobs: { id: number }[] }).jobs, ...(fixtureJson('jobicy-anywhere') as { jobs: { id: number }[] }).jobs].map((j) => String(j.id));
    const unique = [...new Set(all)];
    expect(all.length).toBeGreaterThan(unique.length);
    expect(out).toHaveLength(unique.length);
    expect(ids(out)).toEqual(sorted(unique));
    expect(rec.urls).toEqual([JB('apac'), JB('anywhere')]);
    for (const u of rec.urls) expect(new URL(u).hostname).toBe('jobicy.com');
    for (const h of rec.headers) expect(h).toEqual(HTTP_HEADERS);
    for (const p of out) {
      expect(p).toMatchObject({ source: 'jobicy', slug: 'jobicy' });
      expect(p.company).toBe((p.raw as { companyName: string }).companyName);
    }
  });

  it('another feed or ATS → [] with no fetch', async () => {
    const rec = serve({});
    await expect(run(srcJobicy, req('feed', 'himalayas'), rec)).resolves.toEqual([]);
    await expect(run(srcJobicy, req('lever', 'jobicy'), rec)).resolves.toEqual([]);
    expect(rec.urls).toEqual([]);
  });

  it('404 → invalid_output', async () => {
    await expect(run(srcJobicy, req('feed', 'jobicy'), serve({}))).rejects.toMatchObject({ code: 'invalid_output', message: 'board not found: jobicy' });
  });

  it('skips a malformed job and counts it', () => {
    const json = fixtureJson('jobicy-apac') as { jobs: unknown[] };
    json.jobs.push({ id: 1, jobTitle: 'no company' });
    const parsed = jobicyParse(json);
    expect(parsed.postings).toHaveLength(5);
    expect(parsed.skipped).toHaveLength(1);
  });
});

describe('paging: no silent truncation', () => {
  const pad = (n: number) => String(n).padStart(6, '0');
  const leverPage = (from: number, n: number) => JSON.stringify(Array.from({ length: n }, (_, i) => ({ id: `id-${pad(from + i)}`, text: 'Backend Engineer' })));
  const hmJob = (n: number) => ({ guid: `https://himalayas.app/j/${pad(n)}`, title: 'Backend Engineer', companyName: 'Acme', locationRestrictions: [] });
  const hmPage = (from: number, n: number) => JSON.stringify({ jobs: Array.from({ length: n }, (_, i) => hmJob(from + i)) });
  const jbPage = (ids: number[], hasMore: boolean, nextCursor: string | null) =>
    JSON.stringify({ hasMore, nextCursor, jobs: ids.map((id) => ({ id, jobTitle: 'Backend Engineer', companyName: 'Acme' })) });
  const range = (from: number, n: number) => Array.from({ length: n }, (_, i) => from + i);

  /** A fake fetch computing each answer from the URL. */
  function dyn(answer: (url: URL) => { status?: number; body: string }): Recorder {
    const urls: string[] = [];
    const headers: Readonly<Record<string, string>>[] = [];
    const fetch: FetchLike = async (url, init) => {
      urls.push(url);
      headers.push(init.headers);
      const a = answer(new URL(url));
      return { status: a.status ?? 200, text: async () => a.body };
    };
    return { fetch, urls, headers };
  }

  it('every paged source has at least 9 s of step time per request at its cap', () => {
    expect(LEVER_MAX_PAGES).toBe(100);
    expect(HIMALAYAS_MAX_PAGES).toBe(80);
    expect(JOBICY_MAX_REQUESTS).toBe(20);
    expect(srcLever.contract.timeoutMs / LEVER_MAX_PAGES).toBeGreaterThanOrEqual(9_000);
    expect(srcHimalayas.contract.timeoutMs / HIMALAYAS_MAX_PAGES).toBeGreaterThanOrEqual(9_000);
    expect(srcJobicy.contract.timeoutMs / JOBICY_MAX_REQUESTS).toBeGreaterThanOrEqual(9_000);
  });

  describe('lever', () => {
    it('natural end: pages with skip/limit until a short page', async () => {
      const rec = serve({ [LV(0)]: { body: leverPage(0, 100) }, [LV(100)]: { body: leverPage(100, 100) }, [LV(200)]: { body: leverPage(200, 3) } });
      const out = await run(srcLever, req('lever', 'veeva'), rec);
      expect(rec.urls).toEqual([LV(0), LV(100), LV(200)]);
      expect(out).toHaveLength(203);
      expect(ids(out)).toEqual(sorted(ids(out)));
    });

    it('exact page boundary: a full page then an empty page ends cleanly', async () => {
      const rec = serve({ [LV(0)]: { body: leverPage(0, 100) }, [LV(100)]: { body: '[]' } });
      await expect(run(srcLever, req('lever', 'veeva'), rec)).resolves.toHaveLength(100);
      expect(rec.urls).toEqual([LV(0), LV(100)]);
    });

    it('cap hit before a natural end → invalid_output, never a partial', async () => {
      const rec = dyn((u) => ({ body: leverPage(Number(u.searchParams.get('skip')), 100) }));
      await expect(run(srcLever, req('lever', 'veeva'), rec)).rejects.toMatchObject({
        code: 'invalid_output',
        message: 'lever veeva: page cap reached at 10000 postings',
      });
      expect(rec.urls).toHaveLength(LEVER_MAX_PAGES);
    });

    it('a repeated page (the API ignores skip) → invalid_output after two requests', async () => {
      const rec = dyn(() => ({ body: leverPage(0, 100) }));
      await expect(run(srcLever, req('lever', 'veeva'), rec)).rejects.toMatchObject({ code: 'invalid_output', message: 'lever veeva: page 2 repeats page 1' });
      expect(rec.urls).toHaveLength(2);
    });

    it('a posting on two pages (the board shifted) is kept once, first copy wins', async () => {
      const second = JSON.parse(leverPage(100, 3)) as { id: string; text: string }[];
      second.splice(1, 0, { id: 'id-000050', text: 'moved' });
      const rec = serve({ [LV(0)]: { body: leverPage(0, 100) }, [LV(100)]: { body: JSON.stringify(second) } });
      const out = await run(srcLever, req('lever', 'veeva'), rec);
      expect(out).toHaveLength(103);
      expect((out.find((p) => p.sourceId === 'id-000050')!.raw as { text: string }).text).toBe('Backend Engineer');
    });
  });

  describe('himalayas', () => {
    it('natural end: a short page is not the end, an empty page is', async () => {
      const rec = serve({ [HM(1)]: { body: hmPage(0, 20) }, [HM(2)]: { body: hmPage(20, 19) }, [HM(3)]: { body: EMPTY_HM } });
      const out = await run(srcHimalayas, req('feed', 'himalayas'), rec);
      expect(rec.urls).toEqual([HM(1), HM(2), HM(3)]);
      expect(out).toHaveLength(39);
      expect(ids(out)).toEqual(sorted(ids(out)));
    });

    it('exact page boundary: full pages then an empty page end cleanly', async () => {
      const rec = serve({ [HM(1)]: { body: hmPage(0, 20) }, [HM(2)]: { body: hmPage(20, 20) }, [HM(3)]: { body: EMPTY_HM } });
      await expect(run(srcHimalayas, req('feed', 'himalayas'), rec)).resolves.toHaveLength(40);
      expect(rec.urls).toHaveLength(3);
    });

    it('cap hit before a natural end → invalid_output', async () => {
      const rec = dyn((u) => ({ body: hmPage((Number(u.searchParams.get('page')) - 1) * 20, 20) }));
      await expect(run(srcHimalayas, req('feed', 'himalayas'), rec)).rejects.toMatchObject({
        code: 'invalid_output',
        message: 'himalayas himalayas: page cap reached at 1600 postings',
      });
      expect(rec.urls).toHaveLength(HIMALAYAS_MAX_PAGES);
    });

    it('a repeated page → invalid_output after two requests', async () => {
      const rec = dyn(() => ({ body: hmPage(0, 20) }));
      await expect(run(srcHimalayas, req('feed', 'himalayas'), rec)).rejects.toMatchObject({ code: 'invalid_output', message: 'himalayas himalayas: page 2 repeats page 1' });
      expect(rec.urls).toHaveLength(2);
    });

    it('a repeated page is judged on every job, not only the India-eligible ones', async () => {
      const elsewhere = (from: number) => JSON.stringify({ jobs: range(from, 20).map((n) => ({ ...hmJob(n), locationRestrictions: ['United States'] })) });
      const rec = serve({ [HM(1)]: { body: elsewhere(0) }, [HM(2)]: { body: elsewhere(20) }, [HM(3)]: { body: EMPTY_HM } });
      await expect(run(srcHimalayas, req('feed', 'himalayas'), rec)).resolves.toEqual([]);
      expect(rec.urls).toHaveLength(3);
    });
  });

  describe('jobicy', () => {
    it('natural end: follows nextCursor while hasMore, then the next geo', async () => {
      const rec = serve({
        [JB('apac')]: { body: jbPage([1, 2], true, 'c1') },
        [JB('apac', 'c1')]: { body: jbPage([3], false, null) },
        [JB('anywhere')]: { body: jbPage([2, 4], false, null) },
      });
      const out = await run(srcJobicy, req('feed', 'jobicy'), rec);
      expect(rec.urls).toEqual([JB('apac'), JB('apac', 'c1'), JB('anywhere')]);
      expect(ids(out)).toEqual(['1', '2', '3', '4']);
    });

    it('exact page boundary: hasMore then an empty last page ends cleanly', async () => {
      const rec = serve({
        [JB('apac')]: { body: jbPage([1, 2], true, 'c1') },
        [JB('apac', 'c1')]: { body: jbPage([], false, null) },
        [JB('anywhere')]: { body: jbPage([], false, null) },
      });
      await expect(run(srcJobicy, req('feed', 'jobicy'), rec)).resolves.toHaveLength(2);
      expect(rec.urls).toHaveLength(3);
    });

    it('cap hit before a natural end → invalid_output', async () => {
      const rec = dyn((u) => {
        const n = Number(u.searchParams.get('cursor')?.slice(1) ?? '0');
        return { body: jbPage(range(n * 10, 10), true, `c${n + 1}`) };
      });
      await expect(run(srcJobicy, req('feed', 'jobicy'), rec)).rejects.toMatchObject({
        code: 'invalid_output',
        message: 'jobicy jobicy: request cap reached at 200 postings',
      });
      expect(rec.urls).toHaveLength(JOBICY_MAX_REQUESTS);
    });

    it('a repeated page → invalid_output after two requests', async () => {
      let n = 0;
      const rec = dyn(() => ({ body: jbPage([1, 2, 3], true, `c${++n}`) }));
      await expect(run(srcJobicy, req('feed', 'jobicy'), rec)).rejects.toMatchObject({ code: 'invalid_output', message: 'jobicy jobicy: apac page 2 repeats page 1' });
      expect(rec.urls).toHaveLength(2);
    });

    it('hasMore without a nextCursor → invalid_output (the rest cannot be fetched)', async () => {
      const rec = serve({ [JB('apac')]: { body: jbPage([1], true, null) } });
      await expect(run(srcJobicy, req('feed', 'jobicy'), rec)).rejects.toMatchObject({ code: 'invalid_output', message: 'jobicy jobicy: apac page 1 says hasMore but gives no nextCursor' });
    });
  });
});
