import type { Eligibility, Feeds, Filters, Fx, Lexicon, Targets } from './schema.js';

/**
 * Built-in pack defaults written by `jobpilot pack import` (Task 12): the generic v2 discovery rules
 * (docs/research/v2-discovery-rules.md §5 and §6) with the Task 7 corrections. Nothing here is personal: no name,
 * no employer, no fact. The user edits the written files afterwards; these are only the starting point.
 */

/** v2 §6 STRONG / MEDIUM / GAP, each with its display casing (how documents show the term). */
export const DEFAULT_LEXICON: Lexicon = {
  strong: [
    { key: 'java', synonyms: [], display: 'Java' },
    { key: 'spring', synonyms: ['spring boot'], display: 'Spring' },
    { key: 'kafka', synonyms: [], display: 'Kafka' },
    { key: 'microservices', synonyms: ['microservice', 'micro-services', 'micro-service'], display: 'Microservices' },
    { key: 'distributed systems', synonyms: ['distributed system'], display: 'Distributed Systems' },
    { key: 'postgres', synonyms: ['postgresql'], display: 'PostgreSQL' },
    { key: 'event-driven', synonyms: ['event driven'], display: 'Event-Driven' },
    { key: 'aws', synonyms: [], display: 'AWS' },
    { key: 'kubernetes', synonyms: ['k8s'], display: 'Kubernetes' },
    { key: 'redis', synonyms: [], display: 'Redis' },
    { key: 'multi-tenant', synonyms: ['multitenant', 'multi tenant', 'multi-tenancy', 'multitenancy'], display: 'Multi-tenant' },
    { key: 'saas', synonyms: [], display: 'SaaS' },
    { key: 'fintech', synonyms: ['payments'], display: 'Fintech' },
    // Bare "ai" no longer counts (Task 7): only the explicit LLM wordings do.
    { key: 'llm', synonyms: ['llms', 'large language model', 'large language models'], display: 'LLM' },
  ],
  medium: [
    { key: 'go', synonyms: ['golang'], display: 'Go' },
    { key: 'typescript', synonyms: [], display: 'TypeScript' },
    { key: 'node', synonyms: ['node.js', 'nodejs'], display: 'Node.js' },
    { key: 'react', synonyms: [], display: 'React' },
    { key: 'rabbitmq', synonyms: [], display: 'RabbitMQ' },
    { key: 'sqs', synonyms: [], display: 'SQS' },
    { key: 'gcp', synonyms: [], display: 'GCP' },
    { key: 'docker', synonyms: [], display: 'Docker' },
    { key: 'elasticsearch', synonyms: [], display: 'Elasticsearch' },
    { key: 'mongodb', synonyms: [], display: 'MongoDB' },
    { key: 'cqrs', synonyms: [], display: 'CQRS' },
    { key: 'ddd', synonyms: [], display: 'DDD' },
    { key: 'grpc', synonyms: [], display: 'gRPC' },
    { key: 'mcp', synonyms: [], display: 'MCP' },
    { key: 'rag', synonyms: [], display: 'RAG' },
    { key: 'python', synonyms: [], display: 'Python' },
  ],
  gap: [
    { key: 'scala', synonyms: [], display: 'Scala' },
    { key: 'rust', synonyms: [], display: 'Rust' },
    { key: 'c++', synonyms: [], display: 'C++' },
    { key: '.net', synonyms: ['c#'], display: '.NET' },
    { key: 'ruby', synonyms: [], display: 'Ruby' },
    { key: 'php', synonyms: [], display: 'PHP' },
    { key: 'elixir', synonyms: [], display: 'Elixir' },
    { key: 'spark', synonyms: [], display: 'Spark' },
    { key: 'hadoop', synonyms: [], display: 'Hadoop' },
  ],
};

/** v2 §6 title scoring, with `sr` in the senior group and `back end` as a title bonus word (Task 7). */
export const DEFAULT_TARGETS: Omit<Targets, 'claimableTitles'> = {
  titles: ['backend engineer', 'software engineer', 'platform engineer', 'staff engineer', 'principal engineer', 'lead engineer', 'sde 3'],
  seniority: [
    { words: ['staff', 'lead', 'principal', 'sde-3', 'sde iii'], points: 10 },
    { words: ['senior', 'sr'], points: 8 },
  ],
  titleBonusWords: ['backend', 'back end', 'platform', 'java', 'distributed'],
  titleBonusPoints: 10,
  minFit: 60,
  maxYearsRequired: 14,
  yearsPenalty: 20,
};

/**
 * v2 §5 hard excludes.
 * - `roleDeny`: regex sources (flags 'iu', compiled only by `compileSafePattern`), anchored so they do not drop
 *   legitimate roles: `quality`, `mobile` and `hardware` name the role, not the bare word (Task 7, reviewer M4).
 * - `companyDeny`: the v2 services, consulting and staffing names verbatim, plus `HCLTech` (the current brand).
 * - `employmentDeny`: kept, with the meaning eligibility gives it since Task 7 fix round 2: words that reject only
 *   when they stand bare in the job **title** as its employment label ("(Contract)", "... - Freelance",
 *   "Contract Java Developer", "Backend Engineer (6 months)"). The description is checked with eligibility's own fixed
 *   phrases, not with this list. The list is the v2 §5 employment-type list verbatim (Task 12 fix I2).
 */
export const DEFAULT_FILTERS: Filters = {
  roleDeny: [
    'front[- ]?end',
    '\\bmobile (engineer|developer)\\b',
    '\\bios\\b',
    'android',
    '\\bqa\\b',
    'sdet',
    'test automation',
    'in test',
    '\\bquality (assurance|engineer|analyst)\\b',
    'engineering manager',
    'director',
    '^manager\\b',
    '\\bsales\\b',
    '\\baccount (executive|manager)\\b',
    '\\bsolutions? engineer\\b',
    'support engineer',
    '\\bsupport agent\\b',
    'customer success',
    'devrel',
    'developer advocate',
    'recruiter',
    'designer',
    'data scientist',
    'ml scientist',
    '\\bintern(ship)?\\b',
    'embedded',
    'firmware',
    '\\bhardware engineer\\b',
    'security analyst',
    'sre manager',
  ],
  companyDeny: [
    'TCS', 'Tata Consultancy', 'Infosys', 'Wipro', 'HCL', 'HCLTech', 'Tech Mahindra', 'Cognizant', 'Accenture', 'Capgemini',
    'LTIMindtree', 'Mindtree', 'Mphasis', 'Hexaware', 'Persistent', 'Birlasoft', 'Zensar', 'Cyient', 'L&T Technology', 'UST',
    'Virtusa', 'Coforge', 'NIIT', 'Sonata', 'KPIT', 'Mastek', 'Happiest Minds', 'Thoughtworks', 'Incubyte', 'Scalio',
    'Deloitte', 'EY', 'KPMG', 'PwC', 'IBM Consulting', 'NTT Data', 'DXC', 'Atos', 'Genpact', 'GlobalLogic', 'EPAM', 'Ciklum',
    'Randstad', 'TeamLease', 'Quess', 'Adecco', 'Michael Page', 'ABC Consultants', 'Sourcebae', 'Uplers', 'Xformics',
    'UnionSys', 'Jobgether', 'GiantMind', 'Synthires', 'Staffnix', 'TalixoHR', 'JobCrexa', 'MindBrain', 'Hire Feed',
  ],
  employmentDeny: ['contract', 'contractor', 'c2h', 'contract-to-hire', 'freelance', 'temporary', 'fixed-term', '3 months', '6 months', 'hourly'],
};

/** v2 §3: resident in India, remote scopes that include India, full-time only, no onsite city. */
export const DEFAULT_ELIGIBILITY: Eligibility = {
  residence: 'IN',
  acceptRemoteScopes: ['India', 'APAC', 'Worldwide', 'Anywhere'],
  onsiteCities: [],
  employmentTypes: ['full-time'],
};

export const DEFAULT_FEEDS: Feeds = { enabled: ['himalayas', 'jobicy'] };

/**
 * Pinned rates to INR, with the 1970 sentinel date so the dashboard's stale-rates warning fires until the user
 * writes real rates (`--fx-file`, or by editing fx.yaml).
 */
export const DEFAULT_FX: Fx = { asOf: '1970-01-01', toINR: { USD: 83, EUR: 90, GBP: 105, INR: 1 } };

/** Watchlist slugs known to post only fully remote roles (the import sets `allRemote` for these alone). */
export const ALL_REMOTE_SLUGS: readonly string[] = ['gitlab'];
