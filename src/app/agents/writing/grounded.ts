import { z } from 'zod';
import { KernelError } from '../../../kernel/errors.js';
import { hasTerm, tagsBack, termsIn, type TermGroup } from '../../lexicon.js';
import { citeable, employerDisplay } from '../../pack/rules.js';
import { isCalendarDate, type CoverPlan, type Evidence, type Posting, type ResumePlan, type Scored } from '../../types.js';
import { asSentence, COVER_P1, COVER_P2_LEAD, COVER_P3_TAIL, COVER_P4, fill, joinList, renderSummary, type SummarySlots } from './templates.js';

/**
 * The grounded writing rules (spec §5.4, Task 9), shared by the three writing agents and by G-GROUND, which re-derives
 * every plan from the posting and the pack with these same functions and also checks the invariants independently.
 * Pure and deterministic: no clock, no randomness, every list in a total order.
 *
 * Rules:
 * - **Citeable facts.** Only `verified` and `user-stated` facts are ever read for content (`citeable`). Ranked facts
 *   (bullets, cover facts) are the citeable facts of kind `experience` or `project`; certs are kind `cert`.
 * - **Employers.** Every raw employer string (facts and roles) goes through `employerDisplay`. Every fact and role
 *   employer in the pack is checked on every run, so an unmapped employer naming a forbidden term fails loudly.
 * - **JD terms** are the scorer's `jdTerms` (lexicon keys found in the JD). Gap keys are never covered.
 * - **Backing.** A non-gap lexicon key is backed when a citeable fact (any kind) has a `tech` tag that is the key or a
 *   synonym (`tagsBack`). `covered` = the JD's strong and medium keys that are backed; `missing` = every other JD key.
 * - **Key order** (covered, missing, skills): strong before medium before gap, then the lexicon file's order.
 * - **Rank** = 3 x |JD keys the fact's tech backs| + 1 x |JD keys in the claim text (`termsIn`)| + recency, where
 *   recency = max(0, (120 - age) / 120) and age is the months from the fact's period end ('present' = the firstSeen
 *   month) to the firstSeen month, so 1 means current and 0 means ten or more years ago. Rounded to 4 decimals.
 *   Ties are broken by fact id, so the order is total.
 * - **firstSeen** = the posting's `postedAt` date (its first 10 characters, when a real calendar date). Without one it
 *   is the first day of the latest month named by the roles (starts, dated ends) or by the citeable non-cert facts
 *   (period starts, dated ends): a date the pack proves has passed, so years can only be understated, never inflated.
 *   Never the clock.
 * - **Years** = floor(months / 12), where months = the size of the union of the roles' months. A role covers
 *   [start, end] with the end month included; an ongoing role ('present') runs up to, not including, the firstSeen
 *   month; every role is cut at the firstSeen month. Overlapping roles are not double-counted and gaps are not counted.
 * - **Headline** = the first `targets.titles` entry with the most of its words in the posting title (`hasTerm`), a tie
 *   going to the first entry, shown with each all-lower-case word capitalised ("backend engineer" -> "Backend
 *   Engineer"; a word holding any capital, such as "SDE", is kept as written).
 * - **Roles** = every role, newest first (start descending, then ongoing before ended, then end descending, then
 *   employer and title). A ranked fact belongs to the role with its display employer: the one whose title equals
 *   `fact.role` if several share the employer, else the one whose dates hold the fact's start, else the newest.
 *   Bullets: the top 4 facts for the latest two roles, 2 for the rest, in rank order, each the verbatim claim. A role
 *   with no citeable fact has no bullets.
 * - **Skills** = covered keys, then every other backed non-gap key, in key order.
 * - **Certs** = citeable `cert` facts, period start descending, then id.
 * - **Summary**: `renderSummary` with title = headline, years, top1..top4 = the first four covered keys, and employer
 *   = the display employer of the newest ongoing role (no ongoing role: no employer slot, no "Currently at").
 * - **Cover**: p1 is `COVER_P1`; p2 is `COVER_P2_LEAD` then the two top-ranked facts; p3 the third fact then
 *   `COVER_P3_TAIL`, whose list holds only the covered keys that the three cited claims' text names (`termsIn`), so
 *   "each appears in the work above" is literally true; p4 is `COVER_P4` with its placeholders left for the renderer. A paragraph with
 *   nothing to say is omitted (no facts: no p2; no third fact and no listed key: no p3).
 */

const Group = z.object({ key: z.string(), synonyms: z.array(z.string()) });
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
  roles: z.array(
    z.object({
      employer: z.string(),
      title: z.string(),
      location: z.string(),
      start: z.string().regex(/^\d{4}-\d{2}$/),
      end: z.string().regex(/^(\d{4}-\d{2}|present)$/),
    }),
  ),
  lexicon: z.object({ strong: z.array(Group), medium: z.array(Group), gap: z.array(Group) }),
  targets: z.object({ titles: z.array(z.string()), minFit: z.number() }),
  naming: z.object({ employerDisplay: z.record(z.string(), z.string()), forbiddenTerms: z.array(z.string()) }),
});
/** What the writing team reads from the public pack. */
export type WritingPack = z.infer<typeof PackView>;
type Fact = WritingPack['facts'][number];
type Role = WritingPack['roles'][number];

/** The writing view of `ctx.pack`; a missing or malformed pack fails the step. */
export function writingPackOf(pack: unknown, agent: string): WritingPack {
  const view = PackView.safeParse(pack);
  if (!view.success) throw new KernelError('invalid_output', `${agent}: the pack is missing or lacks facts, roles, lexicon, targets or naming`);
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
const periodOf = (f: Fact): { start: string; end: string } => {
  const [start, end] = f.period.split('..') as [string, string];
  return { start, end };
};
const round4 = (x: number): number => Math.round(x * 10_000) / 10_000;
const isRankable = (f: Fact): boolean => citeable(f) && (f.kind === 'experience' || f.kind === 'project');

/** The display employer, via `employerDisplay`. */
export const displayOf = (raw: string, pack: WritingPack): string => employerDisplay(raw, pack.naming);

/** Every raw employer in the pack must have a display name that holds no forbidden term. */
function checkEmployers(pack: WritingPack): void {
  for (const f of pack.facts) displayOf(f.employer, pack);
  for (const r of pack.roles) displayOf(r.employer, pack);
}

// ---- dates ----

/** See the module rules: postedAt's date, else the latest month the roles and citeable non-cert facts prove. */
export function firstSeenOf(posting: Pick<Posting, 'postedAt'>, pack: WritingPack): string {
  const d = posting.postedAt?.slice(0, 10);
  if (d !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(d) && isCalendarDate(d)) return d;
  const months: number[] = [];
  for (const r of pack.roles) {
    months.push(monthOf(r.start));
    if (r.end !== 'present') months.push(monthOf(r.end));
  }
  for (const f of pack.facts) {
    if (!citeable(f) || f.kind === 'cert') continue;
    const p = periodOf(f);
    months.push(monthOf(p.start));
    if (p.end !== 'present') months.push(monthOf(p.end));
  }
  if (months.length === 0) return '1970-01-01';
  const m = Math.max(...months);
  return `${String(Math.floor(m / 12)).padStart(4, '0')}-${String((m % 12) + 1).padStart(2, '0')}-01`;
}

/** Whole years of experience: see the module rules. */
export function yearsOf(roles: readonly Pick<Role, 'start' | 'end'>[], firstSeen: string): number {
  const cap = monthOf(firstSeen);
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
export const groupOf = (key: string, pack: WritingPack): TermGroup | undefined => tierGroups(pack).find((g) => g.key === key);

/** Sorts keys strong, medium, gap, then by lexicon order; a key not in the lexicon sorts last, by name. */
function sortKeys(keys: readonly string[], pack: WritingPack): string[] {
  const order = allGroups(pack).map((g) => g.key);
  const at = (k: string): number => {
    const i = order.indexOf(k);
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  return [...new Set(keys)].sort((a, b) => at(a) - at(b) || cmp(a, b));
}

/** The non-gap keys some citeable fact's tech backs, in key order. */
export function backedKeys(pack: WritingPack): string[] {
  const facts = pack.facts.filter((f) => citeable(f));
  const keys = tierGroups(pack)
    .filter((g) => !isGapKey(g.key, pack) && facts.some((f) => tagsBack(f.tech, g)))
    .map((g) => g.key);
  return sortKeys(keys, pack);
}

// ---- evidence-matcher ----

/** The Evidence of one scored posting: see the module rules. */
export function buildEvidence(scored: Scored, pack: WritingPack): Evidence {
  checkEmployers(pack);
  const now = monthOf(firstSeenOf(scored.posting, pack));
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
      const end = periodOf(f).end;
      const age = Math.max(0, now - (end === 'present' ? now : monthOf(end)));
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

const capitalised = (title: string): string =>
  title
    .split(/\s+/)
    .filter((w) => w !== '')
    .map((w) => (/^[a-z]+$/.test(w) ? `${w[0]?.toUpperCase() ?? ''}${w.slice(1)}` : w))
    .join(' ');

/** The headline: see the module rules. */
export function headlineOf(postingTitle: string, titles: readonly string[]): string {
  let best = -1;
  let choice: string | undefined;
  for (const t of titles) {
    const words = t.split(/\s+/).filter((w) => w !== '');
    const score = words.filter((w) => hasTerm(postingTitle, w)).length;
    if (score > best) {
      best = score;
      choice = t;
    }
  }
  if (choice === undefined) throw new Error('targets.titles is empty, so no headline can be chosen');
  return capitalised(choice);
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

/** The index (in `roles`, newest first) of the role a fact belongs to, or undefined when no role has its employer. */
export function roleIndexOf(f: Fact, roles: readonly Role[], pack: WritingPack): number | undefined {
  const employer = displayOf(f.employer, pack);
  const cands = roles.flatMap((r, i) => (r.employer === employer ? [i] : []));
  if (cands.length <= 1) return cands[0];
  const byTitle = cands.find((i) => roles[i]?.title === f.role);
  if (byTitle !== undefined) return byTitle;
  const start = monthOf(periodOf(f).start);
  const inside = cands.find((i) => {
    const r = roles[i] as Role;
    return monthOf(r.start) <= start && (r.end === 'present' || start <= monthOf(r.end));
  });
  return inside ?? cands[0];
}

/** Bullets for the latest two roles, then for the rest. */
export const BULLETS_LATEST = 4;
export const BULLETS_OTHER = 2;

/** The summary slots: see the module rules. */
export function summarySlots(headline: string, years: number, covered: readonly string[], roles: readonly Role[]): SummarySlots {
  const [top1, top2, top3, top4] = covered;
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

/** The ResumePlan of one Evidence: see the module rules. */
export function planResume(evidence: Evidence, pack: WritingPack): ResumePlan {
  checkEmployers(pack);
  const posting = evidence.scored.posting;
  const byId = new Map(pack.facts.map((f) => [f.id, f]));
  const firstSeen = firstSeenOf(posting, pack);
  const years = yearsOf(pack.roles, firstSeen);
  const headline = headlineOf(posting.title, pack.targets.titles);
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
  const covered = evidence.covered.filter((k) => !isGapKey(k, pack));
  const slots = summarySlots(headline, years, covered, roles);
  const certs = pack.facts
    .filter((f) => citeable(f) && f.kind === 'cert')
    .sort((a, b) => monthOf(periodOf(b).start) - monthOf(periodOf(a).start) || cmp(a.id, b.id))
    .map((f) => ({ factId: f.id, text: f.claim }));
  return {
    jobKey: posting.jobKey,
    evidence,
    headline,
    summary: { text: renderSummary(slots), slots: { ...slots } },
    skills: [...covered, ...backedKeys(pack).filter((k) => !covered.includes(k))],
    roles: roles.map((r, i) => ({ employer: r.employer, title: r.title, location: r.location, start: r.start, end: r.end, bullets: bulletsOf(i) })),
    certs,
    covered: [...covered],
    missing: [...evidence.missing],
    ats: posting.ats,
    firstSeen,
  };
}

// ---- cover-writer ----

/** The CoverPlan of one ResumePlan: see the module rules. Years and headline are recomputed, never read from the plan. */
export function planCover(resume: ResumePlan, pack: WritingPack): CoverPlan {
  checkEmployers(pack);
  const evidence = resume.evidence;
  const posting = evidence.scored.posting;
  const byId = new Map(pack.facts.map((f) => [f.id, f]));
  const years = yearsOf(pack.roles, firstSeenOf(posting, pack));
  const headline = headlineOf(posting.title, pack.targets.titles);
  const top = evidence.ranked
    .flatMap((r) => {
      const f = byId.get(r.factId);
      return f !== undefined && isRankable(f) ? [f] : [];
    })
    .slice(0, 3);
  const paragraphs: CoverPlan['paragraphs'] = [
    { text: fill(COVER_P1, { title: posting.title, company: posting.company, targetTitle: headline, years }), factIds: [] },
  ];
  const lead = top.slice(0, 2);
  if (lead.length > 0) paragraphs.push({ text: [COVER_P2_LEAD, ...lead.map((f) => asSentence(f.claim))].join(' '), factIds: lead.map((f) => f.id) });
  const third = top[2];
  // Only covered keys the cited claims' own text names (lexicon rules), so "each appears in the work above" holds
  // for a reader of the letter, not just for the facts' tech tags.
  const coveredGroups = evidence.covered.filter((k) => !isGapKey(k, pack)).flatMap((k) => groupOf(k, pack) ?? []);
  const named = new Set(top.flatMap((f) => termsIn(f.claim, coveredGroups, allGroups(pack))));
  const listed = evidence.covered.filter((k) => named.has(k));
  const p3 = [...(third !== undefined ? [asSentence(third.claim)] : []), ...(listed.length > 0 ? [fill(COVER_P3_TAIL, { coveredList: joinList(listed) })] : [])];
  if (p3.length > 0) paragraphs.push({ text: p3.join(' '), factIds: third !== undefined ? [third.id] : [] });
  paragraphs.push({ text: COVER_P4, factIds: [] });
  return { jobKey: resume.jobKey, resume, paragraphs };
}
