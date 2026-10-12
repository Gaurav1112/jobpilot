/**
 * The phrase bank of the gig documents (spec §7, Task 8): the only words in a proposal or pitch that are not the
 * client's own (the hook quote) or a verified fact's claim. Several hand-written phrasings per slot; one gig always gets
 * the same one (`variantOf`), different gigs get different ones. Plain ASCII only: Freelancer.com strips some Unicode.
 *
 * Every phrase must read naturally with every value its slots can take, and none may claim anything a fact does not
 * back: a quoting hook is always attributed ("You wrote:") and claims nothing about the gig, it only points to the
 * closest evidence (used only when some follows; the planner checks); the evidence intro only introduces the lines below; a plan step promises only a way of working, never past work.
 *
 * Slots: `{quote}` the client's words; `{title}` the client's gig title; `{end}` "..." after a cut quote, "." after a quote with no closing punctuation,
 * else nothing; `{term}` a lexicon display name; `{maxHoursPerWeek}`, `{istWindow}` the freelance rules; `{cadence}` left for the gig renderer (`answers.yaml` `updateCadence`).
 */

/** `parseInt(gigKey.slice(0, 8), 16) % n`: the variant of a slot with `n` phrasings. */
export function variantOf(gigKey: string, n: number): number {
  if (n <= 0) throw new Error('a phrase slot has no variants');
  const v = Number.parseInt(gigKey.slice(0, 8), 16);
  if (!Number.isFinite(v)) throw new Error('gigKey does not start with 8 hex digits');
  return v % n;
}

/** The phrase of `list` for this gig, offset by `i` (so consecutive lines of one slot differ). */
export function pick<T>(list: readonly T[], gigKey: string, i = 0): T {
  const v = list[(variantOf(gigKey, list.length) + i) % list.length];
  if (v === undefined) throw new Error('a phrase slot has no variants');
  return v;
}

export type Steps = readonly [string, string, string];
/** The plan categories, in the order `planCategory` tries them (first match wins). */
export const PLAN_CATEGORIES = ['audit', 'fix', 'finish', 'migrate', 'ai', 'integrate', 'build', 'default'] as const;
export type PlanCategory = (typeof PLAN_CATEGORIES)[number];

export interface PhraseBank {
  /** A hook that quotes the client, always attributed ("You wrote:", "Your brief says"). */
  readonly hook: readonly string[];
  /** A hook naming the client's own gig title (no sentence to quote). Claims nothing; used with or without evidence. */
  readonly hookTitle: readonly string[];
  /** A hook with no quote that names a covered term (no sentence safe to quote, but a covered term). */
  readonly hookTerm: readonly string[];
  /** A hook with no quote and no term (nothing covered, or no evidence line follows). */
  readonly hookPlain: readonly string[];
  /** The line before the evidence list. */
  readonly evidenceIntro: readonly string[];
  readonly planIntro: readonly string[];
  /** Per plan category, at least two wordings of its three steps. A way of working only; nothing about past work. */
  readonly planSteps: Readonly<Record<PlanCategory, readonly Steps[]>>;
  readonly availability: readonly string[];
  /** A question about the first missing requirement (a skill). */
  readonly question: readonly string[];
  /** A question about a missing domain (fintech, healthcare, ...). */
  readonly domainQuestion: readonly string[];
  /** A scope question, when nothing is missing. */
  readonly scopeQuestion: readonly string[];
}

export const PHRASES: PhraseBank = {
  hook: [
    'You wrote: "{quote}"{end} Below is the work of mine that comes closest.',
    'I read your brief, and this line stood out: "{quote}"{end}',
    'Your brief says "{quote}"{end} My closest work to what you describe is below.',
    'You mentioned "{quote}"{end} I would like to help with that; my closest work is below.',
  ],
  hookTitle: [
    'Re your "{title}"{end} post: here is how I would approach it.',
    'On your "{title}"{end} project, here is what I would bring and how I would run it.',
    'I read your "{title}"{end} brief and would like to help with it.',
    'For "{title}"{end}, here is how I would take it from start to handover.',
    'Your "{title}"{end} post caught my eye. Here is how I would approach it.',
  ],
  hookTerm: [
    'I read through your brief, and the {term} side is where I would start.',
    'I would like to help with this, starting with the {term} work.',
    'Happy to take this on. The {term} part is where I would begin, and my closest work is below.',
    'Here is how I would approach this, starting with the {term} side.',
    'I have read your brief; the {term} work is where I would put my first hours.',
    '{term} is the part of your brief I would take on first.',
    'Starting with {term}, here is how I would take this on.',
    'On the {term} side, here is what I would bring and how I would run it.',
    'The {term} piece looks like the right place to start, so that is where my plan begins.',
  ],
  hookPlain: [
    'I read through your brief. Here is what I would bring to it.',
    'I have read your brief and would like to help with this.',
    'Happy to take this on. Below is how I would approach it.',
    'Thanks for the brief. Here is how I would take this from start to handover.',
    'Here is a short plan for this, and the work of mine that is closest to it.',
    'Below is how I would run this, step by step, and what I would hand over.',
  ],
  evidenceIntro: ['A few examples from my work:', 'Some of my work that overlaps with this:', 'From my own work:'],
  planIntro: ['How I would approach it:', 'My plan:', 'How I would run this:'],
  planSteps: {
    audit: [
      [
        'Agree with you what is in scope and what a finding should look like.',
        'Go through it systematically and write down each finding with its impact and a suggested fix.',
        'Walk you through the report and help you decide what to fix first.',
      ],
      [
        'Confirm the scope, the access I need and when you want the report.',
        'Review it area by area, noting each issue with evidence and severity.',
        'Hand over a written report with clear next steps, and answer questions on it.',
      ],
    ],
    fix: [
      [
        'Reproduce the problem first, so we agree on what broken looks like.',
        'Find the root cause, fix it, and add a test that would have caught it.',
        'Explain what went wrong and anything nearby likely to break the same way.',
      ],
      [
        'Get the failing case running on my side, with logs if you have them.',
        'Trace it to the cause rather than the symptom, then fix it with a regression test.',
        'Send you a short note on the cause, the fix and how to check it.',
      ],
    ],
    finish: [
      [
        'Get the existing code running and list what is left, riskiest first.',
        'Close the gaps one at a time, testing each against the real setup.',
        'Deploy with you, then hand over notes on running, updating and rolling back.',
      ],
      [
        'Read through what is already there and agree the remaining work with you.',
        'Finish and harden it in small steps, each one deployable on its own.',
        'Ship it, check it in production, and leave a short runbook.',
      ],
    ],
    migrate: [
      [
        'Map what exists today and what has to move, data and integrations included.',
        'Migrate in stages, keeping the old path working until the new one is proven.',
        'Cut over with a rollback plan, then remove what is no longer needed.',
      ],
      [
        'List what the current system does and agree the target and the order of the move.',
        'Move one part at a time, checking results against the old system as we go.',
        'Switch over once the results match, with a way back if anything looks wrong.',
      ],
    ],
    integrate: [
      [
        'Read the API docs and agree the exact flows and failure cases with you.',
        'Build the integration with retries, idempotency and clear logging, tested against the sandbox.',
        'Go live with monitoring in place and a note on what to watch.',
      ],
      [
        'Confirm the endpoints, the credentials and the events we need to handle.',
        'Implement each flow end to end in the sandbox, error paths included.',
        'Switch to production together and hand over the configuration notes.',
      ],
    ],
    ai: [
      [
        'Pin down the inputs, the expected outputs and a small set of real examples to test against.',
        'Build the pipeline step by step, measuring each change against those examples.',
        'Hand over the prompts, the test set and notes on cost and the known failure cases.',
      ],
      [
        'Agree what a good answer looks like, with a handful of real examples.',
        'Build the simplest version that works, then improve it against those examples.',
        'Hand over with the prompts, the test set and notes on cost and limits.',
      ],
    ],
    build: [
      [
        'Agree the scope of a first version with you, and what done looks like for it.',
        'Build it in small pieces, each one tested and something you can try.',
        'Hand over with a short README covering setup, deploy and the main decisions.',
      ],
      [
        'Turn the brief into a short list of milestones and confirm it with you.',
        'Work through them in order, sharing a working build at each step.',
        'Finish with tests, setup notes and a walkthrough of the code.',
      ],
    ],
    default: [
      [
        'Start by confirming the scope with you and what done looks like.',
        'Work in small milestones, each one something you can run and review.',
        'Finish with a clean handover: code, setup notes and anything still open.',
      ],
      [
        'Confirm with you what is needed and by when.',
        'Work in short steps and show you progress as I go.',
        'Wrap up with a clean handover and notes on anything still open.',
      ],
    ],
  },
  availability: [
    'I can give this {maxHoursPerWeek} hours a week, mostly {istWindow} IST, with updates every {cadence}.',
    'I have up to {maxHoursPerWeek} hours a week for this, mostly {istWindow} IST, and I will send an update every {cadence}.',
    'I work mostly {istWindow} IST and can put up to {maxHoursPerWeek} hours a week into this, with an update every {cadence}.',
  ],
  question: [
    'How much of this depends on {term}? It changes how I would plan the work.',
    'Is experience with {term} a hard requirement, or open to discussion?',
    'One question: how important is {term} experience for this?',
  ],
  domainQuestion: [
    'Is prior {term} experience essential, or is strong engineering enough?',
    'How much does {term} domain knowledge matter here, compared with the engineering itself?',
    'Do you need someone who has worked in {term} before, or is solid engineering enough?',
  ],
  scopeQuestion: [
    'What does done look like for the first milestone?',
    'Is there existing code I would be working in, or is this a fresh start?',
    'Who would I be working with day to day, and how do you like to review progress?',
  ],
};

/** Lexicon keys that name a business domain: a missing one is asked about as a domain, not a skill. */
export const DOMAIN_KEYS: ReadonlySet<string> = new Set([
  'fintech', 'healthcare', 'healthtech', 'e-commerce', 'ecommerce', 'saas', 'edtech', 'insurtech', 'banking', 'payments', 'logistics', 'retail', 'gaming', 'adtech', 'web3', 'crypto',
]);

/** Title keywords per plan category, tried in `PLAN_CATEGORIES` order; matched as whole words, any case. */
export const CATEGORY_WORDS: Readonly<Record<Exclude<PlanCategory, 'default'>, readonly string[]>> = {
  audit: ['audit', 'audits', 'review', 'assessment'],
  fix: ['fix', 'fixes', 'bug', 'bugs', 'debug', 'debugging', 'issue', 'issues', 'error', 'errors'],
  finish: ['finish', 'existing', 'hardening', 'deploy', 'upgrade', 'release'],
  migrate: ['migrate', 'migration', 'port'],
  integrate: ['integrate', 'integration', 'integrations', 'api', 'stripe', 'payment gateway', 'webhook', 'webhooks'],
  ai: ['ai model', 'ai models', 'ml model', 'ml models', 'llm', 'llms', 'gpt', 'claude', 'openai', 'rag', 'ai agent', 'ai agents', 'agentic', 'chatbot', 'chatbots', 'machine learning', 'generative'],
  build: ['build', 'platform', 'app', 'apps', 'develop', 'developer', 'development', 'mvp'],
};

const wordRe = (w: string): RegExp => new RegExp(`(?<![\\p{L}\\p{N}])${w.replace(/\s+/g, '\\s+')}(?![\\p{L}\\p{N}])`, 'iu');

/** A title about using AI tools ("AI-Assisted Software Engineer"), not building AI: never the `ai` category. */
const USES_AI = /\bai[- ]assisted\b|\bai[- ]powered (?:dev|engineer)|\busing ai\b/iu;

/**
 * The plan category of a gig title: the first category (in `PLAN_CATEGORIES` order) with one of its keywords in the
 * title as a whole word, else `default`. A title about using AI tools (`USES_AI`) skips `ai`.
 */
export function planCategory(title: string): PlanCategory {
  for (const c of PLAN_CATEGORIES) {
    if (c === 'default') return c;
    if (c === 'ai' && USES_AI.test(title)) continue;
    if (CATEGORY_WORDS[c].some((w) => wordRe(w).test(title))) return c;
  }
  return 'default';
}

const ASCII_MAP: ReadonlyArray<readonly [RegExp, string]> = [
  [/(?<=\p{N})[–—](?=\p{N})/gu, '-'],
  [/\s*[–—―]\s*/gu, ' - '],
  [/[‐‑‒−]/gu, '-'],
  [/[‘’‚′]/gu, "'"],
  [/[“”„″]/gu, '"'],
  [/…/gu, '...'],
  [/→/gu, '->'],
  [/←/gu, '<-'],
  [/•/gu, '-'],
  [/[   ]/gu, ' '],
];

/**
 * Plain ASCII punctuation for a fact claim or display employer shown in a proposal or pitch: dashes, quotes, the
 * ellipsis, arrows, the bullet and non-breaking spaces become their ASCII forms ("2019-2021", "X - Y"). Letters and digits
 * are never changed, so the claim keeps every word, number and name. G-GROUND checks the claim through this function.
 */
export function asciiPunct(s: string): string {
  let out = s;
  for (const [re, to] of ASCII_MAP) out = out.replace(re, to);
  return out;
}

/** Whether `s` has punctuation or a symbol outside ASCII (a letter outside ASCII is fine). */
export const hasNonAsciiPunct = (s: string): boolean => /[^\x00-\x7f]/u.test(s.replace(/[\p{L}\p{M}\p{N}]/gu, ''));
