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
const HM = (page: number) => `https://himalayas.app/jobs/api/search?q=backend&country=IN&sort=recent&page=${page}`;
const JB = (geo: string, cursor?: string) =>
  `https://jobicy.com/api/v2/remote-jobs?count=50&geo=${geo}&tag=backend${cursor === undefined ? '' : `&cursor=${encodeURIComponent(cursor)}`}`;
/** The end page after the trimmed fixture (5 jobs; its totalCount is set to 5 to match the trim). */
const EMPTY_HM = JSON.stringify({ offset: 20, limit: 20, totalCount: 5, jobs: [] });

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
    const rec = serve({ [JB('apac')]: { body: JSON.stringify({ hasMore: false, jobs: [job('APAC')] }) }, [JB('anywhere')]: { body: JSON.stringify({ hasMore: false, jobs: [job('Anywhere')] }) } });
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
  it('returns every fixture posting, sorted; a short page is confirmed by an empty next page', async () => {
    const rec = serve({ [LV(0)]: { body: fixture('lever-veeva') }, [LV(100)]: { body: '[]' } });
    const out = await run(srcLever, req('lever', 'veeva', 'Veeva'), rec);
    const expected = (fixtureJson('lever-veeva') as { id: string }[]).map((j) => j.id);
    expect(out).toHaveLength(5);
    expect(ids(out)).toEqual(sorted(expected));
    expect(rec.urls).toEqual([LV(0), LV(100)]);
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
  const range = (from: number, n: number) => Array.from({ length: n }, (_, i) => from + i);
  const leverJobs = (from: number, n: number) => range(from, n).map((k) => ({ id: `id-${pad(k)}`, text: 'Backend Engineer' }));
  const leverPage = (from: number, n: number) => JSON.stringify(leverJobs(from, n));
  const hmJob = (n: number, where: string[] = []) => ({ guid: `https://himalayas.app/j/${pad(n)}`, title: 'Backend Engineer', companyName: 'Acme', locationRestrictions: where });
  /** A Himalayas search page: `jobs` sit at `offset` in a result set of `total`. */
  const hmPage = (offset: number, jobs: unknown[], total: number, limit = 20) => JSON.stringify({ offset, limit, totalCount: total, jobs });
  const hmFull = (page: number, total: number, n = 20) => hmPage((page - 1) * 20, range((page - 1) * 20, n).map((k) => hmJob(k)), total);
  const jbPage = (ids: number[], hasMore: unknown, nextCursor: string | null, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ ...extra, hasMore, nextCursor, jobs: ids.map((id) => ({ id, jobTitle: 'Backend Engineer', companyName: 'Acme' })) });

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

  it('every paged source has at least 9 s of step time per page at its cap', () => {
    expect(LEVER_MAX_PAGES).toBe(70);
    expect(HIMALAYAS_MAX_PAGES).toBe(80);
    expect(JOBICY_MAX_REQUESTS).toBe(20);
    expect(srcLever.contract.timeoutMs / LEVER_MAX_PAGES).toBeGreaterThanOrEqual(9_000);
    expect(srcHimalayas.contract.timeoutMs / HIMALAYAS_MAX_PAGES).toBeGreaterThanOrEqual(9_000);
    expect(srcJobicy.contract.timeoutMs / JOBICY_MAX_REQUESTS).toBeGreaterThanOrEqual(9_000);
  });

  describe('lever', () => {
    const veeva = req('lever', 'veeva');

    it('natural end: a short page, then an empty page confirming it', async () => {
      const rec = serve({ [LV(0)]: { body: leverPage(0, 100) }, [LV(100)]: { body: leverPage(100, 100) }, [LV(200)]: { body: leverPage(200, 3) }, [LV(300)]: { body: '[]' } });
      const out = await run(srcLever, veeva, rec);
      expect(rec.urls).toEqual([LV(0), LV(100), LV(200), LV(300)]);
      expect(out).toHaveLength(203);
      expect(ids(out)).toEqual(sorted(ids(out)));
    });

    it('a board size that is an exact multiple of 100: the empty page after a full one is re-requested once, then accepted', async () => {
      const rec = serve({ [LV(0)]: { body: leverPage(0, 100) }, [LV(100)]: { body: leverPage(100, 100) }, [LV(200)]: { body: '[]' } });
      await expect(run(srcLever, veeva, rec)).resolves.toHaveLength(200);
      expect(rec.urls).toEqual([LV(0), LV(100), LV(200), LV(200)]);
    });

    it('a spurious empty page after a full one → the re-request is non-empty → invalid_output', async () => {
      let calls = 0;
      const rec = dyn((u) => {
        const skip = Number(u.searchParams.get('skip'));
        if (skip === 300 && calls++ === 0) return { body: '[]' };
        return { body: skip < 937 ? leverPage(skip, Math.min(100, 937 - skip)) : '[]' };
      });
      await expect(run(srcLever, veeva, rec)).rejects.toMatchObject({ code: 'invalid_output', message: 'lever veeva: empty page at skip 300 after a full page was not empty on re-request' });
      expect(rec.urls).toEqual([LV(0), LV(100), LV(200), LV(300), LV(300)]);
    });

    it('an empty page after a short page is the end without a re-request', async () => {
      const rec = serve({ [LV(0)]: { body: leverPage(0, 100) }, [LV(100)]: { body: leverPage(100, 1) }, [LV(200)]: { body: '[]' } });
      await expect(run(srcLever, veeva, rec)).resolves.toHaveLength(101);
      expect(rec.urls).toEqual([LV(0), LV(100), LV(200)]);
    });

    it('an empty board is one request', async () => {
      const rec = serve({ [LV(0)]: { body: '[]' } });
      await expect(run(srcLever, veeva, rec)).resolves.toEqual([]);
      expect(rec.urls).toEqual([LV(0)]);
    });

    it('a short page mid-walk (more follows) → invalid_output', async () => {
      const rec = serve({ [LV(0)]: { body: leverPage(0, 100) }, [LV(100)]: { body: leverPage(100, 37) }, [LV(200)]: { body: leverPage(200, 100) } });
      await expect(run(srcLever, veeva, rec)).rejects.toMatchObject({ code: 'invalid_output', message: 'lever veeva: short page before end' });
    });

    it('a server that clamps the page size → invalid_output, not the first page only', async () => {
      const rec = dyn((u) => ({ body: leverPage(Number(u.searchParams.get('skip')), 50) }));
      await expect(run(srcLever, veeva, rec)).rejects.toMatchObject({ code: 'invalid_output', message: 'lever veeva: short page before end' });
      expect(rec.urls).toEqual([LV(0), LV(100)]);
    });

    it('exactly at the cap: one more request confirms the end, so no false alarm', async () => {
      const rec = dyn((u) => {
        const skip = Number(u.searchParams.get('skip'));
        return { body: skip < 7_000 ? leverPage(skip, 100) : '[]' };
      });
      await expect(run(srcLever, veeva, rec)).resolves.toHaveLength(7_000);
      expect(rec.urls).toHaveLength(LEVER_MAX_PAGES + 2);
    });

    it('past the cap → invalid_output, never a partial', async () => {
      const rec = dyn((u) => ({ body: leverPage(Number(u.searchParams.get('skip')), 100) }));
      await expect(run(srcLever, veeva, rec)).rejects.toMatchObject({ code: 'invalid_output', message: 'lever veeva: page cap reached at 7000 postings' });
      expect(rec.urls).toHaveLength(LEVER_MAX_PAGES + 1);
    });

    it('a repeated page (the API ignores skip) → invalid_output after two requests', async () => {
      const rec = dyn(() => ({ body: leverPage(0, 100) }));
      await expect(run(srcLever, veeva, rec)).rejects.toMatchObject({ code: 'invalid_output', message: 'lever veeva: page 2 repeats earlier postings' });
      expect(rec.urls).toHaveLength(2);
    });

    it('an A, B, A cycle → invalid_output on the third request', async () => {
      const rec = dyn((u) => ({ body: leverPage((Number(u.searchParams.get('skip')) / 100) % 2 === 0 ? 0 : 100, 100) }));
      await expect(run(srcLever, veeva, rec)).rejects.toMatchObject({ code: 'invalid_output', message: 'lever veeva: page 3 repeats earlier postings' });
      expect(rec.urls).toHaveLength(3);
    });

    it('a posting on two pages (the board shifted) is kept once, first copy wins', async () => {
      const second = leverJobs(100, 3) as { id: string; text: string }[];
      second.splice(1, 0, { id: 'id-000050', text: 'moved' });
      const rec = serve({ [LV(0)]: { body: leverPage(0, 100) }, [LV(100)]: { body: JSON.stringify(second) }, [LV(200)]: { body: '[]' } });
      const out = await run(srcLever, veeva, rec);
      expect(out).toHaveLength(103);
      expect((out.find((p) => p.sourceId === 'id-000050')!.raw as { text: string }).text).toBe('Backend Engineer');
    });
  });

  describe('himalayas', () => {
    const feed = req('feed', 'himalayas');

    it('a total that drops to 0 mid-walk (ending the walk early) → invalid_output', async () => {
      const rec = serve({ [HM(1)]: { body: hmFull(1, 842) }, [HM(2)]: { body: hmFull(2, 842) }, [HM(3)]: { body: hmPage(40, [], 0) } });
      await expect(run(srcHimalayas, feed, rec)).rejects.toMatchObject({ code: 'invalid_output', message: 'himalayas himalayas: totalCount fell from 842 to 0 during the walk' });
    });

    it('a total that moves by one between pages (seen live) is fine', async () => {
      const rec = serve({ [HM(1)]: { body: hmFull(1, 41) }, [HM(2)]: { body: hmFull(2, 40) }, [HM(3)]: { body: hmPage(40, [], 40) } });
      await expect(run(srcHimalayas, feed, rec)).resolves.toHaveLength(40);
    });

    it('pages of 1 job each → invalid_output on the first such page', async () => {
      const rec = dyn((u) => {
        const page = Number(u.searchParams.get('page'));
        return { body: page === 1 ? hmFull(1, 842) : hmFull(page, 842, 1) };
      });
      await expect(run(srcHimalayas, feed, rec)).rejects.toMatchObject({ code: 'invalid_output', message: 'himalayas himalayas: page 2 brought 1 new jobs, minimum 10' });
      expect(rec.urls).toHaveLength(2);
    });

    it('19 duplicates plus 1 new job → invalid_output', async () => {
      const page2 = hmPage(20, [...range(1, 19).map((k) => hmJob(k)), hmJob(500)], 842);
      const rec = serve({ [HM(1)]: { body: hmFull(1, 842) }, [HM(2)]: { body: page2 } });
      await expect(run(srcHimalayas, feed, rec)).rejects.toMatchObject({ code: 'invalid_output', message: 'himalayas himalayas: page 2 brought 1 new jobs, minimum 10' });
    });

    it('live-like shortfall (pages short by 1 to 4, 1.8% missing overall) passes', async () => {
      const short = new Map([[2, 19], [7, 19], [9, 19], [10, 19], [23, 19], [26, 18], [27, 19], [29, 19], [30, 19], [38, 19], [42, 16]]);
      const rec = dyn((u) => {
        const page = Number(u.searchParams.get('page'));
        if (page === 43) return { body: hmFull(43, 842, 2) };
        if (page >= 44) return { body: hmPage((page - 1) * 20, [], 842) };
        return { body: hmFull(page, 842, short.get(page) ?? 20) };
      });
      await expect(run(srcHimalayas, feed, rec)).resolves.toHaveLength(827);
      expect(rec.urls).toHaveLength(44);
    });

    it('fewer than 95% of totalCount unique overall → invalid_output', async () => {
      // every page passes the per-page floor (16 new of 20) but the walk ends 80% complete
      const rec = dyn((u) => {
        const page = Number(u.searchParams.get('page'));
        if (page > 5) return { body: hmPage((page - 1) * 20, [], 100) };
        return { body: hmFull(page, 100, 16) };
      });
      await expect(run(srcHimalayas, feed, rec)).rejects.toMatchObject({ code: 'invalid_output', message: 'himalayas himalayas: 80 unique jobs for totalCount 100 (minimum 95%)' });
    });

    it('natural end: short pages mid-list are fine, the end is an empty page at offset ≥ totalCount', async () => {
      const rec = serve({ [HM(1)]: { body: hmFull(1, 39) }, [HM(2)]: { body: hmFull(2, 39, 19) }, [HM(3)]: { body: hmPage(40, [], 39) } });
      const out = await run(srcHimalayas, feed, rec);
      expect(rec.urls).toEqual([HM(1), HM(2), HM(3)]);
      expect(out).toHaveLength(39);
      expect(ids(out)).toEqual(sorted(ids(out)));
    });

    it('server drops some slots (short pages) yet every offset window is visited', async () => {
      const rec = serve({ [HM(1)]: { body: hmFull(1, 60, 18) }, [HM(2)]: { body: hmFull(2, 60, 20) }, [HM(3)]: { body: hmFull(3, 60, 19) }, [HM(4)]: { body: hmPage(60, [], 60) } });
      await expect(run(srcHimalayas, feed, rec)).resolves.toHaveLength(57);
      expect(rec.urls).toHaveLength(4);
    });

    it('exact page boundary: full pages, then an empty page', async () => {
      const rec = serve({ [HM(1)]: { body: hmFull(1, 40) }, [HM(2)]: { body: hmFull(2, 40) }, [HM(3)]: { body: hmPage(40, [], 40) } });
      await expect(run(srcHimalayas, feed, rec)).resolves.toHaveLength(40);
      expect(rec.urls).toHaveLength(3);
    });

    it('a transient empty page before totalCount → invalid_output', async () => {
      const rec = serve({ [HM(1)]: { body: hmFull(1, 100) }, [HM(2)]: { body: hmPage(20, [], 100) } });
      await expect(run(srcHimalayas, feed, rec)).rejects.toMatchObject({ code: 'invalid_output', message: 'himalayas himalayas: empty page 2 at offset 20 before totalCount 100' });
    });

    it('an empty page 1 while totalCount > 0 → invalid_output', async () => {
      const rec = serve({ [HM(1)]: { body: hmPage(0, [], 711) } });
      await expect(run(srcHimalayas, feed, rec)).rejects.toMatchObject({ code: 'invalid_output', message: 'himalayas himalayas: empty page 1 at offset 0 before totalCount 711' });
    });

    it('an empty page 1 with totalCount 0 is an empty feed', async () => {
      await expect(run(srcHimalayas, feed, serve({ [HM(1)]: { body: hmPage(0, [], 0) } }))).resolves.toEqual([]);
    });

    it('a missing totalCount, offset or limit → invalid_output', async () => {
      for (const body of [JSON.stringify({ offset: 0, limit: 20, jobs: [hmJob(1)] }), JSON.stringify({ limit: 20, totalCount: 1, jobs: [hmJob(1)] }), JSON.stringify({ offset: 0, totalCount: 1, jobs: [hmJob(1)] })]) {
        await expect(run(srcHimalayas, feed, serve({ [HM(1)]: { body } })), body).rejects.toMatchObject({ code: 'invalid_output', message: 'himalayas himalayas: page 1 has no numeric offset, limit or totalCount' });
      }
    });

    it('a page whose offset does not follow the previous window → invalid_output', async () => {
      const rec = serve({ [HM(1)]: { body: hmFull(1, 100) }, [HM(2)]: { body: hmPage(40, range(40, 20).map((k) => hmJob(k)), 100) } });
      await expect(run(srcHimalayas, feed, rec)).rejects.toMatchObject({ code: 'invalid_output', message: 'himalayas himalayas: page 2 starts at offset 40, expected 20' });
    });

    it('exactly at the cap: one more request confirms the end', async () => {
      const total = HIMALAYAS_MAX_PAGES * 20;
      const rec = dyn((u) => {
        const page = Number(u.searchParams.get('page'));
        return { body: page <= HIMALAYAS_MAX_PAGES ? hmFull(page, total) : hmPage((page - 1) * 20, [], total) };
      });
      await expect(run(srcHimalayas, feed, rec)).resolves.toHaveLength(total);
      expect(rec.urls).toHaveLength(HIMALAYAS_MAX_PAGES + 1);
    });

    it('past the cap → invalid_output', async () => {
      const rec = dyn((u) => ({ body: hmFull(Number(u.searchParams.get('page')), 100_000) }));
      await expect(run(srcHimalayas, feed, rec)).rejects.toMatchObject({ code: 'invalid_output', message: 'himalayas himalayas: page cap reached at 1600 postings' });
      expect(rec.urls).toHaveLength(HIMALAYAS_MAX_PAGES + 1);
    });

    it('a repeated page → invalid_output after two requests, even when nothing is eligible', async () => {
      const page = hmPage(0, range(0, 20).map((k) => hmJob(k, ['United States'])), 1000);
      const rec = dyn((u) => ({ body: page.replace('"offset":0', `"offset":${(Number(u.searchParams.get('page')) - 1) * 20}`) }));
      await expect(run(srcHimalayas, feed, rec)).rejects.toMatchObject({ code: 'invalid_output', message: 'himalayas himalayas: page 2 repeats earlier postings' });
      expect(rec.urls).toHaveLength(2);
    });

    it('an A, B, A cycle → invalid_output on the third request', async () => {
      const rec = dyn((u) => {
        const page = Number(u.searchParams.get('page'));
        const from = page % 2 === 1 ? 0 : 20;
        return { body: hmPage((page - 1) * 20, range(from, 20).map((k) => hmJob(k)), 1000) };
      });
      await expect(run(srcHimalayas, feed, rec)).rejects.toMatchObject({ code: 'invalid_output', message: 'himalayas himalayas: page 3 repeats earlier postings' });
      expect(rec.urls).toHaveLength(3);
    });

    it('jobs restricted elsewhere count as seen, not lost', async () => {
      const elsewhere = (page: number) => hmPage((page - 1) * 20, range((page - 1) * 20, 20).map((k) => hmJob(k, ['United States'])), 40);
      const rec = serve({ [HM(1)]: { body: elsewhere(1) }, [HM(2)]: { body: elsewhere(2) }, [HM(3)]: { body: hmPage(40, [], 40) } });
      await expect(run(srcHimalayas, feed, rec)).resolves.toEqual([]);
      expect(rec.urls).toHaveLength(3);
    });
  });

  describe('jobicy', () => {
    const feed = req('feed', 'jobicy');

    it('natural end: follows nextCursor while hasMore, then the next geo', async () => {
      const rec = serve({
        [JB('apac')]: { body: jbPage([1, 2], true, 'c1') },
        [JB('apac', 'c1')]: { body: jbPage([3], false, null) },
        [JB('anywhere')]: { body: jbPage([2, 4], false, null) },
      });
      const out = await run(srcJobicy, feed, rec);
      expect(rec.urls).toEqual([JB('apac'), JB('apac', 'c1'), JB('anywhere')]);
      expect(ids(out)).toEqual(['1', '2', '3', '4']);
    });

    it('exact page boundary: hasMore, then an empty last page', async () => {
      const rec = serve({
        [JB('apac')]: { body: jbPage([1, 2], true, 'c1') },
        [JB('apac', 'c1')]: { body: jbPage([], false, null) },
        [JB('anywhere')]: { body: jbPage([], false, null) },
      });
      await expect(run(srcJobicy, feed, rec)).resolves.toHaveLength(2);
      expect(rec.urls).toHaveLength(3);
    });

    it('a missing or non-boolean hasMore → invalid_output', async () => {
      for (const hasMore of [undefined, 'false', 0, null]) {
        const rec = serve({ [JB('apac')]: { body: jbPage([1], hasMore, null) } });
        await expect(run(srcJobicy, feed, rec), String(hasMore)).rejects.toMatchObject({ code: 'invalid_output', message: 'jobicy jobicy: apac page 1 has no boolean hasMore' });
      }
    });

    it('a jobCount that disagrees with the jobs on the page → invalid_output', async () => {
      const rec = serve({ [JB('apac')]: { body: jbPage([1, 2], false, null, { jobCount: 3 }) } });
      await expect(run(srcJobicy, feed, rec)).rejects.toMatchObject({ code: 'invalid_output', message: 'jobicy jobicy: apac page 1 jobCount 3 but 2 jobs' });
    });

    it('hasMore without a nextCursor → invalid_output (the rest cannot be fetched)', async () => {
      const rec = serve({ [JB('apac')]: { body: jbPage([1], true, null) } });
      await expect(run(srcJobicy, feed, rec)).rejects.toMatchObject({ code: 'invalid_output', message: 'jobicy jobicy: apac page 1 says hasMore but gives no nextCursor' });
    });

    it('exactly at the cap: one more request confirms the end', async () => {
      // apac: 19 pages with hasMore, then the 20th request says hasMore; the 21st (confirming) is empty. anywhere would need a 22nd → cap.
      const rec = dyn((u) => {
        const n = Number(u.searchParams.get('cursor')?.slice(1) ?? '0');
        return { body: n < 20 ? jbPage(range(n * 10, 10), true, `c${n + 1}`) : jbPage([], false, null) };
      });
      await expect(run(srcJobicy, feed, rec)).rejects.toMatchObject({ code: 'invalid_output', message: 'jobicy jobicy: request cap reached at 200 postings' });
      expect(rec.urls).toHaveLength(JOBICY_MAX_REQUESTS + 1);
      const single = dyn((u) => {
        const geo = u.searchParams.get('geo');
        const n = Number(u.searchParams.get('cursor')?.slice(1) ?? '0');
        if (geo === 'anywhere') return { body: jbPage([], false, null) };
        return { body: n < 18 ? jbPage(range(n * 10, 10), true, `c${n + 1}`) : n === 18 ? jbPage(range(180, 10), true, 'c19') : jbPage([], false, null) };
      });
      await expect(run(srcJobicy, feed, single)).resolves.toHaveLength(190);
      expect(single.urls).toHaveLength(21);
    });

    it('past the cap → invalid_output', async () => {
      const rec = dyn((u) => {
        const n = Number(u.searchParams.get('cursor')?.slice(1) ?? '0');
        return { body: jbPage(range(n * 10, 10), true, `c${n + 1}`) };
      });
      await expect(run(srcJobicy, feed, rec)).rejects.toMatchObject({ code: 'invalid_output', message: 'jobicy jobicy: request cap reached at 200 postings' });
      expect(rec.urls).toHaveLength(JOBICY_MAX_REQUESTS + 1);
    });

    it('a repeated page → invalid_output after two requests', async () => {
      let n = 0;
      const rec = dyn(() => ({ body: jbPage([1, 2, 3], true, `c${++n}`) }));
      await expect(run(srcJobicy, feed, rec)).rejects.toMatchObject({ code: 'invalid_output', message: 'jobicy jobicy: apac page 2 repeats earlier postings' });
      expect(rec.urls).toHaveLength(2);
    });

    it('an A, B, A cycle → invalid_output on the third request', async () => {
      let n = 0;
      const rec = dyn(() => {
        n++;
        return { body: jbPage(n % 2 === 1 ? [1, 2] : [3, 4], true, `c${n}`) };
      });
      await expect(run(srcJobicy, feed, rec)).rejects.toMatchObject({ code: 'invalid_output', message: 'jobicy jobicy: apac page 3 repeats earlier postings' });
      expect(rec.urls).toHaveLength(3);
    });

    it('the anywhere geo may repeat apac jobs (seen ids are per geo)', async () => {
      const rec = serve({ [JB('apac')]: { body: jbPage([1, 2], false, null) }, [JB('anywhere')]: { body: jbPage([1, 2], false, null) } });
      await expect(run(srcJobicy, feed, rec)).resolves.toHaveLength(2);
    });
  });
});
