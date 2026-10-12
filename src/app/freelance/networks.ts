import {
  backedKeys,
  displayRoles,
  isGapKey,
  keyOfDisplay,
  groupOf,
  planResume,
  roleIndexOf,
  writingPackOf,
  type WritingPack,
} from '../agents/writing/grounded.js';
import { resumeProblems } from '../guardrails.js';
import { literalIn, tagIs, tagsBack, termsIn, type TermGroup } from '../lexicon.js';
import type { Network } from '../pack/freelance-schema.js';
import { citeable, forbiddenTermStrict } from '../pack/rules.js';
import type { ResumePlan } from '../types.js';
import { evidenceFor, syntheticPosting } from './writing/gig-evidence.js';

/**
 * Network application packs (spec §7): for one vetted freelance network, a network-tuned resume plan, the profile
 * text for the network's own fields and a vetting-prep checklist, all from the user's verified facts only. Pure and
 * deterministic: the CLI (`networks-command.ts`) renders and writes it.
 *
 * - **Resume.** `planResume` of the Evidence of a synthetic posting whose title is the network's first clean target
 *   title and whose description is its clean keywords and target titles. `problems` starts with G-GROUND
 *   (`resumeProblems`), so a resume that does not re-derive is refused.
 * - **Profile.** Field `headline` is the resume headline, `summary` the resume summary, `skills` the resume skills line.
 *   Each is cut at a whole sentence (skills: a whole skill) to the field's `maxChars`, as a prefix of its source, so every
 *   profile sentence is a substring of the resume. Nothing is written fresh. A field with no such source, or whose
 *   first sentence is over the limit, is a problem (its text is empty).
 * - **Missing.** A clean keyword is backed when a non-gap lexicon group it names is backed (`backedKeys`), or when a
 *   citeable experience, project or cert fact has it as a tech tag. Every other clean keyword is missing, sorted.
 * - **Naming.** A keyword or target title naming a forbidden term (`forbiddenTermStrict`) is left out of everything and
 *   is a problem, `G-NAMING: network keyword #N names a forbidden term` (or `target title #N`), never naming the term.
 * - **Checklist.** One entry per screening stage, in file order. `evidence` = the ids, sorted, of citeable
 *   experience, project or cert facts with a tech tag the stage text (stage and prep lines) names literally, or that
 *   back a lexicon group the stage text names.
 */

export interface NetworkPackResult {
  networkId: string;
  resume: ResumePlan;
  profile: { id: string; text: string; factIds: string[] }[];
  checklist: { stage: string; prep: string[]; evidence: string[] }[];
  problems: string[];
  missing: string[];
}

export const MOONLIGHTING_LINE = "Before your first gig: check your employment contract's moonlighting and IP clauses.";

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
type Fact = WritingPack['facts'][number];
const tierGroups = (pack: WritingPack): TermGroup[] => [...pack.lexicon.strong, ...pack.lexicon.medium];
const allGroups = (pack: WritingPack): TermGroup[] => [...tierGroups(pack), ...pack.lexicon.gap];
const backsSkills = (f: Fact): boolean => citeable(f) && (f.kind === 'experience' || f.kind === 'project' || f.kind === 'cert');

/** The end offsets of the units of `text`: sentences for prose, whole items for a ", "-joined list (separator excluded). */
function unitEnds(text: string, list: boolean): number[] {
  const ends: number[] = [];
  const re = list ? /, /gu : /(?<=[.!?])\s+/gu;
  for (const m of text.matchAll(re)) ends.push(m.index);
  ends.push(text.length);
  return ends;
}

/** The longest prefix of whole units within `max`, or undefined when the first unit alone is over it. */
function cut(text: string, max: number, list: boolean): { text: string } | { first: number } {
  const ends = unitEnds(text, list);
  const fits = ends.filter((e) => e <= max);
  const last = fits.at(-1);
  if (last === undefined) return { first: ends[0] ?? text.length };
  return { text: text.slice(0, last) };
}

/** Citeable fact ids backing any of `keys`, sorted. */
function factsBacking(keys: readonly string[], facts: readonly Fact[], pack: WritingPack): string[] {
  const groups = keys.map((k) => groupOf(k, pack)).filter((g): g is NonNullable<typeof g> => g !== undefined);
  return facts.filter((f) => groups.some((g) => tagsBack(f.tech, g))).map((f) => f.id).sort(cmp);
}

function profileOf(net: Network, resume: ResumePlan, pack: WritingPack, problems: string[]): NetworkPackResult['profile'] {
  const roles = displayRoles(pack);
  const placed = pack.facts.filter((f) => citeable(f) && f.kind === 'experience' && roleIndexOf(f, roles, pack) !== undefined);
  const skillFacts = pack.facts.filter(backsSkills);
  const summaryTerms = [resume.summary.slots.top1, resume.summary.slots.top2, resume.summary.slots.top3, resume.summary.slots.top4].filter(
    (t): t is string => t !== undefined,
  );
  const keysOf = (shown: readonly string[]): string[] => shown.flatMap((s) => keyOfDisplay(s, pack) ?? []);
  return net.profileFields.map((field, i) => {
    const source =
      field.id === 'headline'
        ? { text: resume.headline, list: false }
        : field.id === 'summary'
          ? { text: resume.summary.text, list: false }
          : field.id === 'skills'
            ? { text: resume.skills.join(', '), list: true }
            : undefined;
    if (source === undefined) {
      problems.push(`profile field #${i + 1} (${field.id}) has no verified source`);
      return { id: field.id, text: '', factIds: [] };
    }
    const c = cut(source.text, field.maxChars, source.list);
    if ('first' in c) {
      problems.push(`profile field ${field.id}: the first sentence has ${c.first} characters, the limit is ${field.maxChars}`);
      return { id: field.id, text: '', factIds: [] };
    }
    const factIds =
      field.id === 'summary'
        ? factsBacking(keysOf(summaryTerms.filter((t) => c.text.includes(t))), placed, pack)
        : field.id === 'skills'
          ? factsBacking(keysOf(c.text.split(', ')), skillFacts, pack)
          : [];
    return { id: field.id, text: c.text, factIds };
  });
}

function missingOf(keywords: readonly string[], pack: WritingPack): string[] {
  const backed = new Set(backedKeys(pack));
  const skillFacts = pack.facts.filter(backsSkills);
  const isBacked = (kw: string): boolean =>
    termsIn(kw, tierGroups(pack), allGroups(pack)).some((k) => backed.has(k) && !isGapKey(k, pack)) ||
    skillFacts.some((f) => f.tech.some((t) => tagIs(t, kw)));
  return [...new Set(keywords.filter((k) => !isBacked(k)))].sort(cmp);
}

function checklistOf(net: Network, pack: WritingPack): NetworkPackResult['checklist'] {
  const facts = pack.facts.filter(backsSkills);
  return net.screening.map((s) => {
    const text = [s.stage, ...s.prep].join('\n');
    const named = termsIn(text, tierGroups(pack), allGroups(pack))
      .filter((k) => !isGapKey(k, pack))
      .map((k) => groupOf(k, pack))
      .filter((g): g is NonNullable<typeof g> => g !== undefined);
    const evidence = facts
      .filter((f) => f.tech.some((t) => literalIn(text, t)) || named.some((g) => tagsBack(f.tech, g)))
      .map((f) => f.id)
      .sort(cmp);
    return { stage: s.stage, prep: [...s.prep], evidence };
  });
}

/**
 * The network pack of one network: see the module rules. `asOf` (YYYY-MM) dates the documents (`firstSeen` is its
 * first day); `rawPack` is the public pack, for the scorer's view (default `pack`).
 */
export function networkPack(net: Network, pack: WritingPack, asOf: string, rawPack: unknown = pack): NetworkPackResult {
  const view = writingPackOf(pack, 'networks');
  const naming = { forbiddenTerms: view.naming.forbiddenTerms };
  const problems: string[] = [];
  const clean = (list: readonly string[], what: string): string[] =>
    list.filter((s, i) => {
      if (forbiddenTermStrict(s, naming) === undefined) return true;
      problems.push(`G-NAMING: ${what} #${i + 1} names a forbidden term`);
      return false;
    });
  const keywords = clean(net.keywords, 'network keyword');
  const titles = clean(net.targetTitles, 'target title');
  const posting = syntheticPosting({
    key: net.id,
    title: titles[0] ?? '',
    company: net.name,
    text: [keywords.join(', '), titles.join(', ')].join('\n'),
    firstSeen: `${asOf}-01`,
  });
  const resume = planResume(evidenceFor(posting, view, rawPack), view);
  const grounding = resumeProblems(resume, view, '', rawPack);
  const profile = profileOf(net, resume, view, problems);
  return {
    networkId: net.id,
    resume,
    profile,
    checklist: checklistOf(net, view),
    problems: [...grounding, ...problems],
    missing: missingOf(keywords, view),
  };
}

/** profile.txt: each field with its length against the limit, the facts behind it, then the missing keywords. */
export function profileText(net: Network, r: NetworkPackResult): string {
  const lines = [`${net.name} profile text. Built only from your verified facts; paste each field as it is.`, ''];
  for (const p of r.profile) {
    const max = net.profileFields.find((f) => f.id === p.id)?.maxChars;
    lines.push(`[${p.id}] (${p.text.length}/${max ?? '?'} characters)`, p.text);
    if (p.factIds.length > 0) lines.push(`Backed by: ${p.factIds.join(', ')}`);
    lines.push('');
  }
  lines.push(
    r.missing.length === 0
      ? 'Missing keywords: none.'
      : `Missing keywords (no verified fact backs them, so do not claim them): ${r.missing.join(', ')}`,
  );
  return `${lines.join('\n')}\n`;
}

/** checklist.md: the moonlighting line first, the unchecked-file warning, then each stage's prep and evidence. */
export function checklistMarkdown(net: Network, r: NetworkPackResult, pack: WritingPack): string {
  const claim = new Map(pack.facts.map((f) => [f.id, f.claim]));
  const lines = [MOONLIGHTING_LINE, ''];
  if (!net.checkedByUser) lines.push(`Network file not yet checked by you: verify the stages at ${net.url}`, '');
  lines.push(`# ${net.name} vetting prep`, '');
  r.checklist.forEach((c, i) => {
    lines.push(`## ${i + 1}. ${c.stage}`, '');
    for (const p of c.prep) lines.push(`- [ ] ${p}`);
    if (c.prep.length > 0) lines.push('');
    if (c.evidence.length === 0) lines.push('Your evidence: none of your verified facts names this stage.');
    else {
      lines.push('Your evidence:');
      for (const id of c.evidence) lines.push(`- ${id}: ${claim.get(id) ?? ''}`);
    }
    lines.push('');
  });
  return `${lines.join('\n').trimEnd()}\n`;
}
