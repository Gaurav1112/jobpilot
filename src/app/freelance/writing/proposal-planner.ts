import { z } from 'zod';
import { defineAgent } from '../../../kernel/agent.js';
import { defineContract } from '../../../kernel/contract.js';
import { COMPACT, displayRoles, failLoud, isRankable, planResume, roleIndexOf, writingPackOf, type WritingPack } from '../../agents/writing/grounded.js';
import { fill, sanitisePostingText, unsafePostingText } from '../../agents/writing/templates.js';
import { termsIn, type TermGroup } from '../../lexicon.js';
import { forbiddenTermStrict } from '../../pack/rules.js';
import type { ResumePlan } from '../../types.js';
import { type Gig, GigDocsPlan, ScoredGig } from '../types.js';
import { evidenceFor, syntheticPosting } from './gig-evidence.js';
import { asciiPunct, DOMAIN_KEYS, hasNonAsciiPunct, PHRASES, pick, planCategory } from './phrases.js';
import { pitchOf } from './pitch-planner.js';

/**
 * proposal-planner (spec §7, Task 8 and its fix round 1): the screening documents of one scored gig, planned from the
 * gig and the pack alone. Pure and deterministic; G-GROUND (`gigDocsProblems`) re-derives the whole plan with these
 * functions.
 *
 * - **Resume (the 1-page contract CV).** `planResume(..., COMPACT)` (2 bullets for each of the latest two roles, none
 *   for older ones) of the Evidence (`evidenceFor`, the real scorer) of the gig's synthetic posting: key the gigKey,
 *   title the gig title, company the platform, text the description plus the skills line (as the gig scorer reads it),
 *   firstSeen the gig's `postedAt` (else the first day of the pack's asOf month). `covered` and `missing` are the
 *   resume plan's.
 * - **Evidence.** Candidates are the Evidence's ranked facts (citeable experience or project facts) that are placed in
 *   a role and whose matched terms meet `covered`, in rank order, with those matching a covered term found literally in
 *   the gig title or skills moved first (stable). A claim over 220 characters is dropped while at least two shorter
 *   candidates remain, else moved after them. At most 2 per employer. Of the first 5, the first is always chosen and the rest of the lines are the
 *   shortest of the other four (ties by order), all shown in candidate order: at most 3 for a proposal (2 when 3 would put it, `{cadence}` unfilled, over the platform's `maxChars`), 2
 *   for a pitch. Each line is `- <display employer> (<role start year>-<end year or "now">): <claim>`, the claim
 *   verbatim with ASCII punctuation (`asciiPunct`), its role the one it is placed in. A proposal puts a
 *   `PHRASES.evidenceIntro` line before the list.
 * - **Hook.** With at least one evidence line, the best client sentence to quote (`hookQuote`), in an attributed
 *   `PHRASES.hook` phrase. With none, a `PHRASES.hookTerm` phrase naming the focus covered term (`focusKey`); with no
 *   evidence or nothing covered, `PHRASES.hookPlain`.
 * - **Plan.** `PHRASES.planIntro`, then a wording of the steps of the title's category (`planCategory`).
 * - **Availability.** A `PHRASES.availability` phrase with `freelance.yaml` `maxHoursPerWeek` and `istWindow`; the
 *   `{cadence}` placeholder stays for the gig renderer (`cadenceOf`).
 * - **Question.** For the focus missing key (`focusKey`): a `PHRASES.domainQuestion` for a domain key (`DOMAIN_KEYS`),
 *   else `PHRASES.question`; with nothing missing, a scope question.
 * - **Variant** of every slot: `variantOf(gigKey, n)` (`phrases.ts`).
 * - Kind `gig` gets a proposal, kind `contract` a pitch (`pitch-planner.ts`); a bounty or network alert gets no plan.
 */

const GigRules = z.object({
  freelance: z.object({ maxHoursPerWeek: z.number(), istWindow: z.string() }),
  platformRules: z.record(z.string(), z.object({ maxChars: z.number().nullable(), hookChars: z.number().nullable() })),
});

/** The longest quote of the client's words. */
export const QUOTE_MAX = 140;
/** The longest claim an evidence line takes when a shorter candidate exists. */
export const CLAIM_SOFT_MAX = 220;
/** The update cadence when `answers.yaml` has no `updateCadence`. */
export const DEFAULT_CADENCE = 'two days';
/** The one placeholder a plan keeps for the gig renderer. */
export const CADENCE_PLACEHOLDER = '{cadence}';

type FactLine = { text: string; factIds: string[] };
type Proposal = NonNullable<GigDocsPlan['proposal']>;

/** Every slot both documents draw from. */
export interface GigSlots {
  readonly hook: { readonly text: string; readonly quote: string | null };
  readonly evidenceIntro: string;
  readonly evidence: readonly FactLine[];
  readonly planIntro: string;
  readonly plan: readonly string[];
  readonly availability: string;
  readonly question: string;
}

const collapse = (s: string): string => s.replace(/\s+/g, ' ').trim();
const URL_OR_EMAIL = /https?:\/\/|www\.|@|\b[a-z0-9-]+\.(?:com|io|net|org|dev|app|ai|co|me|in)\b/i;
const words = (s: string): number => s.split(' ').filter((w) => w !== '').length;

/** Words that end in "." without ending a sentence (lower-cased, without the final "."). */
const ABBREVIATIONS: ReadonlySet<string> = new Set(['e.g', 'eg', 'i.e', 'ie', 'etc', 'vs', 'u.s', 'u.k', 'e.u', 'approx', 'incl', 'no', 'mr', 'mrs', 'ms', 'dr', 'inc', 'ltd', 'jr', 'sr', 'st', 'min', 'max', 'esp']);

/**
 * The sentences of a text, whitespace collapsed (as the normalizer does), each an exact substring of the collapsed
 * text. A sentence ends at ".", "!" or "?" before a space, but not after an abbreviation ("e.g.", "i.e.", "U.S.",
 * "etc.", a single initial) and not before a lower-case letter.
 */
export function sentencesOf(text: string): string[] {
  const t = collapse(text);
  const out: string[] = [];
  let start = 0;
  for (const m of t.matchAll(/[.!?]+(?= )/gu)) {
    const end = m.index + m[0].length;
    const word = (/(\S+)$/u.exec(t.slice(start, m.index))?.[1] ?? '').replace(/^[("'[]+/u, '').toLowerCase();
    const next = t.charAt(end + 1);
    if (m[0] === '.' && (ABBREVIATIONS.has(word) || /^\p{L}$/u.test(word) || /^(?:\p{L}\.)+\p{L}$/u.test(word))) continue;
    if (/\p{Ll}/u.test(next)) continue;
    out.push(t.slice(start, end).trim());
    start = end;
  }
  const rest = t.slice(start).trim();
  if (rest !== '') out.push(rest);
  return out;
}

const REQUEST = /\b(?:need(?:s|ed)?|looking for|build(?:ing)?|develop(?:ing|ment)?|must|requir(?:e|es|ed|ement|ements)|want(?:s|ed)?|help)\b/giu;
const NEGATION = /\b(?:not|never|without|cannot)\b|n't\b|\bdont want\b/iu;
const STATUS = /\b(?:is|are|was|were|has been|have been)\s+(?:already\s+)?(?:\w+ed|done|ready|complete|live|built|in place|set up|up and running)\b|\balready\b/iu;
const FIRST_PERSON_OR_BIDDER = /^(?:I|I'm|I've|We|We're|We've|Our|My|Me|You|Your)\b/iu;
const requests = (s: string): number => [...s.matchAll(REQUEST)].length;

/**
 * Whether a sentence may be quoted:
 * - at least 3 words; no URL or email, quote mark, brace, markup, control character, non-ASCII punctuation or
 *   forbidden term;
 * - not a list (a short "Label: " prefix, four or more commas, or a stray list number at the end, "configuration 9.");
 * - not opening with I, We, Our, My, Me, You or Your (quoting "We ..." back reads oddly; "You ..." is about the
 *   bidder, so the hook would read as a claim that the user meets it);
 * - no negation (not, n't, never, without, cannot); not a status ("X is created", "already ...") unless it also asks
 *   for something (a request word).
 */
function quotable(s: string, forbidden: readonly string[]): boolean {
  if (words(s) < 3) return false;
  if (/^\S+(?:\s\S+){0,3}:\s/u.test(s) || (s.match(/,/g) ?? []).length >= 4 || /\s\d{1,2}[.)]$/u.test(s)) return false;
  if (FIRST_PERSON_OR_BIDDER.test(s) || NEGATION.test(s.replace(/[’']/gu, "'").replace(/don'?t want/iu, 'dont want')) || (STATUS.test(s) && requests(s) === 0)) return false;
  if (URL_OR_EMAIL.test(s) || /["{}<>\\`]|[\x00-\x1f\x7f]/u.test(s) || hasNonAsciiPunct(s)) return false;
  return forbiddenTermStrict(s, { forbiddenTerms: forbidden }) === undefined;
}

/** The longest prefix of `s` ending at a clause boundary (", ", "; ", " - ", " (") within `max` characters that keeps at least 6 words, or undefined. */
function clauseCut(s: string, max: number): string | undefined {
  let best: string | undefined;
  for (const m of s.matchAll(/, |; | - | \(/gu)) {
    if (m.index > max) break;
    const part = s.slice(0, m.index);
    if (words(part) >= 6) best = part;
  }
  return best;
}

/**
 * The client's words to quote: among the description's sentences (`sentencesOf`, a leading list marker dropped) that
 * name one of `groups` and are quotable, each taken whole when it fits `max` characters, else cut at its last clause
 * boundary within `max` that keeps at least 6 words and still names a group (a sentence with no such cut is skipped),
 * the one with the highest score: request words (need, looking for, build, develop, must, require, want, help) plus
 * the groups it names, ties to the earliest. Null when no sentence qualifies.
 */
export function hookQuote(description: string, groups: readonly TermGroup[], all: readonly TermGroup[], max: number, forbidden: readonly string[] = []): { quote: string; cut: boolean } | null {
  if (groups.length === 0 || max < 20) return null;
  let best: { quote: string; cut: boolean; score: number } | null = null;
  for (const sentence of sentencesOf(description)) {
    // a list marker ("- ", "* ", "2) ") is not the client's words; what follows it is still a substring
    const s = sentence.replace(/^(?:[-*+>#]+|\d{1,2}[.)])\s+/u, '');
    if (termsIn(s, groups, all).length === 0 || !quotable(s, forbidden)) continue;
    const quote = s.length <= max ? s : clauseCut(s, max);
    if (quote === undefined || !quotable(quote, forbidden)) continue;
    const named = termsIn(quote, groups, all).length;
    if (named === 0) continue;
    const score = requests(quote) + named;
    if (best === null || score > best.score) best = { quote, cut: quote !== s, score };
  }
  return best === null ? null : { quote: best.quote, cut: best.cut };
}

/** `{end}` of a hook phrase: "..." after a cut quote, "." after one with no closing punctuation, else nothing. */
const endOf = (quote: string, cut: boolean): string => (cut ? '...' : /[.!?]$/.test(quote) ? '' : '.');

const allGroups = (pack: WritingPack): WritingPack['lexicon']['strong'] => [...pack.lexicon.strong, ...pack.lexicon.medium, ...pack.lexicon.gap];
/** The display name of any lexicon key, gap keys included. */
const displayAny = (key: string, pack: WritingPack): string => allGroups(pack).find((g) => g.key === key)?.display ?? key;
const groupsOf = (keys: readonly string[], pack: WritingPack): TermGroup[] => keys.flatMap((k) => allGroups(pack).find((g) => g.key === k) ?? []);
const skillsText = (gig: Gig): string => gig.skills.join(', ');

/** The first of `keys` named literally in the gig title, then in its skills, else the first key. */
export function focusKey(keys: readonly string[], gig: Gig, pack: WritingPack): string | undefined {
  const all = allGroups(pack);
  for (const text of [gig.title, skillsText(gig)]) {
    const hit = keys.find((k) => termsIn(text, groupsOf([k], pack), all).length > 0);
    if (hit !== undefined) return hit;
  }
  return keys[0];
}

/** `(2022-now)`, `(2018-2022)` or `(2019)`: a role's years, from roles.yaml. */
const yearsOf = (r: { readonly start: string; readonly end: string }): string => {
  const a = r.start.slice(0, 4);
  const b = r.end === 'present' ? 'now' : r.end.slice(0, 4);
  return a === b ? a : `${a}-${b}`;
};

/** One evidence line: see the module rules. */
export const evidenceLine = (employer: string, role: { readonly start: string; readonly end: string }, claim: string): string =>
  `- ${asciiPunct(employer)} (${yearsOf(role)}): ${asciiPunct(claim)}`;

/** The evidence lines: see the module rules. */
function evidenceLines(resume: ResumePlan, gig: Gig, pack: WritingPack, max: number): FactLine[] {
  const covered = new Set(resume.covered);
  const byId = new Map(pack.facts.map((f) => [f.id, f]));
  const roles = displayRoles(pack);
  const literal = new Set(termsIn(`${gig.title}\n${skillsText(gig)}`, groupsOf(resume.covered, pack), allGroups(pack)));
  const cands = resume.evidence.ranked.flatMap((r) => {
    const f = byId.get(r.factId);
    if (f === undefined || !isRankable(f) || !r.matched.some((k) => covered.has(k))) return [];
    const i = roleIndexOf(f, roles, pack);
    const role = i === undefined ? undefined : roles[i];
    return role === undefined ? [] : [{ id: f.id, claim: f.claim, role, literal: r.matched.some((k) => literal.has(k)) }];
  });
  let ordered = [...cands.filter((c) => c.literal), ...cands.filter((c) => !c.literal)];
  // A claim over CLAIM_SOFT_MAX is skipped while at least two shorter ones remain (the 2-line minimum), else moved last.
  const short = ordered.filter((c) => c.claim.length <= CLAIM_SOFT_MAX);
  ordered = short.length >= 2 ? short : [...short, ...ordered.filter((c) => c.claim.length > CLAIM_SOFT_MAX)];
  const perEmployer = new Map<string, number>();
  const capped = ordered.filter((c) => {
    const n = perEmployer.get(c.role.employer) ?? 0;
    perEmployer.set(c.role.employer, n + 1);
    return n < 2;
  });
  const top = capped.slice(0, 5).map((c, i) => ({ ...c, i }));
  const [lead, ...rest] = top;
  const shortest = [...rest].sort((a, b) => a.claim.length - b.claim.length || a.i - b.i).slice(0, Math.max(0, max - 1));
  const chosen = (lead === undefined ? [] : [lead, ...shortest]).sort((a, b) => a.i - b.i);
  return chosen.map((c) => ({ text: evidenceLine(c.role.employer, c.role, c.claim), factIds: [c.id] }));
}

/** The hook: see the module rules. */
function hookOf(gig: Gig, resume: ResumePlan, evidence: readonly FactLine[], hookChars: number | null, pack: WritingPack): GigSlots['hook'] {
  const phrase = pick(PHRASES.hook, gig.gigKey);
  const room = hookChars === null ? QUOTE_MAX : Math.min(QUOTE_MAX, hookChars - (phrase.length - '{quote}'.length - '{end}'.length + 3));
  const q = evidence.length === 0 ? null : hookQuote(gig.description, groupsOf(resume.covered, pack), allGroups(pack), room, pack.naming.forbiddenTerms);
  if (q !== null) return { text: fill(phrase, { quote: q.quote, end: endOf(q.quote, q.cut) }), quote: q.quote };
  const term = evidence.length === 0 ? undefined : focusKey(resume.covered, gig, pack);
  if (term !== undefined) return { text: fill(pick(PHRASES.hookTerm, gig.gigKey), { term: asciiPunct(displayAny(term, pack)) }), quote: null };
  return { text: pick(PHRASES.hookPlain, gig.gigKey), quote: null };
}

/** The question: see the module rules. A one-word capitalised domain ("Fintech") is lower-cased mid-sentence. */
function questionOf(gig: Gig, resume: ResumePlan, pack: WritingPack): string {
  const key = focusKey(resume.missing, gig, pack);
  if (key === undefined) return pick(PHRASES.scopeQuestion, gig.gigKey);
  const shown = asciiPunct(displayAny(key, pack));
  if (DOMAIN_KEYS.has(key)) return fill(pick(PHRASES.domainQuestion, gig.gigKey), { term: /^\p{Lu}\p{Ll}+$/u.test(shown) ? shown.toLowerCase() : shown });
  return fill(pick(PHRASES.question, gig.gigKey), { term: shown });
}

/** The proposal's text: hook, evidence intro and list, plan, availability, question, blank-line separated, `{cadence}` filled. */
export function proposalText(p: Proposal, cadence: string): string {
  const evidence = p.evidence.length === 0 ? [] : [p.evidenceIntro, ...p.evidence.map((e) => e.text)];
  const blocks = [[p.hook.text], evidence, [p.planIntro, ...p.plan.map((s, i) => `${i + 1}. ${s}`)], [p.availability], [p.question]];
  return blocks
    .filter((b) => b.length > 0)
    .map((b) => b.join('\n'))
    .join('\n\n')
    .split(CADENCE_PLACEHOLDER)
    .join(cadence);
}

/**
 * The update cadence for the availability line: `answers.yaml` `updateCadence` (trimmed, one trailing "." removed),
 * default "two days". Throws when it cannot go into a document: it must be its own sanitised form, pass the
 * posting-slot rules (no markup, brace, URL, pronoun or sentence break), have at most 4 words and ASCII punctuation.
 */
export function cadenceOf(answers: Readonly<Record<string, unknown>>): string {
  const v = Object.hasOwn(answers, 'updateCadence') ? answers['updateCadence'] : undefined;
  if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '')) return DEFAULT_CADENCE;
  if (typeof v !== 'string') throw new Error('answers.yaml updateCadence must be text, like "two days"');
  const s = v.trim().replace(/\.$/, '').trim();
  const why = sanitisePostingText(s) !== s ? 'it changes when sanitised' : (unsafePostingText(s) ?? (/[{}]/.test(s) ? 'it has a brace' : words(s) > 4 ? 'it has more than 4 words' : hasNonAsciiPunct(s) ? 'it has non-ASCII punctuation' : null));
  if (why !== null) throw new Error(`answers.yaml updateCadence cannot go into a proposal (${why})`);
  return s;
}

/** Every slot of one gig's documents: see the module rules. */
export function gigSlots(scored: ScoredGig, resume: ResumePlan, rawPack: unknown, maxEvidence: number): GigSlots {
  const pack = writingPackOf(rawPack, 'proposal-planner');
  const rules = GigRules.parse(rawPack);
  const gig = scored.risked.verdict.rated.gig;
  const rule = rules.platformRules[gig.platform];
  const evidence = evidenceLines(resume, gig, pack, maxEvidence);
  return {
    hook: hookOf(gig, resume, evidence, rule?.hookChars ?? null, pack),
    evidenceIntro: evidence.length === 0 ? '' : pick(PHRASES.evidenceIntro, gig.gigKey),
    evidence,
    planIntro: pick(PHRASES.planIntro, gig.gigKey),
    plan: [...pick(PHRASES.planSteps[planCategory(gig.title)], gig.gigKey)],
    availability: fill(pick(PHRASES.availability, gig.gigKey), {
      maxHoursPerWeek: rules.freelance.maxHoursPerWeek,
      istWindow: rules.freelance.istWindow,
      cadence: CADENCE_PLACEHOLDER,
    }),
    question: questionOf(gig, resume, pack),
  };
}

/** The contract CV of a gig: `planResume(..., COMPACT)` of its synthetic posting's Evidence. */
export function gigResume(scored: ScoredGig, rawPack: unknown): ResumePlan {
  const pack = writingPackOf(rawPack, 'proposal-planner');
  const gig = scored.risked.verdict.rated.gig;
  const posting = syntheticPosting({
    key: gig.gigKey,
    title: gig.title,
    company: gig.platform,
    text: gig.skills.length === 0 ? gig.description : `${gig.description}\n${gig.skills.join(', ')}`,
    firstSeen: gig.postedAt ?? `${pack.experience.asOf}-01`,
  });
  return planResume(evidenceFor(posting, pack, rawPack), pack, COMPACT);
}

/** The GigDocsPlan of one scored gig, or undefined for a kind that gets neither a proposal nor a pitch. */
export function planGigDocs(scored: ScoredGig, rawPack: unknown): GigDocsPlan | undefined {
  const gig = scored.risked.verdict.rated.gig;
  if (gig.kind !== 'gig' && gig.kind !== 'contract') return undefined;
  const resume = gigResume(scored, rawPack);
  const base = { gigKey: gig.gigKey, scored, platform: gig.platform, resume, covered: [...resume.covered], missing: [...resume.missing] };
  if (gig.kind === 'contract') return { ...base, proposal: null, pitch: pitchOf(gigSlots(scored, resume, rawPack, 2)) };
  const proposalOf = (s: GigSlots): Proposal => ({
    hook: { ...s.hook },
    evidenceIntro: s.evidenceIntro,
    evidence: [...s.evidence],
    planIntro: s.planIntro,
    plan: [...s.plan],
    availability: s.availability,
    question: s.question,
  });
  let proposal = proposalOf(gigSlots(scored, resume, rawPack, 3));
  const maxChars = GigRules.parse(rawPack).platformRules[gig.platform]?.maxChars ?? null;
  if (maxChars !== null && proposal.evidence.length > 2 && [...proposalText(proposal, CADENCE_PLACEHOLDER)].length > maxChars) proposal = proposalOf(gigSlots(scored, resume, rawPack, 2));
  return { ...base, proposal, pitch: null };
}

export const proposalPlannerContract = defineContract({
  id: 'proposal-planner',
  version: '1.0.0',
  description: 'Plans the grounded screening documents of one gig',
  skills: ['proposal-planning'],
  team: 'writing',
  kind: 'deterministic',
  consumes: ScoredGig,
  produces: GigDocsPlan,
  capabilities: { pack: true },
  dataClasses: { in: ['P0'], out: ['P0'] },
  budget: { usdPerCall: 0, usdPerRun: 0 },
  timeoutMs: 10_000,
  guardrails: { in: [], out: ['G-GROUND', 'G-NAMING', 'G-NO-GAP-CLAIM'] },
});

export const proposalPlanner = defineAgent(proposalPlannerContract, async (scored, ctx) => {
  const plan = failLoud('proposal-planner', () => planGigDocs(scored, ctx.pack));
  return plan === undefined ? [] : [plan];
});
