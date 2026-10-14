import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolvePdftotext } from '../../src/app/kernel.js';
import { offlineProviders } from '../../src/app/offline.js';
import { runDaily } from '../../src/app/run.js';
import { normalize } from '../../src/app/agents/normalizer.js';
import { linkJobs, type LinkRow } from '../../src/app/store/links.js';
import { AppStore, type JobUpsert } from '../../src/app/store/app-store.js';
import { atsJobKey, atsRefFromIdentity, atsRefFromUrls, atsRefOf, normalAtsRef } from '../../src/app/text/ats-id.js';
import { Store } from '../../src/kernel/store/store.js';
import { AT, jobRow, LATER } from '../support/app-fixtures.js';

/**
 * Task 10, cross-source dedupe: one job seen through a company page (or a platform adapter) and through its ATS board
 * is one row. The merge is an exact, platform-qualified ATS job id within one company; otherwise the v1 dedupe key.
 */

const all = { band: ['disclosed', 'undisclosed', 'review', 'rejected', 'below-floor'] as const, duplicates: true };
const CO = 'Example Identity Co';
const GH = 'a000000000000001';
const GH2 = 'a000000000000002';
const PAGE = 'b000000000000001';
const PAGE2 = 'b000000000000002';
const WD = 'c000000000000001';
const HM = 'd000000000000001';

/** A Greenhouse board row of board `example-identity`. */
const gh = (over: Partial<JobUpsert> & { id?: string } = {}): JobUpsert => {
  const { id = '7001', ...rest } = over;
  return jobRow({
    jobKey: GH, source: 'greenhouse', sourceId: id, slug: 'example-identity', company: CO, dedupeKey: '1111111111111111',
    atsJob: { platform: 'greenhouse', board: 'example-identity', id }, ...rest,
  });
};
/** A company page row carrying a bare `gh_jid` (no board), with its own title wording, so the dedupe keys differ. */
const page = (over: Partial<JobUpsert> & { id?: string } = {}): JobUpsert => {
  const { id = '7001', ...rest } = over;
  return jobRow({
    jobKey: PAGE, source: 'careers', sourceId: 'p1', slug: 'example-identity-careers', company: CO, ats: 'careers', dedupeKey: '2222222222222222',
    title: 'Senior Backend Engineer (Identity Platform)', url: `https://www.identity.example/careers/opportunity/${id}?gh_jid=${id}`,
    atsJob: { platform: 'greenhouse', board: null, id }, ...rest,
  });
};

describe('the ATS job id key (text/ats-id)', () => {
  it('reads an unambiguous id from a page URL: gh_jid, Greenhouse, Lever, Ashby and Workday job URLs', () => {
    expect(atsRefFromUrls(['https://www.identity.example/careers/opportunity/7001?gh_jid=7001'])).toEqual({ platform: 'greenhouse', board: null, id: '7001' });
    expect(atsRefFromUrls(['https://boards.greenhouse.io/Example-Identity/jobs/7001'])).toEqual({ platform: 'greenhouse', board: 'example-identity', id: '7001' });
    expect(atsRefFromUrls(['https://job-boards.greenhouse.io/example-identity/jobs/7001?gh_src=x'])).toEqual({ platform: 'greenhouse', board: 'example-identity', id: '7001' });
    expect(atsRefFromUrls(['https://boards.greenhouse.io/embed/job_app?for=example-identity&token=7001'])).toEqual({ platform: 'greenhouse', board: 'example-identity', id: '7001' });
    expect(atsRefFromUrls(['https://jobs.lever.co/example/0D3A2B1C-1111-2222-3333-444455556666/apply'])).toEqual({ platform: 'lever', board: 'example', id: '0d3a2b1c-1111-2222-3333-444455556666' });
    expect(atsRefFromUrls(['https://jobs.ashbyhq.com/example/0d3a2b1c-1111-2222-3333-444455556666'])).toEqual({ platform: 'ashby', board: 'example', id: '0d3a2b1c-1111-2222-3333-444455556666' });
    expect(atsRefFromUrls(['https://Acme.wd5.myworkdayjobs.com/en-US/External/job/India-Bengaluru/Senior-Engineer_JR2026776'])).toEqual({ platform: 'workday', board: 'acme', id: 'JR2026776' });
  });

  it('is null when the page carries no id, a non-numeric gh_jid, or two different ids', () => {
    expect(atsRefFromUrls(['https://careers.example.com/jobs/lead-backend-engineer-payments'])).toBeNull();
    expect(atsRefFromUrls(['https://www.identity.example/careers/opportunity/1?gh_jid=12a'])).toBeNull();
    expect(atsRefFromUrls(['https://www.identity.example/careers/opportunity/1?gh_jid=7001&gh_jid=7002'])).toBeNull();
    expect(atsRefFromUrls(['https://www.identity.example/c?gh_jid=7001', 'https://boards.greenhouse.io/example-identity/jobs/7002'])).toBeNull();
    // one board-less and one boarded statement of the same id agree: the board is taken
    expect(atsRefFromUrls(['https://www.identity.example/c?gh_jid=7001', 'https://boards.greenhouse.io/example-identity/jobs/7001'])).toEqual({ platform: 'greenhouse', board: 'example-identity', id: '7001' });
    // two boards for one id disagree: no key
    expect(atsRefFromUrls(['https://boards.greenhouse.io/a/jobs/7001', 'https://boards.greenhouse.io/b/jobs/7001'])).toBeNull();
    expect(atsRefFromUrls(['not a url', ''])).toBeNull();
  });

  it('never throws: a malformed URL, escape or query in any form is no id', () => {
    const bad = [
      'https://jobs.ashbyhq.com/%E0%A4%A/0d3a2b1c-1111-2222-3333-444455556666',
      'https://jobs.ashbyhq.com/%/0d3a2b1c-1111-2222-3333-444455556666',
      'https://jobs.lever.co/%E0%A4%A/0d3a2b1c-1111-2222-3333-444455556666',
      'https://boards.greenhouse.io/%E0%A4%A/jobs/7001',
      'https://boards.greenhouse.io/embed/job_app?for=%E0%A4%A&token=7001',
      'https://www.identity.example/c?gh_jid=%E0%A4%A',
      'https://acme.wd5.myworkdayjobs.com/External/job/%E0%A4%A/Senior_%E0%A4%A',
      'https://[::1', 'http://%', 'https://exa mple.com/?gh_jid=1 2',
    ];
    for (const u of bad) expect(() => atsRefFromUrls([u]), u).not.toThrow();
    for (const u of bad) expect(atsRefFromUrls([u]), u).toBeNull();
    // the normalizer keeps the job, with no ref
    const ld = { '@type': 'JobPosting', title: 'Engineer', description: 'Build services.', sameAs: bad[0], url: bad[1] };
    const p = normalize({ source: 'careers', sourceId: 's', company: CO, slug: 'c', raw: { url: 'https://www.identity.example/careers/x', jsonLd: ld, title: 'Engineer', text: '' } });
    expect('atsRef' in p).toBe(false);
  });

  it('folds the Workday tenant (a host label) and reads a req id only from a /<site>/job/…/<title>_<id> path', () => {
    expect(normalAtsRef('workday', 'ACME', 'JR1')).toEqual({ platform: 'workday', board: 'acme', id: 'JR1' });
    const r = { title: 'E', url: 'https://acme.wd5.myworkdayjobs.com/External/job/X/E_JR1', externalPath: '/job/X/E_JR1', locationsText: 'India', reqId: 'JR1', detail: null };
    expect(normalize({ source: 'workday', sourceId: 'JR1', company: 'Acme', slug: 'ACME.wd5.myworkdayjobs.com/ACME/External', raw: r }).atsRef).toEqual(atsRefFromUrls([r.url]));
    expect(atsRefFromUrls(['https://acme.wd5.myworkdayjobs.com/External/details/X/E_JR1'])).toBeNull();
    expect(atsRefFromUrls(['https://acme.wd5.myworkdayjobs.com/job/X/E_JR1'])).toBeNull();
    expect(atsRefFromUrls(['https://acme.wd5.myworkdayjobs.com/External/job'])).toBeNull();
    expect(atsRefFromUrls(['https://acme.wd5.myworkdayjobs.com/External/job/X/Engineer'])).toBeNull();
    expect(atsRefFromUrls(['https://acme.wd5.myworkdayjobs.com/External/job/X/E_JR1'])).toEqual({ platform: 'workday', board: 'acme', id: 'JR1' });
  });

  it('takes an ATS adapter posting id from its identity; a feed or a page has none', () => {
    expect(atsRefFromIdentity('greenhouse', 'Example-Identity', '7001')).toEqual({ platform: 'greenhouse', board: 'example-identity', id: '7001' });
    expect(atsRefFromIdentity('lever', 'example', '0D3A2B1C-1111-2222-3333-444455556666')).toEqual({ platform: 'lever', board: 'example', id: '0d3a2b1c-1111-2222-3333-444455556666' });
    expect(atsRefFromIdentity('ashby', 'example', '0d3a2b1c-1111-2222-3333-444455556666')).toEqual({ platform: 'ashby', board: 'example', id: '0d3a2b1c-1111-2222-3333-444455556666' });
    expect(atsRefFromIdentity('greenhouse', 'example-identity', 'x1')).toBeNull();
    expect(atsRefFromIdentity('himalayas', 'himalayas', 'https://himalayas.app/x')).toBeNull();
    expect(atsRefFromIdentity('careers', 'example', 'abcdef0123456789')).toBeNull();
  });

  it('platform-qualifies the key, so one id on two platforms or two boards never collides', () => {
    expect(atsJobKey({ platform: 'greenhouse', board: 'example-identity', id: '7001' })).toBe('greenhouse:example-identity:7001');
    expect(atsJobKey({ platform: 'workday', board: 'example-identity', id: '7001' })).toBe('workday:example-identity:7001');
    expect(atsJobKey({ platform: 'greenhouse', board: null, id: '7001' })).toBeNull();
  });

  it('a posting carries its page ref, else its adapter identity', () => {
    const base = { source: 'greenhouse', slug: 'example-identity', sourceId: '7001' };
    expect(atsRefOf(base)).toEqual({ platform: 'greenhouse', board: 'example-identity', id: '7001' });
    expect(atsRefOf({ source: 'careers', slug: 'x', sourceId: 'abc', atsRef: { platform: 'greenhouse', board: null, id: '7001' } })).toEqual({ platform: 'greenhouse', board: null, id: '7001' });
    expect(atsRefOf({ source: 'careers', slug: 'x', sourceId: 'abc' })).toBeNull();
  });
});

describe('the normalizer records the ATS id', () => {
  it('a company page with gh_jid carries a Greenhouse ref; a page with none has no atsRef field at all', () => {
    const ld = { '@type': 'JobPosting', title: 'Senior Backend Engineer', description: 'Build services.', jobLocation: { '@type': 'Place', address: { addressLocality: 'Bengaluru', addressCountry: 'India' } } };
    const withId = normalize({ source: 'careers', sourceId: 's', company: CO, slug: 'c', raw: { url: 'https://www.identity.example/careers/opportunity/7001?gh_jid=7001', jsonLd: ld, title: 'Senior Backend Engineer', text: '' } });
    expect(withId.atsRef).toEqual({ platform: 'greenhouse', board: null, id: '7001' });
    const viaLd = normalize({ source: 'jsonld-sitemap', sourceId: 's', company: CO, slug: 'c', raw: { url: 'https://www.identity.example/careers/7001', jsonLd: { ...ld, url: 'https://boards.greenhouse.io/example-identity/jobs/7001' }, title: 'Senior Backend Engineer' } });
    expect(viaLd.atsRef).toEqual({ platform: 'greenhouse', board: 'example-identity', id: '7001' });
    const none = normalize({ source: 'careers', sourceId: 's', company: CO, slug: 'c', raw: { url: 'https://www.identity.example/careers/senior-backend-engineer', jsonLd: ld, title: 'Senior Backend Engineer', text: '' } });
    expect('atsRef' in none).toBe(false);
  });

  it('a Workday posting carries its req id (never the externalPath) and its tenant', () => {
    const r = { title: 'Senior Engineer', url: 'https://acme.wd5.myworkdayjobs.com/External/job/India-Bengaluru/Senior-Engineer_JR2026776', externalPath: '/job/India-Bengaluru/Senior-Engineer_JR2026776', locationsText: 'India, Bengaluru', reqId: 'JR2026776', detail: null };
    expect(normalize({ source: 'workday', sourceId: 'JR2026776', company: 'Acme', slug: 'acme.wd5.myworkdayjobs.com/acme/External', raw: r }).atsRef).toEqual({ platform: 'workday', board: 'acme', id: 'JR2026776' });
    const noReq = normalize({ source: 'workday', sourceId: r.externalPath, company: 'Acme', slug: 'acme.wd5.myworkdayjobs.com/acme/External', raw: { ...r, reqId: null } });
    expect('atsRef' in noReq).toBe(false);
  });

  it('the watchlist ATS adapters keep main\'s posting unchanged (their id is their identity)', () => {
    const p = normalize({ source: 'greenhouse', sourceId: '7001', company: CO, slug: 'example-identity', raw: { id: 7001, title: 'Senior Backend Engineer', absolute_url: 'https://boards.greenhouse.io/example-identity/jobs/7001', location: { name: 'Bengaluru, India' }, content: '' } });
    expect('atsRef' in p).toBe(false);
    expect(atsRefOf(p)).toEqual({ platform: 'greenhouse', board: 'example-identity', id: '7001' });
  });
});

describe('cross-source dedupe in the store', () => {
  it('the Okta-like pair: a company page with gh_jid and the Greenhouse board job are one visible row', () => {
    const s = AppStore.on(Store.open(':memory:'));
    s.upsertJob(gh({ at: AT }));
    s.upsertJob(page({ at: LATER }));
    expect(s.listJobs().map((j) => j.jobKey)).toEqual([GH]);
    expect(s.getJob(PAGE)?.duplicateOf).toBe(GH);
    expect(s.getJob(GH)?.alsoListedOn).toEqual(['careers']);
    expect(s.listJobs(all).map((j) => j.jobKey).sort()).toEqual([GH, PAGE]);
  });

  it('the earliest first-seen is primary, whichever is written first; on one day the job key decides', () => {
    const a = AppStore.on(Store.open(':memory:'));
    a.upsertJob(page({ at: AT }));
    a.upsertJob(gh({ at: LATER }));
    expect(a.listJobs().map((j) => j.jobKey)).toEqual([PAGE]);
    expect(a.getJob(GH)?.duplicateOf).toBe(PAGE);
    // the same day: arrival order reversed gives the same primary (the smaller job key)
    for (const order of [[gh(), page()], [page(), gh()]]) {
      const s = AppStore.on(Store.open(':memory:'));
      for (const r of order) s.upsertJob(r);
      expect(s.listJobs().map((j) => j.jobKey)).toEqual([GH]);
      expect(s.getJob(PAGE)?.duplicateOf).toBe(GH);
    }
  });

  it('the same title in two cities is two rows; the page joins only the job its id names', () => {
    const s = AppStore.on(Store.open(':memory:'));
    s.upsertJob(gh({ id: '7001', location: 'Bengaluru, India' }));
    s.upsertJob(gh({ jobKey: GH2, id: '7002', location: 'Pune, India', dedupeKey: '3333333333333333' }));
    expect(s.listJobs().map((j) => j.jobKey)).toEqual([GH, GH2]);
    s.upsertJob(page({ id: '7002', location: 'Pune, India' }));
    expect(s.getJob(PAGE)?.duplicateOf).toBe(GH2);
    expect(s.listJobs().map((j) => j.jobKey)).toEqual([GH, GH2]);
  });

  it('a page whose id names another job is not merged by a matching dedupe key (two openings, one title)', () => {
    const s = AppStore.on(Store.open(':memory:'));
    s.upsertJob(gh({ id: '7001' }));
    // same company, title and location as GH (one dedupe key), but its gh_jid names job 7002
    s.upsertJob(page({ id: '7002', dedupeKey: '1111111111111111' }));
    expect(s.getJob(PAGE)?.duplicateOf).toBeNull();
    expect(s.listJobs().map((j) => j.jobKey).sort()).toEqual([GH, PAGE]);
  });

  it('the same id at two different companies is two rows', () => {
    const s = AppStore.on(Store.open(':memory:'));
    s.upsertJob(gh());
    s.upsertJob(page({ company: 'Another Example Co' }));
    expect(s.getJob(PAGE)?.duplicateOf).toBeNull();
    expect(s.listJobs().map((j) => j.jobKey).sort()).toEqual([GH, PAGE]);
  });

  it('company names match by the fixed normalisation only (a legal suffix, case); a generic name never merges', () => {
    const s = AppStore.on(Store.open(':memory:'));
    s.upsertJob(gh());
    s.upsertJob(page({ company: 'example identity co, inc.' }));
    expect(s.getJob(PAGE)?.duplicateOf).toBe(GH);
    const t = AppStore.on(Store.open(':memory:'));
    t.upsertJob(gh({ company: 'Careers' }));
    t.upsertJob(page({ company: 'Careers' }));
    expect(t.getJob(PAGE)?.duplicateOf).toBeNull();
  });

  it('a Workday req id on a company page is the Workday posting', () => {
    const s = AppStore.on(Store.open(':memory:'));
    s.upsertJob(jobRow({ jobKey: WD, source: 'workday', sourceId: 'JR2026776', slug: 'acme.wd5.myworkdayjobs.com/acme/External', company: 'Acme', ats: 'workday', dedupeKey: '4444444444444444', atsJob: { platform: 'workday', board: 'acme', id: 'JR2026776' } }));
    s.upsertJob(jobRow({ jobKey: PAGE, source: 'jsonld-sitemap', sourceId: 'p1', slug: 'www.acme.example', company: 'Acme', ats: 'jsonld-sitemap', dedupeKey: '5555555555555555', atsJob: { platform: 'workday', board: 'acme', id: 'JR2026776' } }));
    expect(s.listJobs().map((j) => j.jobKey)).toEqual([PAGE]);
    expect(s.getJob(WD)?.duplicateOf).toBe(PAGE);
    // one id on another platform is another job
    s.upsertJob(jobRow({ jobKey: GH, source: 'greenhouse', sourceId: 'JR2026776', slug: 'acme', company: 'Acme', dedupeKey: '6666666666666666', atsJob: { platform: 'greenhouse', board: 'acme', id: 'JR2026776' } }));
    expect(s.getJob(GH)?.duplicateOf).toBeNull();
  });

  it('a key collision within one source and board is a named note, never a merge', () => {
    const s = AppStore.on(Store.open(':memory:'));
    s.upsertJob(gh());
    s.upsertJob(page());
    const r = s.upsertJob(page({ jobKey: PAGE2, sourceId: 'p2', url: 'https://www.identity.example/careers/other?gh_jid=7001', dedupeKey: '7777777777777777' }));
    expect(r.notes).toEqual([`ats-id-collision greenhouse:example-identity:7001: careers example-identity-careers lists it 2 times (${PAGE}, ${PAGE2}); not merged`]);
    expect([GH, PAGE, PAGE2].map((k) => s.getJob(k)?.duplicateOf)).toEqual([null, null, null]);
  });

  const registry = (st: AppStore, slug: string, status = 'verified', override: string | null = null): void => {
    st.kernel.db
      .prepare(`INSERT INTO companies (company_key, name, website, platform, platform_slug, board_url, status, source, user_override, updated_at) VALUES (?, ?, 'https://identity.example', 'greenhouse', ?, ?, ?, 'picks', ?, ?)`)
      .run(`k-${slug}-${status}-${override ?? ''}`, CO, slug, `https://boards.greenhouse.io/${slug}`, status, override, AT);
  };
  const intern = (over: Partial<JobUpsert> & { id?: string } = {}): JobUpsert => {
    const { id = '9001', ...rest } = over;
    return gh({ jobKey: GH2, id, slug: 'example-identity-intern', dedupeKey: '3333333333333333', atsJob: { platform: 'greenhouse', board: 'example-identity-intern', id }, ...rest });
  };
  /** A second company page (another source) with the same bare gh_jid. */
  const page2 = (over: Partial<JobUpsert> = {}): JobUpsert =>
    page({ jobKey: PAGE2, source: 'jsonld-sitemap', ats: 'jsonld-sitemap', sourceId: 'p2', slug: 'www.identity.example', dedupeKey: '8888888888888888', ...over });

  it('a bare gh_jid matches the one stored Greenhouse row with that job id, on any of the company\'s boards', () => {
    const s = AppStore.on(Store.open(':memory:'));
    s.upsertJob(gh());
    s.upsertJob(intern());
    s.upsertJob(page());
    expect(s.getJob(PAGE)?.duplicateOf).toBe(GH);
    // a registry board the stored row does not use changes nothing: the stored row wins
    const t = AppStore.on(Store.open(':memory:'));
    registry(t, 'example-identity-eu');
    t.upsertJob(gh());
    t.upsertJob(page());
    expect(t.getJob(PAGE)?.duplicateOf).toBe(GH);
  });

  it('two stored Greenhouse rows with the job id at the company: no merge, a named note', () => {
    const s = AppStore.on(Store.open(':memory:'));
    s.upsertJob(gh());
    // one source key holds one Greenhouse row per id, so the second stored row is a page naming another board's URL
    s.upsertJob(page2({ atsJob: { platform: 'greenhouse', board: 'example-identity-intern', id: '7001' } }));
    const r = s.upsertJob(page());
    expect([GH, PAGE2, PAGE].map((k) => s.getJob(k)?.duplicateOf)).toEqual([null, null, null]);
    expect(r.notes).toEqual([`ats-id-ambiguous gh_jid 7001: boards example-identity, example-identity-intern both list it (${PAGE}); not merged`]);
  });

  it('with no stored row of the id yet, two bare-gh_jid pages share the company\'s one known board; two boards keep them apart', () => {
    const s = AppStore.on(Store.open(':memory:'));
    s.upsertJob(gh({ id: '5555' }));
    s.upsertJob(page());
    s.upsertJob(page2());
    expect(s.getJob(PAGE2)?.duplicateOf).toBe(PAGE);
    const t = AppStore.on(Store.open(':memory:'));
    t.upsertJob(gh({ id: '5555' }));
    registry(t, 'example-identity-eu');
    t.upsertJob(page());
    t.upsertJob(page2());
    expect(t.getJob(PAGE2)?.duplicateOf).toBeNull();
    // the registry alone may name the one board
    const u = AppStore.on(Store.open(':memory:'));
    registry(u, 'Example-Identity');
    u.upsertJob(page());
    u.upsertJob(page2());
    expect(u.getJob(PAGE2)?.duplicateOf).toBe(PAGE);
  });

  it('a rejected or user-rejected registry board is never a known board', () => {
    for (const [status, override] of [['rejected', null], ['proposed', null], ['verified', 'rejected']] as const) {
      const s = AppStore.on(Store.open(':memory:'));
      s.upsertJob(gh({ id: '5555' }));
      registry(s, 'example-identity-eu', status, override);
      s.upsertJob(page());
      s.upsertJob(page2());
      expect(s.getJob(PAGE2)?.duplicateOf, `${status}/${override}`).toBe(PAGE);
    }
  });

  it('the reviewer\'s split: a second board appearing never splits a merged pair, nor announces it again', () => {
    const s = AppStore.on(Store.open(':memory:'));
    s.upsertJob(gh({ docsState: 'ready' }));
    s.upsertJob(page({ docsState: 'ready' }));
    s.markNotified([GH], AT);
    s.upsertJob(intern({ at: LATER }));
    expect(s.getJob(PAGE)?.duplicateOf).toBe(GH);
    expect(s.listJobs().filter((j) => j.company === CO && j.jobKey !== GH2).map((j) => j.jobKey)).toEqual([GH]);
    expect(s.listJobs().filter((j) => j.docsState === 'ready' && j.notifiedAt === null)).toEqual([]);
  });

  const fresh = (st: AppStore) => st.listJobs().filter((j) => j.docsState === 'ready' && j.notifiedAt === null).map((j) => j.jobKey);

  it('a row its id proves to be another job leaves unannounced, is announced on its own, and its board job joins it once', () => {
    const s = AppStore.on(Store.open(':memory:'));
    s.upsertJob(gh({ docsState: 'ready' }));
    s.markNotified([GH], AT);
    // an id-less page with the same dedupe key: a v1 listing of 7001
    s.upsertJob(page({ docsState: 'ready', atsJob: null, dedupeKey: '1111111111111111' }));
    expect(s.getJob(PAGE)?.duplicateOf).toBe(GH);
    expect(fresh(s)).toEqual([]);
    // the page now states gh_jid=7002: another job; it leaves without 7001's announcement
    s.upsertJob(page({ docsState: 'ready', id: '7002', dedupeKey: '1111111111111111', at: LATER }));
    expect(s.getJob(PAGE)?.duplicateOf).toBeNull();
    expect(s.getJob(PAGE)?.notifiedAt).toBeNull();
    expect(fresh(s)).toEqual([PAGE]);
    s.markNotified([PAGE], LATER);
    // the board's 7002 arrives: it joins the page's job, which was announced once
    s.upsertJob(intern({ docsState: 'ready', id: '7002', slug: 'example-identity', atsJob: { platform: 'greenhouse', board: 'example-identity', id: '7002' }, at: LATER }));
    expect(s.getJob(GH2)?.duplicateOf).toBe(PAGE);
    expect(fresh(s)).toEqual([]);
  });

  it('a row leaving with the group\'s own key (a same-source collision splits the job) stays announced', () => {
    const s = AppStore.on(Store.open(':memory:'));
    s.upsertJob(gh({ docsState: 'ready' }));
    s.upsertJob(page({ docsState: 'ready' }));
    s.markNotified([GH], AT);
    s.upsertJob(page({ jobKey: PAGE2, sourceId: 'p2', docsState: 'ready', dedupeKey: '7777777777777777', at: LATER }));
    expect(s.getJob(PAGE)?.duplicateOf).toBeNull();
    expect(s.getJob(PAGE)?.notifiedAt).toBe(AT);
    expect(fresh(s)).toEqual([PAGE2]);
  });

  it('a departing row with no ATS id stays announced', () => {
    const s = AppStore.on(Store.open(':memory:'));
    s.upsertJob(gh({ docsState: 'ready' }));
    s.upsertJob(page({ docsState: 'ready' }));
    s.upsertJob(jobRow({ jobKey: HM, source: 'himalayas', sourceId: 'h1', company: CO, docsState: 'ready', dedupeKey: '2222222222222222' }));
    expect(s.getJob(HM)?.duplicateOf).toBe(GH);
    s.markNotified([GH], AT);
    s.upsertJob(jobRow({ jobKey: HM, source: 'himalayas', sourceId: 'h1', company: CO, docsState: 'ready', dedupeKey: 'eeeeeeeeeeeeeeee', at: LATER }));
    expect(s.getJob(HM)?.duplicateOf).toBeNull();
    expect(s.getJob(HM)?.notifiedAt).toBe(AT);
  });

  it('an id on another platform is no proof of another job: the departing row stays announced', () => {
    const s = AppStore.on(Store.open(':memory:'));
    s.upsertJob(gh({ docsState: 'ready' }));
    s.upsertJob(page({ docsState: 'ready', atsJob: null, dedupeKey: '1111111111111111' }));
    s.markNotified([GH], AT);
    s.upsertJob(page({ docsState: 'ready', dedupeKey: 'eeeeeeeeeeeeeeee', atsJob: { platform: 'lever', board: 'example', id: '0d3a2b1c-1111-2222-3333-444455556666' }, at: LATER }));
    expect(s.getJob(PAGE)?.duplicateOf).toBeNull();
    expect(s.getJob(PAGE)?.notifiedAt).toBe(AT);
  });

  it('a departing row with the group\'s own key carries the earliest announcement of the group', () => {
    const s = AppStore.on(Store.open(':memory:'));
    // three listings of job 7001: the board row, a careers page and a sitemap page (same key)
    s.upsertJob(gh({ docsState: 'ready', at: AT }));
    s.upsertJob(page({ docsState: 'ready', at: AT }));
    s.upsertJob(page2({ docsState: 'ready', at: AT, dedupeKey: '9999999999999999', atsJob: { platform: 'greenhouse', board: 'example-identity', id: '7001' } }));
    s.markNotified([PAGE], LATER);
    s.markNotified([GH], AT);
    // the sitemap page loses its company name match (a rename): it leaves the job, already announced, at the earliest time
    s.upsertJob(page2({ docsState: 'ready', at: LATER, company: 'Renamed Example Co', dedupeKey: '9999999999999999', atsJob: { platform: 'greenhouse', board: 'example-identity', id: '7001' } }));
    expect(s.getJob(PAGE2)?.duplicateOf).toBeNull();
    expect(s.getJob(PAGE2)?.notifiedAt).toBe(AT);
  });

  it('a row that leaves an announced group stays announced', () => {
    const s = AppStore.on(Store.open(':memory:'));
    s.upsertJob(page({ docsState: 'ready', at: AT }));
    s.upsertJob(gh({ docsState: 'ready', at: LATER }));
    expect(s.getJob(GH)?.duplicateOf).toBe(PAGE);
    s.markNotified([PAGE], AT);
    // the page stops stating the id: the board row leaves the group, already announced
    s.upsertJob(page({ docsState: 'ready', at: LATER, atsJob: null }));
    expect(s.getJob(GH)?.duplicateOf).toBeNull();
    expect(s.getJob(GH)?.notifiedAt).toBe(AT);
    expect(s.listJobs().filter((j) => j.docsState === 'ready' && j.notifiedAt === null)).toEqual([]);
  });

  it('status, note and documents follow the primary; the job is announced once', () => {
    const s = AppStore.on(Store.open(':memory:'));
    s.upsertJob(gh({ docsState: 'ready' }));
    s.putDocs(GH, [{ kind: 'resume', format: 'pdf', path: `${GH}/resume.pdf`, sha256: 'a'.repeat(64), pages: 1, qaOk: true }]);
    s.markNotified([GH], AT);
    // the page arrives on the same day with a smaller job key... it would become primary only by key; make it so
    const P0 = '0000000000000001';
    s.upsertJob(page({ jobKey: P0, docsState: 'ready' }));
    expect(s.getJob(GH)?.duplicateOf).toBe(P0);
    // the group was announced already: the new primary is not announced again
    const fresh = s.listJobs(all).filter((j) => j.duplicateOf === null && j.docsState === 'ready' && j.notifiedAt === null);
    expect(fresh).toEqual([]);
    s.setStatus(GH, 'applied', 'user', LATER);
    s.setNote(GH, 'sent through the board');
    expect(s.getJob(P0)).toMatchObject({ status: 'applied', note: 'sent through the board' });
    expect(s.listJobs({ ...all, duplicates: false }).map((j) => [j.jobKey, j.status])).toEqual([[P0, 'applied']]);
    // the documents of a row stay its own; the visible row is the primary
    expect(s.getJob(GH)?.docs.map((d) => d.path)).toEqual([`${GH}/resume.pdf`]);
  });

  it('a company page joined by its id is primary when seen first, though the board is an ATS source', () => {
    const s = AppStore.on(Store.open(':memory:'));
    s.upsertJob(page({ source: 'jsonld-sitemap', ats: 'jsonld-sitemap', at: AT }));
    s.upsertJob(gh({ at: LATER }));
    expect(s.listJobs().map((j) => j.jobKey)).toEqual([PAGE]);
    expect(s.getJob(GH)?.duplicateOf).toBe(PAGE);
  });

  it('in a job an ATS id joined, the dedupe key never adds a second row of one source (v1 keeps those apart)', () => {
    const s = AppStore.on(Store.open(':memory:'));
    // an id-less page of the same source, title and place, seen first: v1 keeps two pages of one source apart
    s.upsertJob(page({ jobKey: PAGE2, sourceId: 'p2', url: 'https://www.identity.example/careers/senior-backend-engineer', atsJob: null, dedupeKey: '1111111111111111', at: AT }));
    s.upsertJob(page({ dedupeKey: '1111111111111111', at: LATER }));
    s.upsertJob(gh({ at: LATER }));
    expect(s.getJob(PAGE)?.duplicateOf).toBe(GH);
    expect(s.getJob(PAGE2)?.duplicateOf).toBeNull();
    expect(s.getJob(GH)?.duplicateOf).toBeNull();
  });

  it('a page that stops stating the id leaves the job, and its former duplicate is shown again', () => {
    const s = AppStore.on(Store.open(':memory:'));
    s.upsertJob(page({ at: AT }));
    s.upsertJob(gh({ at: AT, jobKey: 'f000000000000001' }));
    expect(s.getJob('f000000000000001')?.duplicateOf).toBe(PAGE);
    s.upsertJob(page({ at: LATER, atsJob: null }));
    expect(s.getJob('f000000000000001')?.duplicateOf).toBeNull();
    expect(s.listJobs().map((j) => j.jobKey).sort()).toEqual([PAGE, 'f000000000000001']);
  });

  it('a feed listing of the merged job joins the same group (the user sees it once)', () => {
    const s = AppStore.on(Store.open(':memory:'));
    s.upsertJob(gh());
    s.upsertJob(page());
    s.upsertJob(jobRow({ jobKey: HM, source: 'himalayas', sourceId: 'h1', company: CO, dedupeKey: '2222222222222222' }));
    expect(s.listJobs().map((j) => j.jobKey)).toEqual([GH]);
    expect(s.getJob(GH)?.alsoListedOn).toEqual(['careers', 'himalayas']);
  });
});

describe('linkJobs (pure)', () => {
  const row = (jobKey: string, over: Partial<LinkRow> = {}): LinkRow => ({ jobKey, source: 'greenhouse', firstSeen: AT, dedupeKey: 'd', ats: null, ...over });
  it('without ATS ids it is the v1 rule exactly', () => {
    const rows = [row('k3', { source: 'himalayas' }), row('k1'), row('k2'), row('k4', { source: 'jobicy', dedupeKey: 'e' })];
    expect(Object.fromEntries(linkJobs(rows, () => []).duplicateOf)).toEqual({ k1: null, k2: null, k3: 'k1', k4: null });
  });
  it('one key at two companies is two jobs, even with the board stated on both', () => {
    const rows = [
      row('g1', { dedupeKey: 'a', ats: { platform: 'greenhouse', board: 'b', id: '1', slug: 'b', companyNorm: 'acme' } }),
      row('p1', { source: 'careers', dedupeKey: 'b', ats: { platform: 'greenhouse', board: 'b', id: '1', slug: 'c', companyNorm: 'other' } }),
      row('p2', { source: 'careers', dedupeKey: 'c', ats: { platform: 'greenhouse', board: 'b', id: '1', slug: 'd', companyNorm: 'acme' } }),
    ];
    expect(Object.fromEntries(linkJobs(rows, () => []).duplicateOf)).toEqual({ g1: null, p1: null, p2: 'g1' });
  });
  it('an ATS-joined job stays ATS-joined through a v1 merge: no second row of one source joins later', () => {
    const rows = [
      row('a1', { dedupeKey: 'd2', ats: { platform: 'greenhouse', board: 'b', id: '1', slug: 'b', companyNorm: 'acme' } }),
      row('b1', { source: 'careers', dedupeKey: 'd1', ats: { platform: 'greenhouse', board: 'b', id: '1', slug: 'c', companyNorm: 'acme' } }),
      // a feed row whose job key sorts first: it becomes the union-find root when it joins the page's job
      row('01', { source: 'himalayas', dedupeKey: 'd1' }),
      row('b2', { source: 'careers', dedupeKey: 'd2' }),
    ];
    expect(Object.fromEntries(linkJobs(rows, () => []).duplicateOf)).toEqual({ a1: null, b1: 'a1', '01': 'a1', b2: null });
  });
  it('is the same for every input order', () => {
    const rows = [
      row('g1', { ats: { platform: 'greenhouse', board: 'b', id: '1', slug: 'b', companyNorm: 'acme' } }),
      row('p1', { source: 'careers', dedupeKey: 'x', ats: { platform: 'greenhouse', board: null, id: '1', slug: 'c', companyNorm: 'acme' } }),
      row('h1', { source: 'himalayas', dedupeKey: 'x' }),
      row('g2', { dedupeKey: 'x', ats: { platform: 'greenhouse', board: 'b', id: '2', slug: 'b', companyNorm: 'acme' } }),
    ];
    const want = JSON.stringify([...linkJobs(rows, () => []).duplicateOf].sort());
    for (const perm of [[3, 2, 1, 0], [1, 3, 0, 2], [2, 0, 3, 1]]) expect(JSON.stringify([...linkJobs(perm.map((i) => rows[i] as LinkRow), () => []).duplicateOf].sort())).toBe(want);
  });
});

const pdftotext = (() => {
  try {
    return resolvePdftotext();
  } catch {
    return undefined;
  }
})();

/** One offline daily run over `tests/fixtures/dedupe` with the given careers entry beside the Greenhouse board. */
async function runDedupe(careers: { slug: string; listUrl: string }, forbidden?: string) {
  const root = join(import.meta.dirname, '../..');
  const home = mkdtempSync(join(tmpdir(), 'jobpilot-dedupe-'));
  try {
    cpSync(join(root, 'tests/fixtures/pack'), join(home, 'pack'), { recursive: true });
    writeFileSync(join(home, 'pack/feeds.yaml'), 'enabled: []\n');
    if (forbidden !== undefined) {
      const naming = join(home, 'pack/naming.yaml');
      writeFileSync(naming, readFileSync(naming, 'utf8').replace('forbiddenTerms: [Initech]', `forbiddenTerms: [Initech, ${forbidden}]`));
    }
    writeFileSync(
      join(home, 'pack/watchlist.yaml'),
      [
        'watchlist:',
        `  - {company: ${CO}, ats: greenhouse, slug: example-identity, hiresInIndia: true, allRemote: false}`,
        `  - {company: ${CO}, ats: careers, slug: ${careers.slug}, listUrl: '${careers.listUrl}', linkPattern: '^/jobs/[a-z0-9-]+\\?gh_jid=\\d+$', hiresInIndia: true, allRemote: false}`,
        '',
      ].join('\n'),
    );
    const offline = offlineProviders(join(root, 'tests/fixtures/dedupe'));
    const r = await runDaily({ home, clock: { now: () => '2026-10-09T01:30:00.000Z' }, fetch: offline.fetch, browser: offline.browser, sleep: async () => {}, pdftotext: pdftotext as string });
    const app = AppStore.open(join(home, 'jobpilot.db'));
    try {
      return { r, jobs: app.listJobs(all) };
    } finally {
      app.close();
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

describe.skipIf(pdftotext === undefined)('offline daily run: one careers source lists one gh_jid twice', () => {
  it('names the collision in the run warnings, redacted by the pack naming, and merges nothing', async () => {
    const plain = await runDedupe({ slug: 'example-identity-careers', listUrl: 'https://careers.identity.example/jobs-twice' });
    expect(plain.r.projection.dedupeNotes).toHaveLength(1);
    const note = plain.r.projection.dedupeNotes[0] as string;
    expect(note).toMatch(/^ats-id-collision greenhouse:example-identity:7001: careers example-identity-careers lists it 2 times \([0-9a-f]{16}, [0-9a-f]{16}\); not merged$/);
    expect(plain.r.warnings).toContain(note);
    expect(plain.jobs.filter((j) => j.duplicateOf !== null)).toEqual([]);
    // a note holding a forbidden term of the pack (here a word only the note has) is replaced by the fixed notice
    const named = await runDedupe({ slug: 'example-identity-careers', listUrl: 'https://careers.identity.example/jobs-twice' }, 'collision');
    expect(named.r.projection.dedupeNotes).toHaveLength(1);
    expect(named.r.warnings.filter((w) => w.includes('ats-id-collision'))).toEqual([]);
    expect(named.r.warnings).toContain('[hidden: contains a forbidden term]');
  }, 120_000);
});

describe.skipIf(pdftotext === undefined)('offline daily run: a company page and its Greenhouse board', () => {
  it('yield one row for the job both list in the dashboard\'s list query; the other board job stays its own row', async () => {
    const root = join(import.meta.dirname, '../..');
    const home = mkdtempSync(join(tmpdir(), 'jobpilot-dedupe-'));
    try {
      cpSync(join(root, 'tests/fixtures/pack'), join(home, 'pack'), { recursive: true });
      writeFileSync(join(home, 'pack/feeds.yaml'), 'enabled: []\n');
      writeFileSync(
        join(home, 'pack/watchlist.yaml'),
        [
          'watchlist:',
          `  - {company: ${CO}, ats: greenhouse, slug: example-identity, hiresInIndia: true, allRemote: false}`,
          `  - {company: ${CO}, ats: careers, slug: example-identity-careers, listUrl: 'https://careers.identity.example/jobs', linkPattern: '^/jobs/[a-z0-9-]+\\?gh_jid=\\d+$', hiresInIndia: true, allRemote: false}`,
          '',
        ].join('\n'),
      );
      const offline = offlineProviders(join(root, 'tests/fixtures/dedupe'));
      const r = await runDaily({ home, clock: { now: () => '2026-10-09T01:30:00.000Z' }, fetch: offline.fetch, browser: offline.browser, sleep: async () => {}, pdftotext: pdftotext as string });
      expect(r.report.status).toBe('completed');
      expect(r.projection.dedupeNotes).toEqual([]);
      const app = AppStore.open(join(home, 'jobpilot.db'));
      try {
        const every = app.listJobs(all);
        const bySource = (src: string, id?: string) => every.filter((j) => j.source === src && (id === undefined || j.sourceId === id));
        expect(bySource('careers')).toHaveLength(1);
        expect(bySource('greenhouse')).toHaveLength(2);
        const page = bySource('careers')[0] as (typeof every)[number];
        const board = bySource('greenhouse', '7001')[0] as (typeof every)[number];
        // the dedupe keys differ (another title wording): only the ATS id joins them
        expect(page.dedupeKey).not.toBe(board.dedupeKey);
        // the dashboard's list (duplicates hidden): one row for job 7001, one for 7002
        const shown = app.listJobs({ band: [...all.band] }).filter((j) => j.company === CO);
        expect(shown).toHaveLength(2);
        expect(shown.map((j) => j.sourceId).filter((x) => x === '7002')).toHaveLength(1);
        const primary = page.duplicateOf === null ? page : board;
        const dup = primary === page ? board : page;
        expect(dup.duplicateOf).toBe(primary.jobKey);
        expect(shown.map((j) => j.jobKey)).toContain(primary.jobKey);
        expect(shown.map((j) => j.jobKey)).not.toContain(dup.jobKey);
      } finally {
        app.close();
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 120_000);
});
