import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonicalEmployment, decideEligibility, eligibility } from '../../src/app/agents/eligibility.js';
import { normalize } from '../../src/app/agents/normalizer.js';
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
    expect(decide({ company: 'HCLTech' })).toEqual(rejected('company:HCLTech')); // the current brand (task 7 fix round 1 pack)
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

  it('4. employment: with no (or no known) structured type, only employment phrases in the title or first 1500 chars reject', () => {
    const text = (descriptionText: string, title = 'Senior Backend Engineer') => decide({ employmentType: null, title, descriptionText });
    expect(text('This is a contract role for 9 months.')).toEqual(rejected('employment:contract'));
    expect(text('Hired on a contract basis.')).toEqual(rejected('employment:contract'));
    expect(text('A contract position with our client.')).toEqual(rejected('employment:contract'));
    expect(text('You will join as a contract employee.')).toEqual(rejected('employment:contract'));
    expect(text('This is a 6-month contract.')).toEqual(rejected('employment:contract'));
    expect(text('A 12 month contract, extendable.')).toEqual(rejected('employment:contract'));
    expect(text('Contract-to-hire after 6 months.')).toEqual(rejected('employment:contract-to-hire'));
    expect(text('C2H opportunity.')).toEqual(rejected('employment:c2h'));
    expect(text('Hourly rate: negotiable.')).toEqual(rejected('employment:hourly'));
    expect(text('We pay $60 per hour.')).toEqual(rejected('employment:hourly'));
    expect(text('A temporary position covering parental leave.')).toEqual(rejected('employment:temporary'));
    expect(text('A temporary role for the migration.')).toEqual(rejected('employment:temporary'));
    expect(text('A paid internship for students.')).toEqual(rejected('employment:intern'));
    expect(text('Build services.', 'Backend Intern')).toEqual(rejected('role:\\bintern(ship)?\\b')); // the role rule comes first
    expect(text('We hire freelance developers.')).toEqual(rejected('employment:freelance'));
    expect(decide({ employmentType: 'Regular', descriptionText: 'A contract role.' })).toEqual(rejected('employment:contract'));
    expect(text(`${'x'.repeat(1500)} contract role`)).toEqual(ELIGIBLE_UNDISCLOSED);
  });

  it('4. employment: the reviewer\'s six false rejections are eligible (I1)', () => {
    for (const d of [
      'In your first 6 months you will own the billing service.',
      'Benefits include 6 months parental leave.',
      'Run hourly batch jobs on Spark.',
      'Issue temporary credentials via STS.',
      'Consumer-driven contract testing with Pact.',
      'Build smart contract integrations for our wallet.',
    ]) expect(decide({ employmentType: null, descriptionText: d }), d).toEqual(ELIGIBLE_UNDISCLOSED);
    expect(decide({ employmentType: null, descriptionText: 'Processing 2M events per hour.' })).toEqual(ELIGIBLE_UNDISCLOSED); // per hour needs a pay figure
  });

  it('4. employment: full-time or permanent in the text passes, like a structured full-time type', () => {
    expect(decide({ employmentType: null, descriptionText: 'Full-time. A contract role converting later.' })).toEqual(ELIGIBLE_UNDISCLOSED);
    expect(decide({ employmentType: null, title: 'Backend Engineer (Permanent)', descriptionText: 'A contract basis is possible.' })).toEqual(ELIGIBLE_UNDISCLOSED);
    expect(decide({ employmentType: 'Full-time contract' })).toEqual(ELIGIBLE_UNDISCLOSED);
    expect(decide({ employmentType: 'Full-time', descriptionText: 'A contract role.' })).toEqual(ELIGIBLE_UNDISCLOSED);
  });

  it('5.1 onsite or hybrid: structured, or a bare word in the title or location', () => {
    expect(decide({ remote: remote('onsite', ['india']) })).toEqual(rejected('onsite'));
    expect(decide({ remote: remote('hybrid', ['india']) })).toEqual(rejected('hybrid'));
    expect(decide({ locationText: 'Bengaluru (Hybrid)' })).toEqual(rejected('hybrid'));
    expect(decide({ locationText: 'Pune - Onsite' })).toEqual(rejected('onsite'));
    expect(decide({ locationText: 'In-office, Pune' })).toEqual(rejected('onsite'));
    expect(decide({ title: 'Backend Engineer (Onsite)' })).toEqual(rejected('onsite'));
    expect(decide({ title: 'Backend Engineer - Hybrid' })).toEqual(rejected('hybrid'));
  });

  it('5.1 onsite or hybrid: only work-arrangement phrases in the first 1500 chars of the description', () => {
    const d = (descriptionText: string) => decide({ descriptionText });
    expect(d('Remote with 2 days a week in the office.')).toEqual(rejected('hybrid'));
    expect(d('You will work 3 days in office.')).toEqual(rejected('hybrid'));
    expect(d('In the office 3 days a week.')).toEqual(rejected('hybrid'));
    expect(d('We follow a hybrid work model.')).toEqual(rejected('hybrid'));
    expect(d('This is a hybrid role in Pune.')).toEqual(rejected('hybrid'));
    expect(d('A hybrid schedule.')).toEqual(rejected('hybrid'));
    expect(d('The role is hybrid.')).toEqual(rejected('hybrid'));
    expect(d('You will be working from our office in Pune.')).toEqual(rejected('onsite'));
    expect(d('Work from the office every day.')).toEqual(rejected('onsite'));
    expect(d('This is an on-site role.')).toEqual(rejected('onsite'));
    expect(d('Onsite presence required.')).toEqual(rejected('onsite'));
    expect(d('The position is onsite.')).toEqual(rejected('onsite'));
    expect(d('You must be based near Pune.')).toEqual(rejected('onsite'));
    expect(d('Must be located in Bengaluru or nearby.')).toEqual(rejected('onsite'));
    expect(d('Must be located near our office.')).toEqual(rejected('onsite'));
    expect(d('Relocation required.')).toEqual(rejected('onsite'));
    expect(d('Relocation is required to Dubai.')).toEqual(rejected('onsite'));
    expect(decide({ remote: remote('remote', ['india']), descriptionText: `${'x'.repeat(1500)} hybrid work model` })).toEqual(ELIGIBLE_UNDISCLOSED);
    // must be located in a country is not an office requirement
    expect(d('Must be based in India.')).toEqual(ELIGIBLE_UNDISCLOSED);
  });

  it('5.1 the reviewer\'s ten cases, negations and alternatives never reject (I2)', () => {
    for (const t of [
      'We run hybrid and multi-cloud infrastructure.',
      'Experience with hybrid/multi-cloud setups.',
      'Hybrid transactional/analytical processing (HTAP).',
      'Scale hybrid workloads.',
      'Build hybrid retrieval for search.',
      'This role is fully remote, not hybrid.',
      'You can work remote or hybrid.',
      'Remote or onsite, your choice.',
      'We meet once a year for an on-site team week.',
      'Occasionally provide onsite support to customers.',
      'Remote or hybrid work arrangements are available.',
      'There is no office; we are remote.',
      'Experience with hybrid cloud and an onsite interview loop.',
    ]) expect(decide({ descriptionText: t }), t).toEqual(ELIGIBLE_UNDISCLOSED);
    expect(decide({ locationText: 'Remote or Hybrid - India' })).toEqual(ELIGIBLE_UNDISCLOSED);
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
    expect(decide({ descriptionText: 'Remote, U.S. only.' })).toEqual(rejected('remote-excludes-india:us-only'));
    expect(decide({ descriptionText: 'Remote, United States only.' })).toEqual(rejected('remote-excludes-india:us-only'));
    expect(decide({ descriptionText: 'You must be authorized to work in the U.S.' })).toEqual(rejected('remote-excludes-india:us-work-authorization'));
    expect(decide({ remote: remote('remote', ['canada', 'united states']), locationText: 'Remote' })).toEqual(rejected('remote-excludes-india:country-list'));
  });

  it('5.2 the pronoun "us" is not the US (I4)', () => {
    expect(decide({ descriptionText: 'Contact us only if you have 5 years of Java.' })).toEqual(ELIGIBLE_UNDISCLOSED);
    expect(decide({ descriptionText: 'Join us only after reading our values.' })).toEqual(ELIGIBLE_UNDISCLOSED);
    expect(decide({ descriptionText: 'People must be in the us team channel.' })).toEqual(ELIGIBLE_UNDISCLOSED);
  });

  it('5.2 a remote location in foreign countries rejects, before allRemote and hiresInIndia (#5, I3)', () => {
    const us = { remote: remote(null, ['united states'], ['location:remote']), locationText: 'Remote, United States' };
    expect(decide(us)).toEqual(rejected('remote-excludes-india:country-list'));
    expect(decide({ remote: remote(null, ['canada'], ['location:remote']), locationText: 'CA Remote Ontario' })).toEqual(rejected('remote-excludes-india:country-list'));
    // an all-remote company (lever example-lv) and a hiresInIndia one (greenhouse example-gh) do not rescue it
    expect(decide({ ...us, ats: 'lever', slug: 'example-lv' })).toEqual(rejected('remote-excludes-india:country-list'));
    expect(decide({ ...us, slug: 'example-gh', remote: remote('remote', ['united states'], ['location:remote']) })).toEqual(rejected('remote-excludes-india:country-list'));
    // guard: the description names India or a region with India: review instead
    const review = { verdict: 'review', reasons: ['remote-unclear'], notes: ['remote scope unclear - verify', 'pay not disclosed'] };
    expect(decide({ ...us, descriptionText: 'We also hire in India through an employer of record.' })).toEqual(review);
    expect(decide({ ...us, descriptionText: 'Open across APAC.' })).toEqual(review);
    expect(decide({ ...us, ats: 'lever', slug: 'example-lv', descriptionText: 'Our team is spread across Asia.' })).toEqual(review);
    expect(decide({ ...us, descriptionText: 'Anywhere except India.' })).toEqual(rejected('remote-excludes-india:country-list'));
    // a location that does not say remote is not this rule
    expect(decide({ remote: remote(null, ['canada'], []), locationText: 'Toronto, Canada', descriptionText: 'Join us.' })).toEqual(rejected('onsite'));
    // an Indian city in the list keeps it in scope
    expect(decide({ remote: remote(null, ['india', 'united states'], ['location:remote']), locationText: 'Remote, US; Bengaluru' })).toEqual(ELIGIBLE_UNDISCLOSED);
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

  it('6. comp: a disclosed max below the floor rejects, base or unknown basis; open ranges never do', () => {
    expect(decide({ comp: base(3_000_000, 4_000_000) })).toEqual(rejected('below-floor:4000000'));
    expect(decide({ comp: base(50_000, 60_000, 'USD') })).toEqual(rejected('below-floor:5010000'));
    expect(decide({ comp: base(null, 4_000_000) })).toEqual(rejected('below-floor:4000000'));
    expect(decide({ comp: base(null, 1_200_000) })).toEqual({ verdict: 'eligible', reasons: [], notes: [] });
    expect(decide({ comp: base(70_000, 80_000, 'USD') })).toEqual({ verdict: 'eligible', reasons: [], notes: [] });
    expect(decide({ comp: base(1_000_000, null) })).toEqual({ verdict: 'eligible', reasons: [], notes: [] });
    // fix round 2: a total-type figure (CTC, total comp, OTE, package) is at least base, so its max below the floor rejects too
    expect(decide({ comp: base(3_000_000, 4_000_000, 'INR', 'unknown') })).toEqual(rejected('below-floor:4000000'));
    expect(decide({ comp: base(5_000_000, 7_000_000, 'INR', 'unknown') })).toEqual({ verdict: 'eligible', reasons: [], notes: ['pay basis unclear'] });
    expect(decide({ comp: base(2_000_000, null, 'INR', 'unknown') })).toEqual({ verdict: 'eligible', reasons: [], notes: ['pay basis unclear'] });
    // a review posting still gets the comp check
    expect(decide({ remote: remote('remote', []), comp: base(1_000_000, 2_000_000) })).toEqual(rejected('below-floor:2000000'));
    // no floor in the pack: nothing is below it
    expect(decide({ comp: base(1, 2) }, { ...pack, offers: { floor: null } })).toEqual({ verdict: 'eligible', reasons: [], notes: [] });
  });

  it('6. comp, end to end through the normalizer: total comp, OTE and pay plus equity below the floor reject (fix round 2)', () => {
    const through = (descriptionText: string) =>
      decideEligibility(normalize({ source: 'jobicy', sourceId: '1', company: 'X', slug: 'jobicy', raw: { id: 1, jobTitle: 'Backend Engineer', companyName: 'X', url: 'https://jobicy.com/jobs/1', jobGeo: 'India', jobDescription: `<p>${descriptionText}</p>` } }), pack);
    expect(through('Total compensation $40k–$60k')).toEqual(rejected('below-floor:5010000'));
    expect(through('OTE ₹50 LPA')).toEqual(rejected('below-floor:5000000'));
    expect(through('Salary: ₹30 LPA + equity')).toEqual(rejected('below-floor:3000000'));
    expect(through('Total compensation $100k–$150k')).toEqual({ verdict: 'eligible', reasons: [], notes: ['pay basis unclear'] });
    // components alone are still not pay
    expect(through('Bonus: ₹5 LPA')).toEqual(ELIGIBLE_UNDISCLOSED);
    expect(through('Variable pay: ₹4 LPA')).toEqual(ELIGIBLE_UNDISCLOSED);
    expect(through('₹10 LPA in ESOPs')).toEqual(ELIGIBLE_UNDISCLOSED);
  });

  it('4. employment: a bare contract word from filters.employmentDeny in the title rejects (fix round 2)', () => {
    expect(decide({ title: 'Java Developer (Contract)' })).toEqual(rejected('employment:contract'));
    expect(decide({ title: 'Contract Backend Engineer', employmentType: 'Full-time' })).toEqual(rejected('employment:contract'));
    expect(decide({ title: 'Backend Contractor' })).toEqual(rejected('employment:contractor'));
    expect(decide({ title: 'Backend Engineer - C2H' })).toEqual(rejected('employment:c2h'));
    expect(decide({ title: 'Backend Engineer - Contract-to-Hire' })).toEqual(rejected('employment:contract-to-hire'));
    expect(decide({ title: 'Freelance Backend Engineer' })).toEqual(rejected('employment:freelance'));
    expect(decide({ title: 'Smart Contract Engineer' })).toEqual(ELIGIBLE_UNDISCLOSED);
    expect(decide({ title: 'Backend Engineer, Smart Contracts' })).toEqual(ELIGIBLE_UNDISCLOSED);
    expect(decide({ title: 'Contract Testing Platform Engineer' })).toEqual(ELIGIBLE_UNDISCLOSED);
    expect(decide({ title: 'Backend Engineer, Contracts Platform' })).toEqual(ELIGIBLE_UNDISCLOSED); // "contracts" is not the word
  });

  it('5.2 more US exclusion phrases, case-sensitive on US forms (fix round 2)', () => {
    const d = (descriptionText: string) => decide({ descriptionText });
    expect(d('You must be based in the US.')).toEqual(rejected('remote-excludes-india:must-reside'));
    expect(d('Candidates based in the US.')).toEqual(rejected('remote-excludes-india:must-reside'));
    expect(d('Applicants located in the U.S. are preferred.')).toEqual(rejected('remote-excludes-india:must-reside'));
    expect(d('Applicants located in the U.S. only.')).toEqual(rejected('remote-excludes-india:us-only')); // us-only is checked first
    expect(d('Remote within the US.')).toEqual(rejected('remote-excludes-india:must-reside'));
    expect(d('This is a US-based remote role.')).toEqual(rejected('remote-excludes-india:must-reside'));
    expect(d('Remote within the USA.')).toEqual(rejected('remote-excludes-india:must-reside'));
    expect(d('Must be based in the United States.')).toEqual(rejected('remote-excludes-india:must-reside'));
    expect(d('US residents only.')).toEqual(rejected('remote-excludes-india:us-only'));
    expect(d('You must be eligible to work in the US.')).toEqual(rejected('remote-excludes-india:us-work-authorization'));
    // negatives
    expect(d('We have teams in the US and India.')).toEqual(ELIGIBLE_UNDISCLOSED);
    expect(d('Our engineers are based in the US and India.')).toEqual(ELIGIBLE_UNDISCLOSED);
    expect(d('We are a US-based company hiring across APAC.')).toEqual(ELIGIBLE_UNDISCLOSED);
    expect(d('A US-based company with a Pune team.')).toEqual(ELIGIBLE_UNDISCLOSED);
    expect(d('Tell us within the us channel.')).toEqual(ELIGIBLE_UNDISCLOSED);
    expect(d('Customers based in the us? no.')).toEqual(ELIGIBLE_UNDISCLOSED);
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
