import { describe, expect, it } from 'vitest';
import { decideGig } from '../../../src/app/freelance/gig-eligibility.js';
import { normalizeGig } from '../../../src/app/freelance/gig-normalizer.js';
import { FETCHING_PLATFORMS, PLATFORM_AGENT, freelanceAgents, freelancePipeline, freelanceSeeds } from '../../../src/app/freelance/pipeline.js';
import { FreelanceFile, PlatformRulesFile } from '../../../src/app/pack/freelance-schema.js';
import { rateOf } from '../../../src/app/freelance/rate.js';
import { DRAFTDEV_MAX_FILES, makeSrcDraftdev, parseOpenRoles, parseRoleFile, srcDraftdevContract } from '../../../src/app/freelance/sources/draftdev.js';
import { GITHUB_MAX_REQUESTS_PER_RUN, makeGithubHosts } from '../../../src/app/freelance/sources/github.js';
import type { GigRequest, RawGig } from '../../../src/app/freelance/types.js';
import { loadPack } from '../../../src/app/pack/load.js';
import { join } from 'node:path';
import { KernelError } from '../../../src/kernel/errors.js';
import { fx, githubHost } from '../../support/github-host.js';

const root = join(import.meta.dirname, '../../..');
const { pack } = loadPack(join(root, 'tests/fixtures/pack'));
const gigPack = { filters: pack.filters, naming: pack.naming, platformRules: pack.platformRules, freelance: pack.freelance };

const gh = (routes: Record<string, string>, o: { status?: number } = {}) => githubHost(srcDraftdevContract(), routes, o);
const API = 'https://api.github.com/repos/draftdev/jobs/contents/';
const req: GigRequest = { platform: 'draftdev', query: '', runDate: '2026-10-15', half: 'am' };
const decode = (name: string): string => Buffer.from((JSON.parse(fx(name)) as { content: string }).content, 'base64').toString('utf8');
const encoded = (md: string, name = 'writer-role.md'): string => JSON.stringify({ name, html_url: `https://github.com/draftdev/jobs/blob/main/${name}`, sha: 'abc', encoding: 'base64', content: Buffer.from(md).toString('base64') });
const listing = (...names: string[]): string => JSON.stringify(names.map((name) => ({ name, type: name.endsWith('.md') ? 'file' : 'dir', html_url: `https://github.com/draftdev/jobs/blob/main/${name}` })));

describe('src-draftdev', () => {
  it('the contract: io, its own team, api.github.com only, no LLM', () => {
    expect(srcDraftdevContract()).toMatchObject({ id: 'src-draftdev', version: '1.0.0', kind: 'io', team: 'sourcing-draftdev', skills: ['gig-sourcing'], egress: ['api.github.com'], capabilities: { http: true } });
    expect(srcDraftdevContract().retry).toEqual({ max: 1, on: ['overloaded', 'network', 'timeout'], backoffMs: [8000] });
  });

  it('reads the open writer role from the README and skips the closed strategist file', async () => {
    const h = gh({
      [API]: fx('draftdev/contents.json'),
      [`${API}README.md`]: fx('draftdev/readme.json'),
      [`${API}content-strategist.md`]: fx('draftdev/content-strategist.json'),
    });
    const out = await makeSrcDraftdev(makeGithubHosts()).run(req, h.ctx);
    expect(out.map((g) => g.sourceId)).toEqual(['readme:freelance-technical-writer']);
    expect(h.calls).toHaveLength(3);
    expect(h.skipped).toContain('draftdev: 1 closed roles skipped');
    const gig = normalizeGig(out[0] as RawGig);
    expect(gig).toMatchObject({ kind: 'gig', budget: { type: 'fixed', min: 300, max: null, currency: 'USD' }, location: { worldwide: true }, client: { name: 'Draft.dev' }, postedAt: null });
    expect(gig.url).toBe('https://draft.dev/write');
    expect(Object.keys((out[0] as RawGig).raw as object).sort()).toEqual(['file', 'readmeRemoteGlobal', 'sha', 'summary', 'text', 'title', 'url']);
  });

  it('the README gig is review (no hours, so no rate), never eligible', async () => {
    const h = gh({ [API]: fx('draftdev/contents.json'), [`${API}README.md`]: fx('draftdev/readme.json'), [`${API}content-strategist.md`]: fx('draftdev/content-strategist.json') });
    const gig = normalizeGig((await makeSrcDraftdev(makeGithubHosts()).run(req, h.ctx))[0] as RawGig);
    expect(decideGig({ gig, rate: rateOf(gig, pack.fx, 20) }, gigPack).verdict).toBe('review');
  });

  it('an open role file becomes a gig: hours and pay from its quote line, worldwide from "Remote (Global)"', async () => {
    const h = gh({ [API]: listing('writer-role.md'), [`${API}writer-role.md`]: fx('draftdev/writer-role.json') });
    const out = await makeSrcDraftdev(makeGithubHosts()).run(req, h.ctx);
    expect(out.map((g) => g.sourceId)).toEqual(['file:writer-role.md']);
    const gig = normalizeGig(out[0] as RawGig);
    expect(gig).toMatchObject({ kind: 'contract', budget: { type: 'hourly', min: 60, max: 80, currency: 'USD' }, hoursPerWeek: { min: 10, max: null, source: 'text' }, location: { worldwide: true } });
    expect(gig.url).toBe('https://github.com/draftdev/jobs/blob/main/writer-role.md');
    expect(h.skipped).toEqual([]);
  });

  it('a 40+ hours/week role is rejected by the hours rule', async () => {
    const md = decode('draftdev/writer-role.json').replace('10 hours/week', '40+ hours/week');
    const h = gh({ [API]: listing('writer-role.md'), [`${API}writer-role.md`]: encoded(md) });
    const gig = normalizeGig((await makeSrcDraftdev(makeGithubHosts()).run(req, h.ctx))[0] as RawGig);
    expect(gig.hoursPerWeek).toEqual({ min: 40, max: null, source: 'text' });
    expect(decideGig({ gig, rate: rateOf(gig, pack.fx, 20) }, gigPack).verdict).toBe('rejected');
  });

  it('a yearly salary is no freelance budget', async () => {
    const md = decode('draftdev/writer-role.json').replace('$60 - $80 USD/hour', '$85,000 - $120,000 USD/year');
    const h = gh({ [API]: listing('writer-role.md'), [`${API}writer-role.md`]: encoded(md) });
    const gig = normalizeGig((await makeSrcDraftdev(makeGithubHosts()).run(req, h.ctx))[0] as RawGig);
    expect(gig.budget.type).toBe('unknown');
  });

  it('a role file without a location the rules can read is not worldwide', async () => {
    const md = decode('draftdev/writer-role.json').replace('Remote (Global)', 'hybrid');
    const h = gh({ [API]: listing('writer-role.md'), [`${API}writer-role.md`]: encoded(md) });
    const gig = normalizeGig((await makeSrcDraftdev(makeGithubHosts()).run(req, h.ctx))[0] as RawGig);
    expect(gig.location).toMatchObject({ worldwide: false, countries: [] });
  });

  it('answers only draftdev requests', async () => {
    const h = gh({});
    expect(await makeSrcDraftdev(makeGithubHosts()).run({ ...req, platform: 'himalayas' }, h.ctx)).toEqual([]);
    expect(h.calls).toEqual([]);
  });

  it('more than the file cap is loud and reads no role file', async () => {
    const names = Array.from({ length: DRAFTDEV_MAX_FILES + 1 }, (_, i) => `role-${i}.md`);
    const h = gh({ [API]: listing('README.md', ...names) });
    await expect(makeSrcDraftdev(makeGithubHosts()).run(req, h.ctx)).rejects.toMatchObject({ code: 'input_rejected', message: expect.stringContaining('draftdev: 9 role files over the cap of 8') });
    expect(h.calls).toEqual([API]);
  });

  it('a 403 disables api.github.com for the run: the next GitHub source asks nothing', async () => {
    const hosts = makeGithubHosts();
    const first = gh({}, { status: 403 });
    await expect(makeSrcDraftdev(hosts).run(req, first.ctx)).rejects.toMatchObject({ code: 'challenged' });
    const second = gh({ [API]: fx('draftdev/contents.json') });
    await expect(makeSrcDraftdev(hosts).run(req, second.ctx)).rejects.toMatchObject({ code: 'input_rejected', message: expect.stringContaining('host-disabled:http-403 on api.github.com') });
    expect(second.calls).toEqual([]);
  });

  it('the per-run budget is loud', async () => {
    const hosts = makeGithubHosts();
    hosts.used = GITHUB_MAX_REQUESTS_PER_RUN;
    const h = gh({ [API]: fx('draftdev/contents.json') });
    const e = await makeSrcDraftdev(hosts).run(req, h.ctx).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(KernelError);
    expect((e as KernelError).message).toMatch(/github-budget/);
    expect(h.calls).toEqual([]);
  });
});

describe('the Draft.dev parsers', () => {
  it('parseOpenRoles reads the bullet: title, url, pay, text', () => {
    const r = parseOpenRoles(decode('draftdev/readme.json'));
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ title: 'Freelance Technical Writer', url: 'https://draft.dev/write', pay: '$300+ per blog post' });
    expect(r[0]?.text).toContain('no monthly minimums');
  });

  it('parseRoleFile: open, closed, and not a role file', () => {
    expect(parseRoleFile(decode('draftdev/content-strategist.json'))).toMatchObject({ title: 'Content Strategist', closed: true, summary: '$85,000 - $120,000 USD/year, 40+ hours/week, Remote (Global)' });
    expect(parseRoleFile(decode('draftdev/writer-role.json'))).toMatchObject({ title: 'Technical Writer', closed: false });
    expect(parseRoleFile('# Something else\n')).toBeNull();
    expect(parseRoleFile('')).toBeNull();
  });

  it('are linear on a 1 MB adversarial README', () => {
    const n = 1_000_000;
    const t0 = performance.now();
    parseOpenRoles(`## Open Roles\n${'- **['.repeat(n / 5)}\n${'](x) ('.repeat(n / 6)}`);
    parseOpenRoles(`## Open Roles\n${'- **[a](b) ('.repeat(n / 12)}`);
    parseOpenRoles(`## Open Roles\n${'- **[a](b) (x)**\n'.repeat(n / 16)}`);
    parseRoleFile(`# ${'a at [Draft.dev]('.repeat(n / 20)}`);
    parseRoleFile(`# T at [Draft.dev](x)\n${'> '.repeat(n / 2)}`);
    expect(performance.now() - t0).toBeLessThan(500);
  });
});

describe('Draft.dev in the wiring and the pack defaults', () => {
  it('on by default with no queries and a 2 s interval; one seed, after Himalayas and before boards', () => {
    const rules = FreelanceFile.parse({});
    expect(rules.platforms.draftdev).toEqual({ enabled: true, queries: [] });
    expect(PlatformRulesFile.parse({}).draftdev.minIntervalMs).toBe(2000);
    const seeds = freelanceSeeds(rules, '2026-10-15', 'am', [{}]).map((s) => s.platform);
    expect(seeds.filter((p) => p === 'draftdev')).toHaveLength(1);
    expect(seeds.indexOf('draftdev')).toBeGreaterThan(seeds.lastIndexOf('himalayas'));
    expect(seeds.indexOf('draftdev')).toBeLessThan(seeds.indexOf('boards'));
    expect(freelanceSeeds(rules, '2026-10-15', 'am', []).find((s) => s.platform === 'draftdev')).toEqual({ platform: 'draftdev', query: '', runDate: '2026-10-15', half: 'am' });
    expect(freelanceSeeds(FreelanceFile.parse({ platforms: { draftdev: { enabled: false } } }), '2026-10-15', 'am', []).some((s) => s.platform === 'draftdev')).toBe(false);
  });

  it('a team of its own, an edge, and a fresh GitHub host state per wiring', () => {
    const a = freelanceAgents();
    const p = freelancePipeline(a);
    expect(p.teams.find((t) => t.id === 'sourcing-draftdev')?.members).toEqual(['src-draftdev']);
    expect(p.edges).toContainEqual({ type: 'GigRequest@1', to: 'src-draftdev' });
    expect(PLATFORM_AGENT.draftdev).toBe('src-draftdev');
    expect(FETCHING_PLATFORMS).toContain('draftdev');
    expect(a.find((x) => x.contract.id === 'src-draftdev')).not.toBe(freelanceAgents().find((x) => x.contract.id === 'src-draftdev'));
  });
});
