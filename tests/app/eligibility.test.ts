import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonicalEmployment, decideEligibility, eligibility, fullTimeContract, NOTE_B2B, NOTE_OFFICE_PREFIX, officeNote } from '../../src/app/agents/eligibility.js';
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
  dedupeKey: 'fedcba9876543210',
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
    expect(text('You will be hired on a contract basis.')).toEqual(rejected('employment:contract'));
    expect(text('You will join as a contract employee.')).toEqual(rejected('employment:contract'));
    expect(text('This is a 6-month contract.')).toEqual(rejected('employment:contract'));
    expect(text('A 12 month contract, extendable.')).toEqual(rejected('employment:contract'));
    expect(text('The position is a contract engagement.')).toEqual(rejected('employment:contract'));
    expect(text('Contract-to-hire after 6 months.')).toEqual(rejected('employment:contract-to-hire'));
    expect(text('C2H opportunity.')).toEqual(rejected('employment:c2h'));
    expect(text('Hourly rate of $40.')).toEqual(rejected('employment:hourly'));
    expect(text('Hourly rate: ₹2,500.')).toEqual(rejected('employment:hourly'));
    expect(text('We pay $60 per hour.')).toEqual(rejected('employment:hourly'));
    expect(text('Pay: $40/hour.')).toEqual(rejected('employment:hourly'));
    expect(text('This is a temporary assignment covering parental leave.')).toEqual(rejected('employment:temporary'));
    expect(text('This is an hourly engagement.')).toEqual(rejected('employment:hourly'));
    expect(text('This is an internship for students.')).toEqual(rejected('employment:intern'));
    expect(text('This internship lasts six months.')).toEqual(rejected('employment:intern'));
    expect(text('Build services.', 'Backend Intern')).toEqual(rejected('role:\\bintern(ship)?\\b')); // the role rule comes first
    expect(text('This is a freelance role.')).toEqual(rejected('employment:freelance'));
    expect(text('Work with us on a freelance basis.')).toEqual(rejected('employment:freelance'));
    expect(text('A freelance contract for six months.')).toEqual(rejected('employment:freelance'));
    expect(decide({ employmentType: 'Regular', descriptionText: 'This is a contract role.' })).toEqual(rejected('employment:contract'));
    expect(text(`${'x'.repeat(1500)} this is a contract role`)).toEqual(ELIGIBLE_UNDISCLOSED);
  });

  it('final fix I7: employment words that do not describe the role never reject', () => {
    for (const d of [
      "Acme is the world's largest freelance marketplace, connecting businesses with talent.",
      'We run internships every summer and hire graduates.',
      "Our payroll product computes each worker's hourly rate and overtime.",
      'Our customers pay $15 per hour for on-demand GPU capacity.',
      'Our CLM platform helps legal teams manage every contract position and clause.',
      'We help companies fill temporary roles fast.',
      'Hourly rate: negotiable.',
      'A contract position with our client.',
      'We hire freelance developers.',
      'A six-month internship in our platform team.',
      // re-review R9: product text
      'You will work on contract engagement workflows for our CLM platform.',
      'You will be working on contract employee onboarding.',
      'Businesses join our marketplace as freelance contractor agencies.',
      'The engagement is a temporary staffing product.',
      'Ours is a contract management platform; this is a contract lifecycle tool for legal teams.',
      // rereview-2 M4: a product compound with no role noun after it stays product text
      'This is a contract management platform for engineering teams.',
      'This is a contract data platform used by procurement.',
    ])expect(decide({ employmentType: null, descriptionText: d }), d).toEqual(ELIGIBLE_UNDISCLOSED);
    // the role phrases still reject
    for (const [d, r] of [
      ['You will be hired on a contract basis.', 'employment:contract'],
      ['You will join as a freelance contractor.', 'employment:freelance'],
      ['You will be engaged as a contract employee.', 'employment:contract'],
      ['This position is a temporary engagement for 6 months.', 'employment:temporary'],
      ['The engagement is a temporary one for 6 months.', 'employment:temporary'],
      // rereview-2 M4: a role noun after the word means the phrase describes the role, not a product
      ['This is a contract data engineering role for 6 months.', 'employment:contract'],
      ['This is a contract software engineering position.', 'employment:contract'],
      ['The position is a contract platform engineering role.', 'employment:contract'],
      ['This is a contract data engineer opportunity.', 'employment:contract'],
      ['This is a contract software developer hire.', 'employment:contract'],
    ] as const) expect(decide({ employmentType: null, descriptionText: d }), d).toEqual(rejected(r));
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
    expect(d('Two days a week in the office.')).toEqual(rejected('hybrid'));
    expect(d('You will be in the office three days a week.')).toEqual(rejected('hybrid'));
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
    // fix round 4: more negations
    for (const t of [
      'No need for five days in the office; we are remote.',
      'There is no requirement to work from the office.',
      'Working from our office is not required.',
      'You will never need to work from the office.',
      'Fully remote, without any days in the office.',
    ]) expect(decide({ descriptionText: t }), t).toEqual(ELIGIBLE_UNDISCLOSED);
  });

  // Remote with no country named: JD exclusion phrases may reject it (no India scope of its own to protect).
  const FOREIGN = { remote: remote('remote', [], ['workplaceType:remote']), locationText: 'Remote' };
  const REVIEW_UNDISCLOSED = { verdict: 'review', reasons: ['remote-unclear'], notes: ['remote scope unclear - verify', 'pay not disclosed'] };

  it('5.2 remote that excludes India', () => {
    const f = (descriptionText: string) => decide({ ...FOREIGN, descriptionText });
    expect(decide({ remote: remote('remote', [], ['location:excludes:india']) })).toEqual(rejected('remote-excludes-india:location'));
    expect(decide({ remote: remote(null, ['india'], ['location:remote', 'location:excludes:mumbai']), locationText: 'Remote India (excluding Mumbai)' })).toEqual(ELIGIBLE_UNDISCLOSED);
    expect(f('Remote, US only.')).toEqual(rejected('remote-excludes-india:us-only'));
    expect(f('This role is USA-only.')).toEqual(rejected('remote-excludes-india:us-only'));
    expect(f('You must reside in the UK.')).toEqual(rejected('remote-excludes-india:must-reside'));
    expect(f('Must be located in the United States.')).toEqual(rejected('remote-excludes-india:must-reside'));
    expect(f('You must be authorized to work in the US.')).toEqual(rejected('remote-excludes-india:us-work-authorization'));
    expect(f('Remote (Europe only).')).toEqual(rejected('remote-excludes-india:eu-only'));
    expect(f('Remote, U.S. only.')).toEqual(rejected('remote-excludes-india:us-only'));
    expect(f('Remote, United States only.')).toEqual(rejected('remote-excludes-india:us-only'));
    expect(f('You must be authorized to work in the U.S.')).toEqual(rejected('remote-excludes-india:us-work-authorization'));
    expect(decide({ remote: remote('remote', ['canada', 'united states']), locationText: 'Remote' })).toEqual(rejected('remote-excludes-india:country-list'));
  });

  it('5.2 the pronoun "us" is not the US (I4)', () => {
    const f = (descriptionText: string) => decide({ ...FOREIGN, descriptionText });
    expect(f('Contact us only if you have 5 years of Java.')).toEqual(REVIEW_UNDISCLOSED);
    expect(f('Join us only after reading our values.')).toEqual(REVIEW_UNDISCLOSED);
    expect(f('People must be in the us team channel.')).toEqual(REVIEW_UNDISCLOSED);
  });

  it('5.2 a posting whose own location is Remote India: JD exclusion phrases only send it to review (fix round 3, C-R1)', () => {
    const india = (descriptionText: string) => decide({ descriptionText });
    for (const t of ['Remote, US only.', 'US residents only.', 'You must be authorized to work in the US.', 'Candidates must be located in the U.S.', 'Remote (EU only).'])
      expect(india(t), t).toEqual(REVIEW_UNDISCLOSED);
    // also via a structured India scope with an APAC location
    expect(decide({ remote: remote('remote', ['apac']), locationText: 'Remote - APAC', slug: 'example-gh', descriptionText: 'US only.' })).toEqual(REVIEW_UNDISCLOSED);
  });

  it('5.2 the reviewer\'s US-team and company sentences never reject a Remote India posting (fix round 3, C-R1)', () => {
    for (const t of [
      'You will work closely with our US-based team.',
      'Collaborate with US-based stakeholders.',
      'Partner with our US-based engineering team.',
      'Overlap with US-based colleagues for 3-4 hours.',
      'Report to our US-based CTO.',
      'Join a fast-growing US-based fintech.',
      'Acme is a U.S.-based SaaS leader.',
      'Acme (US-based) is hiring remote engineers.',
      'Founded in 2015 and based in the US, Acme builds billing software.',
      'Acme is headquartered in New York and based in the US.',
      'Our customers located in the U.S. rely on us.',
      'Our HQ is located in the US.',
      'We are among the largest fintechs within the US.',
      'Serve 10M users within the US.',
    ]) {
      const v = decide({ descriptionText: t });
      expect(v.verdict, t).not.toBe('rejected');
      expect(v, t).toEqual(ELIGIBLE_UNDISCLOSED); // and none of them is even an exclusion phrase now
      expect(decide({ ...FOREIGN, descriptionText: t }), t).toEqual(REVIEW_UNDISCLOSED);
    }
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
    // a location that does not say remote is not this rule (final fix L1: it is location-outside-india)
    expect(decide({ remote: remote(null, ['canada'], []), locationText: 'Toronto, Canada', descriptionText: 'Join us.' })).toEqual(rejected('location-outside-india'));
    // an Indian city in the list keeps it in scope
    expect(decide({ remote: remote(null, ['india', 'united states'], ['location:remote']), locationText: 'Remote, US; Bengaluru' })).toEqual(ELIGIBLE_UNDISCLOSED);
  });

  it('5.3 remote from India: eligible', () => {
    expect(decide({ remote: remote('remote', ['india']), locationText: 'Hyderabad' })).toEqual(ELIGIBLE_UNDISCLOSED);
    expect(decide({ remote: remote(null, ['india'], ['location:remote']), locationText: 'IN Remote India' })).toEqual(ELIGIBLE_UNDISCLOSED);
    // all-remote watchlist company (lever example-lv), even with a city and nothing saying remote
    expect(decide({ ats: 'lever', slug: 'example-lv', locationText: 'Bengaluru', remote: remote(null, ['india']) })).toEqual(ELIGIBLE_UNDISCLOSED);
    // hiresInIndia (greenhouse example-gh) with APAC, Asia, South Asia or worldwide (final fix I6: no longer with no
    // country at all, which is review)
    for (const c of [['apac'], ['asia'], ['south asia'], ['worldwide']]) {
      expect(decide({ slug: 'example-gh', remote: remote('remote', c), locationText: 'Remote' }), c.join()).toEqual(ELIGIBLE_UNDISCLOSED);
    }
    // feeds look the watchlist up by company
    expect(decide({ ats: 'feed', source: 'himalayas', slug: 'himalayas', company: 'example greenhouse co', remote: remote('remote', ['worldwide']) })).toEqual(ELIGIBLE_UNDISCLOSED);
  });

  it('final fix L1: a location naming only countries outside India rejects, whatever remote words the JD has', () => {
    const review = { verdict: 'review', reasons: ['remote-unclear'], notes: ['remote scope unclear - verify', 'pay not disclosed'] };
    // LIVE RUN 1: Tide (UK, Lithuania, Bulgaria, Serbia) and Celonis (Redwood City, US / New York, US); the JD says remote
    const tide = { locationText: 'UK; Lithuania; Bulgaria; Serbia', remote: remote(null, ['bulgaria', 'lithuania', 'serbia', 'united kingdom']), descriptionText: 'We are a remote-friendly team building banking for small businesses.' };
    const celonis = { locationText: 'Redwood City, US; New York, US', remote: remote(null, ['united states']), descriptionText: 'Remote work is supported. Build process mining services.' };
    expect(decide(tide)).toEqual(rejected('location-outside-india'));
    expect(decide(celonis)).toEqual(rejected('location-outside-india'));
    // allRemote and hiresInIndia boards do not rescue it
    expect(decide({ ...celonis, ats: 'lever', slug: 'example-lv' })).toEqual(rejected('location-outside-india'));
    expect(decide({ ...celonis, slug: 'example-gh' })).toEqual(rejected('location-outside-india'));
    // guard: the JD names India or a region with India as a place it hires: review instead
    expect(decide({ ...tide, descriptionText: 'Remote-friendly. We also hire in India.' })).toEqual(review);
    expect(decide({ ...celonis, descriptionText: 'Remote across APAC is possible.' })).toEqual(review);
    // but not when the JD excludes India
    expect(decide({ ...celonis, descriptionText: 'Remote anywhere except India.' })).toEqual(rejected('location-outside-india'));
    // India, APAC, Asia, South Asia or worldwide among the countries keeps the posting in scope
    for (const c of [['india', 'united states'], ['apac', 'united kingdom'], ['asia'], ['south asia'], ['worldwide', 'united states']]) {
      expect(decide({ locationText: 'x', remote: remote(null, c), descriptionText: 'We are remote-first.' }).reasons, c.join()).not.toContain('location-outside-india');
    }
    // the existing exclusion rules come first
    expect(decide({ ...celonis, descriptionText: 'Remote, US only.' })).toEqual(rejected('remote-excludes-india:us-only'));
    expect(decide({ ...tide, locationText: 'London, UK (hybrid)' })).toEqual(rejected('hybrid'));
  });

  it('rereview R1: the L1 guard needs a remote signal, and "global" or "worldwide" in prose is no region with India', () => {
    const review = { verdict: 'review', reasons: ['remote-unclear'], notes: ['remote scope unclear - verify', 'pay not disclosed'] };
    const onsite = (locationText: string, countries: string[], descriptionText: string) => ({ locationText, remote: remote(null, countries, []), descriptionText });
    // on-site foreign jobs whose JD only says "global", "worldwide", "anywhere", or names India or APAC without remote
    for (const p of [
      onsite('New York, New York, USA', ['united states'], 'We are a global leader in payments, serving customers worldwide.'),
      onsite('London, United Kingdom', ['united kingdom'], 'Our products are used globally, anywhere people pay.'),
      onsite('San Francisco, California, United States', ['united states'], 'You will support our APAC expansion.'),
      onsite('Toronto, Ontario, Canada', ['canada'], 'We also have engineering hubs in Bengaluru and Singapore.'),
      onsite('Tel Aviv, Israel', ['israel'], 'Join a global team; we have an office in India.'),
      onsite('United States', ['united states'], 'Our customers are in 40 countries worldwide.'),
    ]) expect(decide(p), p.locationText).toEqual(rejected('location-outside-india'));
    // something says remote, but the JD's only "region" is prose: still outside India
    expect(decide(onsite('Redwood City, US', ['united states'], 'Remote work is supported. We are a global company with customers worldwide.'))).toEqual(rejected('location-outside-india'));
    // LIVE RUN 1 Celonis benefits line: "globally" and "remote" in one sentence, but not about each other
    expect(decide(onsite('New York, US, New York', ['united states'], 'Enjoy generous PTO globally, as well as a work model that balances remote focus with vibrant office collaboration.'))).toEqual(rejected('location-outside-india'));
    // L1's intended cases stay: remote plus India (or APAC) named, or a remote sentence that says anywhere in the world
    expect(decide(onsite('Redwood City, US', ['united states'], 'Remote work is supported; we also hire in India.'))).toEqual(review);
    expect(decide(onsite('London, UK', ['united kingdom'], 'Fully remote across APAC is possible.'))).toEqual(review);
    expect(decide(onsite('Berlin, Germany', ['germany'], 'This role is fully remote: work from anywhere in the world.'))).toEqual(review);
    // LIVE RUN 1 ClickHouse: the title names the region ("APJ-Remote"), the location only two of its countries
    expect(decide({ ...onsite('Singapore; Australia', ['australia', 'singapore'], 'Run our cloud.'), title: 'Senior Site Reliability Engineer- (APJ-Remote)' })).toEqual(review);
  });

  it('final fix L2: working hours limited to time zones that exclude UTC+5:30 reject', () => {
    // re-review R2: a posting that names India is never rejected on time zones (see the next test), so these use a
    // remote posting with no country, like the LIVE RUN 1 Jobtome posting (location empty, worldwide)
    const india = { remote: remote('remote', ['worldwide']), locationText: '' };
    const tz = rejected('timezone-excludes-india');
    // LIVE RUN 1, in the title, with the Unicode minus
    expect(decide({ ...india, title: 'Senior Backend Developer (Go) — Full Remote, European Timezones Only (UTC−1 to UTC+3)' })).toEqual(tz);
    expect(decide({ ...india, locationText: 'Full Remote, European Timezones Only (UTC−1 to UTC+3)' })).toEqual(tz);
    // LIVE RUN 1 Grafana: "candidates in the USA EST time zones only"
    expect(decide({ remote: remote('remote', ['united states', 'canada']), locationText: 'USA | Remote', descriptionText: 'This is a remote position. We are looking for candidates in the USA EST time zones only.' })).toEqual(tz);
    for (const d of [
      'Full Remote, European Timezones Only.',
      'EU timezone only.',
      'US time zones only, please.',
      'American time zones only.',
      'Americas timezones only.',
      'EMEA time zones only.',
      'CET timezone only.',
      'EST time zone only.',
      'PST time zones only.',
      'Pacific time zone only.',
      'Eastern timezone only.',
      'You must work in US hours.',
      'Candidates must work within EU hours.',
      // re-review R2: a range or span counts only with restrictive wording
      'Working hours: UTC-1 to UTC+3 only.',
      'You must work UTC−8 to UTC−5.',
      'Candidates must be between GMT and GMT+2.',
      'Core hours UTC+1 ± 2 hours are required.',
      'You need to be based in UTC-5 +/- 3 hours.',
      'You need to be located between UTC-3 and UTC+3.',
      'Candidates in UTC-1 to UTC+3 only.',
      'We hire candidates in European time zones.',
      'Applicants from US time zones, please.',
    ]) expect(decide({ ...india, descriptionText: d }), d).toEqual(tz);
    // never: overlap, flexibility, APAC, or a range or span that includes +5:30
    for (const d of [
      // re-review R2: preferences and descriptions of where the team sits never count
      'The preferred timezone for this candidate will be GMT-4 to GMT+2.',
      'We prefer US time zones.',
      'Our team spans GMT to GMT+3 today.',
      'Our engineers sit in UTC-5 and UTC+1.',
      'Working hours: UTC-1 to UTC+3.',
      'Team hours UTC−8 to UTC−5.',
      'We work between GMT and GMT+2.',
      'Core hours UTC+1 ± 2 hours.',
      'Hours UTC-5 +/- 3 hours.',
      'Overlap with US hours is required.',
      'Some overlap with US hours is expected.',
      'At least 4 hours of overlap with US hours.',
      'Overlap with UTC-5 to UTC-1 for two hours a day.',
      'Flexible hours; US time zones only for on-call is not required.',
      'Flexible working hours.',
      'APAC timezones preferred.',
      'APAC time zones only.',
      'Working hours: UTC+4 to UTC+8.',
      'Core hours UTC+4 ± 2 hours.',
      'Asia time zones only.',
    ]) expect(decide({ ...india, descriptionText: d }).reasons, d).not.toContain('timezone-excludes-india');
  });

  it('rereview R2: a posting that names India or IST is never rejected on time zones', () => {
    const tzReview = { verdict: 'review', reasons: ['remote-unclear'], notes: ['remote scope unclear - verify', 'time zone may exclude India - verify', 'pay not disclosed'] };
    // LIVE RUN 1 Wikimedia: 19 countries with India, structured remote, a preferred zone: eligible as before L2
    const wikimedia = {
      locationText: 'Brazil, Canada, Colombia, Germany, Ghana, India, Indonesia, Italy, Kenya, Mexico, Morocco, Netherlands, Poland, Singapore, South Africa, Spain, Switzerland, United Kingdom, United States',
      remote: remote('remote', ['brazil', 'canada', 'colombia', 'germany', 'ghana', 'india', 'indonesia', 'italy', 'kenya', 'mexico', 'morocco', 'netherlands', 'poland', 'singapore', 'south africa', 'spain', 'switzerland', 'united kingdom', 'united states'], ['feed:remote-only']),
      employmentType: 'Full Time',
      descriptionText: 'In this role, you will work in a mostly-remote environment. To ensure there are enough opportunities to communicate, the preferred timezone for this candidate will be GMT-4 to GMT+2.',
    };
    expect(decide(wikimedia)).toEqual(ELIGIBLE_UNDISCLOSED);
    // the re-review's synthetic shapes: descriptions of the team are no restriction
    expect(decide({ remote: remote(null, ['india'], ['location:remote']), locationText: 'Remote (India)', descriptionText: 'Our engineers sit in UTC-5 and UTC+1, and we are hiring our first engineer in India.' })).toEqual(ELIGIBLE_UNDISCLOSED);
    expect(decide({ remote: remote(null, ['india'], ['location:remote']), locationText: 'Bengaluru, India (Remote)', descriptionText: 'Our team spans GMT to GMT+3 today and you will help us grow in India.' })).toEqual(ELIGIBLE_UNDISCLOSED);
    // overlap stays eligible
    expect(decide({ descriptionText: 'Some overlap with US hours is expected.' })).toEqual(ELIGIBLE_UNDISCLOSED);
    // a restriction on a posting that names India (countries, location, title, or India/IST in the text): review, never rejected
    for (const over of [
      { locationText: 'Remote - India', remote: remote('remote', ['india']), descriptionText: 'This is a remote role based in India. You must work within US business hours.' },
      { locationText: 'Remote - India', remote: remote('remote', ['india']), title: 'Senior Backend Developer (Go) — Full Remote, European Timezones Only (UTC−1 to UTC+3)' },
      { locationText: 'Remote - India', remote: remote('remote', ['india']), descriptionText: 'Design Java services. US time zones only.' },
      { locationText: 'Remote', remote: remote('remote', []), descriptionText: 'Candidates in India welcome. EU time zones only.' },
      { locationText: 'Remote', remote: remote('remote', []), descriptionText: 'You must work UTC+1 to UTC+4 only; IST candidates can shift.' },
      { locationText: 'Remote - APAC', remote: remote('remote', ['apac']), descriptionText: 'US time zones only.' },
    ]) expect(decide(over), JSON.stringify(over)).toEqual(tzReview);
  });

  it('final fix I6: remote with no country, region or worldwide is review whatever hiresInIndia says, unless allRemote', () => {
    const review = { verdict: 'review', reasons: ['remote-unclear'], notes: ['remote scope unclear - verify', 'pay not disclosed'] };
    // hiresInIndia (greenhouse example-gh): structured remote, plain remote location, and the Confluent USA1 shape
    expect(decide({ slug: 'example-gh', remote: remote('remote', []), locationText: 'Remote' })).toEqual(review);
    expect(decide({ slug: 'example-gh', remote: remote(null, [], ['location:remote']), locationText: 'Remote' })).toEqual(review);
    expect(decide({ slug: 'example-gh', remote: remote('remote', [], ['workplaceType:Remote', 'isRemote:true']), locationText: '*Job Posting Only: USA1' })).toEqual(review);
    // hiresInIndia still upgrades structured remote with worldwide, APAC or Asia
    for (const c of [['worldwide'], ['apac'], ['asia']]) expect(decide({ slug: 'example-gh', remote: remote('remote', c), locationText: 'Remote' }), c.join()).toEqual(ELIGIBLE_UNDISCLOSED);
    // an all-remote company (lever example-lv) stays eligible with no country
    expect(decide({ ats: 'lever', slug: 'example-lv', remote: remote('remote', []), locationText: 'Remote' })).toEqual(ELIGIBLE_UNDISCLOSED);
    // the Confluent posting through the normalizer: USA1 is the United States, so a hiresInIndia board does not rescue it
    const confluent = normalize({
      source: 'ashby', sourceId: 'c1', company: 'Example Greenhouse Co', slug: 'example-gh',
      raw: { id: 'c1', title: 'Senior Software Engineer', jobUrl: 'https://jobs.ashbyhq.com/x/c1', location: '*Job Posting Only: USA1', isRemote: true, workplaceType: 'Remote', employmentType: 'FullTime', descriptionPlain: 'Build storage.' },
    });
    expect(confluent.remote.countries).toEqual(['united states']);
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

  it('6. comp, end to end: a total word beside a component never rejects on the component (fix round 3, I-R1)', () => {
    const through = (descriptionText: string) =>
      decideEligibility(normalize({ source: 'jobicy', sourceId: '1', company: 'X', slug: 'jobicy', raw: { id: 1, jobTitle: 'Backend Engineer', companyName: 'X', url: 'https://jobicy.com/jobs/1', jobGeo: 'India', jobDescription: `<p>${descriptionText}</p>` } }), pack);
    for (const t of [
      'On-target earnings include a ₹10 LPA variable component.',
      'OTE includes ₹15 LPA variable.',
      'Your total compensation will include a joining bonus of ₹5 LPA.',
      'Total package includes ₹3 LPA relocation support.',
      'Total compensation includes base salary, bonus and RSUs worth up to ₹20 LPA.',
      'TC includes ₹25 LPA in ESOPs.',
      'Total rewards: ₹2 LPA learning stipend.',
    ]) expect(through(t), t).toEqual(ELIGIBLE_UNDISCLOSED);
    expect(through('OTE ₹50 LPA')).toEqual(rejected('below-floor:5000000'));
    expect(through('TC: $250,000')).toEqual({ verdict: 'eligible', reasons: [], notes: ['pay basis unclear'] });
    expect(through('Total compensation $40k–$60k')).toEqual(rejected('below-floor:5010000'));
    expect(through('CTC up to ₹45 LPA including variable')).toEqual(rejected('below-floor:4500000'));
  });

  it('4. employment: a bare contract word from filters.employmentDeny in the title rejects (fix round 2)', () => {
    expect(decide({ title: 'Java Developer (Contract)' })).toEqual(rejected('employment:contract'));
    expect(decide({ title: 'Contract Backend Engineer', employmentType: 'Full-time' })).toEqual(rejected('employment:contract'));
    expect(decide({ title: 'Backend Engineer (Contractor)' })).toEqual(rejected('employment:contractor'));
    expect(decide({ title: 'Backend Engineer - C2H' })).toEqual(rejected('employment:c2h'));
    expect(decide({ title: 'Backend Engineer - Contract-to-Hire' })).toEqual(rejected('employment:contract-to-hire'));
    expect(decide({ title: 'Freelance Backend Engineer' })).toEqual(rejected('employment:freelance'));
    expect(decide({ title: 'Smart Contract Engineer' })).toEqual(ELIGIBLE_UNDISCLOSED);
    expect(decide({ title: 'Backend Engineer, Smart Contracts' })).toEqual(ELIGIBLE_UNDISCLOSED);
    expect(decide({ title: 'Contract Testing Platform Engineer' })).toEqual(ELIGIBLE_UNDISCLOSED);
    expect(decide({ title: 'Backend Engineer, Contracts Platform' })).toEqual(ELIGIBLE_UNDISCLOSED); // "contracts" is not the word
  });

  it('4. employment: a bracket rejects only when it holds just the word, optionally with role or position (fix round 4)', () => {
    expect(decide({ title: 'Backend Engineer (Contract)' })).toEqual(rejected('employment:contract'));
    expect(decide({ title: 'Backend Engineer (Contractor)' })).toEqual(rejected('employment:contractor'));
    expect(decide({ title: 'Backend Engineer (Contract Role)' })).toEqual(rejected('employment:contract'));
    expect(decide({ title: 'Backend Engineer (Contract Position)' })).toEqual(rejected('employment:contract'));
    expect(decide({ title: 'Backend Engineer (Contract Intelligence)' })).toEqual(ELIGIBLE_UNDISCLOSED);
    expect(decide({ title: 'Backend Engineer (Contracts, Billing)' })).toEqual(ELIGIBLE_UNDISCLOSED);
  });

  it('4. employment: a title word counts only as a standalone qualifier (fix round 3)', () => {
    expect(decide({ title: 'Backend Engineer (6 months)' })).toEqual(rejected('employment:6 months'));
    expect(decide({ title: 'Backend Engineer [Contract]' })).toEqual(rejected('employment:contract'));
    expect(decide({ title: 'Senior Backend Engineer - Contract' })).toEqual(rejected('employment:contract'));
    expect(decide({ title: 'Backend Engineer | Freelance' })).toEqual(rejected('employment:freelance'));
    expect(decide({ title: 'Contract Java Developer' })).toEqual(rejected('employment:contract'));
    for (const t of [
      'Senior Backend Engineer - Contract Lifecycle Management', 'Backend Engineer, Contract Management Platform', 'Staff Engineer, Contracts',
      'Senior Engineer, Freelancer Marketplace', 'Backend Engineer - Hourly Billing', 'Senior Backend Engineer, Temporary Storage',
      'Backend Engineer - Fixed-Term Deposits', 'Contract Management Engineer', 'Backend Contractor Platform Engineer',
    ]) expect(decide({ title: t }), t).toEqual(ELIGIBLE_UNDISCLOSED);
  });

  it('5.2 India in the countries plus a remote JD is India scope too: a JD phrase goes to review (fix round 4)', () => {
    const blr = { remote: remote(null, ['india'], []), locationText: 'Bengaluru, India' };
    expect(decide({ ...blr, descriptionText: 'You must be located in the US. We are remote-first.' })).toEqual(REVIEW_UNDISCLOSED);
    expect(decide({ ...blr, descriptionText: 'You must be located in the US. This role is fully remote.' })).toEqual(REVIEW_UNDISCLOSED);
    // without any remote word it is not protected: the phrase rejects
    expect(decide({ ...blr, descriptionText: 'You must be located in the US.' })).toEqual(rejected('remote-excludes-india:must-reside'));
    // documented: Remote - Worldwide is a scope with India, so a JD phrase goes to review too
    expect(decide({ remote: remote('remote', ['worldwide']), locationText: 'Remote - Worldwide', descriptionText: 'US only.' })).toEqual(REVIEW_UNDISCLOSED);
  });

  it('5.2 must-reside is candidate-directed only; US forms case-sensitive (fix rounds 2 and 3)', () => {
    const f = (descriptionText: string) => decide({ ...FOREIGN, descriptionText });
    expect(f('You must be based in the US.')).toEqual(rejected('remote-excludes-india:must-reside'));
    expect(f('Candidates must be located in the U.S.')).toEqual(rejected('remote-excludes-india:must-reside'));
    expect(f('Applicants should live in the United States.')).toEqual(rejected('remote-excludes-india:must-reside'));
    expect(f('You need to be located in the US.')).toEqual(rejected('remote-excludes-india:must-reside'));
    expect(f('Candidates must be US-based.')).toEqual(rejected('remote-excludes-india:must-reside'));
    expect(f('US-based candidates only.')).toEqual(rejected('remote-excludes-india:must-reside'));
    expect(f('This is a US-based role.')).toEqual(rejected('remote-excludes-india:must-reside'));
    expect(f('The position is US-based.')).toEqual(rejected('remote-excludes-india:must-reside'));
    expect(f('Must be based in the United States.')).toEqual(rejected('remote-excludes-india:must-reside'));
    expect(f('US residents only.')).toEqual(rejected('remote-excludes-india:us-only'));
    expect(f('Applicants located in the U.S. only.')).toEqual(rejected('remote-excludes-india:us-only'));
    expect(f('You must be eligible to work in the US.')).toEqual(rejected('remote-excludes-india:us-work-authorization'));
    // dropped bare patterns and negatives: no exclusion
    for (const t of [
      'Candidates based in the US.', 'Applicants located in the U.S. are preferred.', 'Remote within the US.', 'This is a US-based remote company.',
      'We have teams in the US and India.', 'Our engineers are based in the US and India.', 'We are a US-based company hiring across APAC.',
      'A US-based company with a Pune team.', 'Tell us within the us channel.', 'Customers based in the us? no.', 'You must be eligible to work in the US or India.',
    ]) expect(f(t), t).toEqual(REVIEW_UNDISCLOSED);
  });

  it('every reason and note is one of the fixed codes', () => {
    const CODE = /^(closed|onsite|hybrid|remote-unclear|location-outside-india|timezone-excludes-india|role:.+|company:.+|employment:[a-z0-9 -]+|remote-excludes-india:(location|us-only|eu-only|must-reside|us-work-authorization|country-list)|below-floor:\d+)$/;
    const NOTES = new Set(['pay not disclosed', 'pay basis unclear', 'remote scope unclear - verify', 'time zone may exclude India - verify', NOTE_B2B]);
    const spec = appEvalSpecs(join(root, 'evals/datasets'), join(root, 'tests/fixtures/pack')).find((s) => s.agent.contract.id === 'eligibility')!;
    for (const k of spec.cases) {
      const v = decideEligibility(k.input as Posting, pack);
      for (const r of v.reasons) expect(r, k.id).toMatch(CODE);
      for (const n of v.notes) expect(NOTES.has(n), `${k.id}: ${n}`).toBe(true);
    }
  });
});

describe('D2 full-time B2B', () => {
  const B2B_DESC =
    'Remote role. Base Salary: $100K–$175K USD per year. Contract type: B2B. Work async with a small team, available across all countries.';
  const b2b = (over: Partial<Posting> = {}): Partial<Posting> => ({
    source: 'himalayas',
    ats: 'lever',
    slug: 'example-lv', // a watchlist entry that is all-remote, so the remote rule passes on its own
    title: 'Senior Bank & Integrations Engineer',
    employmentType: 'Contractor',
    descriptionText: B2B_DESC,
    comp: { min: 100000, max: 175000, currency: 'USD', period: 'year', basis: 'base' },
    remote: remote('remote', ['worldwide'], ['location:remote']),
    ...over,
  });

  it('a full-time B2B contractor role is eligible with the badge note', () => {
    expect(decide(b2b())).toEqual({ verdict: 'eligible', reasons: [], notes: [NOTE_B2B] });
    expect(NOTE_B2B).toBe('B2B contractor: no PF/benefits');
  });

  it('a short-term contract keeps the reject', () => {
    expect(decide(b2b({ descriptionText: `${B2B_DESC} This is a 6-month contract.` }))).toEqual(rejected('employment:contract'));
  });

  it('a contract title without B2B wording or a salary keeps the reject', () => {
    expect(decide({ title: 'Java Developer (Contract)' })).toEqual(rejected('employment:contract'));
  });

  it('an hourly rate is still an hourly reject', () => {
    const d = decide({ title: 'Java Developer', descriptionText: 'Contract type: B2B. We offer an hourly rate of $40.' });
    expect(d).toEqual(rejected('employment:hourly'));
  });

  it('the remote rule runs after the pass', () => {
    expect(decide(b2b({ slug: 'unlisted', ats: 'feed', remote: remote(null, ['united states'], []), locationText: 'United States' }))).toEqual(rejected('location-outside-india'));
  });

  it('the pay floor runs after the pass', () => {
    const d = decide(b2b({ comp: { min: 1000, max: 2000, currency: 'USD', period: 'year', basis: 'base' } }));
    expect(d.verdict).toBe('rejected');
    expect(d.reasons[0]).toMatch(/^below-floor:\d+$/);
  });

  it('contract-to-hire stays rejected even with B2B wording', () => {
    expect(decide(b2b({ employmentType: null, descriptionText: `${B2B_DESC} This is a contract-to-hire role.` }))).toEqual(rejected('employment:contract-to-hire'));
    expect(decide(b2b({ descriptionText: `${B2B_DESC} Contract-to-hire.` }))).toEqual(rejected('employment:contract'));
  });

  it('only a contract kind is exempt: freelance, temporary, part-time and hourly are never', () => {
    expect(decide(b2b({ employmentType: 'Temporary' }))).toEqual(rejected('employment:temporary'));
    expect(decide(b2b({ employmentType: 'Part-time' }))).toEqual(rejected('employment:part-time'));
    expect(decide(b2b({ title: 'Freelance Backend Engineer (Freelance)' }))).toEqual(rejected('employment:freelance'));
    expect(decide(b2b({ employmentType: 'Contract, Temporary' }))).toEqual(rejected('employment:contract'));
  });

  it('a non-contract kind anywhere in the 3,000-character window blocks the pass', () => {
    const pad = `${B2B_DESC} ${'filler '.repeat(280)}`; // c2h lands near character 2,000
    expect(pad.length).toBeGreaterThan(1900);
    expect(decide(b2b({ descriptionText: `${pad}This is a c2h role.` }))).toEqual(rejected('employment:contract'));
  });

  it('a title word Contractor counts as contract', () => {
    expect(decide(b2b({ employmentType: null, title: 'Contractor Java Developer' }))).toEqual({ verdict: 'eligible', reasons: [], notes: [NOTE_B2B] });
  });

  it('fullTimeContract: wording or a stated base salary, short-term wording vetoes', () => {
    const p = (over: Partial<Posting>): Posting => posting({ title: 'Engineer', ...over });
    expect(fullTimeContract(p({ descriptionText: 'Full-time contractor.' }))).toBe(true);
    expect(fullTimeContract(p({ descriptionText: 'A long-term contract.' }))).toBe(true);
    expect(fullTimeContract(p({ descriptionText: 'Contractor, full time.' }))).toBe(true);
    expect(fullTimeContract(p({ descriptionText: 'B2B agreement.' }))).toBe(true);
    expect(fullTimeContract(p({ comp: base(100, 200, 'USD') }))).toBe(true);
    expect(fullTimeContract(p({ comp: base(100, 200, 'USD', 'unknown') }))).toBe(false);
    expect(fullTimeContract(p({ descriptionText: 'Contract type: B2B. Part-time.' }))).toBe(false);
    expect(fullTimeContract(p({ descriptionText: 'Contract type: B2B. A short-term engagement.' }))).toBe(false);
    expect(fullTimeContract(p({ descriptionText: 'Contract type: B2B. Pay $50/hr.' }))).toBe(false);
    expect(fullTimeContract(p({ descriptionText: 'Contract type: B2B. Duration: 6 Months.' }))).toBe(false);
    expect(fullTimeContract(p({ descriptionText: 'Contract type: B2B. A 6-month project.' }))).toBe(false);
    expect(fullTimeContract(p({ descriptionText: 'Contract type: B2B. Expect ~15 hrs a week.' }))).toBe(false);
    expect(fullTimeContract(p({ descriptionText: 'Contract type: B2B. 40 hours per week.' }))).toBe(true);
    expect(fullTimeContract(p({ descriptionText: `${'x '.repeat(1600)}Contract type: B2B.` }))).toBe(false); // past 3,000 characters
  });
});

describe('office cities: onsite or hybrid in one of the pack\'s office cities passes with a badge', () => {
  const withOffice = (officeCities: string[]) => ({ ...pack, eligibility: { ...pack.eligibility, officeCities } });
  const pune = withOffice(['pune']);
  const onsite = (locationText: string, over: Partial<Posting> = {}): Partial<Posting> => ({ locationText, remote: remote('onsite', ['india']), ...over });
  const officeEligible = (display: string) => ({ verdict: 'eligible', reasons: [], notes: [officeNote(display), 'pay not disclosed'] });

  it('builds the note from the city display name', () => {
    expect(officeNote('Bengaluru')).toBe('office/hybrid: Bengaluru');
    expect(NOTE_OFFICE_PREFIX).toBe('office/hybrid: ');
  });

  it('a Pune onsite posting is eligible with the note', () => {
    expect(decide(onsite('Pune, Maharashtra, India'), pune)).toEqual(officeEligible('Pune'));
    // also when only the location text says onsite, or nothing says remote at all
    expect(decide({ locationText: 'Pune (On-site)', remote: remote(null, ['india']) }, pune)).toEqual(officeEligible('Pune'));
    expect(decide({ locationText: 'Pune, India', remote: remote(null, ['india']) }, pune)).toEqual(officeEligible('Pune'));
  });

  it('a Pune hybrid posting is eligible with the note', () => {
    expect(decide({ locationText: 'Pune, India', remote: remote('hybrid', ['india']) }, pune)).toEqual(officeEligible('Pune'));
    expect(decide({ locationText: 'Hybrid - Pune', remote: remote(null, ['india']) }, pune)).toEqual(officeEligible('Pune'));
    expect(decide({ locationText: 'Pune, India', remote: remote(null, ['india']), descriptionText: 'This is a hybrid role, 3 days a week in the office.' }, pune)).toEqual(officeEligible('Pune'));
  });

  it('an alias spelling matches its city key, case-insensitively, on word boundaries', () => {
    const blr = withOffice(['bengaluru']);
    expect(decide(onsite('Bangalore, Karnataka'), blr)).toEqual(officeEligible('Bengaluru'));
    expect(decide(onsite('BLR'), blr)).toEqual(officeEligible('Bengaluru'));
    expect(decide(onsite('bengaluru'), blr)).toEqual(officeEligible('Bengaluru'));
    expect(decide(onsite('Gurugram, Haryana'), withOffice(['Delhi NCR']))).toEqual(officeEligible('Delhi NCR'));
    expect(decide(onsite('Blrx Park'), blr)).toEqual(rejected('onsite')); // not on a word boundary
    // an unknown key matches only itself
    expect(decide(onsite('Kochi, Kerala'), withOffice(['kochi']))).toEqual(officeEligible('Kochi'));
    expect(decide(onsite('Cochin, Kerala'), withOffice(['kochi']))).toEqual(rejected('onsite'));
  });

  it('a Mumbai onsite posting is still onsite', () => {
    expect(decide(onsite('Mumbai, India'), pune)).toEqual(rejected('onsite'));
    expect(decide({ locationText: 'Mumbai, India', remote: remote('hybrid', ['india']) }, pune)).toEqual(rejected('hybrid'));
  });

  it('with no office cities nothing changes', () => {
    expect(decide(onsite('Pune, India'))).toEqual(rejected('onsite'));
    expect(decide(onsite('Pune, India'), withOffice([]))).toEqual(rejected('onsite'));
    expect(decide({ locationText: 'Pune, India', remote: remote('hybrid', ['india']) }, withOffice([]))).toEqual(rejected('hybrid'));
  });

  it('the comp floor still applies after it', () => {
    const v = decide(onsite('Pune, India', { comp: base(1_000_000, 2_000_000) }), pune);
    expect(v).toEqual(rejected('below-floor:2000000'));
    expect(decide(onsite('Pune, India', { comp: base(7_000_000, 9_000_000) }), pune)).toEqual({ verdict: 'eligible', reasons: [], notes: [officeNote('Pune')] });
  });

  it('earlier rules still reject first', () => {
    expect(decide(onsite('Pune, India', { company: 'Infosys' }), pune)).toEqual(rejected('company:Infosys'));
    expect(decide(onsite('Pune, India', { title: 'Senior Frontend Engineer' }), pune)).toEqual(rejected('role:front[- ]?end'));
  });

  it('a city named only in the description does not count', () => {
    expect(decide(onsite('India', { descriptionText: 'You will join our Pune engineering team.' }), pune)).toEqual(rejected('onsite'));
    expect(decide(onsite('Mumbai, India', { descriptionText: 'Teams in Pune and Mumbai.' }), pune)).toEqual(rejected('onsite'));
  });

  it('a relocation or residence requirement for another city keeps the reject', () => {
    expect(decide(onsite('Pune, India', { descriptionText: 'Relocate to Mumbai required.' }), pune)).toEqual(rejected('onsite'));
    expect(decide(onsite('Pune, India', { descriptionText: 'Relocation to Hyderabad is required within 3 months.' }), pune)).toEqual(rejected('onsite'));
    expect(decide(onsite('Pune, India', { descriptionText: 'You must be located in Chennai.' }), pune)).toEqual(rejected('onsite'));
    // relocation to the office city itself is fine
    expect(decide(onsite('Pune, India', { descriptionText: 'Relocation to Pune, Maharashtra is supported.' }), pune)).toEqual(officeEligible('Pune'));
  });

  it('a multi-location posting counts when any listed location is an office city in India', () => {
    expect(decide({ locationText: 'Pune, India; Remote US', remote: remote('hybrid', ['india', 'united states']) }, pune)).toEqual(officeEligible('Pune'));
    expect(decide({ locationText: 'San Francisco, US | Pune', remote: remote('onsite', ['india', 'united states']) }, pune)).toEqual(officeEligible('Pune'));
    // a structured location entry kept verbatim counts like the text
    expect(decide({ locationText: 'Office', remote: remote('onsite', ['pune']) }, pune)).toEqual(officeEligible('Pune'));
  });

  it('anything that excludes India keeps the reject', () => {
    expect(decide({ locationText: 'Pune', remote: remote('onsite', ['united states']) }, pune)).toEqual(rejected('onsite'));
    expect(decide({ locationText: 'India (excluding Pune)', remote: remote('onsite', ['india']) }, pune)).toEqual(rejected('onsite'));
    expect(decide({ locationText: 'Pune, India', remote: remote('onsite', ['india'], ['location:excludes:india']) }, pune)).toEqual(rejected('onsite'));
    expect(decide(onsite('Pune, India', { descriptionText: 'Candidates must be authorized to work in the US.' }), pune)).toEqual(rejected('onsite'));
  });

  it('a generic location field takes the city from an explicit label line in the description, for the office match only', () => {
    const blr = withOffice(['bengaluru']);
    const inOffice = (locationText: string, label: string, structured: Posting['remote']['structured'] = null): Partial<Posting> => ({
      locationText,
      remote: remote(structured, ['india']),
      descriptionText: `About the team\nWe build the edge network.\n${label}\nWhat you'll do: build services.`,
    });
    // a Cloudflare-like "In-Office" posting
    expect(decide(inOffice('In-Office', 'Location: Bengaluru'), blr)).toEqual(officeEligible('Bengaluru'));
    expect(decide(inOffice('Hybrid', 'Office - Bangalore, India', 'hybrid'), blr)).toEqual(officeEligible('Bengaluru'));
    expect(decide(inOffice('India', 'Work location: Bengaluru'), blr)).toEqual(officeEligible('Bengaluru'));
    expect(decide(inOffice('', 'Based in: Bengaluru'), blr)).toEqual(officeEligible('Bengaluru'));
    expect(decide(inOffice('N/A', 'Location: Mumbai; Bengaluru'), blr)).toEqual(officeEligible('Bengaluru')); // any listed city
    expect(decide(inOffice('In-Office', 'Available Locations: Bengaluru'), blr)).toEqual(officeEligible('Bengaluru'));
    expect(decide(inOffice('Hybrid', 'Available Locations: Mumbai/Bengaluru/New Delhi', 'hybrid'), blr)).toEqual(officeEligible('Bengaluru'));
    expect(decide(inOffice('N/A', 'Office location — Bengaluru, KA, India'), blr)).toEqual(officeEligible('Bengaluru'));
    // a label word inside prose is no label line
    expect(decide(inOffice('India', 'Snacks: on-the-house in the Bangalore office'), blr)).toEqual(rejected('onsite'));
    // with a generic field, "based|located|working in|at|from our <office city> office" counts (Tilt-like)
    expect(decide(inOffice('India', 'This role is Hybrid, based in our Bangalore office 2-3 days/week.'), blr)).toEqual(officeEligible('Bengaluru'));
    expect(decide(inOffice('In-Office', 'You will be working from our Bengaluru office.'), blr)).toEqual(officeEligible('Bengaluru'));
    expect(decide(inOffice('India', 'This role is Hybrid, based in our Hyderabad office 2-3 days/week.'), blr)).toEqual(rejected('hybrid'));
    expect(decide(inOffice('In-Office', 'You will be based in our Hyderabad office.'), blr)).toEqual(rejected('onsite'));
    // but never with a real location field
    expect(decide(inOffice('Hyderabad', 'You will be based in our Bangalore office.'), blr)).toEqual(rejected('onsite'));
    // the label names another city: stays onsite
    expect(decide(inOffice('In-Office', 'Location: Mumbai'), blr)).toEqual(rejected('onsite'));
    // a non-generic location field wins over the label
    expect(decide(inOffice('Hyderabad', 'Location: Bengaluru'), blr)).toEqual(rejected('onsite'));
    // no label line, only prose: stays onsite
    expect(decide(inOffice('In-Office', 'You will join our Bengaluru team.'), blr)).toEqual(rejected('onsite'));
    // the label never feeds the remote decision: a remote label on a generic location is not remote
    expect(decide(inOffice('In-Office', 'Location: Remote - India'), blr)).toEqual(rejected('onsite'));
    // a label line anywhere in the description counts (Stripe-like, at character 4600)
    const late = `${'Build services. '.repeat(260)}\nOffice-assigned staff spend half their time in the office.\n${'Build services. '.repeat(24)}\n\nOffice location—Bengaluru, KA, India`;
    expect(late.indexOf('Office location')).toBeGreaterThanOrEqual(4590);
    expect(decide({ ...inOffice('N/A', ''), descriptionText: late }, blr)).toEqual(officeEligible('Bengaluru'));
    expect(decide({ ...inOffice('Pune', ''), descriptionText: late }, blr)).toEqual(rejected('onsite'));
  });

  it('a "work from / based in / report to our <City> office" sentence naming another city keeps the reject', () => {
    expect(decide(onsite('Pune, India', { descriptionText: 'This role requires working from our Hyderabad office.' }), pune)).toEqual(rejected('onsite'));
    expect(decide(onsite('Pune, India', { descriptionText: 'You will be based in our Mumbai office.' }), pune)).toEqual(rejected('onsite'));
    expect(decide(onsite('Pune, India', { descriptionText: 'You will report to our Chennai office.' }), pune)).toEqual(rejected('onsite'));
    expect(decide(onsite('Pune, India', { descriptionText: 'This role requires working from our Pune office.' }), pune)).toEqual(officeEligible('Pune'));
  });

  it('knows Mysuru as data only', () => {
    expect(decide(onsite('Mysore, Karnataka'), withOffice(['mysuru']))).toEqual(officeEligible('Mysuru'));
    expect(decide(onsite('Mysore, Karnataka'), withOffice(['bengaluru']))).toEqual(rejected('onsite'));
  });

  it('the pack field is optional and absent means none', () => {
    expect(pack.eligibility.officeCities).toBeUndefined();
    expect(decide(onsite('Pune, India'))).toEqual(rejected('onsite'));
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
    for (const n of ['pay not disclosed', 'pay basis unclear', 'remote scope unclear - verify', 'time zone may exclude India - verify']) expect(notes.has(n), n).toBe(true);
    expect(expected.some((e) => e.verdict === 'review')).toBe(true);
    expect(spec.cases.filter((c) => c.id.startsWith('real-')).length).toBeGreaterThanOrEqual(15);
  });

  it('passes its gate of 1.0', async () => {
    const r = await runEval(spec, { providers: { fetch: async () => ({ status: 404, text: async () => '' }) }, policy: PRODUCT_POLICY_V1 });
    expect(r.failures).toEqual([]);
    expect(r).toMatchObject({ score: 1, pass: true, min: 1 });
    expect(r.packHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('runs the office-* cases on the fixture pack with one office city, every other case without', async () => {
    const office = specs.find((s) => s.name === 'eligibility-office')!;
    expect(office.agent.contract.id).toBe('eligibility');
    expect(office.cases.length).toBeGreaterThanOrEqual(10);
    expect(office.cases.every((c) => c.id.startsWith('office-'))).toBe(true);
    expect(spec.cases.some((c) => c.id.startsWith('office-'))).toBe(false);
    expect(office.cases.some((c) => (c.expected as { notes: string[] }).notes.includes(officeNote('Pune')))).toBe(true);
    const r = await runEval(office, { providers: { fetch: async () => ({ status: 404, text: async () => '' }) }, policy: PRODUCT_POLICY_V1 });
    expect(r.failures).toEqual([]);
    expect(r).toMatchObject({ name: 'eligibility-office', score: 1, pass: true });
    expect(r.packHash).not.toBe((await runEval(spec, { providers: { fetch: async () => ({ status: 404, text: async () => '' }) }, policy: PRODUCT_POLICY_V1 })).packHash);
  });

  it('datasets carry no forbidden fixture term', () => {
    for (const f of ['eligibility.jsonl', 'scorer-lexicon.jsonl']) assertNoForbidden(readFileSync(join(root, 'evals/datasets', f), 'utf8'), pack.naming);
  });
});
