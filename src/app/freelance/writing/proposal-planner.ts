import { z } from 'zod';
import { defineAgent } from '../../../kernel/agent.js';
import { defineContract } from '../../../kernel/contract.js';
import { COMPACT, displayRoles, failLoud, isRankable, planResume, roleIndexOf, writingPackOf, type WritingPack } from '../../agents/writing/grounded.js';
import { fill, sanitisePostingText, unsafePostingText } from '../../agents/writing/templates.js';
import { termsIn, type TermGroup } from '../../lexicon.js';
import { forbiddenTermStrict } from '../../pack/rules.js';
import type { ResumePlan } from '../../types.js';
import { type Gig, GigDocsPlan, ScoredGig } from '../types.js';
import { evidenceFor } from './gig-evidence.js';
import { gigPostingOf, planGigCover } from './gig-cover.js';
import { asciiPunct, DOMAIN_KEYS, hasNonAsciiPunct, PHRASES, pick, planCategory, variantOf } from './phrases.js';
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
 *   a role and whose matched terms meet `covered`, in rank order. A candidate is *literal* when one of its covered
 *   matched terms is named in the gig title, skills or hook quote. The **lead** is chosen first: among the literal
 *   candidates within the top 3 by rank, the first whose terms the hook quote names (relevance beats rotation),
 *   else the one at `variantOf(gigKey, k)` (k of them; a deterministic rotation among equals), else the first literal
 *   candidate, else rank 1; the lead is exempt from the length limit. The other candidates
 *   drop a claim over 220 characters while enough shorter ones remain (else it moves last), take at most 2 per
 *   employer (the lead counts), and the rest of the lines are the shortest of the first four (ties by rank), shown in
 *   rank order after the lead: at most 3 lines for a proposal (2 when 3 would put it, `{cadence}` unfilled, over the
 *   platform's `maxChars`), 2 for a pitch. Each line is `- <display employer> (<role start year>-<end year or "now">):
 *   <claim>`, the claim verbatim with ASCII punctuation (`asciiPunct`), its role the one it is placed in. A proposal
 *   puts a `PHRASES.evidenceIntro` line before the list.
 * - **Hook.** With at least one evidence line, the best client sentence to quote (`hookQuote`), in an attributed
 *   `PHRASES.hook` phrase. Else, when the gig title qualifies (`hookTitle`), a `PHRASES.hookTitle` phrase naming it
 *   (with or without evidence; it claims nothing). Else a `PHRASES.hookTerm` phrase naming the hook term: the first covered key that is not a
 *   domain (`DOMAIN_KEYS`) named in the title, then the skills, else the lead fact's first non-domain matched key.
 *   With no evidence or no such term, `PHRASES.hookPlain`.
 * - **Plan.** `PHRASES.planIntro`, then a wording of the steps of the title's category (`planCategory`).
 * - **Availability.** A `PHRASES.availability` phrase with `freelance.yaml` `maxHoursPerWeek` and `istWindow`; the
 *   `{cadence}` placeholder stays for the gig renderer (`cadenceOf`).
 * - **Question.** For the focus missing key (`focusKey`): a `PHRASES.domainQuestion` for a domain key (`DOMAIN_KEYS`),
 *   else `PHRASES.question`; with nothing missing, a scope question.
 * - **Variant** of every slot: `variantOf(gigKey, n)` (`phrases.ts`).
 * - Kind `gig` gets a proposal, kind `contract` a pitch (`pitch-planner.ts`); a bounty or network alert gets no plan.
 *   A contract from an employer job board also gets a cover letter (`cover`, freelance-v2: `gig-cover.ts`).
 * - **Shortlist (Task 9).** The agent plans nothing for a gig whose fit is under `freelance.fitFloor` (`belowFitFloor`);
 *   `planGigDocs` itself plans any scored gig (the gig-grounding eval runs it on every fixture gig).
 */

const GigRules = z.object({
  freelance: z.object({ maxHoursPerWeek: z.number(), istWindow: z.string(), fitFloor: z.number() }),
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
  readonly hook: { readonly text: string; readonly quote: string | null; readonly title: string | null };
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
const FIRST_PERSON_OR_BIDDER = /^(?:I|I'm|I've|My|Me|You|Your)\b/iu;
const WE_OR_OUR = /^(?:We|We're|We've|Our)\b/iu;
const OUR_DEVELOPER = /^Our\s+(?:developers?|devs?|engineers?|programmers?|freelancers?)\b/iu;
const requests = (s: string): number => [...s.matchAll(REQUEST)].length;

/**
 * Whether a sentence may be quoted:
 * - at least 3 words; no URL or email, quote mark, brace, markup, control character, non-ASCII punctuation or
 *   forbidden term;
 * - not a list (a short "Label: " prefix, four or more commas, or a stray list number at the end, "configuration 9.");
 * - not opening with I, My, Me, You or Your ("You ..." is about the bidder, so the hook would read as a claim that the
 *   user meets it); opening with We or Our only as a request ("We need ...", "We are looking for ..."), never "Our
 *   developer ..." (the hook is attributed, "You wrote:", so the client's "we" is never read as the user's);
 * - no negation (not, n't, never, without, cannot); not a status ("X is created", "already ...") unless it also asks
 *   for something (a request word).
 */
function quotable(s: string, forbidden: readonly string[]): boolean {
  if (words(s) < 3) return false;
  if (/^\S+(?:\s\S+){0,3}:\s/u.test(s) || (s.match(/,/g) ?? []).length >= 4 || /\s\d{1,2}[.)]$/u.test(s)) return false;
  if (WE_OR_OUR.test(s) && (requests(s) === 0 || OUR_DEVELOPER.test(s))) return false;
  if (FIRST_PERSON_OR_BIDDER.test(s) || NEGATION.test(s.replace(/[’']/gu, "'").replace(/don'?t want/iu, 'dont want')) || (STATUS.test(s) && requests(s) === 0)) return false;
  if (URL_OR_EMAIL.test(s) || /["{}<>\\`]|[\x00-\x1f\x7f]/u.test(s) || hasNonAsciiPunct(s)) return false;
  return forbiddenTermStrict(s, { forbiddenTerms: forbidden }) === undefined;
}

/** Whether every bracket in `s` closes, in order, and double quotes pair up. */
function balanced(s: string): boolean {
  const open: string[] = [];
  const pairs: Readonly<Record<string, string>> = { ')': '(', ']': '[', '}': '{' };
  for (const ch of s) {
    if (ch === '(' || ch === '[' || ch === '{') open.push(ch);
    else if (ch in pairs && open.pop() !== pairs[ch]) return false;
  }
  return open.length === 0 && (s.match(/"/g) ?? []).length % 2 === 0;
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
 * boundary within `max` that keeps at least 6 words, still names a group, has balanced brackets and quote marks and
 * holds a request word (a sentence with no such cut is skipped),
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
    // a cut quote must stand on its own: brackets and quote marks balanced, and still asking for something
    if (quote !== s && (!balanced(quote) || requests(quote) === 0)) continue;
    const named = termsIn(quote, groups, all).length;
    if (named === 0) continue;
    const score = requests(quote) + named;
    if (best === null || score > best.score) best = { quote, cut: quote !== s, score };
  }
  return best === null ? null : { quote: best.quote, cut: best.cut };
}

/** The longest gig title a hook names. */
export const TITLE_MAX = 70;
/** What a cut title may not end on: joining punctuation, or a small word ("for a", "and the"); stripped repeatedly. */
const TRAILING_JOINERS = /(?:[\s,;:\-&(/+|]+|\s+(?:a|an|the|for|of|to|with|and|or|in|on))+$/iu;

/**
 * The client's gig title to name in a hook: the title, whitespace collapsed; a trailing posting timestamp
 * (" - 10/10/2026 06:21 EDT") dropped; cut before its first non-ASCII punctuation mark ("Projects – Real-Time" keeps
 * "Projects"), then at the last space within `max` characters (trailing joiners removed); every cut marked, so the
 * hook puts "..." after the closing quote mark. Null (the hook falls through) when what is left has fewer than 3
 * words, is all capitals, has unbalanced brackets, or holds a URL or email, a quote mark, brace, markup, control
 * character or forbidden term. Always a prefix of the collapsed title, so G-GROUND checks it as a substring.
 */
export function hookTitle(title: string, max: number, forbidden: readonly string[] = []): { title: string; cut: boolean } | null {
  let t = collapse(title).replace(/\s+-\s+\d{1,2}\/\d{1,2}\/\d{2,4}\b.*$/u, '');
  let cut = false;
  const at = [...t].findIndex((ch) => hasNonAsciiPunct(ch));
  if (at >= 0) {
    t = [...t].slice(0, at).join('').replace(TRAILING_JOINERS, '');
    cut = true;
  }
  if (t.length > max) {
    const sp = t.lastIndexOf(' ', max);
    if (sp <= 0) return null;
    t = t.slice(0, sp).replace(TRAILING_JOINERS, '');
    cut = true;
  }
  if (words(t) < 3 || !/\p{Ll}/u.test(t) || !balanced(t)) return null;
  if (URL_OR_EMAIL.test(t) || /["{}<>\\`]|[\x00-\x1f\x7f]/u.test(t)) return null;
  if (forbiddenTermStrict(t, { forbiddenTerms: forbidden }) !== undefined) return null;
  return { title: t, cut };
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

interface Candidate {
  readonly id: string;
  readonly claim: string;
  readonly role: ReturnType<typeof displayRoles>[number];
  readonly matched: readonly string[];
  readonly i: number;
}

/** The evidence candidates: ranked placed facts whose matched terms meet the covered list, in rank order. */
function candidatesOf(resume: ResumePlan, pack: WritingPack): Candidate[] {
  const covered = new Set(resume.covered);
  const byId = new Map(pack.facts.map((f) => [f.id, f]));
  const roles = displayRoles(pack);
  return resume.evidence.ranked
    .flatMap((r) => {
      const f = byId.get(r.factId);
      if (f === undefined || !isRankable(f) || !r.matched.some((k) => covered.has(k))) return [];
      const at = roleIndexOf(f, roles, pack);
      const role = at === undefined ? undefined : roles[at];
      return role === undefined ? [] : [{ id: f.id, claim: f.claim, role, matched: r.matched.filter((k) => covered.has(k)) }];
    })
    .map((c, i) => ({ ...c, i }));
}

/** The evidence lines (lead first) and the lead's covered matched keys: see the module rules. */
function evidenceLines(cands: readonly Candidate[], literal: ReadonlySet<string>, inQuote: ReadonlySet<string>, gigKey: string, max: number): { lines: FactLine[]; lead: Candidate | undefined } {
  const isLiteral = (c: Candidate): boolean => c.matched.some((k) => literal.has(k));
  const tier = cands.slice(0, 3).filter(isLiteral);
  // relevance beats rotation: a tier fact the hook quote names leads outright; rotation only among equals
  const quoted = tier.find((c) => c.matched.some((k) => inQuote.has(k)));
  const lead = quoted ?? (tier.length > 0 ? tier[variantOf(gigKey, tier.length)] : (cands.find(isLiteral) ?? cands[0]));
  if (lead === undefined) return { lines: [], lead };
  const others = cands.filter((c) => c.id !== lead.id);
  // A claim over CLAIM_SOFT_MAX is skipped while enough shorter ones remain, else moved last; the lead is exempt.
  const short = others.filter((c) => c.claim.length <= CLAIM_SOFT_MAX);
  const pool = short.length >= max - 1 ? short : [...short, ...others.filter((c) => c.claim.length > CLAIM_SOFT_MAX)];
  const perEmployer = new Map<string, number>([[lead.role.employer, 1]]);
  const capped = pool.filter((c) => {
    const n = perEmployer.get(c.role.employer) ?? 0;
    perEmployer.set(c.role.employer, n + 1);
    return n < 2;
  });
  const rest = capped
    .slice(0, 4)
    .sort((a, b) => a.claim.length - b.claim.length || a.i - b.i)
    .slice(0, Math.max(0, max - 1))
    .sort((a, b) => a.i - b.i);
  return { lines: [lead, ...rest].map((c) => ({ text: evidenceLine(c.role.employer, c.role, c.claim), factIds: [c.id] })), lead };
}

/** The hook term: the first non-domain covered key named in the title, then the skills, else the lead fact's first non-domain matched key. */
function hookTermKey(resume: ResumePlan, gig: Gig, lead: Candidate | undefined, pack: WritingPack): string | undefined {
  const keys = resume.covered.filter((k) => !DOMAIN_KEYS.has(k));
  const all = allGroups(pack);
  for (const text of [gig.title, skillsText(gig)]) {
    const hit = keys.find((k) => termsIn(text, groupsOf([k], pack), all).length > 0);
    if (hit !== undefined) return hit;
  }
  return keys.find((k) => lead?.matched.includes(k) === true);
}

/** The hook: see the module rules. */
function hookOf(gig: Gig, quote: { quote: string; cut: boolean } | null, termKey: string | undefined, hasEvidence: boolean, hookChars: number | null, pack: WritingPack): GigSlots['hook'] {
  if (quote !== null && hasEvidence) return { text: fill(pick(PHRASES.hook, gig.gigKey), { quote: quote.quote, end: endOf(quote.quote, quote.cut) }), quote: quote.quote, title: null };
  const phrase = pick(PHRASES.hookTitle, gig.gigKey);
  const room = hookChars === null ? TITLE_MAX : Math.min(TITLE_MAX, hookChars - (phrase.length - '{title}'.length - '{end}'.length + 3));
  const t = hookTitle(gig.title, room, pack.naming.forbiddenTerms);
  if (t !== null) return { text: fill(phrase, { title: t.title, end: t.cut ? '...' : '' }), quote: null, title: t.title };
  if (termKey !== undefined && hasEvidence) return { text: fill(pick(PHRASES.hookTerm, gig.gigKey), { term: asciiPunct(displayAny(termKey, pack)) }), quote: null, title: null };
  return { text: pick(PHRASES.hookPlain, gig.gigKey), quote: null, title: null };
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
  const cands = candidatesOf(resume, pack);
  const phrase = pick(PHRASES.hook, gig.gigKey);
  const hookChars = rule?.hookChars ?? null;
  const room = hookChars === null ? QUOTE_MAX : Math.min(QUOTE_MAX, hookChars - (phrase.length - '{quote}'.length - '{end}'.length + 3));
  const all = allGroups(pack);
  const quote = cands.length === 0 ? null : hookQuote(gig.description, groupsOf(resume.covered, pack), all, room, pack.naming.forbiddenTerms);
  const literal = new Set(termsIn(`${gig.title}\n${skillsText(gig)}\n${quote?.quote ?? ''}`, groupsOf(resume.covered, pack), all));
  const inQuote = new Set(quote === null ? [] : termsIn(quote.quote, groupsOf(resume.covered, pack), all));
  const { lines: evidence, lead } = evidenceLines(cands, literal, inQuote, gig.gigKey, maxEvidence);
  return {
    hook: hookOf(gig, quote, hookTermKey(resume, gig, lead, pack), evidence.length > 0, hookChars, pack),
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
  return planResume(evidenceFor(gigPostingOf(gig, pack, gig.platform), pack, rawPack), pack, COMPACT);
}

/** The GigDocsPlan of one scored gig, or undefined for a kind that gets neither a proposal nor a pitch. */
export function planGigDocs(scored: ScoredGig, rawPack: unknown): GigDocsPlan | undefined {
  const gig = scored.risked.verdict.rated.gig;
  if (gig.kind !== 'gig' && gig.kind !== 'contract') return undefined;
  const resume = gigResume(scored, rawPack);
  const base = { gigKey: gig.gigKey, scored, platform: gig.platform, resume, covered: [...resume.covered], missing: [...resume.missing] };
  if (gig.kind === 'contract') {
    // freelance-v2: a contract role from an employer job board also gets the daily cover letter (`gig-cover.ts`); the
    // key is left out for every other gig, so their plans are byte-identical to before.
    const c = planGigCover(gig, writingPackOf(rawPack, 'proposal-planner'), rawPack, GigRules.parse(rawPack).freelance);
    const extra = c === undefined ? {} : 'cover' in c ? { cover: c.cover } : { coverNote: c.note };
    return { ...base, proposal: null, pitch: pitchOf(gigSlots(scored, resume, rawPack, 2)), ...extra };
  }
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
  version: '1.7.0',
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

/**
 * The shortlist rule of the freelance wiring (Task 9): a gig scored below `freelance.fitFloor` gets no documents, in
 * any list, so the planner returns nothing for it (as the daily evidence-matcher does below `minFit`).
 */
export const belowFitFloor = (scored: ScoredGig, rawPack: unknown): boolean => scored.fit < GigRules.parse(rawPack).freelance.fitFloor;

export const proposalPlanner = defineAgent(proposalPlannerContract, async (scored, ctx) => {
  if (failLoud('proposal-planner', () => belowFitFloor(scored, ctx.pack))) return [];
  const plan = failLoud('proposal-planner', () => planGigDocs(scored, ctx.pack));
  return plan === undefined ? [] : [plan];
});
