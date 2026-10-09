import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decodeEntities, htmlToText } from '../../src/app/text/html.js';
import { countriesIn, jobKey, normLocation, normTitle, postedAtOf, remoteTextSignals, yearsRequired } from '../../src/app/text/norm.js';
import { normalize, normalizer } from '../../src/app/agents/normalizer.js';
import { ashbyParse } from '../../src/app/agents/sources/ashby.js';
import { greenhouseParse } from '../../src/app/agents/sources/greenhouse.js';
import { himalayasParse } from '../../src/app/agents/sources/himalayas.js';
import { jobicyParse } from '../../src/app/agents/sources/jobicy.js';
import { leverParse } from '../../src/app/agents/sources/lever.js';
import { Posting, type DiscoveryRequest, type RawPosting } from '../../src/app/types.js';
import type { AgentContext } from '../../src/kernel/agent.js';
import { KernelError } from '../../src/kernel/errors.js';

const hex16 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 16);

describe('decodeEntities', () => {
  it('decodes named, decimal and hex entities', () => {
    expect(decodeEntities('Tom &amp; Jerry &lt;3 &gt; &quot;q&quot; &apos;a&#39;')).toBe(`Tom & Jerry <3 > "q" 'a'`);
    expect(decodeEntities('&rsquo;&#8217;&#x2019;&#X2019;')).toBe('’’’’');
    expect(decodeEntities('caf&eacute; &Eacute;cole na&iuml;ve &ndash; &mdash; &hellip; &bull; &euro;5 &pound;6 &copy;')).toBe(
      'café École naïve – — … • €5 £6 ©',
    );
    expect(decodeEntities('a&nbsp;b&ensp;c')).toBe('a\u00a0b\u2002c');
  });

  it('maps the windows-1252 range the way browsers do, and refuses impossible code points', () => {
    expect(decodeEntities('&#150; &#151; &#146;')).toBe('– — ’');
    expect(decodeEntities('&#0; &#xD800; &#x110000;')).toBe('� � �');
  });

  it('leaves unknown names and bare ampersands alone', () => {
    expect(decodeEntities('AT&T R&D &notanentity; &ampere;')).toBe('AT&T R&D &notanentity; &ampere;');
    // Legacy names without a semicolon decode the way browsers do, when no letter or digit follows.
    expect(decodeEntities('a &amp b &nbsp c &copy 2026 &ampx')).toBe('a & b \u00a0 c © 2026 &ampx');
  });

  it('decodes exactly once', () => {
    expect(decodeEntities('&amp;amp; &amp;lt;p&amp;gt;')).toBe('&amp; &lt;p&gt;');
  });
});

describe('htmlToText', () => {
  it('turns block tags into newlines: paragraphs and headings get a blank line, br and div a line break', () => {
    expect(htmlToText('<p>One</p><p>Two</p>')).toBe('One\n\nTwo');
    expect(htmlToText('<h2>About</h2><p>Body</p>')).toBe('About\n\nBody');
    expect(htmlToText('<div>a</div><div>b</div>')).toBe('a\nb');
    expect(htmlToText('a<br>b<br/>c<BR />d')).toBe('a\nb\nc\nd');
    expect(htmlToText('a<br><br>b')).toBe('a\n\nb');
  });

  it('allows at most two newlines in a row', () => {
    expect(htmlToText('a<br><br><br><br>b<p></p><p></p><p>c</p>')).toBe('a\n\nb\n\nc');
  });

  it('collapses whitespace inside text, including source newlines and nbsp', () => {
    expect(htmlToText('<p>  lots \n\t of   space&nbsp;&nbsp;here </p>')).toBe('lots of space here');
  });

  it('strips inline tags without gluing or splitting words', () => {
    expect(htmlToText('<p>Build <b>payment</b> services with <a href="https://x.example/a>b">Go</a>.</p>')).toBe(
      'Build payment services with Go.',
    );
  });

  it('decodes entities after the tags are gone, so escaped markup stays text', () => {
    expect(htmlToText('<p>Use &lt;b&gt; for bold &amp; R&amp;D</p>')).toBe('Use <b> for bold & R&D');
  });

  it('drops script, style, template, noscript and comments', () => {
    expect(htmlToText('<p>a</p><script>var x = "<p>no</p>";</script><style>p{}</style><!-- hidden --><template>t</template><noscript>n</noscript><p>b</p>')).toBe(
      'a\n\nb',
    );
  });

  it('prefixes list items with "- "', () => {
    expect(htmlToText('<p>Needs:</p><ul><li>Go</li><li>Postgres</li></ul><p>Thanks</p>')).toBe('Needs:\n\n- Go\n- Postgres\n\nThanks');
    expect(htmlToText('<ol><li>first</li><li>second</li></ol>')).toBe('- first\n- second');
  });

  it('indents nested lists, keeping every item', () => {
    expect(htmlToText('<ul><li>A<ul><li>A1</li><li>A2<ul><li>A2a</li></ul></li></ul></li><li>B</li></ul>')).toBe(
      '- A\n  - A1\n  - A2\n    - A2a\n- B',
    );
  });

  it('keeps text after a nested list inside its parent item', () => {
    expect(htmlToText('<ul><li>A<ul><li>A1</li></ul>tail of A</li></ul>')).toBe('- A\n  - A1\n  tail of A');
  });

  it('keeps a <br> inside an <li> as an indented continuation of that item', () => {
    expect(htmlToText('<ul><li>Line one<br>line two</li><li>Next</li></ul>')).toBe('- Line one\n  line two\n- Next');
    expect(htmlToText('<ul><li><p>Para one</p><p>Para two</p></li></ul>')).toBe('- Para one\n\n  Para two');
  });

  it('puts the marker on the item text when the item wraps it in a block', () => {
    expect(htmlToText('<ul><li><p><strong>Lead:</strong> text</p></li><li><div>Two</div></li></ul>')).toBe('- Lead: text\n- Two');
  });

  it('handles bare <li> items (Lever lists) and unclosed items', () => {
    expect(htmlToText('\n<li>One</li>\n<li>Two</li>\n')).toBe('- One\n- Two');
    expect(htmlToText('<ul><li>One<li>Two</ul><p>after</p>')).toBe('- One\n- Two\n\nafter');
  });

  it('drops empty list items only', () => {
    expect(htmlToText('<ul><li></li><li> </li><li>Kept</li></ul>')).toBe('- Kept');
  });

  it('keeps every table cell, separating cells and rows', () => {
    expect(htmlToText('<table><tr><th>Level</th><th>Pay</th></tr><tr><td>L4</td><td>$1</td></tr><tr><td></td><td>x</td></tr></table>')).toBe(
      'Level | Pay\nL4 | $1\nx',
    );
  });

  it('leaves a stray < that is not a tag as text', () => {
    expect(htmlToText('<p>a < b and c > d</p>')).toBe('a < b and c > d');
  });

  it('removes soft hyphens and zero-width characters', () => {
    expect(htmlToText('<p>co\u00adop\u200b\ufeff \u2060x</p>')).toBe('coop x');
  });

  it('turns double-escaped Greenhouse content into text when decoded once first', () => {
    const escaped = '&lt;div class=&quot;content-intro&quot;&gt;&lt;p&gt;R&amp;amp;D &amp;nbsp;team&lt;/p&gt;&lt;ul&gt;&lt;li&gt;Go&lt;/li&gt;&lt;/ul&gt;&lt;/div&gt;';
    expect(htmlToText(decodeEntities(escaped))).toBe('R&D team\n\n- Go');
  });
});

describe('normTitle', () => {
  it('lowercases, collapses whitespace, strips gender suffixes', () => {
    expect(normTitle('  Senior   Backend  Engineer (m/f/d) ')).toBe('senior backend engineer');
    expect(normTitle('Backend Engineer (f/m/x)')).toBe('backend engineer');
    expect(normTitle('Backend Engineer (m/w/d)')).toBe('backend engineer');
    expect(normTitle('Backend Engineer (all genders)')).toBe('backend engineer');
  });

  it('strips trailing location parentheses but keeps other ones', () => {
    expect(normTitle('Backend Engineer (Remote)')).toBe('backend engineer');
    expect(normTitle('Backend Engineer (India)')).toBe('backend engineer');
    expect(normTitle('Backend Engineer (Remote - India)')).toBe('backend engineer');
    expect(normTitle('Backend Engineer (Remote, US only) (m/f/d)')).toBe('backend engineer');
    expect(normTitle('Senior Software Engineer (YDB Team)')).toBe('senior software engineer (ydb team)');
    expect(normTitle('QA Tester (Future Roles)')).toBe('qa tester (future roles)');
  });
});

describe('normLocation', () => {
  it('orders the parts, so the same place written two ways has one key', () => {
    expect(normLocation('Remote, India')).toBe('india, remote');
    expect(normLocation('India (Remote)')).toBe('india, remote');
    expect(normLocation('India - Hyderabad')).toBe('hyderabad, india');
    expect(normLocation('  ')).toBe('');
  });
});

describe('jobKey', () => {
  it('is the first 16 hex chars of sha256(company|normTitle|normLocation)', () => {
    expect(jobKey('Acme', 'Backend Engineer (m/f/d)', 'Remote, India')).toBe(hex16('acme|backend engineer|india, remote'));
    expect(jobKey('Acme', 'Backend Engineer', 'Remote, India')).toMatch(/^[0-9a-f]{16}$/);
  });

  it('is stable across casing, spacing, suffixes and location order', () => {
    const k = jobKey('Acme', 'Backend Engineer', 'Remote, India');
    expect(jobKey('ACME', '  backend   ENGINEER (Remote) ', 'India (Remote)')).toBe(k);
    expect(jobKey('Acme', 'Frontend Engineer', 'Remote, India')).not.toBe(k);
    expect(jobKey('Acme', 'Backend Engineer', 'Remote, Canada')).not.toBe(k);
    expect(jobKey('Acme2', 'Backend Engineer', 'Remote, India')).not.toBe(k);
  });
});

describe('countriesIn', () => {
  it('maps country names, aliases and Indian cities to canonical lowercase names, sorted', () => {
    expect(countriesIn('Remote, India')).toEqual(['india']);
    expect(countriesIn('Bengaluru, Karnataka')).toEqual(['india']);
    expect(countriesIn('Remote, US; Remote, UK; Remote, United Kingdom; USA')).toEqual(['united kingdom', 'united states']);
    expect(countriesIn('Remote Ireland; Remote, Australia; Remote, Canada; Remote, India')).toEqual(['australia', 'canada', 'india', 'ireland']);
  });

  it('maps regions to their tokens', () => {
    expect(countriesIn('Worldwide')).toEqual(['worldwide']);
    expect(countriesIn('Anywhere')).toEqual(['worldwide']);
    expect(countriesIn('APAC')).toEqual(['apac']);
    expect(countriesIn('Asia-Pacific')).toEqual(['apac']);
    expect(countriesIn('EMEA, LATAM, Americas')).toEqual(['americas', 'emea', 'latam']);
    expect(countriesIn('Remote - Europe')).toEqual(['europe']);
    expect(countriesIn('Remote - European Union')).toEqual(['europe']);
    expect(countriesIn('Southeast Asia')).toEqual(['southeast asia']);
    expect(countriesIn('Asia')).toEqual(['asia']);
  });

  it('needs whole words: tier codes and words containing a name are not countries', () => {
    expect(countriesIn('*Job Posting Only: USA1')).toEqual([]);
    expect(countriesIn('Indiana')).toEqual([]);
    expect(countriesIn('Remote')).toEqual([]);
    expect(countriesIn('')).toEqual([]);
  });
});

describe('remoteTextSignals', () => {
  it('names each remote, hybrid or onsite word found, with its origin', () => {
    expect(remoteTextSignals('location', 'Remote, India')).toEqual(['location:remote']);
    expect(remoteTextSignals('location', 'Hybrid - Pune')).toEqual(['location:hybrid']);
    expect(remoteTextSignals('location', 'On-site, Pune')).toEqual(['location:onsite']);
    expect(remoteTextSignals('title', 'Engineer (Remote or Hybrid)')).toEqual(['title:remote', 'title:hybrid']);
    expect(remoteTextSignals('location', 'Remotely Bengaluru')).toEqual([]);
  });
});

describe('yearsRequired', () => {
  it('takes the largest years figure in sentences about experience', () => {
    expect(yearsRequired('You have 5+ years of experience in Go.')).toBe(5);
    expect(yearsRequired('A minimum of 8 years of professional experience.')).toBe(8);
    expect(yearsRequired('3-5 years of experience with Java.')).toBe(5);
    expect(yearsRequired('3–5 yrs experience.')).toBe(5);
    expect(yearsRequired('- 2+ years experience with SQL\n- 7 years experience with Kafka')).toBe(7);
  });

  it('ignores years outside experience sentences, company ages, and values above 30', () => {
    expect(yearsRequired('We are a 10 years old company. Experience with Go is a plus.')).toBeNull();
    expect(yearsRequired('Our 10 years old company values experience.')).toBeNull();
    expect(yearsRequired('Founded 12 years ago, we value experience.')).toBeNull();
    expect(yearsRequired('Applicants must be 18 years of age; experience preferred.')).toBeNull();
    expect(yearsRequired('5 years of growth. Experience required.')).toBeNull();
    expect(yearsRequired('40 years experience.')).toBeNull();
    expect(yearsRequired('No figure, but experience matters.')).toBeNull();
    expect(yearsRequired('1.5 years experience')).toBeNull();
    expect(yearsRequired('100 years experience')).toBeNull();
  });
});

describe('postedAtOf', () => {
  it('keeps a real ISO date or datetime unchanged', () => {
    expect(postedAtOf('2026-07-21T17:30:38.012+00:00')).toBe('2026-07-21T17:30:38.012+00:00');
    expect(postedAtOf('2026-07-22T13:38:40-04:00')).toBe('2026-07-22T13:38:40-04:00');
    expect(postedAtOf('2026-10-01')).toBe('2026-10-01');
    expect(postedAtOf('2024-02-29')).toBe('2024-02-29');
  });

  it('converts epoch milliseconds and seconds', () => {
    expect(postedAtOf(1790799896055, 'ms')).toBe('2026-09-30T20:24:56.055Z');
    expect(postedAtOf(1791509657, 's')).toBe('2026-10-09T01:34:17.000Z');
    // A seconds field that actually carries milliseconds is read as milliseconds.
    expect(postedAtOf(1791509657000, 's')).toBe('2026-10-09T01:34:17.000Z');
  });

  it('is null for an impossible or unparseable date', () => {
    for (const bad of ['2026-02-30', '2025-02-29', '2026-13-01', '2026-10-01T25:00:00Z', '2026-10-01T10:61:00Z', 'yesterday', '10/01/2026', '', '0000-01-01', '1969-12-31']) {
      expect(postedAtOf(bad), bad).toBeNull();
    }
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) expect(postedAtOf(bad, 'ms'), String(bad)).toBeNull();
    expect(postedAtOf(null)).toBeNull();
    expect(postedAtOf({})).toBeNull();
    expect(postedAtOf(1790799896055)).toBeNull(); // a number with no stated unit is not guessed
  });
});

const fixtureJson = (name: string): unknown => JSON.parse(readFileSync(new URL(`../fixtures/sources/${name}.json`, import.meta.url), 'utf8'));

// ---------------------------------------------------------------------------
// The normalizer agent
// ---------------------------------------------------------------------------

const golden = (name: string): string => readFileSync(new URL(`../fixtures/normalizer/${name}.txt`, import.meta.url), 'utf8').replace(/\n$/, '');
const req = (ats: DiscoveryRequest['ats'], slug: string, company: string): DiscoveryRequest => ({ ats, slug, company, runDate: '2026-10-09' });
const raw = (source: string, r: Record<string, unknown>, company = 'Acme', slug = 'acme'): RawPosting => ({ source, sourceId: '1', company, slug, raw: r });
const one = (p: RawPosting): Posting => {
  const out = normalize(p);
  expect(Posting.schema.safeParse(out).success, JSON.stringify(Posting.schema.safeParse(out).error?.issues)).toBe(true);
  return out;
};
const listItems = (html: string): string[] =>
  [...html.matchAll(/<li\b[^>]*>([\s\S]*?)(?=<\/?li\b|<\/?[uo]l\b)/gi)].map((m) => htmlToText(m[1] ?? '')).filter((t) => t !== '');

const gh = greenhouseParse(fixtureJson('greenhouse-gitlab'), req('greenhouse', 'gitlab', 'GitLab')).postings;
const lv = leverParse(fixtureJson('lever-veeva'), req('lever', 'veeva', 'Veeva')).postings;
const ab = ashbyParse(fixtureJson('ashby-confluent'), req('ashby', 'confluent', 'Confluent')).postings;
const hm = himalayasParse(fixtureJson('himalayas')).postings;
const jbAny = jobicyParse(fixtureJson('jobicy-anywhere')).postings;
const jbApac = jobicyParse(fixtureJson('jobicy-apac')).postings;
const byId = (ps: readonly RawPosting[], id: string): RawPosting => {
  const p = ps.find((x) => x.sourceId === id);
  if (!p) throw new Error(`no posting ${id}`);
  return p;
};

/** The careers source's raw for the recorded JSON-LD job page (Task 5b fixture). */
const careersJsonLd = (): RawPosting => {
  const html = readFileSync(new URL('../fixtures/careers/job-jsonld.html', import.meta.url), 'utf8');
  const ld = JSON.parse(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html)?.[1] ?? 'null') as Record<string, unknown>;
  return {
    source: 'careers',
    sourceId: 'abcdef0123456789',
    company: 'Example Careers Co',
    slug: 'example-careers',
    raw: { url: 'https://careers.example/jobs/backend-engineer', jsonLd: ld, title: 'Senior Backend Engineer', text: 'Build payment services.\nGo\nPostgres' },
  };
};

describe('normalizer contract', () => {
  it('is a deterministic understanding agent with no capabilities, RawPosting@1 to Posting@1', () => {
    const c = normalizer.contract;
    expect(c.id).toBe('normalizer');
    expect(c.team).toBe('understanding');
    expect(c.kind).toBe('deterministic');
    expect(c.capabilities).toEqual({});
    expect(c.egress).toEqual([]);
    expect(c.consumes.name).toBe('RawPosting');
    expect(c.produces.name).toBe('Posting');
  });

  it('emits exactly one Posting per input', async () => {
    const out = await normalizer.run(byId(lv, 'a89d4ff8-b50b-4e56-9b74-0823d2751c66'), {} as AgentContext);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual(normalize(byId(lv, 'a89d4ff8-b50b-4e56-9b74-0823d2751c66')));
  });

  it('maps every recorded posting of every source to a valid Posting', () => {
    for (const p of [...gh, ...lv, ...ab, ...hm, ...jbAny, ...jbApac, careersJsonLd()]) one(p);
  });
});

describe('greenhouse', () => {
  it('maps the full posting (pay_input_ranges in cents, double-escaped content)', () => {
    expect(one(byId(gh, '8638232002'))).toEqual({
      jobKey: hex16('gitlab|ai transformation owner, cro|remote, united states'),
      source: 'greenhouse', sourceId: '8638232002', company: 'GitLab', slug: 'gitlab', ats: 'greenhouse',
      title: 'AI Transformation Owner, CRO',
      url: 'https://job-boards.greenhouse.io/gitlab/jobs/8638232002',
      locationText: 'Remote, United States',
      remote: { structured: null, countries: ['united states'], signals: ['location:remote'] },
      employmentType: null,
      descriptionText: golden('greenhouse-8638232002'),
      postedAt: '2026-07-22T13:38:40-04:00',
      comp: { min: 139200, max: 235200, currency: 'USD', period: 'year', basis: 'base' },
      yearsRequired: null,
    });
  });

  it('reads every country of a multi-location posting, and collapses title whitespace', () => {
    const p = one(byId(gh, '8869149002'));
    expect(p.title).toBe('Recruiter, GTM');
    expect(p.remote.countries).toEqual(['australia', 'canada', 'india', 'ireland', 'mexico', 'poland', 'united kingdom', 'united states']);
    expect(p.remote.structured).toBeNull();
  });

  it('decodes the escaped content once, then strips it: no tag or entity survives, every list item does', () => {
    for (const p of gh) {
      const text = one(p).descriptionText;
      expect(text).not.toMatch(/<\/?[a-z][a-z0-9]*\b[^>]*>|&[a-z]+;|&#\d+;/i);
      const content = decodeEntities((p.raw as { content: string }).content);
      for (const item of listItems(content)) expect(text, item).toContain(`- ${item.split('\n')[0]}`);
    }
  });

  it('handles HTML entities inside double-escaped content', () => {
    const p = one(raw('greenhouse', { id: 1, title: 'Eng', absolute_url: 'https://x.example/1', location: { name: 'Remote' }, content: '&lt;p&gt;R&amp;amp;D &amp;amp; caf&amp;eacute; &amp;lt;b&amp;gt;&lt;/p&gt;&lt;ul&gt;&lt;li&gt;A&lt;br&gt;B&lt;/li&gt;&lt;/ul&gt;' }));
    expect(p.descriptionText).toBe('R&D & café <b>\n\n- A\n  B');
  });

  it('converts pay ranges: cents to units, INR first, one currency only, hourly and OTE are not base', () => {
    const base = { id: 1, title: 'Eng', absolute_url: 'https://x.example/1', location: { name: 'Remote' }, content: '' };
    const range = (min: number, max: number, cur: string, title = 'Salary Range', blurb = '') => ({ min_cents: min, max_cents: max, currency_type: cur, title, blurb });
    const comp = (ranges: unknown[]) => one(raw('greenhouse', { ...base, pay_input_ranges: ranges })).comp;
    expect(comp([range(10880000, 14960000, 'USD', 'Zone 3 Pay Range')])).toEqual({ min: 108800, max: 149600, currency: 'USD', period: 'year', basis: 'unknown' });
    expect(comp([range(10880000, 14960000, 'USD', 'US Base Salary')])).toEqual({ min: 108800, max: 149600, currency: 'USD', period: 'year', basis: 'base' });
    // Several zones in one currency: the union.
    expect(comp([range(10000000, 12000000, 'USD', 'Zone 1 Base Salary'), range(9000000, 11000000, 'USD', 'Zone 2 Base Salary')])).toEqual({ min: 90000, max: 120000, currency: 'USD', period: 'year', basis: 'base' });
    // A neutral title defers to the blurb; an explicit base there makes it base.
    expect(comp([range(10000000, 12000000, 'USD', 'Zone 1 Salary', '<p>The base salary range for this role</p>')])?.basis).toBe('base');
    expect(comp([range(10000000, 12000000, 'USD', 'Zone 1 Salary')])?.basis).toBe('unknown');
    // An INR range is the one that applies to India.
    expect(comp([range(10000000, 12000000, 'USD', 'US Salary'), range(400000000, 120000000, 'INR', 'India Base Salary')])).toEqual({ min: 4000000, max: 1200000, currency: 'INR', period: 'year', basis: 'base' });
    // Two currencies without INR: no single figure is faithful.
    expect(comp([range(10000000, 12000000, 'USD', 'US Salary'), range(9000000, 11000000, 'EUR', 'EU Salary')])).toBeNull();
    // Unsupported currency, hourly, OTE.
    expect(comp([range(10000000, 12000000, 'CAD', 'Canada Salary')])).toBeNull();
    expect(comp([range(4000, 4000, 'USD', 'Hourly Pay Range')])).toBeNull();
    expect(comp([range(15000000, 20000000, 'USD', 'OTE Range', '<p>On-target earnings, base salary plus commission</p>')])?.basis).toBe('unknown');
    // An empty list falls back to the text.
    expect(one(raw('greenhouse', { ...base, pay_input_ranges: [], content: '&lt;p&gt;Base salary: $120,000 - $150,000&lt;/p&gt;' })).comp).toEqual({ min: 120000, max: 150000, currency: 'USD', period: 'year', basis: 'base' });
  });

  it('reads an employment type from metadata when the board exposes one', () => {
    const base = { id: 1, title: 'Eng', absolute_url: 'https://x.example/1', location: { name: 'Remote' }, content: '' };
    expect(one(raw('greenhouse', { ...base, metadata: [{ name: 'Employment Type', value: 'Full-time' }] })).employmentType).toBe('Full-time');
    expect(one(raw('greenhouse', { ...base, metadata: [{ name: 'Quota Coverage Type', value: 'n/a' }] })).employmentType).toBeNull();
  });
});

describe('lever', () => {
  it('maps the full posting (remote India)', () => {
    expect(one(byId(lv, 'a89d4ff8-b50b-4e56-9b74-0823d2751c66'))).toEqual({
      jobKey: hex16('veeva|netsuite developer|hyderabad, india'),
      source: 'lever', sourceId: 'a89d4ff8-b50b-4e56-9b74-0823d2751c66', company: 'Veeva', slug: 'veeva', ats: 'lever',
      title: 'NetSuite Developer',
      url: 'https://jobs.lever.co/veeva/a89d4ff8-b50b-4e56-9b74-0823d2751c66',
      locationText: 'India - Hyderabad',
      remote: { structured: 'remote', countries: ['india'], signals: ['workplaceType:remote'] },
      employmentType: 'Full-Time',
      descriptionText: golden('lever-a89d4ff8'),
      postedAt: '2026-09-30T20:24:56.055Z',
      comp: null,
      yearsRequired: 3,
    });
  });

  it('keeps the description, every list with its heading, and the closing section', () => {
    for (const p of lv) {
      const r = p.raw as { description: string; additional: string; lists: { text: string; content: string }[] };
      const text = one(p).descriptionText;
      expect(text.startsWith(htmlToText(r.description).slice(0, 40))).toBe(true);
      for (const l of r.lists) {
        expect(text).toContain(l.text.trim());
        for (const item of listItems(l.content)) expect(text, item).toContain(`- ${item.split('\n')[0]}`);
      }
      expect(text).toContain(htmlToText(r.additional).split('\n').at(-1));
    }
  });

  it('reads comp from a Compensation list line, as base', () => {
    const p = one(byId(lv, '9ac55b31-df46-4acb-b305-2c0b7ed56027'));
    expect(p.comp).toEqual({ min: 95000, max: 140000, currency: 'USD', period: 'year', basis: 'base' });
    expect(p.remote).toEqual({ structured: 'onsite', countries: ['united states'], signals: ['workplaceType:onsite'] });
  });

  it('maps workplaceType remote, hybrid, onsite and unspecified', () => {
    const base = { id: '1', text: 'Eng', hostedUrl: 'https://jobs.lever.co/x/1', categories: { location: 'Pune, India' }, description: '' };
    const r = (w: unknown) => one(raw('lever', { ...base, workplaceType: w })).remote;
    expect(r('remote')).toEqual({ structured: 'remote', countries: ['india'], signals: ['workplaceType:remote'] });
    expect(r('hybrid')).toEqual({ structured: 'hybrid', countries: ['india'], signals: ['workplaceType:hybrid'] });
    expect(r('onsite')).toEqual({ structured: 'onsite', countries: ['india'], signals: ['workplaceType:onsite'] });
    expect(r('unspecified')).toEqual({ structured: null, countries: ['india'], signals: ['workplaceType:unspecified'] });
    expect(r(undefined)).toEqual({ structured: null, countries: ['india'], signals: [] });
  });

  it('prefers the structured workplaceType when the location text disagrees, keeping both', () => {
    const p = one(raw('lever', { id: '1', text: 'Eng', hostedUrl: 'https://jobs.lever.co/x/1', workplaceType: 'hybrid', categories: { location: 'Remote - India', allLocations: ['Remote - India', 'Pune, India'] }, country: 'IN' }));
    expect(p.locationText).toBe('Remote - India; Pune, India');
    expect(p.remote).toEqual({ structured: 'hybrid', countries: ['india'], signals: ['workplaceType:hybrid', 'location:remote'] });
  });

  it('converts salaryRange to yearly base comp, refusing intervals it cannot annualise', () => {
    const base = { id: '1', text: 'Eng', hostedUrl: 'https://jobs.lever.co/x/1', categories: { location: 'India' }, description: '<p>Salary: ₹1 crore</p>' };
    const c = (s: unknown) => one(raw('lever', { ...base, salaryRange: s })).comp;
    expect(c({ min: 3000000, max: 4500000, currency: 'INR', interval: 'per-year-salary' })).toEqual({ min: 3000000, max: 4500000, currency: 'INR', period: 'year', basis: 'base' });
    expect(c({ min: 250000, max: 300000, currency: 'INR', interval: 'per-month-salary' })).toEqual({ min: 3000000, max: 3600000, currency: 'INR', period: 'year', basis: 'base' });
    expect(c({ min: 40, max: 60, currency: 'USD', interval: 'per-hour-wage' })).toBeNull();
    expect(c({ min: 100000, max: 120000, currency: 'SGD', interval: 'per-year-salary' })).toBeNull();
    expect(c({ min: 120000, max: 100000, currency: 'USD', interval: 'per-year-salary' })).toBeNull();
    // The plausibility minimum holds for structured figures too: 80 dollars a year is not a salary.
    expect(c({ min: 50, max: 80, currency: 'USD', interval: 'per-year-salary' })).toBeNull();
    expect(c({ min: 60000, max: 90000, currency: 'INR', interval: 'per-year-salary' })).toBeNull();
    // No salaryRange at all: the text decides.
    expect(one(raw('lever', base)).comp).toEqual({ min: 10000000, max: 10000000, currency: 'INR', period: 'year', basis: 'base' });
  });

  it('includes salaryDescription in the text', () => {
    const p = one(raw('lever', { id: '1', text: 'Eng', hostedUrl: 'https://jobs.lever.co/x/1', categories: {}, description: '<p>Body</p>', salaryDescription: '<p>Base salary: $100,000 - $120,000</p>' }));
    expect(p.descriptionText).toBe('Body\n\nBase salary: $100,000 - $120,000');
    expect(p.comp).toEqual({ min: 100000, max: 120000, currency: 'USD', period: 'year', basis: 'base' });
  });
});

describe('ashby', () => {
  it('maps the full posting (remote India by text, no compensation)', () => {
    expect(one(byId(ab, '0b2a4106-7f01-4205-813d-81e4fa1abdb4'))).toEqual({
      jobKey: hex16('confluent|staff software engineer i - sre|in remote india'),
      source: 'ashby', sourceId: '0b2a4106-7f01-4205-813d-81e4fa1abdb4', company: 'Confluent', slug: 'confluent', ats: 'ashby',
      title: 'Staff Software Engineer I - SRE',
      url: 'https://jobs.ashbyhq.com/confluent/0b2a4106-7f01-4205-813d-81e4fa1abdb4',
      locationText: 'IN Remote India',
      remote: { structured: null, countries: ['india'], signals: ['location:remote'] },
      employmentType: 'FullTime',
      descriptionText: golden('ashby-0b2a4106'),
      postedAt: '2026-02-16T07:38:53.841+00:00',
      comp: null,
      yearsRequired: 10,
    });
  });

  it('takes the Salary component as base comp; equity never becomes comp', () => {
    const p = one(byId(ab, '47920ccd-db54-4ed4-a865-70857e865fff'));
    expect(p.comp).toEqual({ min: 197400, max: 271200, currency: 'USD', period: 'year', basis: 'base' });
    expect(p.title).toBe('Distributed Systems Software Engineer - WarpStream');
    expect(p.locationText).toBe('Remote, United States; Remote, Texas; Remote, North Carolina; Remote, Massachusetts; Remote, New York');
    expect(p.remote).toEqual({ structured: 'remote', countries: ['united states'], signals: ['workplaceType:Remote', 'isRemote:true', 'location:remote'] });
    expect(p.yearsRequired).toBe(5);
    const equityOnly = { compensationType: 'EquityCashValue', interval: '1 YEAR', currencyCode: 'USD', minValue: 50000, maxValue: 90000 };
    const bonus = { compensationType: 'Bonus', interval: '1 YEAR', currencyCode: 'USD', minValue: 10000, maxValue: 20000 };
    const withComp = (components: unknown[]) =>
      one(raw('ashby', { id: '1', title: 'Eng', jobUrl: 'https://jobs.ashbyhq.com/x/1', location: 'Remote', descriptionHtml: '<p>Body</p>', compensation: { summaryComponents: components } })).comp;
    expect(withComp([equityOnly])).toBeNull();
    expect(withComp([bonus])).toBeNull();
    expect(withComp([equityOnly, { compensationType: 'Salary', interval: '1 YEAR', currencyCode: 'EUR', minValue: 110000, maxValue: 185000 }])).toEqual({ min: 110000, max: 185000, currency: 'EUR', period: 'year', basis: 'base' });
    expect(withComp([{ compensationType: 'Salary', interval: '1 MONTH', currencyCode: 'INR', minValue: 300000, maxValue: 400000 }])).toEqual({ min: 3600000, max: 4800000, currency: 'INR', period: 'year', basis: 'base' });
    expect(withComp([{ compensationType: 'Salary', interval: '1 HOUR', currencyCode: 'USD', minValue: 50, maxValue: 70 }])).toBeNull();
  });

  it('never reads a CA$ figure as USD: a Salary component in an unsupported currency is null, not text', () => {
    const p = one(byId(ab, 'a24f234c-08a3-4184-a357-763ce5e69454'));
    expect(p.comp).toBeNull();
    expect(p.remote).toEqual({ structured: null, countries: ['canada'], signals: ['location:remote'] });
  });

  it('maps isRemote and workplaceType, structured winning over text', () => {
    const r = (o: Record<string, unknown>) => one(raw('ashby', { id: '1', title: 'Eng', jobUrl: 'https://jobs.ashbyhq.com/x/1', location: 'Remote - India', ...o })).remote;
    expect(r({ workplaceType: 'Hybrid', isRemote: true })).toEqual({ structured: 'hybrid', countries: ['india'], signals: ['workplaceType:Hybrid', 'isRemote:true', 'location:remote'] });
    expect(r({ workplaceType: 'OnSite' })).toEqual({ structured: 'onsite', countries: ['india'], signals: ['workplaceType:OnSite', 'location:remote'] });
    expect(r({ isRemote: true })).toEqual({ structured: 'remote', countries: ['india'], signals: ['isRemote:true', 'location:remote'] });
    expect(r({ isRemote: false })).toEqual({ structured: null, countries: ['india'], signals: ['isRemote:false', 'location:remote'] });
  });

  it('reads countries from addresses, keeping an unlisted address country', () => {
    const p = one(raw('ashby', { id: '1', title: 'Eng', jobUrl: 'https://jobs.ashbyhq.com/x/1', location: 'Remote', address: { postalAddress: { addressCountry: 'Georgia' } }, secondaryLocations: [{ location: 'Remote, Spain', address: { postalAddress: { addressCountry: 'Spain' } } }] }));
    expect(p.remote.countries).toEqual(['georgia', 'spain']);
    expect(p.locationText).toBe('Remote; Remote, Spain');
  });
});

describe('himalayas', () => {
  it('maps the full posting (India restriction, remote-only feed)', () => {
    const p = byId(hm, 'https://himalayas.app/companies/jitterbit/jobs/java-software-engineer-connectors-remote-1342384693');
    expect(one(p)).toEqual({
      jobKey: hex16('jitterbit|java software engineer - connectors - remote|india'),
      source: 'himalayas', sourceId: 'https://himalayas.app/companies/jitterbit/jobs/java-software-engineer-connectors-remote-1342384693',
      company: 'Jitterbit', slug: 'himalayas', ats: 'feed',
      title: 'Java Software Engineer - Connectors - Remote',
      url: 'https://himalayas.app/companies/jitterbit/jobs/java-software-engineer-connectors-remote-1342384693',
      locationText: 'India',
      remote: { structured: 'remote', countries: ['india'], signals: ['feed:remote-only', 'title:remote'] },
      employmentType: 'Full Time',
      descriptionText: golden('himalayas-jitterbit'),
      postedAt: '2026-10-08T20:05:25.000Z',
      comp: null,
      yearsRequired: null,
    });
  });

  it('reads an empty restriction list as worldwide, with an empty location', () => {
    const p = one(byId(hm, 'https://himalayas.app/companies/nebius/jobs/senior-software-engineer-ydb-team-5851203954'));
    expect(p.locationText).toBe('');
    expect(p.remote.countries).toEqual(['worldwide']);
  });

  it('reads min/max salary fields with their period', () => {
    // The adapter drops this US-only job; its recorded raw still shows the salary fields.
    const coinbase = (fixtureJson('himalayas') as { jobs: Record<string, unknown>[] }).jobs.find((j) => j.companyName === 'Coinbase') ?? {};
    expect(one(raw('himalayas', coinbase, 'Coinbase', 'himalayas')).comp).toEqual({ min: 167280, max: 196800, currency: 'USD', period: 'year', basis: 'base' });
    const base = { guid: 'g', title: 'Eng', companyName: 'X', applicationLink: 'https://himalayas.app/x', locationRestrictions: ['India'], description: '<p>Salary: ₹30 LPA</p>' };
    const c = (o: Record<string, unknown>) => one(raw('himalayas', { ...base, ...o }, 'X', 'himalayas')).comp;
    expect(c({ minSalary: 200000, maxSalary: 300000, currency: 'INR', salaryPeriod: 'monthly' })).toEqual({ min: 2400000, max: 3600000, currency: 'INR', period: 'year', basis: 'base' });
    expect(c({ minSalary: 30, maxSalary: 40, currency: 'USD', salaryPeriod: 'hourly' })).toBeNull();
    // One known bound is kept; the other is not invented.
    expect(c({ minSalary: 100000, maxSalary: null, currency: 'USD', salaryPeriod: 'annual' })).toEqual({ min: 100000, max: null, currency: 'USD', period: 'year', basis: 'base' });
    expect(c({ minSalary: null, maxSalary: 150000, currency: 'USD', salaryPeriod: 'annual' })).toEqual({ min: null, max: 150000, currency: 'USD', period: 'year', basis: 'base' });
    expect(c({ minSalary: null, maxSalary: null, currency: null, salaryPeriod: 'annual' })).toEqual({ min: 3000000, max: 3000000, currency: 'INR', period: 'year', basis: 'base' });
  });

  it('maps object restrictions and keeps an unlisted one', () => {
    const p = one(raw('himalayas', { guid: 'g', title: 'Eng', companyName: 'X', applicationLink: 'https://himalayas.app/x', locationRestrictions: [{ alpha2: 'IN', name: 'India' }, 'Georgia'] }, 'X', 'himalayas'));
    expect(p.remote.countries).toEqual(['georgia', 'india']);
    expect(p.locationText).toBe('India, Georgia');
  });
});

describe('jobicy', () => {
  it('maps the full posting (Anywhere, yearly USD salary)', () => {
    expect(one(byId(jbAny, '152574'))).toEqual({
      jobKey: hex16('relationalai|solution engineer|anywhere'),
      source: 'jobicy', sourceId: '152574', company: 'RelationalAI', slug: 'jobicy', ats: 'feed',
      title: 'Solution Engineer',
      url: 'https://jobicy.com/jobs/152574-solution-engineer-3',
      locationText: 'Anywhere',
      remote: { structured: 'remote', countries: ['worldwide'], signals: ['feed:remote-only'] },
      employmentType: 'Full-Time',
      descriptionText: golden('jobicy-152574'),
      postedAt: '2026-10-06T04:50:12+00:00',
      comp: { min: 170000, max: 200000, currency: 'USD', period: 'year', basis: 'base' },
      yearsRequired: null,
    });
  });

  it('reads the geo list as countries and refuses an unsupported salary currency', () => {
    const ph = one(byId(jbApac, '152460'));
    expect(ph.remote.countries).toEqual(['philippines']);
    expect(ph.comp).toBeNull();
    expect(one(byId(jbApac, '154823')).remote.countries).toEqual(['ireland', 'japan', 'poland', 'united kingdom', 'united states']);
    expect(one(byId(jbAny, '152401')).employmentType).toBe('Contract');
  });

  it('reads salary fields with their period', () => {
    const base = { id: 9, jobTitle: 'Eng', companyName: 'X', url: 'https://jobicy.com/jobs/9', jobGeo: 'APAC', jobDescription: '' };
    const c = (o: Record<string, unknown>) => one(raw('jobicy', { ...base, ...o }, 'X', 'jobicy')).comp;
    expect(c({ salaryMin: 5000, salaryMax: 7000, salaryCurrency: 'USD', salaryPeriod: 'monthly' })).toEqual({ min: 60000, max: 84000, currency: 'USD', period: 'year', basis: 'base' });
    expect(c({ salaryMin: 50, salaryMax: 70, salaryCurrency: 'USD', salaryPeriod: 'hourly' })).toBeNull();
    expect(c({ salaryMin: 50000, salaryMax: 70000, salaryCurrency: 'EUR', salaryPeriod: 'yearly' })).toEqual({ min: 50000, max: 70000, currency: 'EUR', period: 'year', basis: 'base' });
  });
});

describe('careers', () => {
  it('maps the full JSON-LD posting (TELECOMMUTE, Country object, yearly baseSalary)', () => {
    expect(one(careersJsonLd())).toEqual({
      jobKey: hex16('example careers co|senior backend engineer|india'),
      source: 'careers', sourceId: 'abcdef0123456789', company: 'Example Careers Co', slug: 'example-careers', ats: 'careers',
      title: 'Senior Backend Engineer',
      url: 'https://careers.example/jobs/backend-engineer',
      locationText: 'India',
      remote: { structured: 'remote', countries: ['india'], signals: ['jobLocationType:TELECOMMUTE'] },
      employmentType: 'FULL_TIME',
      descriptionText: 'Build payment services.\n\n- Go\n- Postgres',
      postedAt: '2026-10-01',
      comp: { min: 4000000, max: 1200000, currency: 'INR', period: 'year', basis: 'base' },
      yearsRequired: null,
    });
  });

  const careers = (ld: Record<string, unknown> | null, text = 'Plain page text.'): Posting =>
    one({ source: 'careers', sourceId: 's', company: 'Co', slug: 'co', raw: { url: 'https://co.example/jobs/1', jsonLd: ld, title: 'Backend Engineer', text } });
  const salary = (unitText: string | undefined, extra: Record<string, unknown> = {}) => ({
    '@type': 'JobPosting', title: 'Backend Engineer', description: '<p>x</p>',
    baseSalary: { '@type': 'MonetaryAmount', currency: 'INR', value: { '@type': 'QuantitativeValue', minValue: 200000, maxValue: 300000, ...(unitText ? { unitText } : {}), ...extra } },
  });

  it('annualises baseSalary by unitText: MONTH x12, YEAR as is, HOUR and missing units null', () => {
    expect(careers(salary('MONTH')).comp).toEqual({ min: 2400000, max: 3600000, currency: 'INR', period: 'year', basis: 'base' });
    expect(careers(salary('YEAR')).comp).toEqual({ min: 200000, max: 300000, currency: 'INR', period: 'year', basis: 'base' });
    expect(careers(salary('HOUR')).comp).toBeNull();
    expect(careers(salary(undefined)).comp).toBeNull();
    expect(careers(salary('YEAR', { minValue: undefined, maxValue: undefined, value: 2500000 })).comp).toEqual({ min: 2500000, max: 2500000, currency: 'INR', period: 'year', basis: 'base' });
  });

  it('reads applicantLocationRequirements as an object or an array, and jobLocation as the place text', () => {
    const p = careers({
      '@type': 'JobPosting', title: 'Backend Engineer', jobLocationType: 'TELECOMMUTE',
      applicantLocationRequirements: [{ '@type': 'Country', name: 'India' }, { '@type': 'Country', name: 'SG' }],
      jobLocation: { '@type': 'Place', address: { '@type': 'PostalAddress', addressLocality: 'Austin', addressRegion: 'TX', addressCountry: 'US' } },
    });
    expect(p.locationText).toBe('Austin, TX, US');
    // A TELECOMMUTE job's jobLocation is an office, not a restriction on applicants.
    expect(p.remote).toEqual({ structured: 'remote', countries: ['india', 'singapore'], signals: ['jobLocationType:TELECOMMUTE'] });
    const onsite = careers({ '@type': 'JobPosting', title: 'Backend Engineer', jobLocation: [{ '@type': 'Place', address: { addressLocality: 'Pune', addressCountry: { '@type': 'Country', name: 'India' } } }] });
    expect(onsite.locationText).toBe('Pune, India');
    expect(onsite.remote).toEqual({ structured: null, countries: ['india'], signals: [] });
  });

  it('uses the page text when there is no JSON-LD', () => {
    const p = careers(null, 'Remote from India.\nOwn the data pipeline.');
    expect(p.descriptionText).toBe('Remote from India.\nOwn the data pipeline.');
    expect(p.remote).toEqual({ structured: null, countries: [], signals: [] });
    expect(p.postedAt).toBeNull();
    expect(p.employmentType).toBeNull();
    expect(p.locationText).toBe('');
  });

  it('sets an impossible datePosted to null', () => {
    expect(careers({ '@type': 'JobPosting', title: 'Backend Engineer', datePosted: '2026-02-30' }).postedAt).toBeNull();
    expect(careers({ '@type': 'JobPosting', title: 'Backend Engineer', datePosted: '2026-02-28' }).postedAt).toBe('2026-02-28');
  });

  it('decodes a JSON-LD description that was HTML-escaped', () => {
    expect(careers({ '@type': 'JobPosting', title: 'Backend Engineer', description: '&lt;p&gt;Hi &amp;amp; bye&lt;/p&gt;&lt;ul&gt;&lt;li&gt;Go&lt;/li&gt;&lt;/ul&gt;' }).descriptionText).toBe('Hi & bye\n\n- Go');
  });
});

describe('comp from text', () => {
  const text = (description: string): Posting['comp'] =>
    one(raw('jobicy', { id: 9, jobTitle: 'Eng', companyName: 'X', url: 'https://jobicy.com/jobs/9', jobGeo: 'APAC', jobDescription: description }, 'X', 'jobicy')).comp;

  it('reads only lines that mention salary, base, CTC, LPA, compensation or pay', () => {
    expect(text('<p>CTC: ₹30-45 LPA</p>')).toEqual({ min: 3000000, max: 4500000, currency: 'INR', period: 'year', basis: 'base' });
    expect(text('<p>Compensation: ₹30-45 LPA</p>')).toEqual({ min: 3000000, max: 4500000, currency: 'INR', period: 'year', basis: 'base' });
    expect(text('<p>Fixed pay: ₹30 LPA</p>')).toEqual({ min: 3000000, max: 3000000, currency: 'INR', period: 'year', basis: 'base' });
    expect(text('<p>Base salary: $150,000 - $180,000 per annum</p>')).toEqual({ min: 150000, max: 180000, currency: 'USD', period: 'year', basis: 'base' });
    expect(text('<p>We raised $50,000,000 last year.</p>')).toBeNull();
    expect(text('<p>Competitive salary.</p>')).toBeNull();
  });

  it('never takes equity or a bonus as comp', () => {
    expect(text('<p>Equity compensation: $50,000 in RSUs</p>')).toBeNull();
    expect(text('<p>Salary: $100,000 plus $20,000 bonus</p>')).toBeNull();
    expect(text('<p>Base pay: $95,000 - $140,000, plus equity</p>')).toEqual({ min: 95000, max: 140000, currency: 'USD', period: 'year', basis: 'unknown' });
  });

  it('refuses dollars that are not US dollars', () => {
    expect(text('<p>Salary: CA$150,000 - CA$180,000</p>')).toBeNull();
    expect(text('<p>Salary: A$150,000</p>')).toBeNull();
    expect(text('<p>Salary: SGD 150,000</p>')).toBeNull();
  });

  it('drops implausible figures (below 1 LPA a year), and lines that disagree', () => {
    expect(text('<p>Pay: ₹50,000 per annum</p>')).toBeNull();
    expect(text('<p>We pay $500 for your home office.</p><p>Salary: $120,000</p>')).toEqual({ min: 120000, max: 120000, currency: 'USD', period: 'year', basis: 'base' });
    expect(text('<p>Salary: $120,000</p><p>Salary: $150,000</p>')).toEqual({ min: 120000, max: 150000, currency: 'USD', period: 'year', basis: 'base' });
    expect(text('<p>Salary: $120,000</p><p>Salary: €150,000</p>')).toBeNull();
  });

  it('annualises a monthly figure', () => {
    expect(text('<p>Salary: ₹2,50,000 per month</p>')).toEqual({ min: 3000000, max: 3000000, currency: 'INR', period: 'year', basis: 'base' });
  });
});

describe('unmappable raw postings', () => {
  it('throws invalid_output for a missing title, a missing or non-http url, or an unknown source', () => {
    const cases: RawPosting[] = [
      raw('greenhouse', { id: 1, absolute_url: 'https://x.example/1' }),
      raw('greenhouse', { id: 1, title: '   ', absolute_url: 'https://x.example/1' }),
      raw('greenhouse', { id: 1, title: 'Eng' }),
      raw('lever', { id: '1', text: 'Eng', hostedUrl: 'javascript:alert(1)' }),
      raw('ashby', { id: '1', title: 'Eng', jobUrl: 'not a url' }),
      raw('workday', { title: 'Eng', url: 'https://x.example/1' }),
      { source: 'greenhouse', sourceId: '1', company: 'A', slug: 'a', raw: 'not an object' },
    ];
    for (const c of cases) {
      let err: unknown;
      try {
        normalize(c);
      } catch (e) {
        err = e;
      }
      expect(err, JSON.stringify(c)).toBeInstanceOf(KernelError);
      expect((err as KernelError).code).toBe('invalid_output');
    }
  });
});

describe('postedAt per source', () => {
  it('maps each source date field, and an impossible one to null', () => {
    expect(one(raw('greenhouse', { id: 1, title: 'E', absolute_url: 'https://x.example/1', first_published: '2026-02-30T10:00:00-04:00' })).postedAt).toBeNull();
    expect(one(raw('lever', { id: '1', text: 'E', hostedUrl: 'https://x.example/1', createdAt: -1 })).postedAt).toBeNull();
    expect(one(raw('jobicy', { id: 1, jobTitle: 'E', companyName: 'X', url: 'https://x.example/1', pubDate: 'not a date' }, 'X', 'jobicy')).postedAt).toBeNull();
    expect(one(raw('ashby', { id: '1', title: 'E', jobUrl: 'https://x.example/1', publishedAt: '2026-13-01T00:00:00Z' })).postedAt).toBeNull();
    expect(one(raw('himalayas', { guid: 'g', title: 'E', companyName: 'X', applicationLink: 'https://x.example/1', locationRestrictions: [], pubDate: 0 }, 'X', 'himalayas')).postedAt).toBeNull();
  });
});

describe('description completeness on every recorded posting', () => {
  /** Words of HTML read naively: raw-text elements gone, every tag a space, entities decoded. */
  const words = (s: string): string[] => (s.match(/[\p{L}\p{N}]+/gu) ?? []).sort();
  /** An entity decoder independent of the one under test: numeric references and the names the fixtures use. */
  const NAMES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', ndash: '–', mdash: '—', hellip: '…', bull: '•', eacute: 'é' };
  const decode = (s: string): string =>
    s.replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, e: string) =>
      e.startsWith('#x') || e.startsWith('#X') ? String.fromCodePoint(parseInt(e.slice(2), 16)) : e.startsWith('#') ? String.fromCodePoint(Number(e.slice(1))) : (NAMES[e] ?? m));
  const naive = (html: string): string =>
    decode(html.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<(script|style|template|noscript)\b[\s\S]*?<\/\1\s*>/gi, ' ').replace(/<[^>]*>/g, ' '));
  const sourceHtml = (p: RawPosting): string => {
    const r = p.raw as Record<string, unknown> & { lists?: { text: string; content: string }[] };
    switch (p.source) {
      case 'greenhouse':
        return decode(String(r.content ?? ''));
      case 'careers':
        return String((r.jsonLd as Record<string, unknown> | null)?.description ?? '');
      case 'lever':
        return [r.description, ...(r.lists ?? []).flatMap((l) => [l.text.replace(/&/g, '&amp;').replace(/</g, '&lt;'), l.content]), r.additional, r.salaryDescription].map((x) => String(x ?? '')).join(' ');
      case 'ashby':
        return String(r.descriptionHtml ?? '');
      case 'himalayas':
        return String(r.description ?? '');
      default:
        return String(r.jobDescription ?? '');
    }
  };

  it('keeps every word of the source, and adds none', () => {
    for (const p of [...gh, ...lv, ...ab, ...hm, ...jbAny, ...jbApac, careersJsonLd()]) {
      expect(words(one(p).descriptionText), `${p.source} ${p.sourceId}`).toEqual(words(naive(sourceHtml(p))));
    }
  });
});

// ---------------------------------------------------------------------------
// Fix round 1 (review I1-I8 and minors)
// ---------------------------------------------------------------------------

describe('fix round 1: comp basis (I1, I4)', () => {
  const text = (description: string): Posting['comp'] =>
    one(raw('jobicy', { id: 9, jobTitle: 'Eng', companyName: 'X', url: 'https://jobicy.com/jobs/9', jobGeo: 'APAC', jobDescription: description }, 'X', 'jobicy')).comp;

  it('never calls OTE, total comp, commission, bonus, equity or variable pay base', () => {
    // task 7 fix round 3 (I-R1): a total beside a component, or a total that includes something, is not read
    expect(text('<p>OTE $200k (50/50 base/commission)</p>')).toBeNull();
    expect(text('<p>Total compensation (base + bonus): $180k - $220k</p>')).toBeNull();
    expect(text('<p>Base salary $150,000 plus variable pay</p>')?.basis).toBe('unknown');
    expect(text('<p>TC: $250,000 including base</p>')).toBeNull();
    expect(text('<p>Base salary: $150,000</p>')?.basis).toBe('base');
    expect(text('<p>Salary: $150,000</p>')?.basis).toBe('base');
  });

  it('judges a Greenhouse range by its title first', () => {
    const base = { id: 1, title: 'Eng', absolute_url: 'https://x.example/1', location: { name: 'Remote' }, content: '' };
    const basis = (title: string, blurb: string) =>
      one(raw('greenhouse', { ...base, pay_input_ranges: [{ min_cents: 15000000, max_cents: 20000000, currency_type: 'USD', title, blurb }] })).comp?.basis;
    expect(basis('Total compensation', '<p>Base salary plus equity and bonus</p>')).toBe('unknown');
    expect(basis('Target cash compensation', '<p>Base salary</p>')).toBe('unknown');
    expect(basis('Base salary range', '<p>Plus equity and benefits</p>')).toBe('base');
    expect(basis('US Pay Range', '<p>This range is total compensation (TC)</p>')).toBe('unknown');
    // The recorded GitLab blurb says "base salary range ... does not include any bonuses, equity": base.
    expect(one(byId(gh, '8638232002')).comp?.basis).toBe('base');
  });
});

describe('fix round 1: text gate per sentence (I2, M3)', () => {
  const text = (description: string): Posting['comp'] =>
    one(raw('jobicy', { id: 9, jobTitle: 'Eng', companyName: 'X', url: 'https://jobicy.com/jobs/9', jobGeo: 'APAC', jobDescription: description }, 'X', 'jobicy')).comp;

  it('needs the figure in the same sentence as a pay word', () => {
    expect(text('<p>We are a startup that raised $50M from top investors, and we pay well.</p>')).toBeNull();
    expect(text('<p>We pay well. Last year we raised $50M.</p>')).toBeNull();
    expect(text('<p>Base salary: competitive. Our customers save $2M a year.</p>')).toBeNull();
    expect(text('<p>Base salary competitive; we saved clients $5k</p>')).toBeNull();
    expect(text('<p>About us. We pay competitively. Salary: ₹40 LPA. Our ARR is $10M.</p>')).toEqual({ min: 4000000, max: 4000000, currency: 'INR', period: 'year', basis: 'base' });
    expect(text('<p>The role pays $150,000 per year.</p>')).toEqual({ min: 150000, max: 150000, currency: 'USD', period: 'year', basis: 'unknown' });
    expect(text('<p>Earn $150,000 a year.</p>')).toEqual({ min: 150000, max: 150000, currency: 'USD', period: 'year', basis: 'unknown' });
  });

  it('does not split a sentence at "Rs."', () => {
    expect(text('<p>CTC Rs. 30,00,000 per annum</p>')).toEqual({ min: 3000000, max: 3000000, currency: 'INR', period: 'year', basis: 'base' });
  });

  it('drops funding and revenue sentences even with a pay word', () => {
    expect(text('<p>Our Series B valuation lets us pay $200,000 salaries.</p>')).toBeNull();
    expect(text('<p>Salary budget: $1,000,000 for the team.</p>')).toBeNull();
  });

  it('reads a bare $ beside Canada, Australia or Singapore as not US dollars', () => {
    expect(text('<p>Canada salary range: $120,000 - $150,000</p>')).toBeNull();
    expect(text('<p>US and Canada salary range: USD 120,000 - 150,000</p>')).toEqual({ min: 120000, max: 150000, currency: 'USD', period: 'year', basis: 'base' });
  });

  it('keeps a plain-text careers description sentence-sized, so an About-us figure is not pay', () => {
    const p = one({ source: 'careers', sourceId: 's', company: 'Co', slug: 'co', raw: { url: 'https://co.example/jobs/1', title: 'Eng', text: '', jsonLd: { '@type': 'JobPosting', description: 'About us\nWe raised $50M and pay well.\n\nRequirements\n- 3+ years of Go' } } });
    expect(p.comp).toBeNull();
    expect(p.descriptionText).toBe('About us\nWe raised $50M and pay well.\n\nRequirements\n- 3+ years of Go');
  });
});

describe('fix round 1: one-sided ranges (I3)', () => {
  const text = (description: string): Posting['comp'] =>
    one(raw('jobicy', { id: 9, jobTitle: 'Eng', companyName: 'X', url: 'https://jobicy.com/jobs/9', jobGeo: 'APAC', jobDescription: description }, 'X', 'jobicy')).comp;

  it('keeps only the stated bound', () => {
    expect(text('<p>Salary from $100,000</p>')).toEqual({ min: 100000, max: null, currency: 'USD', period: 'year', basis: 'base' });
    expect(text('<p>Base salary starting at ₹18 LPA</p>')).toEqual({ min: 1800000, max: null, currency: 'INR', period: 'year', basis: 'base' });
    expect(text('<p>Pay: up to $150,000</p>')).toEqual({ min: null, max: 150000, currency: 'USD', period: 'year', basis: 'unknown' });
    expect(text('<p>Salary: $120k+</p>')).toEqual({ min: 120000, max: null, currency: 'USD', period: 'year', basis: 'base' });
    // A real range with "from ... to" is two bounds.
    expect(text('<p>Salary from $100,000 to $120,000</p>')).toEqual({ min: 100000, max: 120000, currency: 'USD', period: 'year', basis: 'base' });
    // "from" elsewhere in the sentence does not make it open-ended.
    expect(text('<p>Remote from India, salary $100,000</p>')).toEqual({ min: 100000, max: 100000, currency: 'USD', period: 'year', basis: 'base' });
  });

  it('keeps the known bound of a structured range', () => {
    const base = { id: '1', text: 'Eng', hostedUrl: 'https://jobs.lever.co/x/1', categories: { location: 'India' }, description: '' };
    expect(one(raw('lever', { ...base, salaryRange: { min: 3000000, max: null, currency: 'INR', interval: 'per-year-salary' } })).comp).toEqual({ min: 3000000, max: null, currency: 'INR', period: 'year', basis: 'base' });
    expect(one(raw('lever', { ...base, salaryRange: { min: null, max: null, currency: 'INR', interval: 'per-year-salary' } })).comp).toBeNull();
  });

  it('types: at least one bound, nullable bounds, min <= max', () => {
    const p = one(raw('lever', { id: '1', text: 'Eng', hostedUrl: 'https://jobs.lever.co/x/1' }));
    const withComp = (comp: unknown) => Posting.schema.safeParse({ ...p, comp }).success;
    expect(withComp({ min: null, max: 5, currency: 'USD', period: 'year', basis: 'base' })).toBe(true);
    expect(withComp({ min: 5, max: null, currency: 'USD', period: 'year', basis: 'base' })).toBe(true);
    expect(withComp({ min: null, max: null, currency: 'USD', period: 'year', basis: 'base' })).toBe(false);
    expect(withComp({ min: 6, max: 5, currency: 'USD', period: 'year', basis: 'base' })).toBe(false);
  });
});

describe('fix round 1: plausibility per zone (M1)', () => {
  const base = { id: 1, title: 'Eng', absolute_url: 'https://x.example/1', location: { name: 'Remote' }, content: '' };
  const comp = (ranges: [number, number, string][]) =>
    one(raw('greenhouse', { ...base, pay_input_ranges: ranges.map(([min, max, cur]) => ({ min_cents: min * 100, max_cents: max * 100, currency_type: cur, title: 'Base Salary' })) })).comp;

  it('drops an implausible zone without nulling the others', () => {
    expect(comp([[50, 50, 'USD'], [100000, 120000, 'USD']])).toEqual({ min: 100000, max: 120000, currency: 'USD', period: 'year', basis: 'base' });
  });

  it('uses the fixed table: about ₹1 lakh to ₹10 crore a year', () => {
    expect(comp([[1199, 1199, 'USD']])).toBeNull();
    expect(comp([[1200, 1200, 'USD']])?.min).toBe(1200);
    expect(comp([[1099, 1099, 'EUR']])).toBeNull();
    expect(comp([[999, 999, 'GBP']])).toBeNull();
    expect(comp([[99999, 99999, 'INR']])).toBeNull();
    expect(comp([[1200001, 1200001, 'USD']])).toBeNull();
    expect(comp([[100000001, 100000001, 'INR']])).toBeNull();
    expect(comp([[100000000, 100000000, 'INR']])?.max).toBe(100000000);
  });
});

describe('fix round 1: raw-text elements (I5) and htmlToText details (M6)', () => {
  it('drops script, style and noscript bodies in any case', () => {
    expect(htmlToText('<SCRIPT>bad()</SCRIPT>ok')).toBe('ok');
    expect(htmlToText('<Style>p{}</sTyLe><NoScript>n</NOSCRIPT>ok')).toBe('ok');
    expect(htmlToText('<P>One</P><UL><LI>Two</LI></UL>')).toBe('One\n\n- Two');
  });

  it('drops everything after an unclosed script, style, noscript or comment', () => {
    expect(htmlToText('<p>kept</p><script>var x = 1; <p>never</p>')).toBe('kept');
    expect(htmlToText('<p>kept</p><style>p { }')).toBe('kept');
    expect(htmlToText('<p>kept</p><!-- open comment <p>never</p>')).toBe('kept');
  });

  it('keeps <pre> line breaks and separates <option> items', () => {
    expect(htmlToText('<pre>line1\n  line2\nline3</pre>')).toBe('line1\nline2\nline3');
    expect(htmlToText('<select><option>opt1</option><option>opt2</option></select>')).toBe('opt1\nopt2');
  });
});

describe('fix round 1: plain-text JSON-LD descriptions (I6)', () => {
  const careers = (description: string): string =>
    one({ source: 'careers', sourceId: 's', company: 'Co', slug: 'co', raw: { url: 'https://co.example/jobs/1', title: 'Eng', text: '', jsonLd: { '@type': 'JobPosting', description } } }).descriptionText;

  it('keeps lines, paragraphs and bullets', () => {
    expect(careers('About us\nWe build.\n\n\n\nRequirements\n- 3+ years   of Go\n* Postgres\n• Kafka\r\n· Redis')).toBe(
      'About us\nWe build.\n\nRequirements\n- 3+ years of Go\n- Postgres\n- Kafka\n- Redis',
    );
  });

  it('splits inline bullets into lines and decodes entities', () => {
    expect(careers('Stack: • Go • Postgres &amp; Redis')).toBe('Stack:\n- Go\n- Postgres & Redis');
  });
});

describe('fix round 1: yearsRequired (I7, widened)', () => {
  it('ignores the company describing itself', () => {
    expect(yearsRequired('We have 20 years of experience serving clients.')).toBeNull();
    expect(yearsRequired('Our team brings 25+ years of combined experience.')).toBeNull();
    expect(yearsRequired('Founded 15 years ago with deep experience.')).toBeNull();
    expect(yearsRequired('The company has been in business for 12 years, with experience in fintech.')).toBeNull();
    expect(yearsRequired('Collectively we have 40 years experience.')).toBeNull();
    expect(yearsRequired('Options vest over 4 years.')).toBeNull();
    expect(yearsRequired('After 5 years of service you get a sabbatical.')).toBeNull();
    expect(yearsRequired('Over the past 10 years we grew 10x.')).toBeNull();
  });

  it('still reads the requirement when the company is looking for it', () => {
    expect(yearsRequired("We're looking for someone with 5+ years of experience in Go.")).toBe(5);
    expect(yearsRequired('Our ideal candidate has 7 years of backend experience.')).toBe(7);
  });

  it('accepts year/yr/exp, bullet lines and "N+ years of|in|as|with"', () => {
    expect(yearsRequired('1 year of experience with Go.')).toBe(1);
    expect(yearsRequired('15 yrs exp in Java.')).toBe(15);
    expect(yearsRequired('3 yr exp.')).toBe(3);
    expect(yearsRequired('- 6+ years building distributed systems')).toBe(6);
    expect(yearsRequired('You bring 10+ years in SRE or reliability engineering.')).toBe(10);
    expect(yearsRequired('5+ years as a backend engineer.')).toBe(5);
    expect(yearsRequired('4+ years with Kubernetes.')).toBe(4);
    expect(yearsRequired('A 2 year contract.')).toBeNull();
  });

  it('needs requirement wording above 14 years', () => {
    expect(yearsRequired('Experience: 20 years in finance.')).toBe(20);
    expect(yearsRequired('With 18+ years in the industry, the team ships.')).toBeNull();
    expect(yearsRequired('6+ years in the industry, the team ships.')).toBe(6);
    // A bullet alone is not requirement wording above 14 (fix round 2, N2).
    expect(yearsRequired('- 16+ years building payments')).toBeNull();
    expect(yearsRequired('- 16+ years building payments is a must')).toBe(16);
  });

  it('reads the three recorded postings that were null', () => {
    expect(one(byId(ab, '0b2a4106-7f01-4205-813d-81e4fa1abdb4')).yearsRequired).toBe(10);
    expect(one(byId(lv, '9ac55b31-df46-4acb-b305-2c0b7ed56027')).yearsRequired).toBe(5);
    expect(one(byId(jbAny, '154552')).yearsRequired).toBe(5);
  });
});

describe('fix round 1: jobKey keeps title places (I8, M7)', () => {
  it('gives US and India variants of one title different keys', () => {
    expect(jobKey('Acme', 'Software Engineer (US)', 'Remote')).not.toBe(jobKey('Acme', 'Software Engineer (India)', 'Remote'));
    expect(jobKey('Acme', 'Backend Engineer (Remote)', 'Bengaluru')).not.toBe(jobKey('Acme', 'Backend Engineer (Hybrid)', 'Bengaluru'));
  });

  it('still matches the place written in the title or in the location', () => {
    expect(jobKey('Acme', 'Engineer (India)', 'Remote')).toBe(jobKey('Acme', 'Engineer', 'Remote, India'));
    expect(jobKey('Acme', 'Engineer (India)', 'Remote')).toBe(hex16('acme|engineer|india, remote'));
  });

  it('trims the company, folds city aliases, ignores a trailing full stop', () => {
    expect(jobKey(' Acme ', 'Engineer.', 'Bangalore, India')).toBe(jobKey('Acme', 'Engineer', 'Bengaluru, India'));
  });
});

describe('fix round 1: places (M2, M4)', () => {
  it('resolves longer names first', () => {
    expect(countriesIn('Sydney, New South Wales')).toEqual(['australia']);
    expect(countriesIn('Santa Fe, New Mexico')).toEqual(['united states']);
    expect(countriesIn('Boston, New England')).toEqual(['united states']);
  });

  it('does not add India for a city of that name in another country', () => {
    expect(countriesIn('Hyderabad, Sindh, Pakistan')).toEqual(['pakistan']);
    expect(countriesIn('Hyderabad, India')).toEqual(['india']);
    expect(countriesIn('Hyderabad')).toEqual(['india']);
  });

  it('never reads an excluded place as included, and signals the exclusion', () => {
    expect(countriesIn('Remote (except India)')).toEqual([]);
    expect(countriesIn('Anywhere but US')).toEqual(['worldwide']);
    expect(countriesIn('Remote, excluding India, Pakistan; Canada')).toEqual(['canada']);
    const p = one(raw('greenhouse', { id: 1, title: 'Eng', absolute_url: 'https://x.example/1', location: { name: 'Remote (except India)' } }));
    expect(p.remote).toEqual({ structured: null, countries: [], signals: ['location:remote', 'location:excludes:india'] });
  });

  it('decodes a Jobicy geo, and splits an entry naming two places', () => {
    const p = one(raw('jobicy', { id: 9, jobTitle: 'Eng', companyName: 'X', url: 'https://jobicy.com/jobs/9', jobGeo: 'USA &amp; Canada, APAC' }, 'X', 'jobicy'));
    expect(p.locationText).toBe('USA & Canada, APAC');
    expect(p.remote.countries).toEqual(['apac', 'canada', 'united states']);
  });
});

describe('fix round 1: Ashby empty summary falls back to tiers (M5)', () => {
  it('reads tier components when summaryComponents is empty', () => {
    const p = one(raw('ashby', { id: '1', title: 'Eng', jobUrl: 'https://jobs.ashbyhq.com/x/1', location: 'Remote', compensation: { summaryComponents: [], compensationTiers: [{ components: [{ compensationType: 'Salary', interval: '1 YEAR', currencyCode: 'USD', minValue: 100000, maxValue: 120000 }] }] } }));
    expect(p.comp).toEqual({ min: 100000, max: 120000, currency: 'USD', period: 'year', basis: 'base' });
  });
});

// ---------------------------------------------------------------------------
// Fix round 2 (re-review N1-N3, M11-M13)
// ---------------------------------------------------------------------------

describe('fix round 2: variable pay never joins the salary (N1)', () => {
  const text = (description: string): Posting['comp'] =>
    one(raw('jobicy', { id: 9, jobTitle: 'Eng', companyName: 'X', url: 'https://jobicy.com/jobs/9', jobGeo: 'APAC', jobDescription: description }, 'X', 'jobicy')).comp;

  it('skips variable, incentive, commission, bonus and equity clauses, and keeps only explicit base', () => {
    expect(text('<p>Fixed: ₹25 LPA; variable ₹5 LPA</p>')).toEqual({ min: 2500000, max: 2500000, currency: 'INR', period: 'year', basis: 'base' });
    expect(text('<p>Fixed: ₹25 LPA;variable ₹5 LPA</p>')).toEqual({ min: 2500000, max: 2500000, currency: 'INR', period: 'year', basis: 'base' });
    expect(text('<p>Base: ₹25 LPA.</p><p>Variable: ₹5 LPA</p>')).toEqual({ min: 2500000, max: 2500000, currency: 'INR', period: 'year', basis: 'base' });
    expect(text('<p>Base: ₹20-25 LPA. Incentive compensation: ₹5 LPA. On-target pay: ₹35 LPA. Commission: ₹4 LPA.</p>')).toEqual({ min: 2000000, max: 2500000, currency: 'INR', period: 'year', basis: 'base' });
    expect(text('<p>Variable pay: ₹4 LPA</p>')).toBeNull();
    // task 7 fix round 2: a total-type figure (OTE) is kept, with an unknown basis
    expect(text('<p>OTE: $250,000</p>')).toEqual({ min: 250000, max: 250000, currency: 'USD', period: 'year', basis: 'unknown' });
  });

  it('uses only the base figures when base is stated, not a union with unknown ones', () => {
    expect(text('<p>Base salary: $150,000.</p><p>Salary for senior levels: $200,000.</p>')).toEqual({ min: 150000, max: 200000, currency: 'USD', period: 'year', basis: 'base' });
    expect(text('<p>Salary: $150,000.</p><p>Salary for senior levels: $200,000.</p>')).toEqual({ min: 150000, max: 200000, currency: 'USD', period: 'year', basis: 'base' });
  });

  it('does not split after p.a., approx., incl. or e.g.', () => {
    expect(text('<p>CTC ₹20 LPA p.a. Paid monthly.</p>')).toEqual({ min: 2000000, max: 2000000, currency: 'INR', period: 'year', basis: 'base' });
    expect(text('<p>Salary approx. ₹20 LPA</p>')?.max).toBe(2000000);
    expect(text('<p>Base salary incl. allowances ₹20 LPA</p>')?.max).toBe(2000000);
    expect(text('<p>Pay e.g. ₹20 LPA</p>')?.max).toBe(2000000);
  });
});

describe('fix round 2: company bullets above 14 years (N2)', () => {
  it('ignores company-highlight bullets', () => {
    for (const s of ['- 20 years in the market', '- Trusted by 500 companies for 20 years', '- 16+ years of innovation', '- 25 years of excellence in fintech', '- Over 20 years of industry leadership']) {
      expect(yearsRequired(s), s).toBeNull();
    }
    expect(yearsRequired('- Paid parental leave for up to 2 years')).toBeNull();
  });

  it('keeps a bullet that states experience or asks for it', () => {
    expect(yearsRequired('- 20+ years of experience in banking')).toBe(20);
    expect(yearsRequired('- Minimum 15 years in banking')).toBe(15);
    expect(yearsRequired('- 6+ years building distributed systems')).toBe(6);
  });
});

describe('fix round 2: exclusions name the place (N3)', () => {
  const remote = (location: string) => one(raw('greenhouse', { id: 1, title: 'Eng', absolute_url: 'https://x.example/1', location: { name: location } })).remote;

  it('emits location:excludes:<place> and never keeps worldwide when India is excluded', () => {
    expect(remote('Remote - Anywhere except India')).toEqual({ structured: null, countries: [], signals: ['location:remote', 'location:excludes:india'] });
    expect(remote('Remote, excluding India, Pakistan; Canada')).toEqual({ structured: null, countries: ['canada'], signals: ['location:remote', 'location:excludes:india', 'location:excludes:pakistan'] });
    expect(remote('Anywhere but US')).toEqual({ structured: null, countries: ['worldwide'], signals: ['location:excludes:united states'] });
  });

  it('removes an excluded place even when another field names it', () => {
    const p = one(raw('lever', { id: '1', text: 'Eng', hostedUrl: 'https://jobs.lever.co/x/1', country: 'IN', categories: { location: 'Remote (except India)' } }));
    expect(p.remote.countries).toEqual([]);
    expect(p.remote.signals).toContain('location:excludes:india');
  });
});

describe('fix round 2: minors (M11, M13)', () => {
  const text = (description: string): Posting['comp'] =>
    one(raw('jobicy', { id: 9, jobTitle: 'Eng', companyName: 'X', url: 'https://jobicy.com/jobs/9', jobGeo: 'APAC', jobDescription: description }, 'X', 'jobicy')).comp;

  it('reads min., minimum, max. and maximum as one-sided', () => {
    expect(text('<p>Salary: min. ₹20 LPA</p>')).toEqual({ min: 2000000, max: null, currency: 'INR', period: 'year', basis: 'base' });
    expect(text('<p>Salary: minimum ₹20 LPA</p>')).toEqual({ min: 2000000, max: null, currency: 'INR', period: 'year', basis: 'base' });
    expect(text('<p>Salary: max. ₹30 LPA</p>')).toEqual({ min: null, max: 3000000, currency: 'INR', period: 'year', basis: 'base' });
    expect(text('<p>Salary: maximum ₹30 LPA</p>')).toEqual({ min: null, max: 3000000, currency: 'INR', period: 'year', basis: 'base' });
  });

  it('reads a Lever salaryRange min of 0 as not stated', () => {
    const p = one(raw('lever', { id: '1', text: 'Eng', hostedUrl: 'https://jobs.lever.co/x/1', salaryRange: { min: 0, max: 4500000, currency: 'INR', interval: 'per-year-salary' } }));
    expect(p.comp).toEqual({ min: null, max: 4500000, currency: 'INR', period: 'year', basis: 'base' });
  });
});

// ---------------------------------------------------------------------------
// Fix round 3 (re-review P1, M12, M14)
// ---------------------------------------------------------------------------

describe('fix round 3: an excluded city never excludes its country (P1)', () => {
  const posting = (location: string, extra: Record<string, unknown> = {}) =>
    one(raw('lever', { id: '1', text: 'Eng', hostedUrl: 'https://jobs.lever.co/x/1', categories: { location }, ...extra })).remote;

  it('keeps india and names the city', () => {
    const cases: [string, string][] = [
      ['Bengaluru, India (excluding Mumbai)', 'location:excludes:mumbai'],
      ['Pan India, except Mumbai', 'location:excludes:mumbai'],
      ['Remote - India (not Bangalore)', 'location:excludes:bangalore'],
      ['Anywhere in India except Delhi NCR', 'location:excludes:delhi ncr'],
    ];
    for (const [loc, signal] of cases) {
      const r = posting(loc);
      expect(r.countries, loc).toContain('india');
      expect(r.signals, loc).toContain(signal);
      expect(r.signals, loc).not.toContain('location:excludes:india');
    }
    const lever = posting('Bengaluru (not Mumbai)', { country: 'IN', workplaceType: 'remote' });
    expect(lever).toEqual({ structured: 'remote', countries: ['india'], signals: ['workplaceType:remote', 'location:excludes:mumbai'] });
  });

  it('still excludes a country or region named as such', () => {
    expect(posting('Anywhere except India').countries).toEqual([]);
    expect(posting('Worldwide (except APAC)')).toEqual({ structured: null, countries: ['worldwide'], signals: ['location:excludes:apac'] });
  });
});

describe('fix round 3: p.a. and approx. end a sentence before a capitalised word (M12)', () => {
  const text = (description: string): Posting['comp'] =>
    one(raw('jobicy', { id: 9, jobTitle: 'Eng', companyName: 'X', url: 'https://jobicy.com/jobs/9', jobGeo: 'APAC', jobDescription: description }, 'X', 'jobicy')).comp;

  it('reads the salary and keeps the next sentence out of it', () => {
    expect(text('<p>Salary: ₹12 LPA p.a. Equity: ₹50 LPA over 4 years.</p>')).toEqual({ min: 1200000, max: 1200000, currency: 'INR', period: 'year', basis: 'base' });
    expect(text('<p>CTC ₹20 LPA p.a. We also offer ₹5 LPA ESOPs.</p>')).toEqual({ min: 2000000, max: 2000000, currency: 'INR', period: 'year', basis: 'base' });
    expect(text('<p>Base salary ₹18 LPA approx. Bonus ₹3 LPA.</p>')).toEqual({ min: 1800000, max: 1800000, currency: 'INR', period: 'year', basis: 'base' });
  });

  it('does not break before the figure an abbreviation introduces', () => {
    expect(text('<p>Base salary approx. ₹20 LPA</p>')).toEqual({ min: 2000000, max: 2000000, currency: 'INR', period: 'year', basis: 'base' });
    expect(text('<p>Base salary approx. INR 20,00,000 per annum</p>')).toEqual({ min: 2000000, max: 2000000, currency: 'INR', period: 'year', basis: 'base' });
    expect(text('<p>Base salary approx. $150,000</p>')?.basis).toBe('base');
    expect(text('<p>Base salary incl. allowances ₹20 LPA</p>')?.basis).toBe('base');
  });
});

describe('fix round 3: bullet-only 15+ years is null (M14, accepted N2 trade-off)', () => {
  it('needs experience or requirement wording above 14', () => {
    expect(yearsRequired('- 15+ years designing distributed systems')).toBeNull();
    expect(yearsRequired('- 15+ years of experience designing distributed systems')).toBe(15);
  });
});

// ---------------------------------------------------------------------------
// Fix round 4 (re-review Q1, M16, M17)
// ---------------------------------------------------------------------------

describe('fix round 4: an included component is never a bound (Q1)', () => {
  const text = (description: string): Posting['comp'] =>
    one(raw('jobicy', { id: 9, jobTitle: 'Eng', companyName: 'X', url: 'https://jobicy.com/jobs/9', jobGeo: 'APAC', jobDescription: description }, 'X', 'jobicy')).comp;

  it('reads the figure, not the part it includes', () => {
    expect(text('<p>Salary ₹20 LPA incl. HRA ₹5 LPA</p>')).toEqual({ min: 2000000, max: 2000000, currency: 'INR', period: 'year', basis: 'base' });
    expect(text('<p>Compensation ₹20 LPA incl. PF ₹1.5 LPA</p>')).toEqual({ min: 2000000, max: 2000000, currency: 'INR', period: 'year', basis: 'base' });
    expect(text('<p>CTC ₹20 LPA including gratuity ₹0.5 LPA</p>')).toEqual({ min: 2000000, max: 2000000, currency: 'INR', period: 'year', basis: 'base' });
    expect(text('<p>Salary incl. HRA: ₹20 LPA</p>')?.max).toBe(2000000);
  });

  it('skips a clause naming only allowances, PF, gratuity, insurance and the like', () => {
    expect(text('<p>HRA: ₹5 LPA</p>')).toBeNull();
    expect(text('<p>Base: ₹20 LPA. PF ₹1.5 LPA. Insurance cover ₹5 LPA. LTA ₹1 LPA.</p>')).toEqual({ min: 2000000, max: 2000000, currency: 'INR', period: 'year', basis: 'base' });
  });
});

describe('fix round 4: no break before a currency token (M17)', () => {
  const text = (description: string): Posting['comp'] =>
    one(raw('jobicy', { id: 9, jobTitle: 'Eng', companyName: 'X', url: 'https://jobicy.com/jobs/9', jobGeo: 'APAC', jobDescription: description }, 'X', 'jobicy')).comp;

  it('keeps US$, other dollars and codes with their abbreviation', () => {
    expect(text('<p>Base salary approx. US$150,000</p>')).toEqual({ min: 150000, max: 150000, currency: 'USD', period: 'year', basis: 'base' });
    expect(text('<p>Base pay e.g. L3: ₹30 LPA</p>')).toEqual({ min: 3000000, max: 3000000, currency: 'INR', period: 'year', basis: 'base' });
    expect(text('<p>Base salary approx. CA$150,000</p>')).toBeNull();
    // A code that starts a new sentence rather than an amount still breaks it: the INR figure stands alone.
    expect(text('<p>Base salary ₹20 LPA p.a. USD equivalent available.</p>')).toEqual({ min: 2000000, max: 2000000, currency: 'INR', period: 'year', basis: 'base' });
    expect(text('<p>Base salary ₹20 LPA p.a. Rs. 5 LPA bonus.</p>')).toBeNull();
  });
});

describe('fix round 4: "anywhere in <country>" is that country (M16)', () => {
  it('does not add worldwide', () => {
    expect(countriesIn('Anywhere in India except Delhi NCR')).toEqual(['india']);
    expect(countriesIn('Anywhere in the US')).toEqual(['united states']);
    expect(countriesIn('Remote, anywhere within APAC')).toEqual(['apac']);
    expect(countriesIn('Anywhere')).toEqual(['worldwide']);
    expect(countriesIn('Anywhere in the world')).toEqual(['worldwide']);
  });
});

describe('task 7 fix round 1: salary wording is base', () => {
  const text = (description: string): Posting['comp'] =>
    one(raw('jobicy', { id: 9, jobTitle: 'Eng', companyName: 'X', url: 'https://jobicy.com/jobs/9', jobGeo: 'APAC', jobDescription: description }, 'X', 'jobicy')).comp;

  it('a figure beside salary, pay range, CTC or LPA, with no variable, total, bonus, equity or OTE word, is base', () => {
    expect(text('<p>Salary: $150,000</p>')?.basis).toBe('base');
    expect(text('<p>Pay range: $120,000 - $150,000</p>')?.basis).toBe('base');
    expect(text('<p>Salary: ₹40 LPA</p>')?.basis).toBe('base');
    expect(text('<p>₹19–₹24 LPA (based on experience)</p>')?.basis).toBe('base');
  });

  it('LPA and CTC are Indian annual pay figures: base even beside compensation or package', () => {
    expect(text('<p>Compensation: ₹19–₹24 LPA (based on experience)</p>')).toEqual({ min: 1900000, max: 2400000, currency: 'INR', period: 'year', basis: 'base' });
    expect(text('<p>CTC package: ₹30 LPA</p>')?.basis).toBe('base');
  });

  it('compensation, package or total wording without LPA or CTC stays unknown unless base is stated', () => {
    expect(text('<p>Salary package: $150,000</p>')?.basis).toBe('unknown');
    expect(text('<p>Compensation and salary: $150,000</p>')?.basis).toBe('unknown');
    expect(text('<p>Compensation: $150,000 base</p>')?.basis).toBe('base');
    expect(text('<p>Total salary: $150,000</p>')?.basis).toBe('unknown');
  });

  it('variable, total, bonus, equity or OTE words keep it unknown', () => {
    expect(text('<p>Salary: ₹40 LPA plus variable</p>')?.basis).toBe('unknown');
    expect(text('<p>Salary $150,000 plus equity</p>')?.basis).toBe('unknown');
    expect(text('<p>OTE salary: $150,000</p>')?.basis).toBe('unknown');
  });

  it('the recorded Volga posting (₹19–24 LPA) is now base', () => {
    const volga = hm.find((p) => p.sourceId.includes('volga-partners'))!;
    expect(one(volga).comp).toEqual({ min: 1900000, max: 2400000, currency: 'INR', period: 'year', basis: 'base' });
  });
});

describe('task 7 fix round 2: totals are kept, "+ equity" is not "or more"', () => {
  const text = (description: string): Posting['comp'] =>
    one(raw('jobicy', { id: 9, jobTitle: 'Eng', companyName: 'X', url: 'https://jobicy.com/jobs/9', jobGeo: 'APAC', jobDescription: description }, 'X', 'jobicy')).comp;

  it('keeps a total-type figure (total comp, OTE, TC) with an unknown basis', () => {
    expect(text('<p>Total compensation $40k–$60k</p>')).toEqual({ min: 40000, max: 60000, currency: 'USD', period: 'year', basis: 'unknown' });
    expect(text('<p>OTE ₹50 LPA</p>')).toEqual({ min: 5000000, max: 5000000, currency: 'INR', period: 'year', basis: 'unknown' });
    expect(text('<p>TC: $250,000</p>')).toEqual({ min: 250000, max: 250000, currency: 'USD', period: 'year', basis: 'unknown' });
  });

  it('still skips components named alone', () => {
    expect(text('<p>Bonus: ₹5 LPA</p>')).toBeNull();
    expect(text('<p>₹10 LPA in ESOPs</p>')).toBeNull();
  });

  it('reads "+ equity" as an add-on, but a bare trailing + as "or more"', () => {
    expect(text('<p>Salary: ₹30 LPA + equity</p>')).toEqual({ min: 3000000, max: 3000000, currency: 'INR', period: 'year', basis: 'unknown' });
    expect(text('<p>Salary: $120k+</p>')).toEqual({ min: 120000, max: null, currency: 'USD', period: 'year', basis: 'base' });
    expect(text('<p>Salary: $120k + bonus</p>')).toEqual({ min: 120000, max: 120000, currency: 'USD', period: 'year', basis: 'unknown' });
  });
});

describe('task 7 fix round 3: a total word beside a component sets no comp (I-R1)', () => {
  const text = (description: string): Posting['comp'] =>
    one(raw('jobicy', { id: 9, jobTitle: 'Eng', companyName: 'X', url: 'https://jobicy.com/jobs/9', jobGeo: 'APAC', jobDescription: description }, 'X', 'jobicy')).comp;

  it('skips the reviewer sentences', () => {
    for (const t of [
      'On-target earnings include a ₹10 LPA variable component.',
      'OTE includes ₹15 LPA variable.',
      'Your total compensation will include a joining bonus of ₹5 LPA.',
      'Total package includes ₹3 LPA relocation support.',
      'Total compensation includes base salary, bonus and RSUs worth up to ₹20 LPA.',
      'TC includes ₹25 LPA in ESOPs.',
      'Total rewards: ₹2 LPA learning stipend.',
      'Total compensation comprises a ₹30 LPA package.',
    ]) expect(text(`<p>${t}</p>`), t).toBeNull();
  });

  it('keeps a total on its own, and CTC with a component (CTC is base-type)', () => {
    expect(text('<p>OTE ₹50 LPA</p>')?.max).toBe(5000000);
    expect(text('<p>TC: $250,000</p>')).toEqual({ min: 250000, max: 250000, currency: 'USD', period: 'year', basis: 'unknown' });
    expect(text('<p>CTC up to ₹45 LPA including variable</p>')).toEqual({ min: null, max: 4500000, currency: 'INR', period: 'year', basis: 'unknown' });
    expect(text('<p>Salary: ₹80 LPA. Total compensation includes ₹20 LPA in RSUs.</p>')).toEqual({ min: 8000000, max: 8000000, currency: 'INR', period: 'year', basis: 'base' });
  });
});
