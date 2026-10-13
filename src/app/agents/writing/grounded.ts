import { z } from 'zod';
import { KernelError } from '../../../kernel/errors.js';
import { hasTerm, tagsBack, termsIn, type TermGroup } from '../../lexicon.js';
import { citeable, employerDisplay } from '../../pack/rules.js';
import { isCalendarDate, type CoverPlan, type Evidence, type Posting, type ResumePlan, type Scored } from '../../types.js';
import {
  COVER_P4,
  evidenceSentence,
  openingSentence,
  renderOpening,
  renderSummary,
  sanitisePostingText,
  signatureSentence,
  startsWithPastVerb,
  type EvidenceSlots,
  type OpeningSlots,
  type SummarySlots,
} from './templates.js';

/**
 * The grounded writing rules (spec §5.4, Task 9 and its fix round 1), shared by the three writing agents and by
 * G-GROUND, which re-derives every plan from the posting and the pack with these functions and also checks the
 * invariants independently. Pure and deterministic: no clock, no randomness, every list in a total order.
 *
 * Rules:
 * - **Citeable facts.** Only `verified` and `user-stated` facts are ever read for content (`citeable`). Ranked facts
 *   (bullets, cover facts) are the citeable facts of kind `experience` or `project`; certs are kind `cert`; education
 *   facts are kind `education`.
 * - **Employers.** Every raw employer string (facts and roles) goes through `employerDisplay`. Every fact and role
 *   employer in the pack is checked on every run, so an unmapped employer naming a forbidden term fails loudly.
 * - **asOf.** The pack's `experience.asOf` (YYYY-MM) is the "now" of every date rule: years and recency. The
 *   posting's `postedAt` is never used for either (fix C1).
 * - **JD terms** are the scorer's `jdTerms` (lexicon keys found in the JD). Gap keys are never covered.
 * - **Backing.** A non-gap lexicon key is backed for the skills line when a citeable fact of kind experience, project
 *   or cert has a `tech` tag that is the key or a synonym (`tagsBack`); education facts back nothing.
 *   `covered` = the JD's strong and medium keys so backed; `missing` = every other JD key. A key may stand in the
 *   summary ("N+ years building X") only when a citeable *experience* fact placed in a role backs it (fix I2).
 * - **Key order** (covered, missing, skills, summary terms): strong before medium before gap, then lexicon order.
 * - **Display.** Every term a document shows is its group's `display` (default: the key) (fix I5).
 * - **Rank** = 3 x |JD keys the fact's tech backs| + 1 x |JD keys in the claim text (`termsIn`)| + recency, where
 *   recency = max(0, (120 - age) / 120) and age is the months from the fact's period end ('present' = asOf) to asOf.
 *   Rounded to 4 decimals; ties are broken by fact id.
 * - **Years** = floor(months / 12), where months = the size of the union of the roles' months before the asOf month:
 *   a role covers [start, end] with the end month included ('present' runs to asOf), and the asOf month itself is not
 *   counted. Overlapping roles are not double-counted and gaps are not counted.
 * - **firstSeen** (document metadata only, read by no rule) = the posting's `postedAt` date when it is a real calendar
 *   date, else the first day of the asOf month.
 * - **Headline** = the `targets.claimableTitles` entry (titles the candidate truthfully holds; default: the ongoing
 *   roles' titles) with the most of its words in the sanitised posting title (`hasTerm`), used verbatim; a seniority
 *   word (`SENIORITY_WORDS`) counts as matched when the posting title has any seniority word, so "Senior Backend
 *   Engineer" is closer to "Staff Software Engineer" than "Founding Engineer" is. A tie goes to the claimableTitles
 *   order, never to the current role's title (cover letter v2). With no ongoing role it is the most recent role's
 *   title, and p1 uses the past-tense `COVER_TITLE_PAST` (fix round 2, I-R1).
 * - **Placement** (fix I3). A ranked fact is placed in a role at its display employer whose dates contain the fact's
 *   whole period (role end 'present' and fact end 'present' are asOf). If several do, the one whose title equals
 *   `fact.role`, else the newest. A fact no role contains is never a bullet: it is listed in `unplaced`.
 * - **Roles** = every role, newest first (start descending, then ongoing before ended, then end descending, then
 *   employer, title, location). Bullets: the top 4 placed facts for the latest two roles, 2 for the rest, in rank
 *   order, each the verbatim claim. A role with no placed fact has no bullets.
 * - **Skills** = the display of the covered keys, then of every other backed non-gap key, in key order.
 * - **Certs** and **education** = citeable `cert` and `education` facts, verbatim, period start descending, then id.
 * - **Summary**: `renderSummary` with title = the headline, years, top1..top4 = the display of the first four covered
 *   keys that an experience fact placed in a role backs, and employer = the display employer of the newest ongoing
 *   role (none ongoing: no employer slot, no "Currently at").
 * - **Cover** (v2; only facts placed in a role are cited, so each has an employer): `coverSlots` computes every slot
 *   and `renderCover` renders the templates of `templates.ts` from them. p1 is `renderOpening`: the sanitised posting
 *   title and company, the headline with "a"/"an" (`articleFor`) and years (`COVER_TITLE_PAST` when no role is
 *   ongoing), the first three summary terms (covered keys an experience fact placed in a role backs, by display), and
 *   the number of examples. The evidence facts are the three top-ranked placed facts, except that each one in the colon
 *   form (its claim does not start with a past-tense verb), in rank order, is swapped for the highest-ranked unused
 *   verb-led resume bullet outside the top three that backs (as an experience fact) every p1 term it backs; with no
 *   such fact it stays (`preferVerbLed`). p2 holds the first two and p3 the third, each an `evidenceSentence`
 *   anchored to its placed role's display employer: "where I work now" only on the first mention of an ongoing role's
 *   employer, "There I also" for the same employer as the sentence just before in the same paragraph, "Also at" for
 *   one named earlier. No sentence names a missing or gap term. Then, when `writing.signatureFacts` is set and none of
 *   its facts is among the evidence facts, one paragraph of one sentence: the first of them (list order) that is a
 *   citeable experience or project fact placed in a role, its claim verbatim after a lead chosen from the jobKey
 *   (`signatureLead`), citing its fact id. p4 is `COVER_P4`, its placeholders left for the renderer. A paragraph with
 *   nothing to say is omitted.
 */

const Group = z.object({ key: z.string(), synonyms: z.array(z.string()), display: z.string().optional() });
const YearMonth = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
const PackView = z.object({
  facts: z.array(
    z.object({
      id: z.string(),
      claim: z.string(),
      tech: z.array(z.string()),
      employer: z.string(),
      role: z.string().optional(),
      period: z.string().regex(/^\d{4}-\d{2}\.\.(\d{4}-\d{2}|present)$/),
      kind: z.string(),
      status: z.string(),
    }),
  ),
  roles: z.array(z.object({ employer: z.string(), title: z.string(), location: z.string(), start: YearMonth, end: z.union([YearMonth, z.literal('present')]) })),
  experience: z.object({ asOf: YearMonth }),
  lexicon: z.object({ strong: z.array(Group), medium: z.array(Group), gap: z.array(Group) }),
  targets: z.object({ claimableTitles: z.array(z.string()), minFit: z.number() }),
  naming: z.object({ employerDisplay: z.record(z.string(), z.string()), forbiddenTerms: z.array(z.string()) }),
  writing: z.object({ signatureFacts: z.array(z.string()).optional() }).optional(),
});
/** What the writing team reads from the public pack. */
export type WritingPack = z.infer<typeof PackView>;
type Fact = WritingPack['facts'][number];
type Role = WritingPack['roles'][number];

/** The writing view of `ctx.pack`; a missing or malformed pack fails the step. */
export function writingPackOf(pack: unknown, agent: string): WritingPack {
  const view = PackView.safeParse(pack);
  if (!view.success) {
    throw new KernelError('invalid_output', `${agent}: the pack is missing or lacks facts, roles, experience.asOf, lexicon, targets.claimableTitles or naming`);
  }
  return view.data;
}

/** Runs `f`, turning any non-kernel error into a step failure that names the agent. */
export function failLoud<T>(agent: string, f: () => T): T {
  try {
    return f();
  } catch (e) {
    if (e instanceof KernelError) throw e;
    throw new KernelError('invalid_output', `${agent}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
/** Month index of a `YYYY-MM` (or the month of a `YYYY-MM-DD`). */
const monthOf = (ym: string): number => Number(ym.slice(0, 4)) * 12 + Number(ym.slice(5, 7)) - 1;
const round4 = (x: number): number => Math.round(x * 10_000) / 10_000;
export const isRankable = (f: Fact): boolean => citeable(f) && (f.kind === 'experience' || f.kind === 'project');
const backsSkills = (f: Fact): boolean => citeable(f) && (f.kind === 'experience' || f.kind === 'project' || f.kind === 'cert');

/** The asOf month index. */
const asOfMonth = (pack: WritingPack): number => monthOf(pack.experience.asOf);
/** A fact's period as month indexes, 'present' read as asOf. */
export function factSpan(f: Pick<Fact, 'period'>, pack: WritingPack): { start: number; end: number } {
  const [start, end] = f.period.split('..') as [string, string];
  return { start: monthOf(start), end: end === 'present' ? asOfMonth(pack) : monthOf(end) };
}
/** A role's dates as month indexes, 'present' read as asOf. */
export const roleSpan = (r: Pick<Role, 'start' | 'end'>, pack: WritingPack): { start: number; end: number } => ({
  start: monthOf(r.start),
  end: r.end === 'present' ? asOfMonth(pack) : monthOf(r.end),
});

/** The display employer, via `employerDisplay`. */
export const displayOf = (raw: string, pack: WritingPack): string => employerDisplay(raw, pack.naming);

/** Every raw employer in the pack must have a display name that holds no forbidden term. */
function checkEmployers(pack: WritingPack): void {
  for (const f of pack.facts) displayOf(f.employer, pack);
  for (const r of pack.roles) displayOf(r.employer, pack);
}

// ---- dates ----

/** Document metadata only (see the module rules): postedAt's date, else the first day of the asOf month. */
export function firstSeenOf(posting: Pick<Posting, 'postedAt'>, pack: WritingPack): string {
  const d = posting.postedAt?.slice(0, 10);
  if (d !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(d) && isCalendarDate(d)) return d;
  return `${pack.experience.asOf}-01`;
}

/** Whole years of experience up to `asOf` (YYYY-MM): see the module rules. */
export function yearsOf(roles: readonly Pick<Role, 'start' | 'end'>[], asOf: string): number {
  const cap = monthOf(asOf);
  const months = new Set<number>();
  for (const r of roles) {
    const end = r.end === 'present' ? cap : Math.min(monthOf(r.end) + 1, cap);
    for (let m = monthOf(r.start); m < end; m++) months.add(m);
  }
  return Math.floor(months.size / 12);
}

// ---- lexicon ----

const tierGroups = (pack: WritingPack): TermGroup[] => [...pack.lexicon.strong, ...pack.lexicon.medium];
const allGroups = (pack: WritingPack): TermGroup[] => [...pack.lexicon.strong, ...pack.lexicon.medium, ...pack.lexicon.gap];
export const isGapKey = (key: string, pack: WritingPack): boolean => pack.lexicon.gap.some((g) => g.key === key);
/** The non-gap group with this key (strong first). */
export const groupOf = (key: string, pack: WritingPack): (TermGroup & { display?: string }) | undefined => tierGroups(pack).find((g) => g.key === key);
/** How documents show a key: its group's display, else the key. */
export const termDisplay = (key: string, pack: WritingPack): string => groupOf(key, pack)?.display ?? key;
/** The non-gap key whose display (or, without one, key) is `shown`. */
export const keyOfDisplay = (shown: string, pack: WritingPack): string | undefined => tierGroups(pack).find((g) => ((g as { display?: string }).display ?? g.key) === shown)?.key;

/** Sorts keys strong, medium, gap, then by lexicon order; a key not in the lexicon sorts last, by name. */
function sortKeys(keys: readonly string[], pack: WritingPack): string[] {
  const order = allGroups(pack).map((g) => g.key);
  const at = (k: string): number => {
    const i = order.indexOf(k);
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  return [...new Set(keys)].sort((a, b) => at(a) - at(b) || cmp(a, b));
}

/** The non-gap keys some of `facts`' tech backs, in key order. */
function keysBackedBy(facts: readonly Fact[], pack: WritingPack): string[] {
  const keys = tierGroups(pack)
    .filter((g) => !isGapKey(g.key, pack) && facts.some((f) => tagsBack(f.tech, g)))
    .map((g) => g.key);
  return sortKeys(keys, pack);
}

/** The non-gap keys a citeable experience, project or cert fact backs (the skills line), in key order. */
export const backedKeys = (pack: WritingPack): string[] => keysBackedBy(pack.facts.filter(backsSkills), pack);

/** The non-gap keys a citeable experience fact placed in a role backs (the summary may claim years of them). */
export function summaryKeys(pack: WritingPack): string[] {
  const roles = displayRoles(pack);
  return keysBackedBy(
    pack.facts.filter((f) => citeable(f) && f.kind === 'experience' && roleIndexOf(f, roles, pack) !== undefined),
    pack,
  );
}

// ---- evidence-matcher ----

/** The Evidence of one scored posting: see the module rules. */
export function buildEvidence(scored: Scored, pack: WritingPack): Evidence {
  checkEmployers(pack);
  const now = asOfMonth(pack);
  const jd = scored.jdTerms;
  const jdKeys = sortKeys([...jd.strong, ...jd.medium], pack).filter((k) => !isGapKey(k, pack));
  const jdGroups = jdKeys.map((k) => groupOf(k, pack)).filter((g): g is TermGroup => g !== undefined);
  const backed = new Set(backedKeys(pack));
  const covered = jdKeys.filter((k) => backed.has(k));
  const missing = sortKeys([...jd.strong, ...jd.medium, ...jd.gap], pack).filter((k) => !covered.includes(k));
  const all = allGroups(pack);
  const ranked = pack.facts
    .filter(isRankable)
    .map((f) => {
      const tech = jdGroups.filter((g) => tagsBack(f.tech, g)).map((g) => g.key);
      const words = termsIn(f.claim, jdGroups, all);
      const age = Math.max(0, now - factSpan(f, pack).end);
      const recency = Math.max(0, (120 - age) / 120);
      return {
        factId: f.id,
        employer: displayOf(f.employer, pack),
        rank: round4(3 * tech.length + words.length + recency),
        matched: [...new Set([...tech, ...words])].sort(cmp),
      };
    })
    .sort((a, b) => b.rank - a.rank || cmp(a.factId, b.factId));
  return { scored, ranked, covered, missing };
}

// ---- resume-planner ----

/** Whether some role is ongoing (end 'present'): picks the present or the past-tense p1. */
export const hasOngoingRole = (pack: WritingPack): boolean => pack.roles.some((r) => r.end === 'present');

/** Seniority words: one in a claimable title counts as matched when the posting title has any of them. */
export const SENIORITY_WORDS: readonly string[] = ['senior', 'sr', 'staff', 'lead', 'principal', 'distinguished'];

/** The headline match score of a claimable title against a sanitised posting title: see the module rules. */
export function titleMatch(claimable: string, postingTitle: string): number {
  const senior = SENIORITY_WORDS.some((w) => hasTerm(postingTitle, w));
  return claimable
    .split(/\s+/)
    .filter((w) => w !== '' && (hasTerm(postingTitle, w) || (senior && SENIORITY_WORDS.includes(w.toLowerCase().replace(/\.$/, ''))))).length;
}

/** The headline: see the module rules. With no ongoing role it is the most recent role's title. */
export function headlineOf(postingTitle: string, pack: WritingPack): string {
  if (!hasOngoingRole(pack)) {
    const latest = displayRoles(pack)[0];
    if (latest === undefined) throw new Error('roles.yaml has no role, so no headline can be chosen');
    return latest.title;
  }
  const title = sanitisePostingText(postingTitle);
  const scored = pack.targets.claimableTitles.map((t, i) => ({ t, i, score: titleMatch(t, title) }));
  scored.sort((a, b) => b.score - a.score || a.i - b.i);
  const best = scored[0];
  if (best === undefined) throw new Error('targets.claimableTitles is empty, so no headline can be chosen');
  return best.t;
}

const endRank = (end: string): number => (end === 'present' ? Number.MAX_SAFE_INTEGER : monthOf(end));

/** Every role with its display employer, newest first. */
export function displayRoles(pack: WritingPack): Role[] {
  return pack.roles
    .map((r) => ({ ...r, employer: displayOf(r.employer, pack) }))
    .sort(
      (a, b) =>
        monthOf(b.start) - monthOf(a.start) || endRank(b.end) - endRank(a.end) || cmp(a.employer, b.employer) || cmp(a.title, b.title) || cmp(a.location, b.location),
    );
}

/** Whether the role's dates hold the fact's whole period. */
export function roleContains(r: Pick<Role, 'start' | 'end'>, f: Pick<Fact, 'period'>, pack: WritingPack): boolean {
  const rs = roleSpan(r, pack);
  const fs = factSpan(f, pack);
  return rs.start <= fs.start && fs.end <= rs.end;
}

/** The index (in `roles`, newest first) of the role a fact is placed in, or undefined: see the module rules. */
export function roleIndexOf(f: Fact, roles: readonly Role[], pack: WritingPack): number | undefined {
  const employer = displayOf(f.employer, pack);
  const cands = roles.flatMap((r, i) => (r.employer === employer && roleContains(r, f, pack) ? [i] : []));
  if (cands.length <= 1) return cands[0];
  return cands.find((i) => roles[i]?.title === f.role) ?? cands[0];
}

/** Bullets for the latest two roles, then for the rest. */
export const BULLETS_LATEST = 4;
export const BULLETS_OTHER = 2;

/** How many bullets a resume plan gives the latest two roles and every older role. */
export interface BulletBudget {
  readonly latest: number;
  readonly other: number;
  /**
   * When set, the total characters of every bullet's claim in the plan stay at or under this: roles are filled newest
   * first, each in rank order, and a fact whose claim would go over the budget is skipped for the next one in that
   * role. Unset (the daily resume): no character budget.
   */
  readonly chars?: number;
}
/** The daily resume (up to 2 pages): 4 bullets for each of the latest two roles, 2 for the rest. */
export const DEFAULT_BUDGET: BulletBudget = { latest: BULLETS_LATEST, other: BULLETS_OTHER };
/**
 * The total bullet characters of the 1-page contract CV (Task 8 fix round 3). Calibrated on the 161 live gig CVs of
 * 2026-10-12 with the user's real pack: every CV renders on one page up to 869 (870 puts one on two pages); 825 is
 * that less about 5%.
 */
export const CV_BULLET_CHARS = 825; // calibrated on the 2026-10-12 real pack; if facts grow, gig-qa fails a 2-page CV safely (never cuts it)
/**
 * The 1-page contract CV (freelance, Task 8 fix rounds 1 and 3, user decisions): up to 2 bullets for each of the latest
 * two roles, within `CV_BULLET_CHARS` in total; older roles keep their title, employer and dates with no bullet.
 */
export const COMPACT: BulletBudget = { latest: 2, other: 0, chars: CV_BULLET_CHARS };

/** The summary slots: see the module rules. `terms` are display names, in order. */
export function summarySlots(headline: string, years: number, terms: readonly string[], roles: readonly Role[]): SummarySlots {
  const [top1, top2, top3, top4] = terms;
  const current = roles.find((r) => r.end === 'present');
  return {
    title: headline,
    years,
    ...(top1 !== undefined ? { top1 } : {}),
    ...(top2 !== undefined ? { top2 } : {}),
    ...(top3 !== undefined ? { top3 } : {}),
    ...(top4 !== undefined ? { top4 } : {}),
    ...(current !== undefined ? { employer: current.employer } : {}),
  };
}

/** The summary's terms: covered keys an experience fact placed in a role backs, shown by display. */
export function summaryTerms(covered: readonly string[], pack: WritingPack): string[] {
  return summaryKeysOf(covered, pack).map((k) => termDisplay(k, pack));
}

/** The summary's terms as keys, before display: covered non-gap keys an experience fact placed in a role backs. */
function summaryKeysOf(covered: readonly string[], pack: WritingPack): string[] {
  const ok = new Set(summaryKeys(pack));
  return covered.filter((k) => ok.has(k) && !isGapKey(k, pack));
}

const newestFirst = (pack: WritingPack) => (a: Fact, b: Fact) => factSpan(b, pack).start - factSpan(a, pack).start || cmp(a.id, b.id);

/** The ResumePlan of one Evidence: see the module rules. `budget` sets the bullets per role (default: the daily resume's). */
export function planResume(evidence: Evidence, pack: WritingPack, budget: BulletBudget = DEFAULT_BUDGET): ResumePlan {
  checkEmployers(pack);
  const posting = evidence.scored.posting;
  const byId = new Map(pack.facts.map((f) => [f.id, f]));
  const years = yearsOf(pack.roles, pack.experience.asOf);
  const headline = headlineOf(posting.title, pack);
  const roles = displayRoles(pack);
  // Belt and braces: whatever the Evidence says, only citeable experience or project facts become bullets.
  const ranked = evidence.ranked.flatMap((r) => {
    const f = byId.get(r.factId);
    return f !== undefined && isRankable(f) ? [f] : [];
  });
  let used = 0;
  const bulletsOf = (i: number) => {
    const placed = ranked.filter((f) => roleIndexOf(f, roles, pack) === i);
    const cap = i < 2 ? budget.latest : budget.other;
    const max = budget.chars;
    if (max === undefined) return placed.slice(0, cap).map((f) => ({ factId: f.id, text: f.claim }));
    const out: { factId: string; text: string }[] = [];
    for (const f of placed) {
      if (out.length >= cap) break;
      if (used + f.claim.length > max) continue;
      used += f.claim.length;
      out.push({ factId: f.id, text: f.claim });
    }
    return out;
  };
  const unplaced = pack.facts
    .filter((f) => isRankable(f) && roleIndexOf(f, roles, pack) === undefined)
    .map((f) => f.id)
    .sort(cmp);
  const covered = evidence.covered.filter((k) => !isGapKey(k, pack));
  const slots = summarySlots(headline, years, summaryTerms(covered, pack), roles);
  const verbatim = (kind: string) =>
    pack.facts
      .filter((f) => citeable(f) && f.kind === kind)
      .sort(newestFirst(pack))
      .map((f) => ({ factId: f.id, text: f.claim }));
  return {
    jobKey: posting.jobKey,
    evidence,
    headline,
    summary: { text: renderSummary(slots), slots: { ...slots } },
    skills: [...covered, ...backedKeys(pack).filter((k) => !covered.includes(k))].map((k) => termDisplay(k, pack)),
    roles: roles.map((r, i) => ({ employer: r.employer, title: r.title, location: r.location, start: r.start, end: r.end, bullets: bulletsOf(i) })),
    certs: verbatim('cert'),
    education: verbatim('education'),
    unplaced,
    covered: [...covered],
    missing: [...evidence.missing],
    ats: posting.ats,
    firstSeen: firstSeenOf(posting, pack),
  };
}

// ---- cover-writer ----

/** The sanitised posting title and company a cover letter's p1 uses. */
export const postingSlots = (posting: Pick<Posting, 'title' | 'company'>) => ({ title: sanitisePostingText(posting.title), company: sanitisePostingText(posting.company) });

/** Every slot of one cover letter: see the module rules. Years and headline are recomputed, never read from the plan. */
export interface CoverSlots {
  readonly opening: OpeningSlots;
  /** The evidence sentences' slots and fact ids, per paragraph (p2, then p3). */
  readonly evidence: readonly (readonly (EvidenceSlots & { readonly factId: string })[])[];
  /** The signature sentence (writing.signatureFacts), when there is one: its fact, display employer and claim. */
  readonly signature?: { readonly jobKey: string; readonly factId: string; readonly employer: string; readonly claim: string };
}

/** Whether a fact backs `key` for p1's "I've used" sentence: a citeable experience fact whose tech backs it. */
const backsLetterKey = (f: Fact, key: string, pack: WritingPack): boolean => {
  const g = groupOf(key, pack);
  return g !== undefined && citeable(f) && f.kind === 'experience' && tagsBack(f.tech, g);
};

/**
 * The cover's evidence facts: the top three of `placed` (ranked placed facts), with each colon-form fact (its claim
 * does not start with a past-tense verb) swapped, in rank order, for the highest-ranked unused verb-led fact outside
 * the top three that is a resume bullet and backs every letter key the colon-form fact backs. The swapped-in fact
 * takes the colon-form fact's place, so swapped-in facts keep their rank order; a colon-form fact with no such
 * substitute stays. The p1 covered list is therefore backed exactly as before, and no claim text changes.
 */
function preferVerbLed<T extends { readonly f: Fact }>(placed: readonly T[], letterKeys: readonly string[], bullets: ReadonlySet<string>, pack: WritingPack): T[] {
  const top = placed.slice(0, 3);
  const pool = placed.slice(3).filter((c) => bullets.has(c.f.id) && startsWithPastVerb(c.f.claim));
  return top.map((t) => {
    if (startsWithPastVerb(t.f.claim)) return t;
    const needs = letterKeys.filter((k) => backsLetterKey(t.f, k, pack));
    const at = pool.findIndex((c) => needs.every((k) => backsLetterKey(c.f, k, pack)));
    if (at < 0) return t;
    return pool.splice(at, 1)[0] as T;
  });
}

/** The cover slots of one ResumePlan, recomputed from the posting and the pack. */
export function coverSlots(resume: ResumePlan, pack: WritingPack): CoverSlots {
  checkEmployers(pack);
  const evidence = resume.evidence;
  const posting = evidence.scored.posting;
  const byId = new Map(pack.facts.map((f) => [f.id, f]));
  const roles = displayRoles(pack);
  const placed = evidence.ranked.flatMap((r) => {
    const f = byId.get(r.factId);
    const i = f !== undefined && isRankable(f) ? roleIndexOf(f, roles, pack) : undefined;
    const role = i === undefined ? undefined : roles[i];
    return f !== undefined && role !== undefined ? [{ f, role }] : [];
  });
  const letterKeys = summaryKeysOf(evidence.covered, pack).slice(0, 3);
  const bullets = new Set(resume.roles.flatMap((r) => r.bullets.map((b) => b.factId)));
  const top = preferVerbLed(placed, letterKeys, bullets, pack);
  const named = new Set<string>();
  const paragraphs = [top.slice(0, 2), top.slice(2, 3)].filter((p) => p.length > 0);
  const slots = paragraphs.map((p) =>
    p.map(({ f, role }, j) => {
      const after = j > 0 && p[j - 1]?.role.employer === role.employer ? 'adjacent' : named.has(role.employer) ? 'again' : 'first';
      named.add(role.employer);
      return { factId: f.id, employer: role.employer, claim: f.claim, ongoing: role.end === 'present', after } as const;
    }),
  );
  // writing.signatureFacts: when none is already cited, the first citeable one placed in a role, in list order.
  const signatureIds = pack.writing?.signatureFacts ?? [];
  const cited = new Set(top.map(({ f }) => f.id));
  const signature = signatureIds.some((id) => cited.has(id))
    ? undefined
    : signatureIds.flatMap((id) => {
        const f = byId.get(id);
        const i = f !== undefined && isRankable(f) ? roleIndexOf(f, roles, pack) : undefined;
        const role = i === undefined ? undefined : roles[i];
        return f !== undefined && role !== undefined ? [{ jobKey: resume.jobKey, factId: f.id, employer: role.employer, claim: f.claim }] : [];
      })[0];
  return {
    opening: {
      ...postingSlots(posting),
      targetTitle: headlineOf(posting.title, pack),
      years: yearsOf(pack.roles, pack.experience.asOf),
      past: !hasOngoingRole(pack),
      terms: letterKeys.map((k) => termDisplay(k, pack)),
      examples: top.length,
    },
    evidence: slots,
    ...(signature === undefined ? {} : { signature }),
  };
}

/** The paragraphs of a cover letter rendered from its slots: p1, the evidence paragraphs, the signature sentence, then `COVER_P4`. */
export function renderCover(s: CoverSlots): CoverPlan['paragraphs'] {
  return [
    { text: renderOpening(s.opening), factIds: [] },
    ...s.evidence.map((p) => ({ text: p.map((e) => evidenceSentence(e)).join(' '), factIds: p.map((e) => e.factId) })),
    ...(s.signature === undefined ? [] : [{ text: signatureSentence(s.signature.jobKey, s.signature.employer, s.signature.claim), factIds: [s.signature.factId] }]),
    { text: COVER_P4, factIds: [] },
  ];
}

/** The CoverPlan of one ResumePlan: see the module rules. */
export function planCover(resume: ResumePlan, pack: WritingPack): CoverPlan {
  return { jobKey: resume.jobKey, resume, paragraphs: renderCover(coverSlots(resume, pack)) };
}

/**
 * The dashboard's short cover note for a (filled) cover plan: the letter's opening sentence and its first evidence
 * sentence, exactly as the letter has them, or undefined when the plan has no evidence or its text is not the letter
 * these slots give. Computed from the plan alone: the top fact is the first bullet of its role (bullets keep rank
 * order), whose text is the claim verbatim and whose role gives the display employer.
 */
export function coverNoteShort(cover: CoverPlan): string | undefined {
  const opening = openingSentence(postingSlots(cover.resume.evidence.scored.posting));
  const p1 = cover.paragraphs[0]?.text;
  const p2 = cover.paragraphs[1];
  const id = p2?.factIds[0];
  if (p1 === undefined || p2 === undefined || id === undefined || !p1.startsWith(`${opening} `)) return undefined;
  const role = cover.resume.roles.find((r) => r.bullets.some((b) => b.factId === id));
  const claim = role?.bullets.find((b) => b.factId === id)?.text;
  if (role === undefined || claim === undefined) return undefined;
  const sentence = evidenceSentence({ employer: role.employer, claim, ongoing: role.end === 'present', after: 'first' });
  return p2.text === sentence || p2.text.startsWith(`${sentence} `) ? `${opening} ${sentence}` : undefined;
}
