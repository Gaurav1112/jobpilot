import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonicalEmployment, decideEligibility, eligibility } from '../../src/app/agents/eligibility.js';
import { appEvalSpecs } from '../../src/app/evals.js';
import { assertNoForbidden, loadPack } from '../../src/app/pack/load.js';
import { EligibilityVerdict, Posting } from '../../src/app/types.js';
import { freezePack, issueContext } from '../../src/kernel/broker.js';
import { fixedClock } from '../../src/kernel/clock.js';
import { PRODUCT_POLICY_V1 } from '../../src/kernel/policy.js';
import { runEval } from '../../src/evals/runner.js';

const root = join(import.meta.dirname, '../..');
const { pack: full } = loadPack(join(root, 'tests/fixtures/pack'));
const { contact: _c, answers: _a, ...pack } = full;
const frozen = freezePack(pack);

const posting = (over: Partial<Posting> = {}): Posting => ({
  jobKey: '0123456789abcdef',
  source: 'greenhouse',
  sourceId: 's1',
  company: 'Unlisted Co',
  slug: 'unlisted',
  ats: 'greenhouse',
  title: 'Senior Backend Engineer',
  url: 'https://jobs.example.com/1',
  locationText: 'Remote - India',
  remote: { structured: null, countries: ['india'], signals: ['location:remote'] },
  employmentType: null,
  descriptionText: 'Build services.',
  postedAt: null,
  comp: null,
  yearsRequired: null,
  ...over,
});
const remote = (structured: Posting['remote']['structured'], countries: string[], signals: string[] = []): Posting['remote'] => ({ structured, countries, signals });
const decide = (over: Partial<Posting>, p = pack) => decideEligibility(posting(over), p);
const rejected = (reason: string) => ({ verdict: 'rejected', reasons: [reason], notes: [] });
const ELIGIBLE_UNDISCLOSED = { verdict: 'eligible', reasons: [], notes: ['pay not disclosed'] };
const base = (min: number | null, max: number | null, currency: 'INR' | 'USD' = 'INR', basis: 'base' | 'unknown' = 'base') => ({ min, max, currency, period: 'year' as const, basis });

describe('eligibility, in spec §5.2 order; the first failure ends it', () => {
  it('1. closed: a blank title or URL', () => {
    expect(decide({ title: '  ' })).toEqual(rejected('closed'));
    expect(decide({ url: '' })).toEqual(rejected('closed'));
    // closed wins over everything after it
    expect(decide({ url: '', title: 'QA Engineer', company: 'Infosys' })).toEqual(rejected('closed'));
  });

  it('2. role: the first role-deny pattern the title matches, as written in the pack', () => {
    expect(decide({ title: 'Senior Frontend Engineer' })).toEqual(rejected('role:front[- ]?end'));
    expect(decide({ title: 'Software Engineer in Test' })).toEqual(rejected('role:in test'));
    expect(decide({ title: 'iOS Engineer' })).toEqual(rejected('role:\\bios\\b'));
    expect(decide({ title: 'Manager, Platform' })).toEqual(rejected('role:^manager\\b'));
    expect(decide({ title: 'Biostatistics Platform Engineer' }).verdict).toBe('eligible'); // "ios" inside a word
    // a blank pattern or deny word in the pack matches nothing rather than everything
    const blank = { ...pack, filters: { roleDeny: ['', ...pack.filters.roleDeny], companyDeny: [' '], employmentDeny: [''] } };
    expect(decide({}, blank)).toEqual(ELIGIBLE_UNDISCLOSED);
  });

  it('3. company: a deny-list name on word boundaries, case-insensitive', () => {
    expect(decide({ company: 'Infosys Limited' })).toEqual(rejected('company:Infosys'));
    expect(decide({ company: 'persistent systems' })).toEqual(rejected('company:Persistent'));
    expect(decide({ company: 'L&T Technology Services' })).toEqual(rejected('company:L&T Technology'));
    expect(decide({ company: 'Trust Bank' }).verdict).toBe('eligible'); // not UST
    expect(decide({ company: 'Eyeota' }).verdict).toBe('eligible'); // not EY
  });

  it('4. employment: canonical structured types; full-time only', () => {
    for (const v of ['FullTime', 'Full-Time', 'Full Time', 'FULL_TIME', 'full_time', 'Permanent', 'full-time']) expect(canonicalEmployment(v), v).toBe('full-time');
    expect(canonicalEmployment('Contract')).toBe('contract');
    expect(canonicalEmployment('Contractor')).toBe('contract');
    expect(canonicalEmployment('Temporary')).toBe('temporary');
    expect(canonicalEmployment('Intern')).toBe('intern');
    expect(canonicalEmployment('Internship')).toBe('intern');
    expect(canonicalEmployment('Part-time')).toBe('part-time');
    expect(canonicalEmployment('PartTime')).toBe('part-time');
    expect(canonicalEmployment('Regular')).toBeNull();
    expect(decide({ employmentType: 'FULL_TIME' })).toEqual(ELIGIBLE_UNDISCLOSED);
    expect(decide({ employmentType: 'Part-time' })).toEqual(rejected('employment:part-time'));
    expect(decide({ employmentType: 'Contractor' })).toEqual(rejected('employment:contract'));
    expect(decide({ employmentType: 'Temporary' })).toEqual(rejected('employment:temporary'));
    expect(decide({ employmentType: 'Internship' })).toEqual(rejected('employment:intern'));
    expect(decide({ employmentType: 'Full-Time, Contract' })).toEqual(ELIGIBLE_UNDISCLOSED); // full-time is offered
  });

  it('4. employment: with no (or no known) structured type, the pack deny words in the title or first 1500 chars', () => {
    expect(decide({ employmentType: null, title: 'Java Developer (Contract)' })).toEqual(rejected('employment:contract'));
    expect(decide({ employmentType: null, descriptionText: 'This is a 6 months fixed-term engagement.' })).toEqual(rejected('employment:fixed-term'));
    expect(decide({ employmentType: 'Full-time contract' })).toEqual(rejected('employment:contract'));
    expect(decide({ employmentType: null, descriptionText: `${'x'.repeat(1500)} contract` })).toEqual(ELIGIBLE_UNDISCLOSED);
    // a structured full-time type is trusted over incidental words in the text
    expect(decide({ employmentType: 'Full-time', descriptionText: 'Includes 6 months paid parental leave.' })).toEqual(ELIGIBLE_UNDISCLOSED);
  });

  it('5.1 onsite or hybrid: structured, or text in the title, location or first 1500 chars', () => {
    expect(decide({ remote: remote('onsite', ['india']) })).toEqual(rejected('onsite'));
    expect(decide({ remote: remote('hybrid', ['india']) })).toEqual(rejected('hybrid'));
    expect(decide({ locationText: 'Bengaluru (Hybrid)' })).toEqual(rejected('hybrid'));
    expect(decide({ descriptionText: 'Remote with 2 days a week in the office.' })).toEqual(rejected('hybrid'));
    expect(decide({ descriptionText: 'You will work 3 days in office.' })).toEqual(rejected('hybrid'));
    expect(decide({ descriptionText: 'This role is on-site in Pune.' })).toEqual(rejected('onsite'));
    expect(decide({ title: 'Backend Engineer (Onsite)' })).toEqual(rejected('onsite'));
    expect(decide({ remote: remote('remote', ['india']), descriptionText: `${'x'.repeat(1500)} hybrid` })).toEqual(ELIGIBLE_UNDISCLOSED);
    // documented refinements: technical uses of the words are not a work arrangement
    expect(decide({ descriptionText: 'Experience with hybrid cloud and an onsite interview loop.' })).toEqual(ELIGIBLE_UNDISCLOSED);
  });

  it('5.2 remote that excludes India', () => {
    expect(decide({ remote: remote('remote', [], ['location:excludes:india']) })).toEqual(rejected('remote-excludes-india:location'));
    expect(decide({ remote: remote(null, ['india'], ['location:remote', 'location:excludes:mumbai']), locationText: 'Remote India (excluding Mumbai)' })).toEqual(ELIGIBLE_UNDISCLOSED);
    expect(decide({ descriptionText: 'Remote, US only.' })).toEqual(rejected('remote-excludes-india:us-only'));
    expect(decide({ descriptionText: 'This role is USA-only.' })).toEqual(rejected('remote-excludes-india:us-only'));
    expect(decide({ descriptionText: 'You must reside in the UK.' })).toEqual(rejected('remote-excludes-india:must-reside'));
    expect(decide({ descriptionText: 'Must be located in the United States.' })).toEqual(rejected('remote-excludes-india:must-reside'));
    expect(decide({ descriptionText: 'You must be authorized to work in the US.' })).toEqual(rejected('remote-excludes-india:us-work-authorization'));
    expect(decide({ descriptionText: 'Remote (Europe only).' })).toEqual(rejected('remote-excludes-india:eu-only'));
    expect(decide({ remote: remote('remote', ['canada', 'united states']), locationText: 'Remote' })).toEqual(rejected('remote-excludes-india:country-list'));
    // not structured remote: the country list alone does not reject
    expect(decide({ remote: remote(null, ['canada'], ['location:remote']), locationText: 'Remote, Canada' }).verdict).toBe('review');
  });

  it('5.3 remote from India: eligible', () => {
    expect(decide({ remote: remote('remote', ['india']), locationText: 'Hyderabad' })).toEqual(ELIGIBLE_UNDISCLOSED);
    expect(decide({ remote: remote(null, ['india'], ['location:remote']), locationText: 'IN Remote India' })).toEqual(ELIGIBLE_UNDISCLOSED);
    // all-remote watchlist company (lever example-lv), even with a city and nothing saying remote
    expect(decide({ ats: 'lever', slug: 'example-lv', locationText: 'Bengaluru', remote: remote(null, ['india']) })).toEqual(ELIGIBLE_UNDISCLOSED);
    // hiresInIndia (greenhouse example-gh) with APAC, Asia, South Asia, worldwide or no country restriction
    for (const c of [['apac'], ['asia'], ['south asia'], ['worldwide'], []]) {
      expect(decide({ slug: 'example-gh', remote: remote('remote', c), locationText: 'Remote' }), c.join()).toEqual(ELIGIBLE_UNDISCLOSED);
    }
    // feeds look the watchlist up by company
    expect(decide({ ats: 'feed', source: 'himalayas', slug: 'himalayas', company: 'example greenhouse co', remote: remote('remote', ['worldwide']) })).toEqual(ELIGIBLE_UNDISCLOSED);
  });

  it('5.4 remote but unclear: review with the fixed note; nothing remote: onsite', () => {
    const review = { verdict: 'review', reasons: ['remote-unclear'], notes: ['remote scope unclear - verify', 'pay not disclosed'] };
    expect(decide({ remote: remote('remote', []), locationText: 'Remote' })).toEqual(review); // no watchlist entry
    expect(decide({ slug: 'example-ab', ats: 'ashby', remote: remote('remote', ['apac']), locationText: 'Remote - APAC' })).toEqual(review); // hiresInIndia false
    expect(decide({ remote: remote('remote', ['worldwide']), locationText: '' })).toEqual(review);
    // India named, but only the description says remote
    expect(decide({ remote: remote(null, ['india']), locationText: 'Bangalore, India', descriptionText: 'We are a remote-first company.' })).toEqual(review);
    expect(decide({ remote: remote(null, ['india']), locationText: 'Bangalore, India', descriptionText: 'Join our team.' })).toEqual(rejected('onsite'));
  });

  it('6. comp: disclosed base max below the floor rejects; unknown basis and open ranges never do', () => {
    expect(decide({ comp: base(3_000_000, 4_000_000) })).toEqual(rejected('below-floor:4000000'));
    expect(decide({ comp: base(50_000, 60_000, 'USD') })).toEqual(rejected('below-floor:5010000'));
    expect(decide({ comp: base(null, 4_000_000) })).toEqual(rejected('below-floor:4000000'));
    expect(decide({ comp: base(null, 1_200_000) })).toEqual({ verdict: 'eligible', reasons: [], notes: [] });
    expect(decide({ comp: base(70_000, 80_000, 'USD') })).toEqual({ verdict: 'eligible', reasons: [], notes: [] });
    expect(decide({ comp: base(1_000_000, null) })).toEqual({ verdict: 'eligible', reasons: [], notes: [] });
    expect(decide({ comp: base(3_000_000, 4_000_000, 'INR', 'unknown') })).toEqual({ verdict: 'eligible', reasons: [], notes: ['pay basis unclear'] });
    // a review posting still gets the comp check
    expect(decide({ remote: remote('remote', []), comp: base(1_000_000, 2_000_000) })).toEqual(rejected('below-floor:2000000'));
    // no floor in the pack: nothing is below it
    expect(decide({ comp: base(1, 2) }, { ...pack, offers: { floor: null } })).toEqual({ verdict: 'eligible', reasons: [], notes: [] });
  });

  it('every reason and note is one of the fixed codes', () => {
    const CODE = /^(closed|onsite|hybrid|remote-unclear|role:.+|company:.+|employment:[a-z0-9 -]+|remote-excludes-india:(location|us-only|eu-only|must-reside|us-work-authorization|country-list)|below-floor:\d+)$/;
    const NOTES = new Set(['pay not disclosed', 'pay basis unclear', 'remote scope unclear - verify']);
    const spec = appEvalSpecs(join(root, 'evals/datasets'), join(root, 'tests/fixtures/pack')).find((s) => s.agent.contract.id === 'eligibility')!;
    for (const k of spec.cases) {
      const v = decideEligibility(k.input as Posting, pack);
      for (const r of v.reasons) expect(r, k.id).toMatch(CODE);
      for (const n of v.notes) expect(NOTES.has(n), `${k.id}: ${n}`).toBe(true);
    }
  });
});

describe('eligibility agent', () => {
  const ctxWith = (p?: unknown) =>
    issueContext({
      contract: eligibility.contract, policy: PRODUCT_POLICY_V1, inputClass: 'P0', providers: { fetch: async () => ({ status: 404, text: async () => '' }) },
      clock: fixedClock('2026-01-01T00:00:00Z'), signal: new AbortController().signal, ...(p === undefined ? {} : { pack: p }),
    });

  it('emits exactly one EligibilityVerdict carrying the posting', async () => {
    const p = posting();
    const outs = await eligibility.run(p, ctxWith(frozen));
    expect(outs).toEqual([{ posting: p, ...ELIGIBLE_UNDISCLOSED }]);
    expect(EligibilityVerdict.schema.safeParse(outs[0]).success).toBe(true);
  });

  it('fails closed without a pack', async () => {
    await expect(eligibility.run(posting(), ctxWith())).rejects.toThrow(/pack/);
  });

  it('declares one skill, the pack capability, and no spend', () => {
    expect(eligibility.contract).toMatchObject({ id: 'eligibility', team: 'evaluation', kind: 'deterministic', capabilities: { pack: true } });
    expect(eligibility.contract.consumes.id).toBe(Posting.id);
    expect(eligibility.contract.produces.id).toBe(EligibilityVerdict.id);
  });
});

describe('eligibility golden eval', () => {
  const specs = appEvalSpecs(join(root, 'evals/datasets'), join(root, 'tests/fixtures/pack'));
  const spec = specs.find((s) => s.agent.contract.id === 'eligibility')!;

  it('has at least 30 cases covering every reject code, every note and the review path', () => {
    expect(spec.cases.length).toBeGreaterThanOrEqual(30);
    const expected = spec.cases.map((c) => c.expected as { verdict: string; reasons: string[]; notes: string[] });
    const reasons = new Set(expected.flatMap((e) => e.reasons.map((r) => r.replace(/^(role|company|employment|below-floor):.*/, '$1'))));
    for (const code of ['closed', 'role', 'company', 'employment', 'onsite', 'hybrid', 'remote-unclear', 'below-floor']) expect(reasons.has(code), code).toBe(true);
    for (const phrase of ['location', 'us-only', 'eu-only', 'must-reside', 'us-work-authorization', 'country-list']) expect(reasons.has(`remote-excludes-india:${phrase}`), phrase).toBe(true);
    const notes = new Set(expected.flatMap((e) => e.notes));
    for (const n of ['pay not disclosed', 'pay basis unclear', 'remote scope unclear - verify']) expect(notes.has(n), n).toBe(true);
    expect(expected.some((e) => e.verdict === 'review')).toBe(true);
    expect(spec.cases.filter((c) => c.id.startsWith('real-')).length).toBeGreaterThanOrEqual(15);
  });

  it('passes its gate of 1.0', async () => {
    const r = await runEval(spec, { providers: { fetch: async () => ({ status: 404, text: async () => '' }) }, policy: PRODUCT_POLICY_V1 });
    expect(r.failures).toEqual([]);
    expect(r).toMatchObject({ score: 1, pass: true, min: 1 });
    expect(r.packHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('datasets carry no forbidden fixture term', () => {
    for (const f of ['eligibility.jsonl', 'scorer-lexicon.jsonl']) assertNoForbidden(readFileSync(join(root, 'evals/datasets', f), 'utf8'), pack.naming);
  });
});
