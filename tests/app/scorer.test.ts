import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { scorerLexicon, scorePosting } from '../../src/app/agents/scorer-lexicon.js';
import { appEvalSpecs } from '../../src/app/evals.js';
import { hasTerm, termsIn } from '../../src/app/lexicon.js';
import { loadPack } from '../../src/app/pack/load.js';
import { EligibilityVerdict, Scored, type Posting } from '../../src/app/types.js';
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
  source: 'lever',
  sourceId: 's1',
  company: 'Example Lever Co',
  slug: 'example-lv',
  ats: 'lever',
  title: 'Software Engineer',
  url: 'https://jobs.example.com/1',
  locationText: 'Remote - India',
  remote: { structured: 'remote', countries: ['india'], signals: ['workplaceType:remote'] },
  employmentType: 'Full-time',
  descriptionText: '',
  postedAt: null,
  comp: null,
  yearsRequired: null,
  ...over,
});
const verdict = (p: Posting, v: 'eligible' | 'review' | 'rejected' = 'eligible', notes: string[] = []): EligibilityVerdict => ({
  posting: p,
  verdict: v,
  reasons: v === 'review' ? ['remote-unclear'] : v === 'rejected' ? ['onsite'] : [],
  notes,
});

describe('lexicon: termsIn', () => {
  const groups = [
    { key: 'c++', synonyms: [] },
    { key: '.net', synonyms: ['c#'] },
    { key: 'node', synonyms: ['node.js', 'nodejs'] },
    { key: 'go', synonyms: ['golang'] },
    { key: 'spring', synonyms: ['spring boot'] },
    { key: 'event-driven', synonyms: ['event driven'] },
    { key: 'java', synonyms: [] },
  ];

  it('matches symbols literally: c++, c#, .net, node.js', () => {
    expect(termsIn('We write C++ and C# on .NET, plus Node.js.', groups)).toEqual(['.net', 'c++', 'node']);
    expect(termsIn('ASP.NET Core, VB.NET', groups)).toEqual(['.net']); // asp.net and vb.net are .NET
    expect(termsIn('see example.net/jobs', groups)).toEqual([]);
    expect(termsIn('c+ or c++x or abc++', groups)).toEqual([]);
    expect(termsIn('c#/f#', groups)).toEqual(['.net']);
    expect(termsIn('a .network of things', groups)).toEqual([]);
  });

  it('matches whole words only, case-insensitive', () => {
    expect(termsIn('JAVA developers', groups)).toEqual(['java']);
    expect(termsIn('javascript only', groups)).toEqual([]);
    expect(termsIn('nodes and node-red', groups)).toEqual([]); // bare node is ambiguous, and not a list item here
    expect(termsIn('springfield', groups)).toEqual([]);
  });

  it('counts each group once through its synonyms, keys sorted', () => {
    expect(termsIn('Spring Boot, spring, Java, java, event driven, event-driven', groups)).toEqual(['event-driven', 'java', 'spring']);
  });

  it('go: never inside a word, never English go; needs a qualifier, a tech list or a skill phrase', () => {
    const go = (t: string) => termsIn(t, groups).includes('go');
    for (const t of ['good engineers', 'Google Cloud', 'go-to-market plan', 'ready to go', 'Be bold, go above and beyond', 'go live in May', "let's go, team", 'we go fast and go far', 'on the go', 'Go-getter wanted', 'gopher', 'go/no-go decisions', 'a no-go area', 'Go and check the dashboard', 'In Go we trust', '(Go)', '- Go'])
      expect(go(t), t).toBe(false);
    for (const t of ['Java, Go, Python', 'Go/Java', 'Languages: Java, Python and Go', 'Python or Go.', 'experience in Go', 'written in Go', 'familiar with go', 'deep knowledge of Go', 'Go services at scale', 'Go programming', '- Go, Java', 'golang', 'Golang microservices', 'Go (Golang)'])
      expect(go(t), t).toBe(true);
  });

  it('ambiguous words: the reviewer golden cases (task 7 fix round 1)', () => {
    const lex = [
      { key: 'react', synonyms: [] }, { key: 'spark', synonyms: [] }, { key: 'spring', synonyms: ['spring boot'] },
      { key: 'node', synonyms: ['node.js', 'nodejs'] }, { key: 'llm', synonyms: ['llms', 'large language model', 'large language models', 'ai'] },
      { key: 'go', synonyms: ['golang'] }, { key: 'typescript', synonyms: [] }, { key: 'rust', synonyms: [] }, { key: 'ruby', synonyms: [] },
      { key: 'kubernetes', synonyms: ['k8s'] }, { key: 'kotlin', synonyms: [] },
    ];
    const cases: [string, string[]][] = [
      ['companies can react faster', []],
      ['React, TypeScript', ['react', 'typescript']],
      ['a spark of genius', []],
      ['Spark Streaming', ['spark']],
      ['spring hiring', []],
      ['Spring Boot', ['spring']],
      ['Kubernetes node pools', ['kubernetes']],
      ['Node.js', ['node']],
      ['we embrace AI', []],
      ['AI/ML platform', ['llm']],
      ['go/no-go', []],
      ['Kotlin, Swift, JAVA, and React', ['kotlin', 'react']],
      ['spring, summer', []],
      ['ReactJS and React.js', ['react']],
      ['AI-powered tools', []],
      ['use AI', []],
      ['generative AI features', ['llm']],
      ['GenAI', ['llm']],
      ['AI platform team', ['llm']],
      ['large language models', ['llm']],
      ['Ruby on Rails', ['ruby']],
      ['rust belt', []],
      ['Rust, Go', ['go', 'rust']],
      ['spark ideas', []],
      ['each node in the cluster', []],
    ];
    for (const [t, want] of cases) expect(termsIn(t, lex), t).toEqual(want);
  });

  it('ambiguous words in bullet blocks, beside a tech term, after a label or before skills (fix round 3, I-R2)', () => {
    const lex = [...pack.lexicon.strong, ...pack.lexicon.medium, ...pack.lexicon.gap];
    const cases: [string, string[]][] = [
      ['Requirements:\n- Go\n- Postgres\n- Kafka', ['go', 'kafka', 'postgres']],
      ['Requirements:\n- Spring\n- Hibernate\n- MySQL', ['spring']],
      ['- Spring\n- Kafka', ['kafka', 'spring']],
      ['1. Go\n2. Kafka', ['go', 'kafka']],
      ['• React\n• Redux', ['react']],
      ['Build payment services.\nGo\nPostgres', ['go', 'postgres']],
      ['We use Go and Postgres.', ['go', 'postgres']],
      ['Backend: Go', ['go']],
      ['Tech: React', ['react']],
      ['Strong Go skills.', ['go']],
      ['Spring, Hibernate, JPA', ['spring']],
      ['Node, Express', ['node']],
      ['Flink/Spark pipelines', ['spark']],
      ['Ruby/Rails, Go', ['go', 'ruby']],
      ['React experience is a plus', ['react']],
      // homonyms stay non-hits
      ['companies can react faster', []],
      ['a spark of genius', []],
      ['spring hiring', []],
      ['Kubernetes node pools', ['kubernetes']],
      ['Go and check the dashboard', []],
      ['In Go we trust', []],
      ['go/no-go', []],
      ['rust belt', []],
      ['- Spring hiring drive\n- Summer offsite', []],
      ['Note: go to the portal', []],
    ];
    for (const [t, want] of cases) expect(termsIn(t, lex), t).toEqual(want);
  });

  it('adjacency needs the ambiguous word delimited on its other side or capitalised mid-sentence; use / built with are skill phrases (fix round 4)', () => {
    const lex = [...pack.lexicon.strong, ...pack.lexicon.medium, ...pack.lexicon.gap];
    const cases: [string, string[]][] = [
      ['We use Go and Postgres.', ['go', 'postgres']],
      ['we use go and postgres.', ['go', 'postgres']],
      ['Services built with spring.', ['spring']],
      ['We hire every spring and Kotlin is our language.', []],
      ['Kubernetes, node pools', ['kubernetes']],
      ['Learn Python and go beyond.', ['python']],
      ['Our stack uses Java and Go.', ['go', 'java']],
      ['Spring, Hibernate, JPA', ['spring']],
      ['Ruby/Rails, Go', ['go', 'ruby']],
    ];
    for (const [t, want] of cases) expect(termsIn(t, lex), t).toEqual(want);
  });

  it('the careers fixture gets medium:go back (fix round 3, I-R2)', () => {
    // The recorded careers JSON-LD job (tests/fixtures/careers/job-jsonld.html) normalises to this description.
    const p = posting({ title: 'Senior Backend Engineer', descriptionText: 'Build payment services.\n\n- Go\n- Postgres' });
    const s = scorePosting(verdict(p), pack);
    expect(s.jdTerms).toEqual({ strong: ['postgres'], medium: ['go'], gap: [] });
    expect(s.score).toBe(54); // 30 + 8 + 10 + 4 + 1.5 = 53.5
  });

  it('an empty or blank term matches nothing (a stray "" in the pack must not match every posting)', () => {
    expect(hasTerm('anything at all', '')).toBe(false);
    expect(hasTerm('anything at all', '  ')).toBe(false);
    expect(termsIn('anything', [{ key: 'x', synonyms: ['', ' - '] }])).toEqual([]);
  });

  it('hasTerm treats space and hyphen inside a term alike', () => {
    expect(hasTerm('SDE 3 role', 'sde-3')).toBe(true);
    expect(hasTerm('SDE-III', 'sde iii')).toBe(true);
    expect(hasTerm('SDE-30', 'sde-3')).toBe(false);
  });
});

describe('scorer-lexicon: the v2 §6 formula', () => {
  const STRONG10 = 'java, spring boot, kafka, microservices, distributed systems, postgresql, event-driven, aws, kubernetes, redis';
  const MEDIUM6 = 'golang, typescript, react, rabbitmq, docker, grpc';

  it('scores the v2 worked example at 89', () => {
    const s = scorePosting(verdict(posting({ title: 'Lead Software Engineer', descriptionText: `We use ${STRONG10}. Also ${MEDIUM6}.` })), pack);
    expect(s.score).toBe(89);
    expect(s.breakdown[0]).toEqual({ label: 'base', points: 30 });
    expect(s.breakdown[1]).toEqual({ label: 'title:seniority', points: 10 });
    expect(s.breakdown.filter((b) => b.label.startsWith('strong:'))).toHaveLength(10);
    expect(s.breakdown.filter((b) => b.label.startsWith('medium:'))).toHaveLength(6);
    expect(s.breakdown.some((b) => b.label === 'title:family')).toBe(false);
    expect(s.jdTerms.medium).toEqual(['docker', 'go', 'grpc', 'rabbitmq', 'react', 'typescript']);
  });

  it('gives senior +8 only when no higher seniority word applies, and the title family +10', () => {
    const senior = scorePosting(verdict(posting({ title: 'Senior Backend Engineer' })), pack);
    expect(senior.breakdown).toEqual([{ label: 'base', points: 30 }, { label: 'title:seniority', points: 8 }, { label: 'title:family', points: 10 }]);
    expect(senior.score).toBe(48);
    const staff = scorePosting(verdict(posting({ title: 'Senior Staff Platform Engineer' })), pack);
    expect(staff.breakdown).toEqual([{ label: 'base', points: 30 }, { label: 'title:seniority', points: 10 }, { label: 'title:family', points: 10 }]);
    expect(scorePosting(verdict(posting({ title: 'Staffing Partner' })), pack).score).toBe(30);
  });

  it('reads Sr. as senior and back end / back-end as the backend family (task 7 fix round 1 pack)', () => {
    expect(scorePosting(verdict(posting({ title: 'Sr. Software Engineer' })), pack).breakdown).toEqual([{ label: 'base', points: 30 }, { label: 'title:seniority', points: 8 }]);
    expect(scorePosting(verdict(posting({ title: 'Sr Back-end Engineer' })), pack).score).toBe(48);
    expect(scorePosting(verdict(posting({ title: 'Back End Engineer' })), pack).breakdown).toEqual([{ label: 'base', points: 30 }, { label: 'title:family', points: 10 }]);
  });

  it('subtracts gaps and the years penalty, rounds half up, clamps to 0..100', () => {
    const s = scorePosting(verdict(posting({ title: 'Engineer', descriptionText: 'Scala, Rust, C++, C#, Ruby, PHP, Elixir, Spark, Hadoop', yearsRequired: 15 })), pack);
    expect(s.breakdown.at(-1)).toEqual({ label: 'years>max', points: -20 });
    expect(s.score).toBe(0); // 30 - 9 gaps x 4 - 20 = -26, clamped
    const half = scorePosting(verdict(posting({ title: 'Engineer', descriptionText: 'Python.' })), pack);
    expect(half.score).toBe(32); // 31.5 rounds up
    const fourteen = scorePosting(verdict(posting({ title: 'Engineer', yearsRequired: 14 })), pack);
    expect(fourteen.breakdown).toEqual([{ label: 'base', points: 30 }]);
  });

  it('reads skills from the description only, never the title', () => {
    const s = scorePosting(verdict(posting({ title: 'Java Engineer', descriptionText: 'Nothing listed.' })), pack);
    expect(s.jdTerms).toEqual({ strong: [], medium: [], gap: [] });
    expect(s.breakdown).toEqual([{ label: 'base', points: 30 }, { label: 'title:family', points: 10 }]);
  });

  it('passes verdict and notes through, and emits nothing for a rejected verdict', async () => {
    const p = posting({ title: 'Engineer' });
    const s = scorePosting(verdict(p, 'review', ['remote scope unclear - verify', 'pay not disclosed']), pack);
    expect(s).toMatchObject({ verdict: 'review', notes: ['remote scope unclear - verify', 'pay not disclosed'], posting: p });
    expect(Scored.schema.safeParse(s).success).toBe(true);
    const ctx = issueContext({
      contract: scorerLexicon.contract, policy: PRODUCT_POLICY_V1, inputClass: 'P0', providers: { fetch: async () => ({ status: 404, text: async () => '' }) },
      clock: fixedClock('2026-01-01T00:00:00Z'), signal: new AbortController().signal, pack: frozen,
    });
    expect(await scorerLexicon.run(verdict(p, 'rejected'), ctx)).toEqual([]);
    expect(await scorerLexicon.run(verdict(p), ctx)).toHaveLength(1);
  });

  it('fails closed without a pack', async () => {
    const ctx = issueContext({
      contract: scorerLexicon.contract, policy: PRODUCT_POLICY_V1, inputClass: 'P0', providers: { fetch: async () => ({ status: 404, text: async () => '' }) },
      clock: fixedClock('2026-01-01T00:00:00Z'), signal: new AbortController().signal,
    });
    await expect(scorerLexicon.run(verdict(posting()), ctx)).rejects.toThrow(/pack/);
  });

  it('declares one skill, the pack capability, and no spend', () => {
    const c = scorerLexicon.contract;
    expect(c).toMatchObject({ id: 'scorer-lexicon', team: 'evaluation', kind: 'deterministic', capabilities: { pack: true } });
    expect(c.consumes.id).toBe(EligibilityVerdict.id);
    expect(c.produces.id).toBe(Scored.id);
  });
});

describe('scorer-lexicon golden eval', () => {
  it('passes its gate of 1.0 with at least 8 cases, the worked example included', async () => {
    const spec = appEvalSpecs(join(root, 'evals/datasets'), join(root, 'tests/fixtures/pack')).find((s) => s.agent.contract.id === 'scorer-lexicon');
    expect(spec).toBeDefined();
    expect(spec!.cases.length).toBeGreaterThanOrEqual(8);
    expect(spec!.cases.some((c) => (c.expected as { score: number }).score === 89)).toBe(true);
    const r = await runEval(spec!, { providers: { fetch: async () => ({ status: 404, text: async () => '' }) }, policy: PRODUCT_POLICY_V1 });
    expect(r.failures).toEqual([]);
    expect(r).toMatchObject({ score: 1, pass: true, min: 1 });
  });
});
