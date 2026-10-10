import { z } from 'zod';
import { KernelError } from '../../../kernel/errors.js';
import { hasTerm, LANGUAGE_WORDS, lexiconTerms, tagsBack, termsIn, type TermGroup } from '../../lexicon.js';
import { citeable, employerDisplay } from '../../pack/rules.js';
import { isCalendarDate, type CoverPlan, type Evidence, type Posting, type ResumePlan, type Scored } from '../../types.js';
import {
  articleFor,
  asSentence,
  COVER_P1,
  COVER_P1_PAST,
  COVER_P2_LEAD,
  COVER_P3_TAIL,
  COVER_P3_TAIL_ONE,
  COVER_P4,
  fill,
  joinList,
  renderSummary,
  sanitisePostingText,
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
 *   roles' titles) with the most of its words in the sanitised posting title (`hasTerm`), used verbatim. A tie goes to
 *   the entry that is the most recent role's title (roles newest first), then to list order (fix C2). With no ongoing
 *   role it is the most recent role's title, and p1 uses the past-tense `COVER_P1_PAST` (fix round 2, I-R1).
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
 * - **Cover** (only placed facts are cited): p1 is `COVER_P1` with the sanitised posting title and company; p2 is
 *   `COVER_P2_LEAD` then the two top-ranked placed facts; p3 the third, then `COVER_P3_TAIL` (or `COVER_P3_TAIL_ONE`
 *   for one term) listing the display of each covered key whose key or display a cited claim names (`hasTerm`, with
 *   its ambiguous-word rules, no synonyms), so "appears in the work above" is true; p1 takes "a" or "an" from
 *   `articleFor`; p4 is `COVER_P4` with its placeholders left for the
 *   renderer. A paragraph with nothing to say is omitted.
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

/** The role titles, newest role first (the tie-break order of the headline). */
const recentTitles = (pack: WritingPack): string[] => [...new Set(displayRoles(pack).map((r) => r.title))];

/** Whether some role is ongoing (end 'present'): picks the present or the past-tense p1. */
export const hasOngoingRole = (pack: WritingPack): boolean => pack.roles.some((r) => r.end === 'present');

/** The headline: see the module rules. With no ongoing role it is the most recent role's title. */
export function headlineOf(postingTitle: string, pack: WritingPack): string {
  if (!hasOngoingRole(pack)) {
    const latest = displayRoles(pack)[0];
    if (latest === undefined) throw new Error('roles.yaml has no role, so no headline can be chosen');
    return latest.title;
  }
  const title = sanitisePostingText(postingTitle);
  const recent = recentTitles(pack);
  const recency = (t: string): number => {
    const i = recent.indexOf(t);
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  const scored = pack.targets.claimableTitles.map((t, i) => ({
    t,
    i,
    score: t.split(/\s+/).filter((w) => w !== '' && hasTerm(title, w)).length,
  }));
  scored.sort((a, b) => b.score - a.score || recency(a.t) - recency(b.t) || a.i - b.i);
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
  const ok = new Set(summaryKeys(pack));
  return covered.filter((k) => ok.has(k) && !isGapKey(k, pack)).map((k) => termDisplay(k, pack));
}

const newestFirst = (pack: WritingPack) => (a: Fact, b: Fact) => factSpan(b, pack).start - factSpan(a, pack).start || cmp(a.id, b.id);

/** The ResumePlan of one Evidence: see the module rules. */
export function planResume(evidence: Evidence, pack: WritingPack): ResumePlan {
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
  const bulletsOf = (i: number) =>
    ranked
      .filter((f) => roleIndexOf(f, roles, pack) === i)
      .slice(0, i < 2 ? BULLETS_LATEST : BULLETS_OTHER)
      .map((f) => ({ factId: f.id, text: f.claim }));
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

/** The CoverPlan of one ResumePlan: see the module rules. Years and headline are recomputed, never read from the plan. */
export function planCover(resume: ResumePlan, pack: WritingPack): CoverPlan {
  checkEmployers(pack);
  const evidence = resume.evidence;
  const posting = evidence.scored.posting;
  const byId = new Map(pack.facts.map((f) => [f.id, f]));
  const roles = displayRoles(pack);
  const years = yearsOf(pack.roles, pack.experience.asOf);
  const headline = headlineOf(posting.title, pack);
  const top = evidence.ranked
    .flatMap((r) => {
      const f = byId.get(r.factId);
      return f !== undefined && isRankable(f) && roleIndexOf(f, roles, pack) !== undefined ? [f] : [];
    })
    .slice(0, 3);
  const slots = postingSlots(posting);
  const p1 = hasOngoingRole(pack) ? COVER_P1 : COVER_P1_PAST;
  const paragraphs: CoverPlan['paragraphs'] = [{ text: fill(p1, { ...slots, article: articleFor(headline), targetTitle: headline, years }), factIds: [] }];
  const lead = top.slice(0, 2);
  if (lead.length > 0) paragraphs.push({ text: [COVER_P2_LEAD, ...lead.map((f) => asSentence(f.claim))].join(' '), factIds: lead.map((f) => f.id) });
  const third = top[2];
  // Only covered keys whose key or display a cited claim's text names, so "appears in the work above" is true for a
  // reader of the letter: no synonym (a claim saying "payments" does not list "fintech"), and the ambiguous-word rules
  // of `hasTerm` ("go live", "teams react quickly" and "spring hiring" do not name Go, React or Spring).
  const neighbours = [...LANGUAGE_WORDS, ...lexiconTerms(allGroups(pack))];
  const names = (claim: string, k: string) => hasTerm(claim, k, neighbours) || hasTerm(claim, termDisplay(k, pack), neighbours);
  const listed = evidence.covered.filter((k) => !isGapKey(k, pack) && top.some((f) => names(f.claim, k))).map((k) => termDisplay(k, pack));
  const tail = listed.length === 0 ? [] : [fill(listed.length === 1 ? COVER_P3_TAIL_ONE : COVER_P3_TAIL, { coveredList: joinList(listed) })];
  const p3 = [...(third !== undefined ? [asSentence(third.claim)] : []), ...tail];
  if (p3.length > 0) paragraphs.push({ text: p3.join(' '), factIds: third !== undefined ? [third.id] : [] });
  paragraphs.push({ text: COVER_P4, factIds: [] });
  return { jobKey: resume.jobKey, resume, paragraphs };
}
