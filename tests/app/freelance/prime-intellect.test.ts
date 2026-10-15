import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { decideGig } from '../../../src/app/freelance/gig-eligibility.js';
import { normalizeGig } from '../../../src/app/freelance/gig-normalizer.js';
import { FETCHING_PLATFORMS, PLATFORM_AGENT, freelanceAgents, freelancePipeline, freelanceSeeds } from '../../../src/app/freelance/pipeline.js';
import { rateOf } from '../../../src/app/freelance/rate.js';
import { BOUNTY_AMOUNT, PI_SEARCH_URL, makeSrcPrimeIntellect, srcPrimeIntellectContract } from '../../../src/app/freelance/sources/prime-intellect.js';
import { makeGithubHosts } from '../../../src/app/freelance/sources/github.js';
import type { GigRequest, RawGig } from '../../../src/app/freelance/types.js';
import { FreelanceFile, PlatformRulesFile } from '../../../src/app/pack/freelance-schema.js';
import { loadPack } from '../../../src/app/pack/load.js';
import { fx, githubHost } from '../../support/github-host.js';

const root = join(import.meta.dirname, '../../..');
const { pack } = loadPack(join(root, 'tests/fixtures/pack'));
const gigPack = { filters: pack.filters, naming: pack.naming, platformRules: pack.platformRules, freelance: pack.freelance };
const gh = (body: string, o: { status?: number } = {}) => githubHost(srcPrimeIntellectContract(), { [PI_SEARCH_URL]: body }, o);
const req: GigRequest = { platform: 'prime-intellect', query: '', runDate: '2026-10-15', half: 'am' };
const amountOf = (s: string): number | null => {
  const m = BOUNTY_AMOUNT.exec(s);
  if (m === null) return null;
  const n = Number((m[1] ?? m[3] ?? '').replace(/,/g, ''));
  return (m[2] ?? m[4]) === undefined ? n : n * 1000;
};

describe('src-prime-intellect', () => {
  it('the contract: io, its own team, api.github.com only, no LLM', () => {
    expect(srcPrimeIntellectContract()).toMatchObject({ id: 'src-prime-intellect', version: '1.0.0', kind: 'io', team: 'sourcing-prime-intellect', skills: ['gig-sourcing'], egress: ['api.github.com'], capabilities: { http: true }, description: 'Reads open Prime Intellect environment bounties through the GitHub search API' });
  });

  it('an empty open list is the normal answer: no gigs, the 0-open note, one request', async () => {
    const h = gh(fx('prime-intellect/search-empty.json'));
    expect(await makeSrcPrimeIntellect(makeGithubHosts()).run(req, h.ctx)).toEqual([]);
    expect(h.calls).toEqual([PI_SEARCH_URL]);
    expect(h.skipped).toEqual(['prime-intellect: 0 open bounty issues']);
  });

  it('two bounties become gigs; the PR and the unlabelled no-amount items are dropped and counted', async () => {
    const h = gh(fx('prime-intellect/search-two.json'));
    const out = await makeSrcPrimeIntellect(makeGithubHosts()).run(req, h.ctx);
    expect(out.map((g) => g.sourceId)).toEqual(['example-environments#17', 'example-environments#41']);
    expect(h.calls).toHaveLength(1);
    expect(h.skipped).toEqual(['prime-intellect: 2 matches without a bounty label or amount dropped']);
    const labelled = out[0] as RawGig;
    expect(labelled.raw).toMatchObject({ number: 17, repo: 'example-environments', url: 'https://github.com/PrimeIntellect-ai/example-environments/issues/17', amount: null, labels: ['\u{1F48E} Bounty', 'help wanted'], created_at: '2026-10-02T12:00:00Z' });
    expect(Object.keys(labelled.raw as object).sort()).toEqual(['amount', 'body', 'created_at', 'labels', 'number', 'repo', 'title', 'url']);
    expect((out[1] as RawGig).raw).toMatchObject({ amount: 1200 });
    const g17 = normalizeGig(labelled);
    expect(g17).toMatchObject({ kind: 'bounty', budget: { type: 'unknown' }, client: { name: 'Prime Intellect' }, postedAt: '2026-10-02', location: { worldwide: false, text: null }, hoursPerWeek: { min: null, max: null, source: null } });
    const g41 = normalizeGig(out[1] as RawGig);
    expect(g41).toMatchObject({ kind: 'bounty', budget: { type: 'fixed', min: 1200, max: 1200, currency: 'USD', from: 'description' }, location: { worldwide: true }, postedAt: '2026-10-10' });
  });

  it('a bounty is never eligible on a rate it does not state: review', async () => {
    const out = await makeSrcPrimeIntellect(makeGithubHosts()).run(req, gh(fx('prime-intellect/search-two.json')).ctx);
    for (const raw of out) {
      const gig = normalizeGig(raw);
      expect(decideGig({ gig, rate: rateOf(gig, pack.fx, 20) }, gigPack).verdict).not.toBe('rejected');
    }
    const unlabelled = normalizeGig(out[0] as RawGig);
    expect(decideGig({ gig: unlabelled, rate: rateOf(unlabelled, pack.fx, 20) }, gigPack).verdict).toBe('review');
  });

  it('incomplete_results and more than one page are loud notes', async () => {
    const h = gh(fx('prime-intellect/search-incomplete.json'));
    const out = await makeSrcPrimeIntellect(makeGithubHosts()).run(req, h.ctx);
    expect(out).toHaveLength(1);
    expect(h.skipped).toEqual(['prime-intellect: GitHub says the results are incomplete', 'prime-intellect: 119 more not read (one page)']);
  });

  it('answers only prime-intellect requests', async () => {
    const h = gh('{}');
    expect(await makeSrcPrimeIntellect(makeGithubHosts()).run({ ...req, platform: 'draftdev' }, h.ctx)).toEqual([]);
    expect(h.calls).toEqual([]);
  });

  it('a 403 disables api.github.com for the run; an answer that is not a search is invalid_output', async () => {
    const hosts = makeGithubHosts();
    await expect(makeSrcPrimeIntellect(hosts).run(req, gh('{}', { status: 403 }).ctx)).rejects.toMatchObject({ code: 'challenged' });
    expect(hosts.disabled).toBe('http-403');
    await expect(makeSrcPrimeIntellect(makeGithubHosts()).run(req, gh('{"message":"x"}').ctx)).rejects.toMatchObject({ code: 'invalid_output' });
  });

  it('every item unreadable is drift, not an empty list', async () => {
    await expect(makeSrcPrimeIntellect(makeGithubHosts()).run(req, gh('{"total_count":2,"items":[{"x":1},{"y":2}]}').ctx)).rejects.toMatchObject({ code: 'invalid_output' });
  });
});

describe('BOUNTY_AMOUNT', () => {
  it('reads $5k bounty as 5000 and finds nothing in "bounty of 300 credits"', () => {
    expect(amountOf('a $5k bounty')).toBe(5000);
    expect(amountOf('Bounty: $800 for it')).toBe(800);
    expect(amountOf('$1,200 bounty')).toBe(1200);
    expect(amountOf('bounty of 300 credits')).toBeNull();
  });

  it('is linear on 1 MB adversarial text', () => {
    const t0 = performance.now();
    for (const s of ['$1'.repeat(500_000), `$${' '.repeat(1_000_000)}`, `bounty ${'$1,'.repeat(300_000)}`, 'bounty'.repeat(160_000), `$${'9'.repeat(1_000_000)}`]) BOUNTY_AMOUNT.exec(s);
    expect(performance.now() - t0).toBeLessThan(500);
  });
});

describe('Prime Intellect in the wiring and the pack defaults', () => {
  it('on by default with no queries and a 2 s interval; one seed after Draft.dev', () => {
    const rules = FreelanceFile.parse({});
    expect(rules.platforms['prime-intellect']).toEqual({ enabled: true, queries: [] });
    expect(PlatformRulesFile.parse({})['prime-intellect'].minIntervalMs).toBe(2000);
    const seeds = freelanceSeeds(rules, '2026-10-15', 'am', []).map((s) => s.platform);
    expect(seeds.filter((p) => p === 'prime-intellect')).toHaveLength(1);
    expect(seeds.indexOf('prime-intellect')).toBeGreaterThan(seeds.indexOf('draftdev'));
    expect(freelanceSeeds(rules, '2026-10-15', 'am', []).find((s) => s.platform === 'prime-intellect')).toEqual({ platform: 'prime-intellect', query: '', runDate: '2026-10-15', half: 'am' });
    expect(freelanceSeeds(FreelanceFile.parse({ platforms: { 'prime-intellect': { enabled: false } } }), '2026-10-15', 'am', []).some((s) => s.platform === 'prime-intellect')).toBe(false);
  });

  it('a team of its own, an edge, and the run-wide GitHub host state shared with Draft.dev', () => {
    const a = freelanceAgents();
    const p = freelancePipeline(a);
    expect(p.teams.find((t) => t.id === 'sourcing-prime-intellect')?.members).toEqual(['src-prime-intellect']);
    expect(p.edges).toContainEqual({ type: 'GigRequest@1', to: 'src-prime-intellect' });
    expect(PLATFORM_AGENT['prime-intellect']).toBe('src-prime-intellect');
    expect(FETCHING_PLATFORMS).toContain('prime-intellect');
    expect(a.find((x) => x.contract.id === 'src-prime-intellect')).not.toBe(freelanceAgents().find((x) => x.contract.id === 'src-prime-intellect'));
  });
});
