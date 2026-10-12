import { canonicalJson } from '../kernel/canonical.js';
import type { GuardrailVerdict } from '../kernel/envelope.js';
import { BUILTIN_GUARDRAILS } from '../kernel/guardrails/builtin.js';
import { GuardrailRegistry, type Guardrail, type GuardrailContext } from '../kernel/guardrails/index.js';
import { scorePosting, type ScorerPack } from './agents/scorer-lexicon.js';
import {
  backedKeys,
  type BulletBudget,
  buildEvidence,
  COMPACT,
  DEFAULT_BUDGET,
  coverSlots,
  displayOf,
  displayRoles,
  firstSeenOf,
  groupOf,
  hasOngoingRole,
  headlineOf,
  isGapKey,
  keyOfDisplay,
  planResume,
  postingSlots,
  renderCover,
  roleContains,
  roleIndexOf,
  summaryKeys,
  summarySlots,
  summaryTerms,
  writingPackOf,
  yearsOf,
  type WritingPack,
} from './agents/writing/grounded.js';
import { renderSummary, RENDER_PLACEHOLDERS, unsafePostingText } from './agents/writing/templates.js';
import { profileFor } from './ats-profiles.js';
import { hasBrace, RenderPack, renderModels } from './render/fill.js';
import { modelText, RENDER_FILES, renderedPath } from './render/model.js';
import { literalIn, tagIs, tagsBack } from './lexicon.js';
import { assertNoForbidden, assertNoForbiddenStrict, citeable, ForbiddenTermError } from './pack/rules.js';
import { CoverPlan, Rendered, ResumePlan } from './types.js';
import { GigDocsPlan, GigRendered } from './freelance/types.js';
import { gigFilesOf, gigTexts } from './freelance/writing/gig-text.js';
import { asciiPunct } from './freelance/writing/phrases.js';
import { evidenceLine, gigResume, planGigDocs, sentencesOf as sentencesOfDescription } from './freelance/writing/proposal-planner.js';

/**
 * The app guardrails (spec §5.5, Task 9 and its fix round 1). All run on the out side and read the public pack from
 * `ctx.pack`; any failure trips, which quarantines that job's documents ("documents blocked: <detail>"). Details name
 * paths and fact ids only, never a forbidden term, a claim's text or the posting's text.
 *
 * - **G-GROUND** (out of resume-planner and cover-writer) re-derives the plan from the posting and the pack and never
 *   trusts the plan's own values. For a ResumePlan: its `evidence` is the input envelope's Evidence; the posting's
 *   score and JD terms equal a fresh `scorePosting` (review M2); the evidence equals its re-derivation; the headline is
 *   a `targets.claimableTitles` entry and the computed choice; the roles, firstSeen, years (from `experience.asOf`),
 *   summary slots and text equal their computed values, and every summary term is backed by an experience fact placed
 *   in a role; every bullet, cert and education entry is a known, citeable fact of the right kind whose claim equals
 *   the text character for character; a bullet's fact has its role's display employer and its period lies inside the
 *   role's dates; every skill is the display of a non-gap lexicon key that a citeable experience, project or cert
 *   fact backs; then the whole plan equals its re-derivation. For a CoverPlan: the sanitised posting title and company
 *   are safe (else `unsafe-posting-text: ...`, reported first); its `resume` is the input ResumePlan and passes the
 *   resume checks; every paragraph fact id is a known citeable fact placed in a role whose claim appears verbatim in
 *   the paragraph (its first letter may be lower-cased after "I"); then every slot is recomputed (`coverSlots`:
 *   headline, years, covered list, display employer, verb form, "where I work now", same-employer phrasing) and every
 *   paragraph must equal its template rendering (`renderCover`) byte for byte, with the renderer placeholders `{city}`
 *   and `{notice}` intact. For a Rendered (out of the renderer, cover letter v2) it also re-renders the filled letter
 *   from the input's resume plan, the public pack and the full pack (city, notice) and compares the plan paragraphs and
 *   `text.cover` byte for byte (`renderedProblems`).
 *   For a GigDocsPlan (out of proposal-planner, Task 8): `gigDocsProblems`. For a GigRendered (out of the gig renderer):
 *   the input plan's `gigDocsProblems`, the output's plan equal to the input, and the proposal or pitch text and the
 *   resume text re-rendered from the plan and the full pack (`gigTexts`: cadence, contact block) byte for byte, with
 *   the expected files in order.
 * - **G-NAMING** (out of every writing agent) runs `forbiddenTermStrict` over every string and key of the payload, and
 *   `assertNoForbidden` over the JSON-stringified payload (word-bounded: joined fields must not glue), except the embedded source posting (`scored.posting`,
 *   `evidence.scored.posting`, `resume.evidence.scored.posting`): the JD's own text is not generated output, and the
 *   posting's title and company are still checked where a template renders them.
 * - **G-NO-GAP-CLAIM** (out of resume-planner) trips when a skills entry is, or names, a gap group's key, display or
 *   synonym.
 */

const pass = (id: string): GuardrailVerdict => ({ id, verdict: 'pass' });
const trip = (id: string, detail: string): GuardrailVerdict => ({ id, verdict: 'trip', detail });
const same = (a: unknown, b: unknown): boolean => canonicalJson(a) === canonicalJson(b);
const MAX_PROBLEMS = 5;

/** The first path at which `a` and `b` differ, or undefined when they are equal. A key on one side only differs. */
export function firstDiff(a: unknown, b: unknown, path = ''): string | undefined {
  const here = path === '' ? '(root)' : path;
  const at = (k: string | number): string => (typeof k === 'number' ? `${path}[${k}]` : path === '' ? k : `${path}.${k}`);
  if (a === undefined || b === undefined) return a === b ? undefined : here;
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
  try {
    return same(a, b) ? undefined : here;
  } catch {
    return here;
  }
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

/**
 * Every grounding problem of a ResumePlan, each prefixed with `prefix`. `rawPack` is the whole public pack (the
 * scorer's view is wider than the writing view).
 */
export function resumeProblems(plan: ResumePlan, pack: WritingPack, prefix = '', rawPack: unknown = pack, budget: BulletBudget = DEFAULT_BUDGET): string[] {
  const problems: string[] = [];
  const say = (s: string) => problems.push(`${prefix}${s}`);
  const byId = new Map(pack.facts.map((f) => [f.id, f]));
  const scored = plan.evidence.scored;
  const posting = scored.posting;

  const rescored = attempt(problems, `${prefix}score`, () =>
    scorePosting({ posting, verdict: scored.verdict, reasons: [], notes: scored.notes }, rawPack as ScorerPack),
  );
  if (rescored !== undefined) {
    const d = firstDiff(rescored, scored);
    if (d !== undefined) say(`evidence.scored is not what the scorer gives for the posting (at ${d})`);
  }
  const evidence = attempt(problems, `${prefix}evidence`, () => buildEvidence(scored, pack));
  if (evidence !== undefined) {
    const d = firstDiff(evidence, plan.evidence);
    if (d !== undefined) say(`evidence is not what the posting and the pack give (at ${d})`);
  }
  // With an ongoing role the headline is a claimable title; with none it is the most recent role's title (past tense).
  const claimable = hasOngoingRole(pack) ? pack.targets.claimableTitles : displayRoles(pack).slice(0, 1).map((r) => r.title);
  if (!claimable.includes(plan.headline)) say('headline is not a claimable title');
  const headline = attempt(problems, `${prefix}headline`, () => headlineOf(posting.title, pack));
  if (headline !== undefined && plan.headline !== headline) say('headline is not the computed claimable title');
  const roles = attempt(problems, `${prefix}roles`, () => displayRoles(pack));
  if (roles !== undefined) {
    const meta = plan.roles.map((r) => ({ employer: r.employer, title: r.title, location: r.location, start: r.start, end: r.end }));
    const d = firstDiff(roles, meta);
    if (d !== undefined) say(`roles are not the pack's roles, newest first, with display employers (at ${d})`);
  }

  const cite = (where: string, factId: string, text: string, kinds: ReadonlySet<string>) => {
    const f = byId.get(factId);
    if (f === undefined) {
      say(`${where}: unknown fact ${factId}`);
      return undefined;
    }
    if (!citeable(f)) say(`${where}: fact ${factId} is not citeable (${f.status})`);
    if (!kinds.has(f.kind)) say(`${where}: fact ${factId} is a ${f.kind}, not ${[...kinds].join(' or ')}`);
    if (text !== f.claim) say(`${where}: text is not fact ${factId}'s claim verbatim`);
    return f;
  };
  plan.roles.forEach((r, i) =>
    r.bullets.forEach((b, j) => {
      const where = `roles[${i}].bullets[${j}]`;
      const f = cite(where, b.factId, b.text, RANKABLE);
      if (f === undefined) return;
      const shown = attempt(problems, `${prefix}${where}`, () => displayOf(f.employer, pack));
      if (shown !== undefined && shown !== r.employer) say(`${where}: fact ${b.factId}'s employer shows as ${shown}, but the bullet sits under the role at ${r.employer}`);
      if (!roleContains(r, f, pack)) say(`${where}: fact ${b.factId} (${f.period}) is not dated inside the role (${r.start}..${r.end})`);
    }),
  );
  plan.certs.forEach((c, i) => cite(`certs[${i}]`, c.factId, c.text, new Set(['cert'])));
  plan.education.forEach((c, i) => cite(`education[${i}]`, c.factId, c.text, new Set(['education'])));

  const skillFacts = pack.facts.filter((f) => citeable(f) && f.kind !== 'education');
  plan.skills.forEach((s) => {
    const key = keyOfDisplay(s, pack);
    if (key === undefined) return say(isGapKey(s, pack) || pack.lexicon.gap.some((g) => (g.display ?? g.key) === s) ? `skills: ${s} is a gap skill` : `skills: ${s} is not a lexicon term`);
    const g = groupOf(key, pack);
    if (g === undefined || isGapKey(key, pack)) return say(`skills: ${s} is a gap skill`);
    if (!skillFacts.some((f) => tagsBack(f.tech, g))) say(`skills: ${s} has no citeable fact behind it`);
  });
  if (new Set(plan.skills).size !== plan.skills.length) say('skills: an entry is listed twice');
  const backed = new Set(backedKeys(pack));
  for (const k of plan.covered) if (!backed.has(k) || isGapKey(k, pack)) say(`covered: ${k} has no citeable fact behind it`);

  const firstSeen = attempt(problems, `${prefix}firstSeen`, () => firstSeenOf(posting, pack));
  if (firstSeen !== undefined && plan.firstSeen !== firstSeen) say(`firstSeen is ${plan.firstSeen}, the posting and the pack give ${firstSeen}`);
  const years = yearsOf(pack.roles, pack.experience.asOf);
  if (plan.summary.slots['years'] !== years) say(`summary.slots.years is ${String(plan.summary.slots['years'])}, the roles give ${years} as of ${pack.experience.asOf}`);
  const experienced = new Set(summaryKeys(pack));
  for (const slot of ['top1', 'top2', 'top3', 'top4']) {
    const v = plan.summary.slots[slot];
    if (v === undefined) continue;
    const key = typeof v === 'string' ? keyOfDisplay(v, pack) : undefined;
    if (key === undefined || !experienced.has(key)) say(`summary.slots.${slot} is not backed by an experience fact dated inside a role`);
  }
  if (headline !== undefined && roles !== undefined && evidence !== undefined) {
    const slots = summarySlots(headline, years, summaryTerms(evidence.covered, pack), roles);
    if (!same(slots, plan.summary.slots)) say(`summary.slots differ from the computed slots (at ${firstDiff(slots, plan.summary.slots) ?? '?'})`);
    if (plan.summary.text !== renderSummary(slots)) say('summary.text is not the template rendering of its computed slots');
  }

  if (evidence !== undefined && problems.length === 0) {
    const expected = attempt(problems, `${prefix}plan`, () => planResume(evidence, pack, budget));
    const d = expected === undefined ? undefined : firstDiff(expected, plan);
    if (d !== undefined) say(`the plan differs from its re-derivation (at ${d})`);
  }
  return problems;
}

/** The `unsafe-posting-text` problems of a posting's template slots (title, company), naming the rule, never the text. */
export function postingSlotProblems(posting: { readonly title: string; readonly company: string }): string[] {
  const slots = postingSlots(posting);
  return (['title', 'company'] as const).flatMap((k) => {
    const why = unsafePostingText(slots[k]);
    return why === null ? [] : [`unsafe-posting-text: the posting ${k} ${why}`];
  });
}

/** Every grounding problem of a CoverPlan, its resume included; unsafe posting text first. */
export function coverProblems(cover: CoverPlan, pack: WritingPack, rawPack: unknown = pack): string[] {
  const problems = [...postingSlotProblems(cover.resume.evidence.scored.posting), ...resumeProblems(cover.resume, pack, 'resume.', rawPack)];
  const byId = new Map(pack.facts.map((f) => [f.id, f]));
  const roles = displayRoles(pack);
  if (cover.jobKey !== cover.resume.jobKey) problems.push("jobKey is not the resume plan's");
  cover.paragraphs.forEach((p, i) => {
    for (const id of p.factIds) {
      const f = byId.get(id);
      if (f === undefined) problems.push(`paragraphs[${i}]: unknown fact ${id}`);
      else {
        if (!citeable(f)) problems.push(`paragraphs[${i}]: fact ${id} is not citeable (${f.status})`);
        if (!RANKABLE.has(f.kind)) problems.push(`paragraphs[${i}]: fact ${id} is a ${f.kind}, not experience or project`);
        else if (!roles.some((r) => r.employer === displayOf(f.employer, pack) && roleContains(r, f, pack))) problems.push(`paragraphs[${i}]: fact ${id} is dated inside no role`);
        // verbatim, but for its first letter, which is lower-cased after "I" when the claim starts with a past-tense verb
        if (!p.text.includes(f.claim) && !p.text.includes(`${f.claim.charAt(0).toLowerCase()}${f.claim.slice(1)}`)) problems.push(`paragraphs[${i}]: fact ${id}'s claim is not in the text verbatim`);
      }
    }
  });
  // Every slot recomputed (headline, years, covered list, employer display, verb form, where I work now), then the
  // templates re-rendered: any difference from the plan, to the byte, trips.
  const expected = attempt(problems, 'paragraphs', () => renderCover(coverSlots(cover.resume, pack)));
  if (expected !== undefined) {
    for (let i = 0; i < Math.max(expected.length, cover.paragraphs.length); i++) {
      if (!same(expected[i] ?? null, cover.paragraphs[i] ?? null)) {
        problems.push(`paragraphs[${i}] is not the template rendering of its computed slots and facts`);
        break;
      }
    }
  }
  return problems;
}

/**
 * Every grounding problem of a GigDocsPlan (Task 8). `rawPack` is the public pack (writing view, freelance rules,
 * platform rules). Independent checks first, then the whole plan re-derived (`planGigDocs`) and compared:
 * - the plan's gigKey and platform are the scored gig's, and its kind has the right document (gig: a proposal, contract:
 *   a pitch, nothing else);
 * - the resume plan is the gig's synthetic posting planned afresh (`gigResume`) and passes `resumeProblems` with the
 *   compact (1-page) bullet budget, `COMPACT`;
 *   `covered` and `missing` are the resume plan's;
 * - the hook quote, when there is one, is a substring of the description (whitespace collapsed) and stands in the
 *   hook in quote marks;
 * - the hook quote also lies inside one sentence of the description (`sentencesOf`); a hook title is a substring of
 *   the gig title (whitespace collapsed) and stands in the hook in quote marks, and a hook has at most one of the two;
 * - every evidence line (proposal evidence, pitch lines with fact ids) cites one known, citeable experience or project
 *   fact placed in a role, its claim in the text verbatim (ASCII punctuation, `asciiPunct`), and the line is exactly
 *   `- <role display employer> (<role years>): <claim>` (`evidenceLine`);
 * - finally the plan equals its re-derivation, so every phrase, variant, step, availability and question is checked.
 * Details name paths and fact ids only, never a claim or the gig's text.
 */
export function gigDocsProblems(plan: GigDocsPlan, rawPack: unknown): string[] {
  const problems: string[] = [];
  let pack: WritingPack;
  try {
    pack = writingPackOf(rawPack, 'G-GROUND');
  } catch (e) {
    return [e instanceof Error ? e.message : String(e)];
  }
  const gig = plan.scored.risked.verdict.rated.gig;
  if (plan.gigKey !== gig.gigKey) problems.push("gigKey is not the scored gig's");
  if (plan.platform !== gig.platform) problems.push("platform is not the scored gig's");
  if (gig.kind === 'gig' && (plan.proposal === null || plan.pitch !== null)) problems.push('a gig must have a proposal and no pitch');
  if (gig.kind === 'contract' && (plan.pitch === null || plan.proposal !== null)) problems.push('a contract must have a pitch and no proposal');
  if (gig.kind !== 'gig' && gig.kind !== 'contract') problems.push(`a ${gig.kind} gets no screening documents`);

  const resume = attempt(problems, 'resume', () => gigResume(plan.scored, rawPack));
  if (resume !== undefined) {
    const d = firstDiff(resume.evidence.scored.posting, plan.resume.evidence.scored.posting);
    if (d !== undefined) problems.push(`resume.evidence.scored.posting is not the gig's synthetic posting (at ${d})`);
  }
  problems.push(...resumeProblems(plan.resume, pack, 'resume.', rawPack, COMPACT));
  if (!same(plan.covered, plan.resume.covered)) problems.push("covered is not the resume plan's covered list");
  if (!same(plan.missing, plan.resume.missing)) problems.push("missing is not the resume plan's missing list");

  const hook = plan.proposal?.hook;
  if (hook !== undefined && hook.title !== null) {
    if (hook.quote !== null) problems.push('proposal.hook has both a quote and a title');
    if (!gig.title.replace(/\s+/g, ' ').trim().includes(hook.title)) problems.push('proposal.hook.title is not in the gig title verbatim');
    if (!hook.text.includes(`"${hook.title}"`)) problems.push('proposal.hook.text does not hold the title in quote marks');
  }
  if (hook !== undefined && hook.quote !== null) {
    if (!sentencesOfDescription(gig.description).some((x) => x.includes(hook.quote as string))) problems.push('proposal.hook.quote is not inside one sentence of the description');
    if (!gig.description.replace(/\s+/g, ' ').trim().includes(hook.quote)) problems.push('proposal.hook.quote is not in the gig description verbatim');
    if (!hook.text.includes(`"${hook.quote}"`)) problems.push('proposal.hook.text does not hold the quote in quote marks');
  }
  const byId = new Map(pack.facts.map((f) => [f.id, f]));
  const roles = displayRoles(pack);
  const lines = [
    ...(plan.proposal?.evidence.map((e, i) => ({ where: `proposal.evidence[${i}]`, ...e })) ?? []),
    ...(plan.pitch?.lines.map((e, i) => ({ where: `pitch.lines[${i}]`, ...e })) ?? []),
  ];
  for (const l of lines) {
    if (l.where.startsWith('proposal') && l.factIds.length !== 1) problems.push(`${l.where} must cite exactly one fact`);
    if (l.where.startsWith('pitch') && l.factIds.length > 1) problems.push(`${l.where} cites more than one fact`);
    for (const id of l.factIds) {
      const f = byId.get(id);
      if (f === undefined) {
        problems.push(`${l.where}: unknown fact ${id}`);
        continue;
      }
      if (!citeable(f)) problems.push(`${l.where}: fact ${id} is not citeable (${f.status})`);
      if (!RANKABLE.has(f.kind)) problems.push(`${l.where}: fact ${id} is a ${f.kind}, not experience or project`);
      if (!l.text.includes(asciiPunct(f.claim))) problems.push(`${l.where}: fact ${id}'s claim is not in the text verbatim`);
      const i = attempt(problems, l.where, () => roleIndexOf(f, roles, pack));
      const role = i === undefined ? undefined : roles[i];
      if (role === undefined) problems.push(`${l.where}: fact ${id} is dated inside no role at its employer`);
      else if (l.text !== evidenceLine(role.employer, role, f.claim)) problems.push(`${l.where}: the line is not "- employer (years): claim" for fact ${id}'s role (${role.employer}, ${role.start}..${role.end})`);
    }
  }

  const expected = attempt(problems, 'plan', () => planGigDocs(plan.scored, rawPack));
  if (expected !== undefined) {
    const d = firstDiff(expected, plan);
    if (d !== undefined) problems.push(`the plan differs from its re-derivation (at ${d})`);
  }
  return problems;
}

/** G-GROUND on the gig renderer's output: see the module rules. Details name fields and lines, never their text. */
function gigRenderedProblems(ctx: GuardrailContext): string[] {
  if (ctx.fullPack === undefined || ctx.fullPack === null) return ['no full pack, so the gig documents cannot be re-rendered'];
  const full = RenderPack.safeParse(ctx.fullPack);
  if (!full.success) return ['the full pack lacks contact, answers or naming'];
  const input = GigDocsPlan.schema.safeParse(ctx.input.payload);
  if (ctx.input.type !== GigDocsPlan.id || !input.success) return [`the input is not a valid ${GigDocsPlan.id}`];
  const out = GigRendered.schema.safeParse(ctx.output?.payload);
  if (!out.success) return [`not a valid ${GigRendered.id}`];
  const problems = gigDocsProblems(input.data, ctx.pack).map((p) => `plan: ${p}`);
  if (out.data.gigKey !== input.data.gigKey) problems.push("gigKey is not the input plan's");
  if (!same(out.data.plan, input.data)) problems.push(`plan differs from the input plan (at ${firstDiff(out.data.plan, input.data) ?? '?'})`);
  const want = attempt(problems, 'text', () => gigTexts(input.data, full.data));
  if (want !== undefined) {
    for (const k of ['proposal', 'pitch', 'resume'] as const) {
      const w = want[k];
      const g = out.data.text[k];
      if (w === g) continue;
      if (w === null || g === null) problems.push(`text.${k} is ${g === null ? 'missing' : 'present'}, the plan gives ${w === null ? 'none' : 'one'}`);
      else {
        const got = g.split('\n');
        const line = w.split('\n').findIndex((l, j) => l !== got[j]);
        problems.push(`text.${k} line ${line < 0 ? w.split('\n').length + 1 : line + 1} is not the document re-rendered from the plan`);
      }
    }
  }
  const files = gigFilesOf(input.data);
  const got = out.data.files.map((f) => ({ kind: f.kind, format: f.format, path: f.path }));
  if (!same(files, got)) problems.push(`files are not the expected gig documents in order (at ${firstDiff(files, got) ?? '?'})`);
  out.data.files.forEach((f, i) => {
    const okPages = f.format === 'pdf' ? f.pages !== null && Number.isInteger(f.pages) && f.pages >= 1 : f.pages === null;
    if (!okPages) problems.push(`files[${i}].pages ${f.format === 'pdf' ? 'must be a page count' : 'must be null'}`);
  });
  return problems;
}

const report = (id: string, problems: readonly string[]): GuardrailVerdict =>
  problems.length === 0
    ? pass(id)
    : trip(id, problems.slice(0, MAX_PROBLEMS).join('; ') + (problems.length > MAX_PROBLEMS ? `; and ${problems.length - MAX_PROBLEMS} more` : ''));

/**
 * G-GROUND on the renderer's output (cover letter v2): the letter is re-rendered from scratch and compared byte for
 * byte. The cover plan is re-derived from the input's resume plan and the public pack (every p1 to p3 slot recomputed),
 * the p4 fill from the full pack (`contact.city`, `answers.yaml` `notice_period`), then the cover document text; the
 * output's plan paragraphs and `text.cover` must equal them exactly. Details name the paragraph or line, never its text.
 */
function renderedProblems(ctx: GuardrailContext, pack: WritingPack): string[] {
  if (ctx.fullPack === undefined || ctx.fullPack === null) return ['no full pack, so the letter cannot be re-rendered'];
  const full = RenderPack.safeParse(ctx.fullPack);
  if (!full.success) return ['the full pack lacks contact, answers or naming'];
  const input = CoverPlan.schema.safeParse(ctx.input.payload);
  if (ctx.input.type !== CoverPlan.id || !input.success) return [`the input is not a valid ${CoverPlan.id}`];
  const out = Rendered.schema.safeParse(ctx.output?.payload);
  if (!out.success) return [`not a valid ${Rendered.id}`];
  const problems: string[] = [];
  const paragraphs = attempt(problems, 'paragraphs', () => renderCover(coverSlots(input.data.resume, pack)));
  if (paragraphs === undefined) return problems;
  paragraphs.forEach((p, i) => {
    if (!same(p, input.data.paragraphs[i] ?? null)) problems.push(`paragraphs[${i}] is not the template rendering of its computed slots and facts`);
  });
  if (input.data.paragraphs.length !== paragraphs.length) problems.push(`the input has ${input.data.paragraphs.length} paragraphs, the slots give ${paragraphs.length}`);
  const models = attempt(problems, 'letter', () => renderModels({ ...input.data, paragraphs }, full.data));
  if (models === undefined) return problems;
  const want = modelText(models.cover);
  if (!same(models.plan.paragraphs, out.data.plan.paragraphs)) {
    const i = models.plan.paragraphs.findIndex((p, j) => !same(p, out.data.plan.paragraphs[j] ?? null));
    problems.push(`plan.paragraphs[${i < 0 ? models.plan.paragraphs.length : i}] is not the letter re-rendered from recomputed slots`);
  }
  if (out.data.text.cover !== want) {
    const got = out.data.text.cover.split('\n');
    const line = want.split('\n').findIndex((l, j) => l !== got[j]);
    problems.push(`text.cover line ${line < 0 ? want.split('\n').length + 1 : line + 1} is not the letter re-rendered from recomputed slots`);
  }
  return problems;
}

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
      return report('G-GROUND', [...problems, ...resumeProblems(r.data, pack, '', ctx.pack)]);
    }
    if (type === CoverPlan.id) {
      const r = CoverPlan.schema.safeParse(payload);
      if (!r.success) return trip('G-GROUND', `not a valid ${CoverPlan.id}`);
      const unsafe = postingSlotProblems(r.data.resume.evidence.scored.posting);
      const problems: string[] = [];
      if (ctx.input.type === ResumePlan.id && !same(ctx.input.payload, r.data.resume)) problems.push('resume differs from the input ResumePlan@1');
      const rest = coverProblems(r.data, pack, ctx.pack).filter((p) => !unsafe.includes(p));
      return report('G-GROUND', [...unsafe, ...problems, ...rest]);
    }
    if (type === Rendered.id) return report('G-GROUND', renderedProblems(ctx, pack));
    if (type === GigDocsPlan.id) {
      const r = GigDocsPlan.schema.safeParse(payload);
      if (!r.success) return trip('G-GROUND', `not a valid ${GigDocsPlan.id}`);
      const problems: string[] = [];
      if (ctx.input.type === 'ScoredGig@1' && !same(ctx.input.payload, r.data.scored)) problems.push('scored differs from the input ScoredGig@1');
      return report('G-GROUND', [...problems, ...gigDocsProblems(r.data, ctx.pack)]);
    }
    if (type === GigRendered.id) return report('G-GROUND', gigRenderedProblems(ctx));
    return trip('G-GROUND', `G-GROUND checks only ResumePlan@1, CoverPlan@1, Rendered@1, GigDocsPlan@1 and GigRendered@1, not ${type}`);
  },
};

/** Every string in `v` (values and object keys) with its path. */
/** The embedded source posting, by exact path: source data, not generated text (G-NAMING scope, fix round 1). */
export const SOURCE_POSTING_PATHS: ReadonlySet<string> = new Set([
  'scored.posting',
  'evidence.scored.posting',
  'resume.evidence.scored.posting',
  'plan.resume.evidence.scored.posting',
  // GigDocsPlan@1 and GigRendered@1 (Task 8): the scored gig is source data; the hook quote is checked where it is used.
  'scored.risked',
  'plan.scored.risked',
]);

/** A copy of `v` without the values at `SOURCE_POSTING_PATHS`. */
function withoutSourcePosting(v: unknown, path = ''): unknown {
  if (Array.isArray(v)) return v.map((x, i) => withoutSourcePosting(x, `${path}[${i}]`));
  if (v === null || typeof v !== 'object') return v;
  const out: Record<string, unknown> = {};
  for (const [k, child] of Object.entries(v)) {
    const at = path === '' ? k : `${path}.${k}`;
    if (!SOURCE_POSTING_PATHS.has(at)) out[k] = withoutSourcePosting(child, at);
  }
  return out;
}

function* strings(v: unknown, path = ''): Generator<{ path: string; text: string }> {
  if (SOURCE_POSTING_PATHS.has(path)) return;
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
        // final I8: every generated string, strictly (glued, split, plural, look-alike); the posting is exempt
        assertNoForbiddenStrict(s.text, naming);
      } catch (e) {
        if (e instanceof ForbiddenTermError) return trip('G-NAMING', `forbidden term #${index(e)} appears in ${s.path}`);
        throw e;
      }
    }
    try {
      assertNoForbidden(JSON.stringify(withoutSourcePosting(payload)) ?? '', naming);
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
    const groups = gap as { key?: unknown; synonyms?: unknown; display?: unknown }[];
    const terms = groups.flatMap((g) => [g.key, g.display, ...(Array.isArray(g.synonyms) ? g.synonyms : [])]).filter((t): t is string => typeof t === 'string');
    const squeeze = (x: string) => x.replace(/\s+/g, '');
    for (const s of skills) {
      if (typeof s !== 'string') return trip('G-NO-GAP-CLAIM', `${where}: an entry is not a string`);
      // the entry is the term ("Scala", "C#"), the term with stray spaces ("c #"), or names it ("Ruby on Rails")
      if (terms.some((t) => tagIs(s, t) || tagIs(squeeze(s), squeeze(t)) || literalIn(s, t))) return trip('G-NO-GAP-CLAIM', `${where}: ${s} is a gap skill`);
    }
    return pass('G-NO-GAP-CLAIM');
  },
};

/**
 * G-FILL (out of the renderer, Task 10). The renderer is the only agent that reads the full pack, so this guardrail,
 * which gets that pack as `ctx.fullPack`, re-derives everything it added and never trusts the payload:
 * - the input is a CoverPlan@1 and the output's `jobKey`, `plan.jobKey` and `plan.resume` equal the input's;
 * - every paragraph but the last is unchanged (text and fact ids), and the last is the p4 fill re-rendered from
 *   `answers.yaml` (`available_from`, `notice_period`; the availability sentence dropped when either is missing);
 * - no placeholder brace remains in any paragraph or document text;
 * - `text.resume` and `text.cover` equal the document text re-rendered from the plan and the contact details, so the
 *   qa-gate compares the files with kernel-checked text and G-NAMING sees every rendered line, contact block included;
 * - `recommended` is the ATS profile's format, and `files` lists exactly the six expected files in order, with page
 *   counts on PDFs only.
 * Details never quote an answer, a contact detail or a claim.
 */
export const G_FILL: Guardrail = {
  id: 'G-FILL',
  sides: ['out'],
  check(ctx: GuardrailContext): GuardrailVerdict {
    if (!ctx.output) return trip('G-FILL', 'no output to check');
    if (ctx.fullPack === undefined || ctx.fullPack === null) return trip('G-FILL', 'no full pack, so the fill cannot be re-derived');
    const pack = RenderPack.safeParse(ctx.fullPack);
    if (!pack.success) return trip('G-FILL', 'the full pack lacks contact, answers or naming');
    if (ctx.input.type !== CoverPlan.id) return trip('G-FILL', `G-FILL checks the renderer's output for a ${CoverPlan.id} input, not ${ctx.input.type}`);
    const input = CoverPlan.schema.safeParse(ctx.input.payload);
    const out = Rendered.schema.safeParse(ctx.output.payload);
    if (!input.success) return trip('G-FILL', `the input is not a valid ${CoverPlan.id}`);
    if (!out.success) return trip('G-FILL', `not a valid ${Rendered.id}`);
    const cover = input.data;
    const r = out.data;
    const problems: string[] = [];
    if (r.jobKey !== cover.jobKey || r.plan.jobKey !== cover.jobKey) problems.push('jobKey is not the input plan\'s');
    if (!same(r.plan.resume, cover.resume)) problems.push(`plan.resume differs from the input resume plan (at ${firstDiff(r.plan.resume, cover.resume) ?? '?'})`);
    let expected: ReturnType<typeof renderModels> | undefined;
    try {
      expected = renderModels(cover, pack.data);
    } catch (e) {
      problems.push(`the fill cannot be re-derived: ${e instanceof Error ? e.message : String(e)}`);
    }
    const last = cover.paragraphs.length - 1;
    if (r.plan.paragraphs.length !== cover.paragraphs.length) problems.push(`plan has ${r.plan.paragraphs.length} paragraphs, the input ${cover.paragraphs.length}`);
    r.plan.paragraphs.forEach((p, i) => {
      if (hasBrace(p.text)) problems.push(`paragraphs[${i}] still holds a placeholder brace`);
      if (i < last && !same(p, cover.paragraphs[i])) problems.push(`paragraphs[${i}] changed; only the last paragraph is filled`);
      if (i === last && expected !== undefined && !same(p, expected.plan.paragraphs[last])) problems.push(`paragraphs[${i}] is not the p4 fill from answers.yaml`);
    });
    for (const k of ['resume', 'cover'] as const) {
      if (hasBrace(r.text[k]) || RENDER_PLACEHOLDERS.some((ph) => r.text[k].includes(ph))) problems.push(`text.${k} still holds a placeholder brace`);
      if (expected !== undefined && r.text[k] !== modelText(expected[k])) problems.push(`text.${k} is not the document rendered from the plan and the contact details`);
    }
    const profile = profileFor(cover.resume.ats, cover.resume.evidence.scored.posting.url);
    if (r.recommended !== profile.recommended) problems.push(`recommended is ${r.recommended}, the ${profile.id} profile gives ${profile.recommended}`);
    const want = RENDER_FILES.map((f) => ({ kind: f.kind, format: f.format, path: renderedPath(cover.jobKey, f.kind, f.format) }));
    const got = r.files.map((f) => ({ kind: f.kind, format: f.format, path: f.path }));
    if (!same(want, got)) problems.push(`files are not the six expected documents in order (at ${firstDiff(want, got) ?? '?'})`);
    r.files.forEach((f, i) => {
      const okPages = f.format === 'pdf' ? f.pages !== null && Number.isInteger(f.pages) && f.pages >= 1 : f.pages === null;
      if (!okPages) problems.push(`files[${i}].pages ${f.format === 'pdf' ? 'must be a page count' : 'must be null'}`);
    });
    return report('G-FILL', problems);
  },
};

export const APP_GUARDRAILS: readonly Guardrail[] = [G_GROUND, G_NAMING, G_NO_GAP_CLAIM, G_FILL];

/** The kernel's built-in guardrails plus the app's: the registry the app pipeline compiles and runs with. */
export function appGuardrails(): GuardrailRegistry {
  return new GuardrailRegistry([...BUILTIN_GUARDRAILS, ...APP_GUARDRAILS]);
}
