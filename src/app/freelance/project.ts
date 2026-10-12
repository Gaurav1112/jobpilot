import { canonicalJson } from '../../kernel/canonical.js';
import type { Envelope } from '../../kernel/envelope.js';
import type { Store } from '../../kernel/store/store.js';
import type { DocCheck } from '../docs-check.js';
import type { AppStore, GigDoc, GigDocsState, GigList, GigUpsert } from '../store/app-store.js';
import { rankGigs } from './rank.js';
import type { Gig, GigQaReport, GigRendered, GigVerdict, RatedGig, RiskedGig, ScoredGig } from './types.js';
import { repeatKey } from './writing/gig-qa.js';

/**
 * The freelance projector (spec §8, Task 9): writes one `jobpilot-freelance` run's outputs into the `gigs` and
 * `gig_docs` tables. Like the daily projector it reads the run's own steps from its events (done and replayed steps,
 * minus quarantined ones), groups their envelopes by gigKey and writes one row per gig from the furthest stage reached.
 *
 * - **One row per gigKey.** Cross-query duplicates (one Freelancer project found by two queries) are separate items
 *   with one gigKey; the row takes the first of them in `rankGigs` order (contracts, gigs, review), or for a gig under
 *   the fit floor the one with the least canonical JSON, so it never depends on input order.
 * - **list:** the `rankGigs(rows, fitFloor)` list the gig is in; `below-floor` for a contract or gig under the floor;
 *   null when it was rejected or not scored.
 * - **coverage gate:** a Contracts or Gigs row whose documents' plan backs no lexicon term, or cites no fact
 *   (`coverageGate`), goes to `review` with the note NOTE_NO_FACTS and its documents `blocked` (never ready to paste,
 *   never announced); one backed term keeps it listed with the note NOTE_ONE_SKILL. The fit formula is unchanged.
 * - **docs:** from the gig's GigQaReport: `ready` when QA passed and every file is on disk with its sha256, `missing`
 *   when one is not, `blocked` with the failed checks when QA failed. A quarantined writing step, a files commit
 *   failure, or a writing failure with a named reason blocks the documents. Anything else is `none`; a scored gig
 *   under the fit floor (a review row too) says `below the fit floor`.
 * - **flags:** the gig-risk flags, then the projector's own two, which need the whole run:
 *   - `duplicate-text`: another gig of this run has the same normalised description (NFC, whitespace folded, lower
 *     case) and is not provably the same client (both client names known and equal); the detail says "client
 *     unknown" when either name is missing, else "another client";
 *   - `repeat` (gig-qa's `gig.repeat`): another proposal written in this run opens with the same `repeatKey`.
 * - `duplicate_of` is set by the store (the earliest-first-seen gig of the dedupe key, from another platform).
 * - Status, note and notified_at are never written. A row last seen after this run is skipped (`stale`). Projecting a
 *   run twice is a no-op. A gig no run sees again keeps its row as it was (a pm run, in which Remotive answers
 *   nothing, keeps the am rows).
 */

export interface GigProjectOptions {
  /** `freelance.fitFloor` (45): a contract or gig scored under it is `below-floor`. */
  readonly fitFloor: number;
  /** Checks a QA-passed file is on disk with its recorded sha256 (`diskDocCheck(outDir)` in production). */
  readonly docOnDisk: DocCheck;
  /** When the gigs were seen; default the run's `run_started` event time. */
  readonly at?: string;
}

export interface GigProjectResult {
  readonly gigs: number;
  readonly inserted: number;
  readonly stale: number;
  readonly docs: Record<GigDocsState, number>;
  /** Rows written per list (`rejected`: verdict rejected; `unscored`: normalised or rated but never scored). */
  readonly lists: Record<GigList | 'rejected' | 'unscored', number>;
  /** The rows as written, by gigKey (the health counter and the tests read them). */
  readonly rows: readonly GigUpsert[];
}

/** What one run produced for its gigs, read from the kernel store (or built by a test). */
export interface GigRunOutputs {
  readonly gigs: readonly Gig[];
  readonly rated: readonly RatedGig[];
  readonly verdicts: readonly GigVerdict[];
  readonly risked: readonly RiskedGig[];
  readonly scored: readonly ScoredGig[];
  readonly rendered: readonly GigRendered[];
  readonly qa: readonly GigQaReport[];
  /** A writing step of the gig was quarantined or could not commit, or failed with a named reason: docs blocked. */
  readonly blocked: ReadonlyMap<string, string>;
  /** A writing step of the gig failed with no named reason: docs `none`, the failure shown in the detail. */
  readonly writingFailed: ReadonlyMap<string, string>;
}

/** The note (and docs detail) of a listed gig whose plan backs no lexicon term or cites no fact: it goes to review. */
export const NOTE_NO_FACTS = 'none of your verified facts match this gig';
/** The amber note of a listed gig whose plan backs exactly one term. */
export const NOTE_ONE_SKILL = 'only one of the skills it asks for is backed by your facts';

/**
 * The coverage of a gig's plan: `none` when it backs no term (`covered` empty) or cites no fact (no evidence or pitch
 * line with a fact id), `one` when it backs exactly one term, `ok` otherwise; `unknown` without a plan on record.
 */
export function coverageGate(plan: GigRendered['plan'] | undefined): 'none' | 'one' | 'ok' | 'unknown' {
  if (plan === undefined || !Array.isArray(plan.covered)) return 'unknown';
  const lines = plan.proposal?.evidence ?? plan.pitch?.lines ?? [];
  const cited = lines.filter((l) => l.factIds.length > 0).length;
  if (plan.covered.length === 0 || cited === 0) return 'none';
  return plan.covered.length === 1 ? 'one' : 'ok';
}

/** The docs detail of a scored gig under the fit floor (review rows included): no documents are written for it. */
export const BELOW_FLOOR_DETAIL = 'below the fit floor';

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const byJson = <T>(xs: readonly T[]): T[] => [...xs].sort((a, b) => cmp(canonicalJson(a), canonicalJson(b)));
const keyOfScored = (s: ScoredGig): string => s.risked.verdict.rated.gig.gigKey;

/** Groups `xs` by key, each group in least-canonical-JSON order. */
function groupBy<T>(xs: readonly T[], key: (x: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const x of byJson(xs)) {
    const k = key(x);
    m.set(k, [...(m.get(k) ?? []), x]);
  }
  return m;
}

/** The text a duplicate-text comparison reads: NFC, whitespace folded, lower case. */
export const textKey = (s: string): string => s.normalize('NFC').replace(/\s+/gu, ' ').trim().toLowerCase();

/** Docs and state from one QA report, as the daily `docsOfQa`. */
function docsOfGigQa(qa: GigQaReport, docOnDisk: DocCheck): { docsState: GigDocsState; docsDetail: string | null; docs: GigDoc[] } {
  const docs = qa.files.map((f) => ({ kind: f.kind, format: f.format, path: f.path, sha256: f.sha256, pages: f.pages }));
  if (!qa.ok) return { docsState: 'blocked', docsDetail: `qa failed: ${qa.checks.filter((c) => !c.ok).map((c) => `${c.id}: ${c.detail}`).join('; ')}`, docs };
  const gone = qa.files.flatMap((f) => {
    const s = docOnDisk(f.path, f.sha256);
    return s === 'ok' ? [] : [`${f.path} ${s === 'absent' ? 'is not on disk' : 'changed on disk'}`];
  });
  return gone.length > 0 ? { docsState: 'missing', docsDetail: `documents missing: ${gone.join('; ')}`, docs } : { docsState: 'ready', docsDetail: null, docs };
}

/**
 * The rows of one run's outputs (pure: the projector and the unit tests call it). Every gigKey that reached Gig@1 gets
 * one row; see the module comment for each column.
 */
export function gigRowsOf(out: GigRunOutputs, opts: Required<Pick<GigProjectOptions, 'fitFloor' | 'docOnDisk' | 'at'>>): { row: GigUpsert; docs: GigDoc[] }[] {
  const ranked = rankGigs(out.scored, opts.fitFloor);
  const chosen = new Map<string, { scored: ScoredGig; list: GigList }>();
  for (const list of ['contracts', 'gigs', 'review'] as const) for (const s of ranked[list]) if (!chosen.has(keyOfScored(s))) chosen.set(keyOfScored(s), { scored: s, list });
  for (const [k, xs] of groupBy(out.scored, keyOfScored)) if (!chosen.has(k)) chosen.set(k, { scored: xs[0] as ScoredGig, list: 'below-floor' });

  const risked = groupBy(out.risked, (r) => r.verdict.rated.gig.gigKey);
  const verdicts = groupBy(out.verdicts, (v) => v.rated.gig.gigKey);
  const rated = groupBy(out.rated, (r) => r.gig.gigKey);
  const gigs = groupBy(out.gigs, (g) => g.gigKey);
  const qaOf = groupBy(out.qa, (q) => q.gigKey);
  const renderedOf = groupBy(out.rendered, (r) => r.gigKey);

  type Base = { gig: Gig; rate: RatedGig['rate'] | null; verdict: GigVerdict | null; flags: RiskedGig['flags']; scored: ScoredGig | null; list: GigList | null };
  const bases = new Map<string, Base>();
  for (const [k, g] of gigs) {
    const c = chosen.get(k);
    const r = c?.scored.risked ?? risked.get(k)?.[0];
    const v = r?.verdict ?? verdicts.get(k)?.[0];
    const rt = v?.rated ?? rated.get(k)?.[0];
    bases.set(k, { gig: rt?.gig ?? (g[0] as Gig), rate: rt?.rate ?? null, verdict: v ?? null, flags: r?.flags ?? [], scored: c?.scored ?? null, list: c?.list ?? null });
  }

  // Docs: of the gig's QA reports (one per duplicate item), a passed one whose files are on disk first.
  const docsOf = new Map<string, { docsState: GigDocsState; docsDetail: string | null; docs: GigDoc[]; qa: GigQaReport }>();
  for (const [k, reports] of qaOf) {
    const graded = reports.map((qa) => ({ qa, ...docsOfGigQa(qa, opts.docOnDisk) }));
    const rank: Record<GigDocsState, number> = { ready: 0, missing: 1, blocked: 2, none: 3 };
    graded.sort((a, b) => rank[a.docsState] - rank[b.docsState]);
    docsOf.set(k, graded[0] as { docsState: GigDocsState; docsDetail: string | null; docs: GigDoc[]; qa: GigQaReport });
  }

  // The proposal text behind each gig's chosen documents: the rendering whose files are those the QA report lists.
  const proposalOf = new Map<string, string>();
  const planOf = new Map<string, GigRendered['plan']>();
  for (const [k, d] of docsOf) {
    const want = d.qa.files.map((f) => `${f.path}\u0000${f.sha256}`).sort().join('\n');
    const r = (renderedOf.get(k) ?? []).find((x) => x.files.map((f) => `${f.path}\u0000${f.sha256}`).sort().join('\n') === want);
    if (r?.text.proposal != null) proposalOf.set(k, r.text.proposal);
    if (r !== undefined) planOf.set(k, r.plan);
  }

  const projectorFlags = new Map<string, { id: string; detail: string }[]>();
  const addFlag = (k: string, f: { id: string; detail: string }) => projectorFlags.set(k, [...(projectorFlags.get(k) ?? []), f]);
  // duplicate-text
  const byText = new Map<string, string[]>();
  for (const [k, b] of [...bases].sort(([a], [c]) => cmp(a, c))) {
    const t = textKey(b.gig.description);
    if (t !== '') byText.set(t, [...(byText.get(t) ?? []), k]);
  }
  for (const keys of byText.values()) {
    for (const k of keys) {
      const me = (bases.get(k) as Base).gig.client.name;
      const others = keys.filter((o) => {
        if (o === k) return false;
        const them = (bases.get(o) as Base).gig.client.name;
        return me === null || them === null || textKey(me) !== textKey(them);
      });
      if (others.length === 0) continue;
      const unknown = me === null || others.some((o) => (bases.get(o) as Base).gig.client.name === null);
      addFlag(k, { id: 'duplicate-text', detail: `same description as gig ${others.slice(0, 3).join(', ')}${others.length > 3 ? ` and ${others.length - 3} more` : ''}${unknown ? ' (client unknown)' : ' (another client)'}` });
    }
  }
  // repeat
  const byOpening = new Map<string, string[]>();
  for (const [k, p] of [...proposalOf].sort(([a], [c]) => cmp(a, c))) byOpening.set(repeatKey(p), [...(byOpening.get(repeatKey(p)) ?? []), k]);
  for (const keys of byOpening.values()) {
    if (keys.length < 2) continue;
    for (const k of keys) {
      const others = keys.filter((o) => o !== k);
      addFlag(k, { id: 'repeat', detail: `the proposal opens like gig ${others.slice(0, 3).join(', ')}${others.length > 3 ? ` and ${others.length - 3} more` : ''}` });
    }
  }

  const rows: { row: GigUpsert; docs: GigDoc[] }[] = [];
  for (const k of [...bases.keys()].sort()) {
    const b = bases.get(k) as Base;
    const g = b.gig;
    let docsState: GigDocsState = 'none';
    let docsDetail: string | null = null;
    let docs: GigDoc[] = [];
    const d = docsOf.get(k);
    const block = out.blocked.get(k);
    if (block !== undefined) {
      docsState = 'blocked';
      docsDetail = block;
    } else if (d !== undefined) ({ docsState, docsDetail, docs } = d);
    else docsDetail = out.writingFailed.get(k) ?? (b.scored !== null && b.scored.fit < opts.fitFloor ? BELOW_FLOOR_DETAIL : null);
    // The coverage gate (fix round 1): fit counts the lexicon terms a posting names; coverage counts the terms the
    // user's verified facts back. A listed gig whose plan backs none of them, or cites no fact, is not shortlisted.
    let list = b.list;
    let notes = b.verdict?.notes ?? [];
    const gate = coverageGate(planOf.get(k));
    if ((list === 'contracts' || list === 'gigs') && gate === 'none') {
      list = 'review';
      notes = [...notes, NOTE_NO_FACTS];
      if (docsState === 'ready') {
        docsState = 'blocked';
        docsDetail = NOTE_NO_FACTS;
      }
    } else if ((list === 'contracts' || list === 'gigs') && gate === 'one') notes = [...notes, NOTE_ONE_SKILL];
    rows.push({
      row: {
        gigKey: k,
        dedupeKey: g.dedupeKey,
        platform: g.platform,
        sourceId: g.sourceId,
        url: g.url,
        title: g.title,
        description: g.description,
        client: g.client,
        kind: g.kind,
        budget: g.budget,
        rate: b.rate,
        hours: g.hoursPerWeek,
        verdict: b.verdict?.verdict ?? null,
        reasons: b.verdict?.reasons ?? [],
        notes,
        flags: [...b.flags, ...(projectorFlags.get(k) ?? [])],
        fit: b.scored?.fit ?? null,
        breakdown: b.scored?.breakdown ?? null,
        list,
        docsState,
        docsDetail,
        postedAt: g.postedAt,
        at: opts.at,
      },
      docs,
    });
  }
  return rows;
}

/** Envelope type → how to find its gigKey. */
const KEY_OF: Readonly<Record<string, (p: unknown) => string>> = {
  'Gig@1': (p) => (p as Gig).gigKey,
  'RatedGig@1': (p) => (p as RatedGig).gig.gigKey,
  'GigVerdict@1': (p) => (p as GigVerdict).rated.gig.gigKey,
  'RiskedGig@1': (p) => (p as RiskedGig).verdict.rated.gig.gigKey,
  'ScoredGig@1': (p) => keyOfScored(p as ScoredGig),
  'GigDocsPlan@1': (p) => (p as { gigKey: string }).gigKey,
  'GigRendered@1': (p) => (p as GigRendered).gigKey,
  'GigQaReport@1': (p) => (p as GigQaReport).gigKey,
};

/** The gigKey an envelope carries, or null for a request or a raw gig. */
export function gigKeyOf(env: Pick<Envelope, 'type' | 'payload'>): string | null {
  const f = KEY_OF[env.type];
  return f === undefined ? null : f(env.payload);
}

const WRITING = new Set(['proposal-planner', 'gig-renderer', 'gig-qa']);
/** Named reasons a failed writing step may carry (as the daily projector's): only these are shown, never free text. */
const NAMED_REASON = /\b(?:unrenderable-glyph:U\+[0-9A-F]{4,6}|G-NAMING: forbidden term #\d+)\b/;

function inputOf(kernel: Store, stepKey: string): Envelope | undefined {
  const row = kernel.getStep(stepKey);
  if (!row || row.input_envelope_id === '') return undefined;
  try {
    return kernel.getEnvelope(row.input_envelope_id);
  } catch {
    return undefined;
  }
}

/** The run's done outputs and writing problems, from the kernel store. */
export function gigRunOutputs(kernel: Store, runId: string): GigRunOutputs {
  const done = new Set<string>();
  const quarantined = new Map<string, { agent: string; verdict: unknown }>();
  const commitFailed = new Map<string, string>();
  const failed = new Map<string, { agent: string; error: string; detail: string }>();
  for (const e of kernel.events(runId)) {
    const d = JSON.parse(e.data) as Record<string, unknown>;
    const stepKey = typeof d['stepKey'] === 'string' ? d['stepKey'] : undefined;
    const agent = typeof d['agent'] === 'string' ? d['agent'] : '';
    if (stepKey === undefined) continue;
    if (e.kind === 'step_done' || (e.kind === 'step_replayed' && d['status'] === 'done')) done.add(stepKey);
    else if (e.kind === 'files_commit_failed') commitFailed.set(stepKey, agent);
    else if (e.kind === 'step_quarantined') quarantined.set(stepKey, { agent, verdict: d['verdict'] });
    else if (e.kind === 'step_replayed' && d['status'] === 'quarantined') {
      const verdicts = JSON.parse(kernel.getStep(stepKey)?.detail ?? '[]') as unknown[];
      quarantined.set(stepKey, { agent, verdict: verdicts.at(-1) });
    } else if (e.kind === 'step_failed') failed.set(stepKey, { agent, error: String(d['error'] ?? 'unknown'), detail: String(d['detail'] ?? '') });
  }
  for (const k of quarantined.keys()) done.delete(k);
  for (const k of commitFailed.keys()) done.delete(k);

  const by: Record<string, unknown[]> = {};
  for (const stepKey of [...done].sort()) for (const env of kernel.envelopesOfStep(stepKey)) (by[env.type] ??= []).push(env.payload);
  const blocked = new Map<string, string>();
  const writingFailed = new Map<string, string>();
  const keyOfInput = (stepKey: string): string | null => {
    const input = inputOf(kernel, stepKey);
    return input ? gigKeyOf(input) : null;
  };
  for (const [stepKey, q] of [...quarantined].sort(([a], [b]) => cmp(a, b))) {
    const k = WRITING.has(q.agent) ? keyOfInput(stepKey) : null;
    const v = q.verdict as { id?: unknown; detail?: unknown } | undefined;
    if (k !== null && !blocked.has(k)) blocked.set(k, `${q.agent} quarantined: ${String(v?.id ?? 'quarantined')}${v?.detail === undefined ? '' : `: ${String(v.detail)}`}`);
  }
  for (const [stepKey] of [...commitFailed].sort(([a], [b]) => cmp(a, b))) {
    const k = keyOfInput(stepKey);
    if (k !== null && !blocked.has(k)) blocked.set(k, 'the documents could not be written to disk (files commit failed); they are rendered again on the next run');
  }
  for (const [stepKey, f] of [...failed].sort(([a], [b]) => cmp(a, b))) {
    if (!WRITING.has(f.agent)) continue;
    const k = keyOfInput(stepKey);
    if (k === null) continue;
    const reason = NAMED_REASON.exec(f.detail)?.[0];
    if (reason !== undefined && !blocked.has(k)) blocked.set(k, `${f.agent} failed: ${f.error} (${reason})`);
    else if (reason === undefined && !writingFailed.has(k)) writingFailed.set(k, `${f.agent} failed: ${f.error}`);
  }
  const of = <T>(type: string): T[] => (by[type] ?? []) as T[];
  return {
    gigs: of<Gig>('Gig@1'),
    rated: of<RatedGig>('RatedGig@1'),
    verdicts: of<GigVerdict>('GigVerdict@1'),
    risked: of<RiskedGig>('RiskedGig@1'),
    scored: of<ScoredGig>('ScoredGig@1'),
    rendered: of<GigRendered>('GigRendered@1'),
    qa: of<GigQaReport>('GigQaReport@1'),
    blocked,
    writingFailed,
  };
}

/** Projects one freelance run into the gig tables (see the module comment). */
export function projectFreelanceRun(kernel: Store, app: AppStore, runId: string, opts: GigProjectOptions): GigProjectResult {
  const run = kernel.getRun(runId);
  if (!run) throw new Error(`unknown run ${runId}`);
  const events = kernel.events(runId);
  const at = opts.at ?? events.find((e) => e.kind === 'run_started')?.at ?? events[0]?.at;
  if (at === undefined) throw new Error(`run ${runId} has no events`);
  const rows = gigRowsOf(gigRunOutputs(kernel, runId), { fitFloor: opts.fitFloor, docOnDisk: opts.docOnDisk, at });
  const docs: Record<GigDocsState, number> = { ready: 0, blocked: 0, missing: 0, none: 0 };
  const lists: GigProjectResult['lists'] = { contracts: 0, gigs: 0, review: 0, 'below-floor': 0, rejected: 0, unscored: 0 };
  let gigs = 0;
  let inserted = 0;
  let stale = 0;
  const written: GigUpsert[] = [];
  app.tx(() => {
    for (const { row, docs: files } of rows) {
      const res = app.upsertGig(row);
      if (res.stale) {
        stale += 1;
        continue;
      }
      app.putGigDocs(row.gigKey, files);
      gigs += 1;
      if (res.inserted) inserted += 1;
      docs[row.docsState] += 1;
      lists[row.list ?? (row.verdict === 'rejected' ? 'rejected' : 'unscored')] += 1;
      written.push(row);
    }
  });
  return { gigs, inserted, stale, docs, lists, rows: written };
}
