/**
 * The phrase bank of the gig documents (spec §7, Task 8): the only words in a proposal or pitch that are not the
 * client's own (the hook quote) or a verified fact's claim. Several hand-written phrasings per slot; one gig always gets
 * the same one (`variantOf`), different gigs get different ones. Plain ASCII only: Freelancer.com strips some Unicode.
 *
 * Every phrase must read naturally with every value its slots can take, and none may claim anything a fact does not
 * back: a quoting hook claims nothing about the gig, it only points to the closest evidence lines (it is used only when
 * some follow; the planner checks), a lead
 * names a display employer and the tense of the role it is placed in, and a plan step promises only a way of working.
 *
 * Slots: `{quote}` the client's words; `{term}` in a hook, the display of the first covered key; `{end}` "..." after a cut quote, "." after a quote with no closing punctuation,
 * else nothing; `{employer}` a display employer; `{term}` a lexicon display name; `{maxHoursPerWeek}`, `{istWindow}`
 * the freelance rules; `{cadence}` left for the gig renderer (`answers.yaml` `updateCadence`).
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

export interface PhraseBank {
  /** A hook that quotes the client. */
  readonly hook: readonly string[];
  /** A hook with no quote that names the first covered term (no safe sentence to quote, but a covered term). */
  readonly hookTerm: readonly string[];
  /** A hook with no quote and no term (nothing covered, or no evidence line follows). */
  readonly hookPlain: readonly string[];
  /**
   * The lead before an evidence claim. `now`/`past` (the claim starts with a past-tense verb, lower-cased after "I"),
   * by whether the role the fact is placed in is ongoing; `again` for the same employer as the line before; `colon`
   * and `colonAgain` for a claim that does not start with a verb (verbatim after a colon).
   */
  readonly evidenceLead: { readonly now: readonly string[]; readonly past: readonly string[]; readonly again: readonly string[]; readonly colon: readonly string[]; readonly colonAgain: readonly string[] };
  readonly planIntro: readonly string[];
  /** Three steps per term group (lexicon key), plus `default`. A way of working only; nothing about the gig itself. */
  readonly planSteps: Readonly<Record<string, readonly [string, string, string]>>;
  readonly availability: readonly string[];
  /** A question about the first missing requirement. */
  readonly question: readonly string[];
  /** A scope question, when nothing is missing. */
  readonly scopeQuestion: readonly string[];
}

const BACKEND = [
  'Read the existing code (or your spec, if this is new) and agree the API and data model with you first.',
  'Build it in small pieces, each covered by tests and working end to end before the next one starts.',
  'Hand over with a short README: setup, deploy, and the decisions I made along the way.',
] as const;
const MESSAGING = [
  'Map the events: who produces them, who consumes them, and what must happen when one fails.',
  'Build the flow with retries and idempotent handlers, and test it with duplicate and out-of-order messages.',
  'Add metrics for lag and failures, and write down how to replay messages safely.',
] as const;
const CLOUD = [
  'Review the current setup and write down what runs where and what it costs.',
  'Make the changes as code, one environment at a time, so each step can be rolled back.',
  'Leave you a runbook for deploys, rollbacks and the alerts that matter.',
] as const;
const FRONTEND = [
  'Agree the screens and the data each one needs, working from your designs if you have them.',
  'Build the components against real API responses and check each screen on desktop and mobile.',
  'Hand over clean, typed code with a short note on how to run and extend it.',
] as const;
const AI = [
  'Pin down the inputs, the expected outputs and a small set of real examples to test against.',
  'Build the pipeline step by step, measuring each change against those examples.',
  'Hand over the prompts, the test set and notes on cost and the known failure cases.',
] as const;
const DEFAULT = [
  'Start by confirming the scope with you and what done looks like.',
  'Work in small milestones, each one something you can run and review.',
  'Finish with a clean handover: code, setup notes and anything still open.',
] as const;

export const PHRASES: PhraseBank = {
  hook: [
    'You wrote: "{quote}"{end} Below is the work of mine that comes closest.',
    'I read your brief, and this line stood out: "{quote}"{end}',
    'Your brief says "{quote}"{end} Here is what I have done that is nearest to it.',
    '"{quote}"{end} I would like to help with that. My closest work is below.',
  ],
  hookTerm: [
    'I read through your brief, and the {term} side is where I would start.',
    'I would like to help with this, starting with the {term} work.',
    'Happy to take this on. The {term} part is where I would begin, and my closest work is below.',
    'Here is how I would approach this, starting with the {term} side.',
    'I have read your brief; the {term} work is where I would put my first hours.',
  ],
  hookPlain: [
    'I read through your brief. Here is what I would bring to it.',
    'I have read your brief and would like to help with this.',
    'Happy to take this on. Below is how I would approach it.',
  ],
  evidenceLead: {
    now: ['At {employer}, where I work now, I ', 'In my current role at {employer}, I ', 'At {employer}, I '],
    past: ['At {employer}, I ', 'While at {employer}, I ', 'During my time at {employer}, I '],
    again: ['There I also ', 'I also ', 'Also at {employer}, I '],
    colon: ['At {employer}: ', 'From my work at {employer}: ', 'One example from {employer}: '],
    colonAgain: ['Also at {employer}: ', 'At {employer} as well: ', 'Also from {employer}: '],
  },
  planIntro: ['How I would approach it:', 'My plan:', 'How I would run this:'],
  planSteps: {
    java: BACKEND, spring: BACKEND, go: BACKEND, node: BACKEND, typescript: BACKEND, python: BACKEND, microservices: BACKEND,
    'distributed systems': BACKEND, postgres: BACKEND, redis: BACKEND, mongodb: BACKEND, elasticsearch: BACKEND, grpc: BACKEND,
    cqrs: BACKEND, ddd: BACKEND, 'multi-tenant': BACKEND, saas: BACKEND, fintech: BACKEND,
    kafka: MESSAGING, rabbitmq: MESSAGING, sqs: MESSAGING, 'event-driven': MESSAGING,
    aws: CLOUD, gcp: CLOUD, kubernetes: CLOUD, docker: CLOUD,
    react: FRONTEND,
    llm: AI, rag: AI, mcp: AI,
    default: DEFAULT,
  },
  availability: [
    'I can give this {maxHoursPerWeek} hours a week, mostly {istWindow} IST, with updates every {cadence}.',
    'I have up to {maxHoursPerWeek} hours a week for this, mostly {istWindow} IST, and I will send an update every {cadence}.',
    'I work mostly {istWindow} IST and can put up to {maxHoursPerWeek} hours a week into this, with an update every {cadence}.',
  ],
  question: [
    'Would you count {term} as a must-have here, or as a bonus?',
    'How much of this depends on {term}? It changes how I would plan the work.',
    'Is experience with {term} a hard requirement, or open to discussion?',
    'One question: how important is {term} experience for this?',
  ],
  scopeQuestion: [
    'What does done look like for the first milestone?',
    'Is there existing code I would be working in, or is this a fresh start?',
    'Who would I be working with day to day, and how do you like to review progress?',
  ],
};

/** The step library of a term group key, else `default`. */
export const stepsOf = (key: string | undefined): readonly [string, string, string] => (key !== undefined ? PHRASES.planSteps[key] : undefined) ?? DEFAULT;

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
