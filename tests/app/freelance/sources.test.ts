import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { GigRequest, RawGig } from '../../../src/app/freelance/types.js';
import { GigRequest as GigRequestType, RawGig as RawGigType } from '../../../src/app/freelance/types.js';
import { mergeGigs } from '../../../src/app/freelance/sources/common.js';
import { freelancerUrl, srcFreelancer } from '../../../src/app/freelance/sources/freelancer.js';
import { srcRemotive } from '../../../src/app/freelance/sources/remotive.js';
import { srcHn } from '../../../src/app/freelance/sources/hn.js';
import { srcBoardContracts } from '../../../src/app/freelance/sources/board-contracts.js';
import { offlineProviders } from '../../../src/app/offline.js';
import type { Agent } from '../../../src/kernel/agent.js';
import { issueContext } from '../../../src/kernel/broker.js';
import { fixedClock } from '../../../src/kernel/clock.js';
import { PRODUCT_POLICY_V1 } from '../../../src/kernel/policy.js';
import type { FetchLike } from '../../../src/kernel/providers.js';
import { Posting } from '../../../src/app/types.js';

const dir = (name: string): string => new URL(`../../fixtures/freelance/${name}`, import.meta.url).pathname;
const read = (name: string): unknown => JSON.parse(readFileSync(`${dir(name)}`, 'utf8'));

const req = (platform: GigRequest['platform'], query = '', extra: Partial<GigRequest> = {}): GigRequest => ({ platform, query, runDate: '2026-10-12', half: 'am', ...extra });

interface Run {
  readonly gigs: readonly RawGig[];
  readonly skips: readonly string[];
}

async function runWith(agent: Agent<GigRequest, RawGig>, r: GigRequest, fetch: FetchLike): Promise<Run> {
  const ctx = issueContext({
    contract: agent.contract,
    policy: PRODUCT_POLICY_V1,
    inputClass: 'P0',
    providers: { fetch },
    clock: fixedClock('2026-10-12T00:00:00Z'),
    signal: new AbortController().signal,
  });
  const gigs = await agent.run(r, ctx);
  return { gigs, skips: ctx.skips() };
}

const offline = (name: string) => offlineProviders(dir(name)).fetch;

/** A fake fetch serving exact URLs with exact bodies; anything else is a 404. */
function serve(routes: Record<string, string>): FetchLike & { calls: string[] } {
  const calls: string[] = [];
  const fetch = async (url: string) => {
    calls.push(url);
    const body = routes[url];
    return body === undefined ? { status: 404, text: async () => 'Not Found' } : { status: 200, text: async () => body };
  };
  return Object.assign(fetch, { calls });
}

const ids = (gs: readonly RawGig[]): string[] => gs.map((g) => g.sourceId);
const sorted = (xs: readonly string[]): string[] => [...xs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
const HN = 'https://hn.algolia.com/api/v1';
const HN_FREELANCER_SEARCH = `${HN}/search_by_date?query=%22Seeking%20freelancer%22&tags=story`;
const HN_HIRING_SEARCH = `${HN}/search_by_date?tags=story,author_whoishiring`;

describe('gig source contracts', () => {
  it.each([
    [srcFreelancer, 'src-freelancer', 'www.freelancer.com', 'io'],
    [srcRemotive, 'src-remotive', 'remotive.com', 'io'],
    [srcHn, 'src-hn', 'hn.algolia.com', 'io'],
  ])('%#: id, team, skill, kind, egress, retry', (agent, id, host, kind) => {
    const c = agent.contract;
    expect(c.id).toBe(id);
    expect(c.team).toBe('sourcing');
    expect(c.skills).toEqual(['gig-sourcing']);
    expect(c.kind).toBe(kind);
    expect(c.capabilities).toEqual({ http: true });
    expect(c.egress).toEqual([host]);
    expect(c.retry).toEqual({ max: 2, on: ['rate_limit', 'overloaded', 'network', 'timeout'], backoffMs: [2000, 8000] });
    expect(c.consumes).toBe(GigRequestType);
    expect(c.produces).toBe(RawGigType);
    expect(c.capabilities.llm).toBeUndefined();
  });

  it('src-board-contracts is deterministic with no egress', () => {
    const c = srcBoardContracts.contract;
    expect(c.id).toBe('src-board-contracts');
    expect(c.kind).toBe('deterministic');
    expect(c.egress).toEqual([]);
    expect(c.capabilities).toEqual({});
    expect(c.team).toBe('sourcing');
    expect(c.skills).toEqual(['gig-sourcing']);
    expect(c.consumes).toBe(GigRequestType);
    expect(c.produces).toBe(RawGigType);
  });
});

describe('src-freelancer', () => {
  it('asks the exact URL for one query', async () => {
    const f = offlineProviders(dir('freelancer'));
    await runWith(srcFreelancer, req('freelancer', 'java'), f.fetch);
    expect(f.fetch.calls).toEqual(['https://www.freelancer.com/api/projects/0.1/projects/active/?query=java&limit=50&full_description=true&job_details=true&sort_field=time_updated']);
    expect(freelancerUrl('node.js')).toContain('?query=node.js&limit=50');
    expect(freelancerUrl('c++ dev')).toContain('?query=c%2B%2B%20dev&limit=50');
  });

  it('emits one RawGig per project id, sorted by sourceId', async () => {
    const { gigs } = await runWith(srcFreelancer, req('freelancer', 'java'), offline('freelancer'));
    expect(gigs).toHaveLength(25);
    expect(ids(gigs)).toEqual(sorted(ids(gigs)));
    expect(new Set(ids(gigs)).size).toBe(25);
    for (const g of gigs) {
      expect(g.platform).toBe('freelancer');
      expect(RawGigType.schema.safeParse(g).success).toBe(true);
    }
    const project = (read('freelancer/java.json') as { result: { projects: { id: number }[] } }).result.projects[0]!;
    expect(ids(gigs)).toContain(String(project.id));
  });

  it('keeps the fields the spec names and drops hourly_project_info.commitment', async () => {
    const { gigs } = await runWith(srcFreelancer, req('freelancer', 'java'), offline('freelancer'));
    const keys = new Set(gigs.flatMap((g) => Object.keys(g.raw as object)));
    expect([...keys].sort()).toEqual(
      ['bid_stats', 'budget', 'currency', 'description', 'hourly_project_info', 'jobs', 'local', 'owner_id', 'preview_description', 'seo_url', 'time_submitted', 'title', 'type'].sort(),
    );
    const hourly = gigs.map((g) => g.raw as Record<string, unknown>).filter((r) => r.hourly_project_info !== null);
    expect(hourly.length).toBeGreaterThan(0);
    for (const r of hourly) {
      expect(r.hourly_project_info).not.toHaveProperty('commitment');
      expect(r.hourly_project_info).toEqual({ duration_enum: 'unspecified' });
    }
    expect(JSON.stringify(gigs)).not.toContain('commitment');
    const one = gigs[0]!.raw as { currency: object; jobs: { name: string }[] };
    expect(Object.keys(one.currency).sort()).toEqual(['code', 'exchange_rate']);
    expect(one.jobs.length).toBeGreaterThan(0);
    expect(Object.keys(one.jobs[0]!)).toEqual(['name']);
  });

  it('an empty but valid result is [], with no skip note', async () => {
    const r = await runWith(srcFreelancer, req('freelancer', 'golang'), offline('freelancer'));
    expect(r.gigs).toEqual([]);
    expect(r.skips).toEqual([]);
  });

  it('ignores other platforms without fetching', async () => {
    const f = serve({});
    const r = await runWith(srcFreelancer, req('remotive', 'java'), f);
    expect(r.gigs).toEqual([]);
    expect(f.calls).toEqual([]);
  });

  it('cross-query dedupe: first query wins, sorted by sourceId', async () => {
    const f = offline('freelancer');
    const java = (await runWith(srcFreelancer, req('freelancer', 'java'), f)).gigs;
    const ts = (await runWith(srcFreelancer, req('freelancer', 'typescript'), f)).gigs;
    expect(java).toHaveLength(25);
    expect(ts).toHaveLength(25);
    const merged = mergeGigs([java, ts]);
    expect(merged).toHaveLength(46); // 4 projects appear under both queries
    expect(ids(merged)).toEqual(sorted(ids(merged)));
    // first query wins: the java copy is kept
    const first = { platform: 'freelancer', sourceId: '7', raw: { title: 'from java' } } as const;
    const second = { platform: 'freelancer', sourceId: '7', raw: { title: 'from ts' } } as const;
    expect(mergeGigs([[first], [second]])).toEqual([first]);
  });

  it('a project listed twice in one response is emitted once', async () => {
    const p = { id: 5, title: 't', description: 'd' };
    const body = JSON.stringify({ status: 'success', result: { projects: [p, p, { ...p, id: 4 }] } });
    const r = await runWith(srcFreelancer, req('freelancer', 'x'), serve({ [freelancerUrl('x')]: body }));
    expect(ids(r.gigs)).toEqual(['4', '5']);
  });

  it('malformed bodies are invalid_output', async () => {
    const bodies = ['{"status":"success","result":{}}', '{"status":"error","message":"nope"}', '[]', 'not json', '{"result":{"projects":{}}}'];
    for (const body of bodies) {
      await expect(runWith(srcFreelancer, req('freelancer', 'x'), serve({ [freelancerUrl('x')]: body })), body).rejects.toMatchObject({ code: 'invalid_output' });
    }
  });

  it('every project malformed is invalid_output; a partial skip is reported', async () => {
    const all = JSON.stringify({ result: { projects: [{ nope: 1 }, { nope: 2 }] } });
    await expect(runWith(srcFreelancer, req('freelancer', 'x'), serve({ [freelancerUrl('x')]: all }))).rejects.toMatchObject({ code: 'invalid_output', message: 'freelancer: all 2 projects failed to parse' });
    const some = JSON.stringify({ result: { projects: [{ id: 1, title: 'ok' }, { nope: 1 }] } });
    const r = await runWith(srcFreelancer, req('freelancer', 'x'), serve({ [freelancerUrl('x')]: some }));
    expect(ids(r.gigs)).toEqual(['1']);
    expect(r.skips).toEqual(['freelancer x project 1: missing id or title']);
  });

  it('an HTTP error is invalid_output; 404 is gone', async () => {
    await expect(runWith(srcFreelancer, req('freelancer', 'x'), async () => ({ status: 400, text: async () => 'bad' }))).rejects.toMatchObject({ code: 'invalid_output' });
    await expect(runWith(srcFreelancer, req('freelancer', 'x'), serve({}))).rejects.toMatchObject({ code: 'gone' });
  });
});

describe('src-remotive', () => {
  const URL_ = 'https://remotive.com/api/remote-jobs?category=software-dev';

  it('am: one request, only contract / freelance / part_time jobs, sorted, with the Remotive url', async () => {
    const f = offlineProviders(dir('remotive'));
    const { gigs } = await runWith(srcRemotive, req('remotive'), f.fetch);
    expect(f.fetch.calls).toEqual([URL_]);
    const all = (read('remotive/software-dev.json') as { jobs: { id: number; job_type: string; url: string }[] }).jobs;
    const want = all.filter((j) => ['contract', 'freelance', 'part_time'].includes(j.job_type));
    expect(want.length).toBe(8);
    expect(ids(gigs)).toEqual(sorted(want.map((j) => String(j.id))));
    for (const g of gigs) {
      const raw = g.raw as { url: string; job_type: string };
      expect(raw.url).toMatch(/^https:\/\/remotive\.com\/remote-jobs\//);
      expect(['contract', 'freelance', 'part_time']).toContain(raw.job_type);
      expect(g.platform).toBe('remotive');
    }
    expect(JSON.stringify(gigs)).not.toContain('legal');
  });

  it('pm answers [] and makes no request (the pm run reuses the am outputs)', async () => {
    const f = serve({});
    const r = await runWith(srcRemotive, req('remotive', '', { half: 'pm' }), f);
    expect(r.gigs).toEqual([]);
    expect(f.calls).toEqual([]);
  });

  it('ignores other platforms', async () => {
    const f = serve({});
    expect((await runWith(srcRemotive, req('freelancer'), f)).gigs).toEqual([]);
    expect(f.calls).toEqual([]);
  });

  it('malformed bodies are invalid_output; zero kept jobs is []', async () => {
    for (const body of ['{}', '[]', '{"jobs":{}}', 'nope']) {
      await expect(runWith(srcRemotive, req('remotive'), serve({ [URL_]: body })), body).rejects.toMatchObject({ code: 'invalid_output' });
    }
    await expect(runWith(srcRemotive, req('remotive'), serve({ [URL_]: '{"jobs":[]}' }))).resolves.toMatchObject({ gigs: [] });
    const fullTime = JSON.stringify({ jobs: [{ id: 1, title: 't', job_type: 'full_time', url: 'u' }] });
    await expect(runWith(srcRemotive, req('remotive'), serve({ [URL_]: fullTime }))).resolves.toMatchObject({ gigs: [] });
    await expect(runWith(srcRemotive, req('remotive'), serve({ [URL_]: '{"jobs":[{"nope":1}]}' }))).rejects.toMatchObject({ code: 'invalid_output' });
  });
});

describe('src-hn', () => {
  it('freelancer mode: finds the thread, keeps top-level SEEKING FREELANCER comments only, sourceId = comment id', async () => {
    const f = offlineProviders(dir('hn-synthetic'));
    const { gigs, skips } = await runWith(srcHn, req('hn-freelancer'), f.fetch);
    expect(f.fetch.calls).toEqual([HN_FREELANCER_SEARCH, `${HN}/items/9001`]);
    expect(ids(gigs)).toEqual(['9101', '9104']);
    expect(skips).toEqual([]);
    expect(gigs[0]).toMatchObject({ platform: 'hn-freelancer', sourceId: '9101' });
    expect(gigs[0]!.raw).toMatchObject({ id: 9101, author: 'a', created_at_i: 1790870400, text: expect.stringContaining('Go backend') });
    expect(JSON.stringify(gigs)).not.toContain('"children"');
  });

  it('freelancer mode on the recorded October thread: found, no SEEKING FREELANCER comment in it', async () => {
    const f = offlineProviders(dir('hn'));
    const { gigs } = await runWith(srcHn, req('hn-freelancer'), f.fetch);
    expect(f.fetch.calls).toEqual([HN_FREELANCER_SEARCH, `${HN}/items/49922572`]);
    expect(gigs).toEqual([]);
  });

  it('hiring mode: latest Who is hiring thread, REMOTE in the first 300 chars plus contract / part-time / freelance', async () => {
    const f = offlineProviders(dir('hn'));
    const { gigs } = await runWith(srcHn, req('hn-hiring'), f.fetch);
    expect(f.fetch.calls).toEqual([HN_HIRING_SEARCH, `${HN}/items/49922569`]);
    const thread = read('hn/hiring-thread.json') as { children: { id: number; text: string | null }[] };
    const want = thread.children
      .filter((c) => {
        const t = (c.text ?? '').slice(0, 300);
        return /\bremote\b/i.test(t) && /\b(contract|contractor|part[- ]?time|freelance|freelancer)\b/i.test(t);
      })
      .map((c) => String(c.id));
    expect(want.length).toBe(10);
    expect(ids(gigs)).toEqual(sorted(want));
    for (const g of gigs) expect(g.platform).toBe('hn-hiring');
  });

  it('a thread older than 45 days → [] plus the note, measured from runDate', async () => {
    // The recorded October thread was created 2026-10-01 15:02 UTC.
    const f = offlineProviders(dir('hn'));
    const old = await runWith(srcHn, req('hn-hiring', '', { runDate: '2026-12-01' }), f.fetch);
    expect(old.gigs).toEqual([]);
    expect(old.skips).toEqual(['no thread in 45 days']);
    expect(f.fetch.calls).toEqual([HN_HIRING_SEARCH]); // the thread itself is never read
    // 2026-10-01T15:02Z; 45 days before 2026-11-15 00:00 IST (2026-11-14T18:30Z) is 2026-09-30T18:30Z, so it counts
    const edge = await runWith(srcHn, req('hn-hiring', '', { runDate: '2026-11-15' }), offline('hn'));
    expect(edge.skips).toEqual([]);
    expect(edge.gigs.length).toBeGreaterThan(0);
    // the day after: 2026-11-16 00:00 IST - 45 days = 2026-10-01T18:30Z, after the thread
    const past = await runWith(srcHn, req('hn-hiring', '', { runDate: '2026-11-16' }), offline('hn'));
    expect(past.skips).toEqual(['no thread in 45 days']);
  });

  it('no matching thread at all → [] plus the note', async () => {
    const body = JSON.stringify({ hits: [{ objectID: '1', title: 'Ask HN: Who wants to be hired? (October 2026)', created_at_i: 1790866927 }] });
    const r = await runWith(srcHn, req('hn-hiring'), serve({ [HN_HIRING_SEARCH]: body }));
    expect(r).toEqual({ gigs: [], skips: ['no thread in 45 days'] });
    const none = await runWith(srcHn, req('hn-freelancer'), serve({ [HN_FREELANCER_SEARCH]: '{"hits":[]}' }));
    expect(none).toEqual({ gigs: [], skips: ['no thread in 45 days'] });
  });

  it('picks the newest matching thread inside the window', async () => {
    const hit = (id: string, at: number, title = 'Ask HN: Who is hiring? (X)') => ({ objectID: id, title, created_at_i: at });
    const search = JSON.stringify({ hits: [hit('1', 1790000000), hit('2', 1790866927), hit('3', 1790866000)] });
    const f = serve({ [HN_HIRING_SEARCH]: search, [`${HN}/items/2`]: '{"id":2,"children":[]}' });
    await runWith(srcHn, req('hn-hiring'), f);
    expect(f.calls).toEqual([HN_HIRING_SEARCH, `${HN}/items/2`]);
  });

  it('malformed bodies are invalid_output', async () => {
    const hit = JSON.stringify({ hits: [{ objectID: '7', title: 'Ask HN: Who is hiring? (X)', created_at_i: 1790866927 }] });
    await expect(runWith(srcHn, req('hn-hiring'), serve({ [HN_HIRING_SEARCH]: '{}' }))).rejects.toMatchObject({ code: 'invalid_output' });
    await expect(runWith(srcHn, req('hn-hiring'), serve({ [HN_HIRING_SEARCH]: 'nope' }))).rejects.toMatchObject({ code: 'invalid_output' });
    await expect(runWith(srcHn, req('hn-hiring'), serve({ [HN_HIRING_SEARCH]: hit, [`${HN}/items/7`]: '{"id":7}' }))).rejects.toMatchObject({ code: 'invalid_output' });
    await expect(runWith(srcHn, req('hn-hiring'), serve({ [HN_HIRING_SEARCH]: hit, [`${HN}/items/7`]: '[]' }))).rejects.toMatchObject({ code: 'invalid_output' });
    await expect(runWith(srcHn, req('hn-hiring'), serve({ [HN_HIRING_SEARCH]: hit }))).rejects.toMatchObject({ code: 'gone' });
  });

  it('ignores other platforms', async () => {
    const f = serve({});
    expect((await runWith(srcHn, req('freelancer'), f)).gigs).toEqual([]);
    expect(f.calls).toEqual([]);
  });
});

describe('src-board-contracts', () => {
  const posting: Posting = {
    jobKey: '0123456789abcdef',
    dedupeKey: 'fedcba9876543210',
    source: 'himalayas',
    sourceId: 'abc',
    company: 'Acme',
    slug: 'himalayas',
    ats: 'feed',
    title: 'Contract Backend Engineer',
    url: 'https://example.com/j/1',
    locationText: 'Worldwide',
    remote: { structured: 'remote', countries: ['worldwide'], signals: ['feed:remote-only'] },
    employmentType: 'Contractor',
    descriptionText: 'Build APIs.',
    postedAt: '2026-10-10',
    comp: null,
    yearsRequired: null,
  };
  const run = (item: unknown, platform: GigRequest['platform'] = 'boards') => runWith(srcBoardContracts, req(platform, '', { item }), serve({}));

  it('converts a stored Posting into one RawGig, no fetching', async () => {
    const { gigs } = await run(posting);
    expect(gigs).toEqual([{ platform: 'boards', sourceId: '0123456789abcdef', raw: posting }]);
  });

  it('an item that is not a Posting → invalid_output', async () => {
    await expect(run({ jobKey: 'x' })).rejects.toMatchObject({ code: 'invalid_output' });
    await expect(run(undefined)).rejects.toMatchObject({ code: 'invalid_output' });
    await expect(run('nope')).rejects.toMatchObject({ code: 'invalid_output' });
    await expect(run({ ...posting, extra: 1 })).rejects.toMatchObject({ code: 'invalid_output' });
  });

  it('answers only platform boards', async () => {
    expect((await run(posting, 'freelancer')).gigs).toEqual([]);
  });
});
