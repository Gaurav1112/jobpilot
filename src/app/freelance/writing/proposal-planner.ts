import { z } from 'zod';
import { defineAgent } from '../../../kernel/agent.js';
import { defineContract } from '../../../kernel/contract.js';
import { failLoud, planResume, writingPackOf, type WritingPack } from '../../agents/writing/grounded.js';
import { asSentence, fill, sanitisePostingText, startsWithPastVerb, unsafePostingText } from '../../agents/writing/templates.js';
import { termsIn, type TermGroup } from '../../lexicon.js';
import { forbiddenTermStrict } from '../../pack/rules.js';
import type { ResumePlan } from '../../types.js';
import { GigDocsPlan, ScoredGig } from '../types.js';
import { evidenceFor, syntheticPosting } from './gig-evidence.js';
import { asciiPunct, hasNonAsciiPunct, PHRASES, pick, stepsOf } from './phrases.js';
import { pitchOf } from './pitch-planner.js';

/**
 * proposal-planner (spec §7, Task 8): the screening documents of one scored gig, planned from the gig and the pack
 * alone. Pure and deterministic; G-GROUND (`gigDocsProblems`) re-derives the whole plan with these functions.
 *
 * - **Resume (the contract CV).** `planResume` of the Evidence (`evidenceFor`, the real scorer) of the gig's synthetic
 *   posting: key the gigKey, title the gig title, company the platform, text the description plus the skills line
 *   (as the gig scorer reads it), firstSeen the gig's `postedAt` (else the first day of the pack's asOf month).
 *   `covered` and `missing` are the resume plan's.
 * - **Evidence lines.** The resume bullets, in Evidence rank order, whose matched terms meet `covered`: at most 3 for a
 *   proposal (2 when 3 would put the proposal, `{cadence}` unfilled, over the platform's `maxChars`), 2 for a pitch.
 *   Each is the claim verbatim (ASCII punctuation, `asciiPunct`) after `PHRASES.evidenceLead`: a claim starting with a
 *   past-tense verb has its first letter lower-cased after "I"; the lead is chosen by the tense of the role the bullet
 *   is in, or "again" for the same employer as the line before. The employer is the role's display employer.
 * - **Hook.** With at least one evidence line: the first sentence of the description (whitespace collapsed, as the
 *   normalizer does) that names a covered term and is safe to quote (`hookQuote`), quoted verbatim in a
 *   `PHRASES.hook` phrase. A sentence longer than the room left (140 characters, and the hook within the platform's
 *   `hookChars`) is cut at a word boundary, with "..." after the closing quote mark, and only if the cut part still
 *   names a covered term. With no such sentence, a `PHRASES.hookTerm` phrase naming the first covered key's display;
 *   with no evidence line or nothing covered, a `PHRASES.hookPlain` phrase.
 * - **Plan.** `PHRASES.planIntro`, then the three steps of the first covered key that has a step library, else
 *   `default`.
 * - **Availability.** A `PHRASES.availability` phrase with `freelance.yaml` `maxHoursPerWeek` and `istWindow`; the
 *   `{cadence}` placeholder stays for the gig renderer (`cadenceOf`).
 * - **Question.** A `PHRASES.question` phrase naming the display of the first missing key, else a scope question.
 * - **Variant** of every slot: `variantOf(gigKey, n)` (`phrases.ts`); consecutive evidence lines step one variant on.
 * - Kind `gig` gets a proposal, kind `contract` a pitch (`pitch-planner.ts`); a bounty or network alert gets no plan.
 */

const GigRules = z.object({
  freelance: z.object({ maxHoursPerWeek: z.number(), istWindow: z.string() }),
  platformRules: z.record(z.string(), z.object({ maxChars: z.number().nullable(), hookChars: z.number().nullable() })),
});

/** The longest quote of the client's words. */
export const QUOTE_MAX = 140;
/** The update cadence when `answers.yaml` has no `updateCadence`. */
export const DEFAULT_CADENCE = 'two days';
/** The one placeholder a plan keeps for the gig renderer. */
export const CADENCE_PLACEHOLDER = '{cadence}';

type FactLine = { text: string; factIds: string[] };
type Proposal = NonNullable<GigDocsPlan['proposal']>;

/** Every slot both documents draw from. */
export interface GigSlots {
  readonly hook: { readonly text: string; readonly quote: string | null };
  readonly evidence: readonly FactLine[];
  readonly planIntro: string;
  readonly plan: readonly string[];
  readonly availability: string;
  readonly question: string;
}

const collapse = (s: string): string => s.replace(/\s+/g, ' ').trim();
const URL_OR_EMAIL = /https?:\/\/|www\.|@|\b[a-z0-9-]+\.(?:com|io|net|org|dev|app|ai|co|me|in)\b/i;
const words = (s: string): number => s.split(' ').filter((w) => w !== '').length;

/**
 * Whether a sentence may be quoted: at least 3 words; no URL or email, quote mark, brace, markup, control character,
 * non-ASCII punctuation or forbidden term; not a list (a short "Label: " prefix, four or more commas, or a stray list
 * number at the end, "configuration 9."); not about the bidder (first word "You" or "Your"), so the hook never reads as
 * a claim that the user meets it.
 */
function quotable(s: string, forbidden: readonly string[]): boolean {
  if (words(s) < 3) return false;
  if (/^\S+(?:\s\S+){0,3}:\s/u.test(s) || (s.match(/,/g) ?? []).length >= 4 || /\s\d{1,2}[.)]$/u.test(s) || /^your?\b/iu.test(s)) return false;
  if (URL_OR_EMAIL.test(s) || /["{}<>\\`]|[\x00-\x1f\x7f]/u.test(s) || hasNonAsciiPunct(s)) return false;
  return forbiddenTermStrict(s, { forbiddenTerms: forbidden }) === undefined;
}

/**
 * The client's words to quote: the first sentence of `description` (whitespace collapsed) that names one of `groups`
 * and is quotable (a leading list marker dropped), whole when it fits `max` characters, else cut at the last space within `max` (trailing commas,
 * colons, dashes and spaces removed) when the cut part still names a group. Null when no sentence qualifies.
 */
export function hookQuote(description: string, groups: readonly TermGroup[], all: readonly TermGroup[], max: number, forbidden: readonly string[] = []): { quote: string; cut: boolean } | null {
  if (groups.length === 0 || max < 20) return null;
  for (const sentence of collapse(description).split(/(?<=[.!?])\s+/u)) {
    // a list marker ("- ", "* ", "2) ") is not the client's words; what follows it is still a substring
    const s = sentence.replace(/^(?:[-*+>#]+|\d{1,2}[.)])\s+/u, '');
    if (termsIn(s, groups, all).length === 0 || !quotable(s, forbidden)) continue;
    if (s.length <= max) return { quote: s, cut: false };
    const at = s.lastIndexOf(' ', max);
    if (at <= 0) continue;
    const part = s.slice(0, at).replace(/[\s,;:\-(]+$/u, '');
    if (termsIn(part, groups, all).length > 0 && quotable(part, forbidden)) return { quote: part, cut: true };
  }
  return null;
}

/** `{end}` of a hook phrase: "..." after a cut quote, "." after one with no closing punctuation, else nothing. */
const endOf = (quote: string, cut: boolean): string => (cut ? '...' : /[.!?]$/.test(quote) ? '' : '.');

const lowerFirst = (s: string): string => `${s.charAt(0).toLowerCase()}${s.slice(1)}`;
const allGroups = (pack: WritingPack): WritingPack['lexicon']['strong'] => [...pack.lexicon.strong, ...pack.lexicon.medium, ...pack.lexicon.gap];
/** The display name of any lexicon key, gap keys included. */
const displayAny = (key: string, pack: WritingPack): string => allGroups(pack).find((g) => g.key === key)?.display ?? key;

/** The evidence lines of a resume plan: see the module rules. */
function evidenceLines(resume: ResumePlan, gigKey: string, max: number): FactLine[] {
  const covered = new Set(resume.covered);
  const where = new Map(resume.roles.flatMap((r) => r.bullets.map((b) => [b.factId, { role: r, text: b.text }] as const)));
  const chosen = resume.evidence.ranked.filter((r) => where.has(r.factId) && r.matched.some((k) => covered.has(k))).slice(0, max);
  let before: string | undefined;
  return chosen.map((r, i) => {
    const { role, text } = where.get(r.factId) as { role: ResumePlan['roles'][number]; text: string };
    const claim = asciiPunct(text);
    const employer = asciiPunct(role.employer);
    const verb = startsWithPastVerb(claim);
    const again = before === employer;
    before = employer;
    const L = PHRASES.evidenceLead;
    const lead = verb ? (again ? L.again : role.end === 'present' ? L.now : L.past) : again ? L.colonAgain : L.colon;
    return { text: `${fill(pick(lead, gigKey, i), { employer })}${asSentence(verb ? lowerFirst(claim) : claim)}`, factIds: [r.factId] };
  });
}

/** The hook: see the module rules. */
function hookOf(gigKey: string, description: string, resume: ResumePlan, evidence: readonly FactLine[], hookChars: number | null, pack: WritingPack): GigSlots['hook'] {
  const phrase = pick(PHRASES.hook, gigKey);
  const room = hookChars === null ? QUOTE_MAX : Math.min(QUOTE_MAX, hookChars - (phrase.length - '{quote}'.length - '{end}'.length + 3));
  const all = allGroups(pack);
  const groups: TermGroup[] = resume.covered.flatMap((k) => all.find((g) => g.key === k) ?? []);
  const q = evidence.length === 0 ? null : hookQuote(description, groups, all, room, pack.naming.forbiddenTerms);
  const first = resume.covered[0];
  if (q === null && evidence.length > 0 && first !== undefined) return { text: fill(pick(PHRASES.hookTerm, gigKey), { term: asciiPunct(displayAny(first, pack)) }), quote: null };
  if (q === null) return { text: pick(PHRASES.hookPlain, gigKey), quote: null };
  return { text: fill(phrase, { quote: q.quote, end: endOf(q.quote, q.cut) }), quote: q.quote };
}

/** The proposal's text: hook, evidence lines, plan, availability, question, blank-line separated, `{cadence}` filled. */
export function proposalText(p: Proposal, cadence: string): string {
  const blocks = [[p.hook.text], p.evidence.map((e) => e.text), [p.planIntro, ...p.plan.map((s, i) => `${i + 1}. ${s}`)], [p.availability], [p.question]];
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
  const evidence = evidenceLines(resume, gig.gigKey, maxEvidence);
  const missing = resume.missing[0];
  return {
    hook: hookOf(gig.gigKey, gig.description, resume, evidence, rule?.hookChars ?? null, pack),
    evidence,
    planIntro: pick(PHRASES.planIntro, gig.gigKey),
    plan: [...stepsOf(resume.covered.find((k) => Object.hasOwn(PHRASES.planSteps, k) && k !== 'default'))],
    availability: fill(pick(PHRASES.availability, gig.gigKey), {
      maxHoursPerWeek: rules.freelance.maxHoursPerWeek,
      istWindow: rules.freelance.istWindow,
      cadence: CADENCE_PLACEHOLDER,
    }),
    question: missing === undefined ? pick(PHRASES.scopeQuestion, gig.gigKey) : fill(pick(PHRASES.question, gig.gigKey), { term: asciiPunct(displayAny(missing, pack)) }),
  };
}

/** The contract CV of a gig: `planResume` of its synthetic posting's Evidence. */
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
  return planResume(evidenceFor(posting, pack, rawPack), pack);
}

/** The GigDocsPlan of one scored gig, or undefined for a kind that gets neither a proposal nor a pitch. */
export function planGigDocs(scored: ScoredGig, rawPack: unknown): GigDocsPlan | undefined {
  const gig = scored.risked.verdict.rated.gig;
  if (gig.kind !== 'gig' && gig.kind !== 'contract') return undefined;
  const resume = gigResume(scored, rawPack);
  const base = { gigKey: gig.gigKey, scored, platform: gig.platform, resume, covered: [...resume.covered], missing: [...resume.missing] };
  if (gig.kind === 'contract') return { ...base, proposal: null, pitch: pitchOf(gigSlots(scored, resume, rawPack, 2)) };
  const proposalOf = (s: GigSlots): Proposal => ({ hook: { ...s.hook }, evidence: [...s.evidence], planIntro: s.planIntro, plan: [...s.plan], availability: s.availability, question: s.question });
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
