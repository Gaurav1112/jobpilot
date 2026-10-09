import { canonicalJson } from '../kernel/canonical.js';
import type { GuardrailVerdict } from '../kernel/envelope.js';
import { BUILTIN_GUARDRAILS } from '../kernel/guardrails/builtin.js';
import { GuardrailRegistry, type Guardrail, type GuardrailContext } from '../kernel/guardrails/index.js';
import {
  backedKeys,
  buildEvidence,
  displayOf,
  displayRoles,
  firstSeenOf,
  groupOf,
  headlineOf,
  isGapKey,
  planCover,
  planResume,
  summarySlots,
  writingPackOf,
  yearsOf,
  type WritingPack,
} from './agents/writing/grounded.js';
import { renderSummary } from './agents/writing/templates.js';
import { tagIs, tagsBack } from './lexicon.js';
import { assertNoForbidden, citeable, ForbiddenTermError } from './pack/rules.js';
import { CoverPlan, ResumePlan } from './types.js';

/**
 * The app guardrails (spec §5.5, Task 9). All run on the out side and read the public pack from `ctx.pack`; any
 * failure trips, which quarantines that job's documents ("documents blocked: <detail>"). Details name paths and fact
 * ids only, never a forbidden term or a claim's text.
 *
 * - **G-GROUND** (out of resume-planner and cover-writer) re-derives the plan from the posting and the pack and never
 *   trusts the plan's own values. For a ResumePlan: its `evidence` is the input envelope's Evidence and equals the
 *   re-derived evidence; the headline, roles, firstSeen, years, summary slots and summary text equal their computed
 *   values; every bullet and cert is a known, citeable fact of the right kind whose claim equals the text character
 *   for character, and a bullet's fact has its role's display employer; every skill is a non-gap lexicon key that
 *   some citeable fact's tech backs (through the synonyms); then the whole plan equals its re-derivation. For a
 *   CoverPlan: its `resume` is the input ResumePlan and passes the resume checks; every paragraph fact id is a known
 *   citeable fact whose claim appears verbatim in the paragraph; then every paragraph equals the template rendering
 *   from recomputed slots, with the renderer placeholders `{availableFrom}` and `{notice}` intact.
 * - **G-NAMING** (out of every writing agent) runs `assertNoForbidden` over every string and key of the payload, and
 *   over the JSON-stringified payload.
 * - **G-NO-GAP-CLAIM** (out of resume-planner) trips when a skills entry is a gap group's key or synonym.
 */

const pass = (id: string): GuardrailVerdict => ({ id, verdict: 'pass' });
const trip = (id: string, detail: string): GuardrailVerdict => ({ id, verdict: 'trip', detail });
const same = (a: unknown, b: unknown): boolean => canonicalJson(a) === canonicalJson(b);
const MAX_PROBLEMS = 5;

/** The first path at which `a` and `b` differ, or undefined when they are equal. */
export function firstDiff(a: unknown, b: unknown, path = ''): string | undefined {
  const at = (k: string | number): string => (typeof k === 'number' ? `${path}[${k}]` : path === '' ? k : `${path}.${k}`);
  if (Array.isArray(a) && Array.isArray(b)) {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if (i >= a.length || i >= b.length) return at(i);
      const d = firstDiff(a[i], b[i], at(i));
      if (d !== undefined) return d;
    }
    return undefined;
  }
  if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
    for (const k of keys) {
      const d = firstDiff((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], at(k));
      if (d !== undefined) return d;
    }
    return undefined;
  }
  return same(a, b) ? undefined : path === '' ? '(root)' : path;
}

/** Runs a re-derivation; a throw (an unmapped forbidden employer, say) is a problem, not a crash. */
function attempt<T>(problems: string[], what: string, f: () => T): T | undefined {
  try {
    return f();
  } catch (e) {
    problems.push(`${what} cannot be re-derived: ${e instanceof Error ? e.message : String(e)}`);
    return undefined;
  }
}

const RANKABLE = new Set(['experience', 'project']);

/** Every grounding problem of a ResumePlan, each prefixed with `prefix`. */
export function resumeProblems(plan: ResumePlan, pack: WritingPack, prefix = ''): string[] {
  const problems: string[] = [];
  const say = (s: string) => problems.push(`${prefix}${s}`);
  const byId = new Map(pack.facts.map((f) => [f.id, f]));
  const posting = plan.evidence.scored.posting;

  const evidence = attempt(problems, `${prefix}evidence`, () => buildEvidence(plan.evidence.scored, pack));
  if (evidence !== undefined) {
    const d = firstDiff(evidence, plan.evidence);
    if (d !== undefined) say(`evidence is not what the posting and the pack give (at ${d})`);
  }
  const headline = attempt(problems, `${prefix}headline`, () => headlineOf(posting.title, pack.targets.titles));
  if (headline !== undefined && plan.headline !== headline) say('headline is not the computed target title');
  const roles = attempt(problems, `${prefix}roles`, () => displayRoles(pack));
  if (roles !== undefined) {
    const meta = plan.roles.map((r) => ({ employer: r.employer, title: r.title, location: r.location, start: r.start, end: r.end }));
    const d = firstDiff(roles, meta);
    if (d !== undefined) say(`roles are not the pack's roles, newest first, with display employers (at ${d})`);
  }

  const cite = (where: string, factId: string, text: string, kinds: ReadonlySet<string>): string | undefined => {
    const f = byId.get(factId);
    if (f === undefined) {
      say(`${where}: unknown fact ${factId}`);
      return undefined;
    }
    if (!citeable(f)) say(`${where}: fact ${factId} is not citeable (${f.status})`);
    if (!kinds.has(f.kind)) say(`${where}: fact ${factId} is a ${f.kind}, not ${[...kinds].join(' or ')}`);
    if (text !== f.claim) say(`${where}: text is not fact ${factId}'s claim verbatim`);
    return f.employer;
  };
  plan.roles.forEach((r, i) =>
    r.bullets.forEach((b, j) => {
      const where = `roles[${i}].bullets[${j}]`;
      const raw = cite(where, b.factId, b.text, RANKABLE);
      if (raw === undefined) return;
      const shown = attempt(problems, `${prefix}${where}`, () => displayOf(raw, pack));
      if (shown !== undefined && shown !== r.employer) say(`${where}: fact ${b.factId} is from ${shown}, not ${r.employer}`);
    }),
  );
  plan.certs.forEach((c, i) => cite(`certs[${i}]`, c.factId, c.text, new Set(['cert'])));

  const citeableFacts = pack.facts.filter((f) => citeable(f));
  plan.skills.forEach((s) => {
    if (isGapKey(s, pack)) return say(`skills: ${s} is a gap skill`);
    const g = groupOf(s, pack);
    if (g === undefined) return say(`skills: ${s} is not a lexicon key`);
    if (!citeableFacts.some((f) => tagsBack(f.tech, g))) say(`skills: ${s} has no citeable fact behind it`);
  });
  if (new Set(plan.skills).size !== plan.skills.length) say('skills: an entry is listed twice');
  const backed = new Set(backedKeys(pack));
  for (const k of plan.covered) if (!backed.has(k) || isGapKey(k, pack)) say(`covered: ${k} has no citeable fact behind it`);

  const firstSeen = attempt(problems, `${prefix}firstSeen`, () => firstSeenOf(posting, pack));
  if (firstSeen !== undefined) {
    if (plan.firstSeen !== firstSeen) say(`firstSeen is ${plan.firstSeen}, the posting and the pack give ${firstSeen}`);
    const years = yearsOf(pack.roles, firstSeen);
    if (plan.summary.slots['years'] !== years) say(`summary.slots.years is ${String(plan.summary.slots['years'])}, the roles give ${years}`);
    if (headline !== undefined && roles !== undefined && evidence !== undefined) {
      const slots = summarySlots(headline, years, evidence.covered, roles);
      if (!same(slots, plan.summary.slots)) say(`summary.slots differ from the computed slots (at ${firstDiff(slots, plan.summary.slots) ?? '?'})`);
      if (plan.summary.text !== renderSummary(slots)) say('summary.text is not the template rendering of its computed slots');
    }
  }

  if (evidence !== undefined && problems.length === 0) {
    const expected = attempt(problems, `${prefix}plan`, () => planResume(evidence, pack));
    const d = expected === undefined ? undefined : firstDiff(expected, plan);
    if (d !== undefined) say(`the plan differs from its re-derivation (at ${d})`);
  }
  return problems;
}

/** Every grounding problem of a CoverPlan, its resume included. */
export function coverProblems(cover: CoverPlan, pack: WritingPack): string[] {
  const problems = resumeProblems(cover.resume, pack, 'resume.');
  const byId = new Map(pack.facts.map((f) => [f.id, f]));
  if (cover.jobKey !== cover.resume.jobKey) problems.push('jobKey is not the resume plan\'s');
  cover.paragraphs.forEach((p, i) => {
    for (const id of p.factIds) {
      const f = byId.get(id);
      if (f === undefined) problems.push(`paragraphs[${i}]: unknown fact ${id}`);
      else {
        if (!citeable(f)) problems.push(`paragraphs[${i}]: fact ${id} is not citeable (${f.status})`);
        if (!RANKABLE.has(f.kind)) problems.push(`paragraphs[${i}]: fact ${id} is a ${f.kind}, not experience or project`);
        if (!p.text.includes(f.claim)) problems.push(`paragraphs[${i}]: fact ${id}'s claim is not in the text verbatim`);
      }
    }
  });
  const expected = attempt(problems, 'paragraphs', () => planCover(cover.resume, pack).paragraphs);
  if (expected !== undefined) {
    for (let i = 0; i < Math.max(expected.length, cover.paragraphs.length); i++) {
      if (!same(expected[i], cover.paragraphs[i])) {
        problems.push(`paragraphs[${i}] is not the template rendering of its computed slots and facts`);
        break;
      }
    }
  }
  return problems;
}

const report = (id: string, problems: readonly string[]): GuardrailVerdict =>
  problems.length === 0
    ? pass(id)
    : trip(id, problems.slice(0, MAX_PROBLEMS).join('; ') + (problems.length > MAX_PROBLEMS ? `; and ${problems.length - MAX_PROBLEMS} more` : ''));

export const G_GROUND: Guardrail = {
  id: 'G-GROUND',
  sides: ['out'],
  check(ctx: GuardrailContext): GuardrailVerdict {
    if (!ctx.output) return trip('G-GROUND', 'no output to check');
    if (ctx.pack === undefined || ctx.pack === null) return trip('G-GROUND', 'no pack to ground the plan against');
    let pack: WritingPack;
    try {
      pack = writingPackOf(ctx.pack, 'G-GROUND');
    } catch (e) {
      return trip('G-GROUND', e instanceof Error ? e.message : String(e));
    }
    const type = ctx.contract.produces.id;
    const payload = ctx.output.payload;
    if (type === ResumePlan.id) {
      const r = ResumePlan.schema.safeParse(payload);
      if (!r.success) return trip('G-GROUND', `not a valid ${ResumePlan.id}`);
      const problems: string[] = [];
      if (ctx.input.type === 'Evidence@1' && !same(ctx.input.payload, r.data.evidence)) problems.push('evidence differs from the input Evidence@1');
      return report('G-GROUND', [...problems, ...resumeProblems(r.data, pack)]);
    }
    if (type === CoverPlan.id) {
      const r = CoverPlan.schema.safeParse(payload);
      if (!r.success) return trip('G-GROUND', `not a valid ${CoverPlan.id}`);
      const problems: string[] = [];
      if (ctx.input.type === ResumePlan.id && !same(ctx.input.payload, r.data.resume)) problems.push('resume differs from the input ResumePlan@1');
      return report('G-GROUND', [...problems, ...coverProblems(r.data, pack)]);
    }
    return trip('G-GROUND', `G-GROUND checks only ResumePlan@1 and CoverPlan@1, not ${type}`);
  },
};

/** Every string in `v` (values and object keys) with its path. */
function* strings(v: unknown, path = ''): Generator<{ path: string; text: string }> {
  if (typeof v === 'string') yield { path: path === '' ? '(root)' : path, text: v };
  else if (Array.isArray(v)) for (let i = 0; i < v.length; i++) yield* strings(v[i], `${path}[${i}]`);
  else if (v !== null && typeof v === 'object') {
    for (const [k, child] of Object.entries(v)) {
      yield { path: `${path === '' ? '(root)' : path} (a key)`, text: k };
      yield* strings(child, path === '' ? k : `${path}.${k}`);
    }
  }
}

export const G_NAMING: Guardrail = {
  id: 'G-NAMING',
  sides: ['out'],
  check(ctx: GuardrailContext): GuardrailVerdict {
    if (!ctx.output) return trip('G-NAMING', 'no output to check');
    const terms = (ctx.pack as { naming?: { forbiddenTerms?: unknown } } | null | undefined)?.naming?.forbiddenTerms;
    if (ctx.pack === undefined || ctx.pack === null) return trip('G-NAMING', 'no pack, so the forbidden terms are unknown');
    if (!Array.isArray(terms) || !terms.every((t) => typeof t === 'string')) return trip('G-NAMING', 'the pack has no naming.forbiddenTerms list');
    const naming = { forbiddenTerms: terms as string[] };
    const index = (e: ForbiddenTermError) => naming.forbiddenTerms.indexOf(e.term) + 1;
    const payload = ctx.output.payload;
    for (const s of strings(payload)) {
      try {
        assertNoForbidden(s.text, naming);
      } catch (e) {
        if (e instanceof ForbiddenTermError) return trip('G-NAMING', `forbidden term #${index(e)} appears in ${s.path}`);
        throw e;
      }
    }
    try {
      assertNoForbidden(JSON.stringify(payload) ?? '', naming);
    } catch (e) {
      if (e instanceof ForbiddenTermError) return trip('G-NAMING', `forbidden term #${index(e)} appears in the output`);
      throw e;
    }
    return pass('G-NAMING');
  },
};

export const G_NO_GAP_CLAIM: Guardrail = {
  id: 'G-NO-GAP-CLAIM',
  sides: ['out'],
  check(ctx: GuardrailContext): GuardrailVerdict {
    if (!ctx.output) return trip('G-NO-GAP-CLAIM', 'no output to check');
    const gap = (ctx.pack as { lexicon?: { gap?: unknown } } | null | undefined)?.lexicon?.gap;
    if (!Array.isArray(gap)) return trip('G-NO-GAP-CLAIM', 'no pack lexicon, so the gap skills are unknown');
    const p = ctx.output.payload as { skills?: unknown; resume?: { skills?: unknown } } | null;
    const [where, skills] = Array.isArray(p?.skills) ? ['skills', p.skills] : Array.isArray(p?.resume?.skills) ? ['resume.skills', p.resume.skills] : [undefined, undefined];
    if (where === undefined || skills === undefined) return trip('G-NO-GAP-CLAIM', 'the output has no skills line');
    const groups = gap as { key?: unknown; synonyms?: unknown }[];
    const terms = groups.flatMap((g) => [g.key, ...(Array.isArray(g.synonyms) ? g.synonyms : [])]).filter((t): t is string => typeof t === 'string');
    for (const s of skills) {
      if (typeof s !== 'string') return trip('G-NO-GAP-CLAIM', `${where}: an entry is not a string`);
      if (terms.some((t) => tagIs(s, t))) return trip('G-NO-GAP-CLAIM', `${where}: ${s} is a gap skill`);
    }
    return pass('G-NO-GAP-CLAIM');
  },
};

export const APP_GUARDRAILS: readonly Guardrail[] = [G_GROUND, G_NAMING, G_NO_GAP_CLAIM];

/** The kernel's built-in guardrails plus the app's: the registry the app pipeline compiles and runs with. */
export function appGuardrails(): GuardrailRegistry {
  return new GuardrailRegistry([...BUILTIN_GUARDRAILS, ...APP_GUARDRAILS]);
}
