import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decideEligibility, REASON_FREEHIRE_LEAD } from '../../src/app/agents/eligibility.js';
import { normalize } from '../../src/app/agents/normalizer.js';
import { LEADS_MAX_PER_DAY, makeSrcFreehireLeads } from '../../src/app/agents/sources/freehire-leads.js';
import { PLATFORM_NOTE_PREFIXES } from '../../src/app/agents/sources/platforms/shared.js';
import { loadPack } from '../../src/app/pack/load.js';
import { compileDaily, dailyAgents, dailyPipeline, dailySeeds } from '../../src/app/pipeline.js';
import { leadsSince } from '../../src/app/run.js';
import { appGuardrails } from '../../src/app/guardrails.js';
import { AppStore, type FreehireLead } from '../../src/app/store/app-store.js';
import { linkJobs, type LinkRow } from '../../src/app/store/links.js';
import { jobBody } from '../../src/app/web/views/job.js';
import { reasonText } from '../../src/app/web/copy.js';
import { Posting, type DiscoveryRequest } from '../../src/app/types.js';
import { createHostPacer, issueContext } from '../../src/kernel/broker.js';
import { fixedClock } from '../../src/kernel/clock.js';
import { PRODUCT_POLICY_V1 } from '../../src/kernel/policy.js';
import { Store } from '../../src/kernel/store/store.js';
import { AT, jobRow, LATER } from '../support/app-fixtures.js';

/**
 * Sources expansion, Task 9: `src-freehire-leads` puts the stored freehire leads into the daily REVIEW band, never
 * `eligible`, with no network. Daily byte-identity with no leads is `daily-identity.test.ts` (unchanged).
 */

const root = join(import.meta.dirname, '../..');
const { pack: full } = loadPack(join(root, 'tests/fixtures/pack'));
const { contact: _c, answers: _a, ...pack } = full;

const lead = (n: number, over: Partial<FreehireLead> = {}): FreehireLead => ({
  leadKey: `lever:${String(n).padStart(4, '0')}`,
  source: 'lever',
  url: `https://jobs.example.com/lead/${n}`,
  title: 'Senior Backend Engineer',
  company: `Lead Co ${n}`,
  location: 'Remote, India',
  postedAt: '2026-10-12',
  evidence: 'india',
  queryId: 'q1',
  firstWeek: '2026-10-11',
  lastWeek: '2026-10-11',
  ...over,
});

const seed: DiscoveryRequest = { ats: 'freehire', slug: 'leads', company: 'freehire', runDate: '2026-10-15' };

async function runAgent(leads: readonly FreehireLead[], req: DiscoveryRequest = seed) {
  const agent = makeSrcFreehireLeads(leads);
  const ctx = issueContext({
    contract: agent.contract,
    policy: PRODUCT_POLICY_V1,
    inputClass: 'P0',
    providers: { fetch: async () => { throw new Error('no network'); } },
    clock: fixedClock('2026-10-15T01:30:00Z'),
    signal: new AbortController().signal,
    hostPacer: createHostPacer(2000, fixedClock('2026-10-15T01:30:00Z'), async () => {}),
  });
  const out = await agent.run(req, ctx);
  return { out, notes: ctx.skips() };
}

describe('the src-freehire-leads agent', () => {
  it('declares no capability and no egress: it fetches nothing', () => {
    const { contract } = makeSrcFreehireLeads([]);
    expect(contract.id).toBe('src-freehire-leads');
    expect(contract.kind).toBe('deterministic');
    expect(contract.team).toBe('sourcing-freehire');
    expect(contract.capabilities.http).toBeFalsy();
    expect(contract.egress).toEqual([]);
  });

  it('3 leads: 3 raw postings, sorted by lead key, with the fields the discovery stored', async () => {
    const { out, notes } = await runAgent([lead(3), lead(1, { company: null }), lead(2)]);
    expect(out.map((r) => r.sourceId)).toEqual(['lever:0001', 'lever:0002', 'lever:0003']);
    expect(out[0]).toEqual({
      source: 'freehire',
      sourceId: 'lever:0001',
      company: 'Unknown company',
      slug: 'leads',
      raw: { url: 'https://jobs.example.com/lead/1', title: 'Senior Backend Engineer', company: null, location: 'Remote, India', postedAt: '2026-10-12', via: 'lever' },
    });
    expect(notes).toEqual([]);
  });

  it('answers only its own seed', async () => {
    expect((await runAgent([lead(1)], { ...seed, ats: 'greenhouse', slug: 'acme' })).out).toEqual([]);
    expect((await runAgent([lead(1)], { ...seed, slug: 'other' })).out).toEqual([]);
  });

  it('250 leads: the first 200 by lead key and a named note for the 50 left', async () => {
    const leads = Array.from({ length: 250 }, (_, i) => lead(250 - i));
    const { out, notes } = await runAgent(leads);
    expect(LEADS_MAX_PER_DAY).toBe(200);
    expect(out).toHaveLength(200);
    expect(out[199]?.sourceId).toBe('lever:0200');
    expect(notes).toEqual(['freehire-leads: 50 more leads not read today (cap 200)']);
    // a named skip, so it is printed as a note and never counted as a malformed posting
    expect(PLATFORM_NOTE_PREFIXES.some((p) => notes[0]?.startsWith(p))).toBe(true);
  });
});

describe('the normalizer and eligibility for a lead', () => {
  const posted = async (over: Partial<FreehireLead> = {}): Promise<Posting> => {
    const { out } = await runAgent([lead(1, over)]);
    const p = normalize(out[0] as NonNullable<(typeof out)[number]>);
    expect(Posting.schema.safeParse(p).success).toBe(true);
    return p;
  };

  it('maps title, company, url and location; remote is the word "remote"; no description; the date as stored', async () => {
    const p = await posted();
    expect(p).toMatchObject({ ats: 'freehire', source: 'freehire', sourceId: 'lever:0001', slug: 'leads', title: 'Senior Backend Engineer', company: 'Lead Co 1', url: 'https://jobs.example.com/lead/1', locationText: 'Remote, India', descriptionText: '', postedAt: '2026-10-12' });
    expect(p.remote.structured).toBe('remote');
    const onsite = await posted({ location: 'Pune, India', postedAt: null });
    expect(onsite.remote.structured).toBeNull();
    expect(onsite.postedAt).toBeNull();
  });

  it('a lead that would be eligible is review with the freehire-lead reason; a rejected one stays rejected; a review one stays', async () => {
    const p = await posted();
    // the same posting read directly is eligible, so the cap is what holds the lead back
    expect(decideEligibility({ ...p, ats: 'greenhouse' }, pack).verdict).toBe('eligible');
    const v = decideEligibility(p, pack);
    expect(v.verdict).toBe('review');
    expect(v.reasons).toEqual([REASON_FREEHIRE_LEAD]);
    expect(decideEligibility({ ...p, title: 'Senior Frontend Engineer' }, pack)).toEqual({ verdict: 'rejected', reasons: ['role:front[- ]?end'], notes: [] });
    const unclear = await posted({ location: 'Remote' });
    expect(decideEligibility(unclear, pack).verdict).toBe('review');
    expect(decideEligibility(unclear, pack).reasons).not.toContain(REASON_FREEHIRE_LEAD);
  });

  it('the dashboard reads the reason in words', () => {
    expect(reasonText(REASON_FREEHIRE_LEAD)).toMatch(/freehire/u);
  });
});

describe('daily wiring', () => {
  it('no leads: no agent, no seed, no team, no edge; the seeds are exactly the empty-registry baseline', () => {
    const packLike = { watchlist: [{ ats: 'greenhouse' as const, slug: 'acme', company: 'Acme' }], feeds: { enabled: [] } };
    const base = dailySeeds(packLike, '2026-10-15');
    expect(dailySeeds(packLike, '2026-10-15', undefined, [], false)).toEqual(base);
    expect(base.some((s) => s.ats === 'freehire')).toBe(false);
    for (const agents of [dailyAgents(packLike.watchlist), dailyAgents(packLike.watchlist, [], { leads: [] })]) {
      expect(agents.some((a) => a.contract.id === 'src-freehire-leads')).toBe(false);
      const p = dailyPipeline(agents);
      expect(p.teams.some((t) => t.id === 'sourcing-freehire')).toBe(false);
      expect(p.edges.some((e) => e.to === 'src-freehire-leads')).toBe(false);
    }
  });

  it('with leads: the agent, its team (after the platform teams), its edge and its seed; the pipeline compiles', () => {
    const packLike = { watchlist: [], feeds: { enabled: [] } };
    const agents = dailyAgents([], [], { leads: [lead(1)] });
    expect(agents.some((a) => a.contract.id === 'src-freehire-leads')).toBe(true);
    const p = dailyPipeline(agents);
    const ids = p.teams.map((t) => t.id);
    expect(ids.indexOf('sourcing-freehire')).toBeGreaterThan(ids.indexOf('sourcing'));
    expect(ids.indexOf('sourcing-freehire')).toBeLessThan(ids.indexOf('understanding'));
    expect(p.teams.find((t) => t.id === 'sourcing-freehire')?.members).toEqual(['src-freehire-leads']);
    expect(p.edges).toContainEqual({ type: 'DiscoveryRequest@1', to: 'src-freehire-leads' });
    expect(() => compileDaily(agents, appGuardrails())).not.toThrow();
    expect(dailySeeds(packLike, '2026-10-15', undefined, [], true)).toEqual([seed]);
  });

  it('the leads window is this coverage week and the one before', () => {
    // Thursday 2026-10-15: the week began on Sunday 2026-10-11
    expect(leadsSince('2026-10-15T01:30:00Z')).toBe('2026-10-04');
    expect(leadsSince('2026-10-11T01:00:00Z')).toBe('2026-10-04');
  });
});

describe('a lead and the same job read directly', () => {
  const row = (jobKey: string, source: string, firstSeen: string): LinkRow => ({ jobKey, source, firstSeen, dedupeKey: 'dddd', ats: null });

  it('are linked by the existing dedupe, the direct one primary even when the lead was seen first', () => {
    for (const direct of ['workday', 'himalayas', 'greenhouse']) {
      const { duplicateOf } = linkJobs([row('k1', 'freehire', AT), row('k2', direct, LATER)], () => []);
      expect(duplicateOf.get('k2'), direct).toBeNull();
      expect(duplicateOf.get('k1'), direct).toBe('k2');
    }
  });

  it('in the store: the lead row becomes the duplicate of the direct row, and the dashboard shows it as found through freehire', () => {
    const s = AppStore.on(Store.open(':memory:'));
    const { out } = { out: [normalize({ source: 'freehire', sourceId: 'lever:0001', company: 'Acme Robotics', slug: 'leads', raw: { url: 'https://jobs.example.com/lead/1', title: 'Senior Backend Engineer', company: 'Acme Robotics', location: 'Remote, India', postedAt: null, via: 'lever' } })] };
    const l = out[0] as Posting;
    s.upsertJob(jobRow({ jobKey: l.jobKey, source: 'freehire', sourceId: l.sourceId, slug: 'leads', company: l.company, title: l.title, ats: 'freehire', url: l.url, location: l.locationText, dedupeKey: 'dddddddddddddddd', verdict: 'review', at: AT }));
    s.upsertJob(jobRow({ jobKey: 'f000000000000001', source: 'workday', sourceId: 'acme|1', slug: 'acme', company: 'Acme Robotics', ats: 'workday', dedupeKey: 'dddddddddddddddd', at: LATER }));
    expect(s.getJob(l.jobKey)?.duplicateOf).toBe('f000000000000001');
    expect(s.getJob('f000000000000001')?.duplicateOf).toBeNull();
    const detail = s.getJob(l.jobKey);
    const page = jobBody({ job: detail as NonNullable<typeof detail>, csrf: 't', sent: { jobKey: l.jobKey, snapshots: [], changedSince: {}, canKeep: false, appliedDay: null, csrf: 't', istDay: (x) => x }, answers: null, display: (k) => k, recommended: { format: 'pdf', atsName: 'Most applicant systems' }, preferred: null, istDay: (x) => x }).value;
    expect(page).toContain('Found through freehire (via lever)');
  });
});

describe('the sources', () => {
  it('src/ names no personal data (the repo is public)', () => {
    const src = readFileSync(join(root, 'src/app/agents/sources/freehire-leads.ts'), 'utf8');
    expect(src).not.toMatch(/@[a-z0-9-]+\.(?:com|co\.jp)/iu);
  });
});
