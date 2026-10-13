import type { Envelope } from '../kernel/envelope.js';
import type { Store } from '../kernel/store/store.js';
import { forbiddenTermStrict } from './pack/rules.js';
import type { Naming } from './pack/schema.js';
import { PLATFORM_NOTE_PREFIXES } from './agents/sources/platforms/shared.js';

/**
 * One problem or warning line (rereview R7): control characters dropped and whitespace folded, or a fixed notice when
 * the text, raw or as the line, names a forbidden term under the strict check (`forbiddenTermStrict`: glued, split,
 * look-alike spellings), the same check the dashboard redacts with.
 */
export function safeLine(t: string, naming: Pick<Naming, 'forbiddenTerms'>): string {
  const line = oneLine(t);
  return forbiddenTermStrict(t, naming) === undefined && forbiddenTermStrict(line, naming) === undefined ? line : '[hidden: contains a forbidden term]';
}

/**
 * One item the run did not carry through: a failed step (with `gone` and `input_rejected` told apart), a quarantined
 * step, or a step skipped because a breaker was open. Review I1: every one is named in the run summary, counted in
 * the notification and kept in `runs_summary`.
 */
export interface Problem {
  /**
   * `commit-failed` (review I3): a writing step's files could not be moved into place; its documents are blocked and
   * the next run renders them again. `docs-blocked`: the qa-gate refused a job's documents (`cause` says whether the
   * content or the system failed). `docs-stale` (review I2): ready documents cite a fact the user has since rejected.
   * `source-dead` (freelance §4.5): a gig source with no yield for weeks or failing every fetch; never removed.
   * `mail-quarantined` (freelance §4.3): an alert email no parser recognised, set aside whole; not a failure.
   * `deferred` (coverage): a step refused with `input_rejected` because a host was disabled in the run
   * (`host-disabled:<why>`): nothing is wrong with its input, it is asked again in a later run. Not a failure.
   */
  readonly kind: 'failed' | 'gone' | 'input_rejected' | 'deferred' | 'quarantined' | 'skipped' | 'commit-failed' | 'docs-blocked' | 'docs-stale' | 'source-dead' | 'mail-quarantined';
  readonly agent: string;
  /** What the step was working on: the board (company and ats:slug), the career link, the posting or the job. */
  readonly item: string;
  readonly reason: string;
  /** `docs-blocked` only: `system` counts in the exit code, `content` does not (QA_CHECK_CAUSE). */
  readonly cause?: 'content' | 'system';
}

/**
 * Review I3: why a failed qa-gate check blocked a job's documents. A `content` cause is decided by the posting and the
 * pack (re-running gives the same refusal, like `input_rejected`): it is listed and counted in the notification but
 * does not change the exit code. A `system` cause means the toolchain or the disk misbehaved: it makes the run exit 1.
 * A check id not listed here is `system` (fail loud).
 *
 * | check | cause | why |
 * |---|---|---|
 * | qa.pages | content | the plan's text does not fit the page limit |
 * | qa.terms | content | a planned term is not in the text the plan produced |
 * | qa.hyphen | content | a wrap point the text itself creates |
 * | qa.naming | content | a forbidden term in the pack or posting text |
 * | qa.contact-intact | content | a contact token too long to keep on one line |
 * | qa.files | system | a file is unreadable or not the bytes the renderer recorded |
 * | qa.docx-text | system | the DOCX text layer differs from the document text (renderer or reader bug) |
 * | qa.pdf-text | system | the PDF text layer differs, or pdftotext gave none (renderer or poppler) |
 */
export const QA_CHECK_CAUSE: Readonly<Record<string, 'content' | 'system'>> = {
  'qa.pages': 'content',
  'qa.terms': 'content',
  'qa.hyphen': 'content',
  'qa.naming': 'content',
  'qa.contact-intact': 'content',
  'qa.files': 'system',
  'qa.docx-text': 'system',
  'qa.pdf-text': 'system',
  // gig-qa (freelance Task 8): the text's own limits and wording are content; a text file or grounding mismatch is the system.
  'gig.limits': 'content',
  'gig.links': 'content',
  'gig.banned': 'content',
  'gig.ascii': 'content',
  'gig.naming': 'content',
  'gig.text': 'system',
  'gig.ground': 'system',
};

/** The cause of a QA block: `system` when any failed check is a system cause (or unknown), else `content`. */
export const qaCause = (failedIds: readonly string[]): 'content' | 'system' =>
  failedIds.some((id) => (QA_CHECK_CAUSE[id] ?? 'system') === 'system') ? 'system' : 'content';

const MAX_TEXT = 200;
/** The coverage gate's marker of a refusal decided by run state (a disabled host), not by the input (`coverage/gate.ts`). */
export const HOST_DISABLED_MARK = 'host-disabled:';
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const s = (v: unknown): string => (typeof v === 'string' ? v : '?');
const oneLine = (t: string): string => {
  const line = t.replace(/[\u0000-\u001F\u007F]+/g, ' ').replace(/\s+/g, ' ').trim();
  return line.length > MAX_TEXT ? `${line.slice(0, MAX_TEXT - 1)}…` : line;
};

/** The posting an app envelope carries, at whatever depth its type puts it. */
function postingIn(env: Pick<Envelope, 'type' | 'payload'>): Record<string, unknown> | undefined {
  const p = env.payload;
  const at = (...path: string[]): unknown => path.reduce<unknown>((v, k) => (isObj(v) ? v[k] : undefined), p);
  const found = ((): unknown => {
    switch (env.type) {
      case 'Posting@1':
        return p;
      case 'EligibilityVerdict@1':
      case 'Scored@1':
        return at('posting');
      case 'Evidence@1':
        return at('scored', 'posting');
      case 'ResumePlan@1':
        return at('evidence', 'scored', 'posting');
      case 'CoverPlan@1':
        return at('resume', 'evidence', 'scored', 'posting');
      case 'Rendered@1':
        return at('plan', 'resume', 'evidence', 'scored', 'posting');
      default:
        return undefined;
    }
  })();
  return isObj(found) ? found : undefined;
}

/** The gig a freelance envelope carries, at whatever depth its type puts it. */
function gigIn(env: Pick<Envelope, 'type' | 'payload'>): Record<string, unknown> | undefined {
  const at = (...path: string[]): unknown => path.reduce<unknown>((v, k) => (isObj(v) ? v[k] : undefined), env.payload);
  const found = ((): unknown => {
    switch (env.type) {
      case 'Gig@1':
        return env.payload;
      case 'RatedGig@1':
        return at('gig');
      case 'GigVerdict@1':
        return at('rated', 'gig');
      case 'RiskedGig@1':
        return at('verdict', 'rated', 'gig');
      case 'ScoredGig@1':
        return at('risked', 'verdict', 'rated', 'gig');
      case 'GigDocsPlan@1':
        return at('scored', 'risked', 'verdict', 'rated', 'gig');
      case 'GigRendered@1':
        return at('plan', 'scored', 'risked', 'verdict', 'rated', 'gig');
      default:
        return undefined;
    }
  })();
  return isObj(found) ? found : undefined;
}

/** A short identity of a step's input: never the free text of a posting, only names and ids. */
export function itemOf(env: Pick<Envelope, 'type' | 'payload'>): string {
  const p = isObj(env.payload) ? env.payload : {};
  switch (env.type) {
    case 'DiscoveryRequest@1':
      return `${s(p['company'])} (${s(p['ats'])}:${s(p['slug'])})`;
    case 'CareerLink@1':
      return `${s(p['company'])} (careers:${s(p['slug'])}) ${s(p['url'])}`;
    case 'RawPosting@1':
      return `${s(p['company'])} (${s(p['source'])}:${s(p['sourceId'])})`;
    case 'GigRequest@1':
      return p['platform'] === 'boards' && isObj(p['item']) ? `boards: ${s(p['item']['company'])} — ${s(p['item']['title'])}` : `${s(p['platform'])}${p['query'] ? ` ${s(p['query'])}` : ''}`;
    case 'RawGig@1':
      return `${s(p['platform'])}:${s(p['sourceId'])}`;
    // coverage (career sites): the company, by name and registrable domain
    case 'CoverageRequest@1':
      return `coverage seed ${s(p['source'])}`;
    case 'CompanyCandidate@1':
      return `${s(p['name'])} (${s(p['companyKey'])})`;
    case 'CareersSite@1':
      return isObj(p['candidate']) ? `${s(p['candidate']['name'])} (${s(p['candidate']['companyKey'])}) ${s(p['careersUrl'])}` : env.type;
    case 'PlatformGuess@1': {
      const c = isObj(p['site']) && isObj(p['site']['candidate']) ? p['site']['candidate'] : {};
      return `${s(c['name'])} (${s(c['companyKey'])}) ${s(p['platform'])}:${s(p['slug'])}`;
    }
    default: {
      const gig = gigIn(env);
      if (gig) return `${s(gig['title'])} (${s(gig['platform'])} gig ${s(gig['gigKey'])})`;
      const posting = postingIn(env);
      if (posting) return `${s(posting['company'])} — ${s(posting['title'])} (job ${s(posting['jobKey'])})`;
      return env.type;
    }
  }
}

interface StepEvent {
  readonly kind: string;
  readonly data: Record<string, unknown>;
}

function reasonOf(e: StepEvent | undefined, kernel: Store): string {
  if (!e) return 'no step event recorded';
  const d = e.data;
  if (e.kind === 'step_failed') return `${s(d['error'])}: ${s(d['detail'])}`;
  if (e.kind === 'files_commit_failed') return `the documents could not be written; they are rendered again on the next run (${s(d['message'])})`;
  if (e.kind === 'step_skipped') return d['reason'] === 'breaker_open' ? 'skipped: a breaker was open after earlier failures' : `skipped: ${s(d['reason'])}`;
  let verdict: unknown = d['verdict'];
  if (e.kind === 'step_replayed') {
    const row = kernel.getStep(s(d['stepKey']));
    verdict = (JSON.parse(row?.detail ?? '[]') as unknown[]).at(-1);
  }
  return isObj(verdict) ? `${s(verdict['id'])}: ${s(verdict['detail'])}` : 'quarantined';
}

/**
 * The problems of one run, in queue order: every queue item that did not end `done`, with its input's identity and
 * the reason from its step's event. Each line is one line of at most 200 characters, and any line holding a
 * forbidden term is replaced by a fixed notice.
 */
export function runProblems(
  kernel: Store,
  runId: string,
  naming: Pick<Naming, 'forbiddenTerms'>,
  /** Leaves out the queue items it returns true for (the freelance run: a source skipped on another platform's request, a no-op). */
  ignore?: (agentId: string, input: Envelope, status: string) => boolean,
): Problem[] {
  const last = new Map<string, StepEvent>();
  const events = kernel.events(runId);
  for (const ev of events) {
    if (!['step_failed', 'step_quarantined', 'step_skipped', 'step_replayed', 'files_commit_failed'].includes(ev.kind)) continue;
    const data = JSON.parse(ev.data) as Record<string, unknown>;
    if (ev.kind === 'step_replayed' && data['status'] !== 'quarantined') continue;
    // Events name their input envelope; an older event without it is tied through its step row.
    const envelopeId = typeof data['envelopeId'] === 'string' ? data['envelopeId'] : kernel.getStep(s(data['stepKey']))?.input_envelope_id;
    if (typeof data['agent'] === 'string' && envelopeId) last.set(`${data['agent']}\u0000${envelopeId}`, { kind: ev.kind, data });
  }
  const safe = (t: string): string => safeLine(t, naming);
  const out: Problem[] = [];
  for (const q of kernel.queueItems(runId)) {
    if (q.status === 'done' || q.status === 'pending') continue;
    const e = last.get(`${q.agent_id}\u0000${q.envelope_id}`);
    const error = e?.kind === 'step_failed' ? s(e.data['error']) : undefined;
    const kind: Problem['kind'] =
      q.status === 'skipped'
        ? 'skipped'
        : q.status === 'quarantined'
          ? 'quarantined'
          : e?.kind === 'files_commit_failed'
            ? 'commit-failed'
            : error === 'gone'
              ? 'gone'
              : error === 'input_rejected'
                ? s(e?.data['detail']).includes(HOST_DISABLED_MARK)
                  ? 'deferred'
                  : 'input_rejected'
                : 'failed';
    let item: string;
    try {
      const input = kernel.getEnvelope(q.envelope_id);
      if (ignore?.(q.agent_id, input, q.status) === true) continue;
      item = itemOf(input);
    } catch {
      item = `envelope ${q.envelope_id}`;
    }
    out.push({ kind, agent: q.agent_id, item: safe(item), reason: safe(reasonOf(e, kernel)) });
  }
  out.push(...qaBlocks(kernel, events, safe));
  return out;
}

/**
 * Review I3: every job whose QaReport (or gig whose GigQaReport) in this run (executed or replayed) failed, once per job, in step-key order,
 * with the failed checks and their cause.
 */
function qaBlocks(kernel: Store, events: readonly { kind: string; data: string }[], safe: (t: string) => string): Problem[] {
  const keys = new Set<string>();
  for (const ev of events) {
    if (ev.kind !== 'step_done' && ev.kind !== 'step_replayed') continue;
    const d = JSON.parse(ev.data) as Record<string, unknown>;
    if ((d['agent'] !== 'qa-gate' && d['agent'] !== 'gig-qa') || (ev.kind === 'step_replayed' && d['status'] !== 'done') || typeof d['stepKey'] !== 'string') continue;
    keys.add(d['stepKey']);
  }
  const byJob = new Map<string, Problem>();
  for (const stepKey of [...keys].sort()) {
    for (const env of kernel.envelopesOfStep(stepKey)) {
      const qa = env.payload as { jobKey?: unknown; gigKey?: unknown; ok?: unknown; checks?: { id: string; ok: boolean; detail: string }[] };
      const gig = env.type === 'GigQaReport@1';
      const key = gig ? qa.gigKey : qa.jobKey;
      if ((env.type !== 'QaReport@1' && !gig) || qa.ok !== false || typeof key !== 'string' || byJob.has(key)) continue;
      const failed = (qa.checks ?? []).filter((c) => !c.ok);
      let item = `${gig ? 'gig' : 'job'} ${key}`;
      try {
        const input = kernel.getStep(stepKey)?.input_envelope_id;
        if (input) item = itemOf(kernel.getEnvelope(input));
      } catch {
        // keep the job key
      }
      byJob.set(key, {
        kind: 'docs-blocked',
        agent: gig ? 'gig-qa' : 'qa-gate',
        item: safe(item),
        reason: safe(`qa failed (${failed.map((c) => c.id).join(', ')}): ${failed.map((c) => `${c.id}: ${c.detail}`).join('; ')}`),
        cause: qaCause(failed.map((c) => c.id)),
      });
    }
  }
  return [...byJob.values()];
}

/**
 * Review I2: one `docs-stale` problem per job whose documents are stale (they cite a fact that is no longer citeable),
 * in job-key order. Listed after every run until the posting is seen again (and rebuilt) or the fact is restored; not a
 * failure of the run, so it does not change the exit code.
 */
export function staleProblems(
  jobs: readonly { jobKey: string; company: string; title: string; docsState: string; docsDetail: string | null }[],
  naming: Pick<Naming, 'forbiddenTerms'>,
): Problem[] {
  const safe = (t: string): string => safeLine(t, naming);
  return [...jobs]
    .filter((j) => j.docsState === 'stale')
    .sort((a, b) => (a.jobKey < b.jobKey ? -1 : a.jobKey > b.jobKey ? 1 : 0))
    .map((j) => ({
      kind: 'docs-stale' as const,
      agent: 'projector',
      item: safe(`${j.company} — ${j.title} (job ${j.jobKey})`),
      reason: safe(`the documents ${j.docsDetail ?? 'cite a fact that is no longer citeable'}; they are rebuilt the next time the posting is seen`),
    }));
}

/** Note prefixes of the named skips a platform source records (`PLATFORM_NOTE_PREFIXES`): never counted as malformed postings. */
const NAMED_SKIPS: readonly string[] = PLATFORM_NOTE_PREFIXES;
const isNamedSkip = (note: string): boolean => NAMED_SKIPS.some((p) => note.startsWith(p));

/**
 * Task 6 (no silent drop): every named skip a source recorded in this run, one warning each, as recorded, in event
 * order, each step once: `src-workday: robots-disallow <host>: <company> not read today (…)`, `src-workday:
 * detail-budget <company>: N jobs without detail`, `src-workday: no-india-or-remote-facet <company>: …`. A note holding a forbidden term
 * is replaced by a fixed notice. Not a failure: the exit code does not change.
 */
export function namedSkipWarnings(kernel: Store, runId: string, naming: Pick<Naming, 'forbiddenTerms'>): string[] {
  const steps = new Set<string>();
  const out: string[] = [];
  for (const ev of kernel.events(runId)) {
    if (ev.kind !== 'step_done' && ev.kind !== 'step_replayed') continue;
    const d = JSON.parse(ev.data) as Record<string, unknown>;
    if (ev.kind === 'step_replayed' && d['status'] !== 'done') continue;
    const agent = d['agent'];
    const stepKey = d['stepKey'];
    if (typeof agent !== 'string' || typeof stepKey !== 'string' || steps.has(stepKey)) continue;
    steps.add(stepKey);
    const notes: unknown[] = Array.isArray(d['skippedNotes']) ? d['skippedNotes'] : [];
    for (const n of notes) if (typeof n === 'string' && isNamedSkip(n)) out.push(safeLine(`${agent}: ${n}`, naming));
  }
  return out;
}

/**
 * Final minor (no silent loss): one warning per source agent that skipped malformed jobs in this run without failing,
 * `N postings skipped by <agent> as malformed (B boards; first: <note>)`, in agent order. It reads the `skipped` count
 * the executor puts in each step_done (and done step_replayed) event; each step counts once, less its named skips
 * (`namedSkipWarnings`). A note holding a forbidden term is replaced by a fixed notice.
 */
export function sourceSkipWarnings(kernel: Store, runId: string, naming: Pick<Naming, 'forbiddenTerms'>, except: readonly string[] = []): string[] {
  const steps = new Set<string>();
  const byAgent = new Map<string, { postings: number; boards: number; first: string | undefined }>();
  for (const ev of kernel.events(runId)) {
    if (ev.kind !== 'step_done' && ev.kind !== 'step_replayed') continue;
    const d = JSON.parse(ev.data) as Record<string, unknown>;
    if (ev.kind === 'step_replayed' && d['status'] !== 'done') continue;
    const n = d['skipped'];
    const agent = d['agent'];
    const stepKey = d['stepKey'];
    if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 1 || typeof agent !== 'string' || typeof stepKey !== 'string' || steps.has(stepKey) || except.includes(agent)) continue;
    steps.add(stepKey);
    const all: unknown[] = Array.isArray(d['skippedNotes']) ? d['skippedNotes'] : [];
    // a named skip (robots.txt, a request budget) is not a malformed posting: `namedSkipWarnings` prints it
    const notes = all.filter((x) => !(typeof x === 'string' && isNamedSkip(x)));
    const malformed = n - (all.length - notes.length);
    if (malformed < 1) continue;
    const a = byAgent.get(agent) ?? { postings: 0, boards: 0, first: undefined };
    byAgent.set(agent, { postings: a.postings + malformed, boards: a.boards + 1, first: a.first ?? (typeof notes[0] === 'string' ? notes[0] : undefined) });
  }
  const safe = (t: string): string => safeLine(t, naming);
  return [...byAgent.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([agent, a]) => {
      const first = a.first === undefined ? '' : `; first: ${safe(a.first)}`;
      return `${a.postings} ${a.postings === 1 ? 'posting' : 'postings'} skipped by ${agent} as malformed (${a.boards} ${a.boards === 1 ? 'board' : 'boards'}${first})`;
    });
}

/**
 * Freelance §4.3: one `mail-quarantined` problem per note `agent` recorded with `ctx.skipped` in this run (each step
 * once, executed or replayed done), in event order: an alert email no parser recognised, or one gone before it was
 * read. The executor keeps the first SKIP_NOTES_KEPT notes of a step; the rest are counted in one more line. Not a
 * failure: the exit code does not change.
 */
export function skipNoteProblems(kernel: Store, runId: string, agent: string, naming: Pick<Naming, 'forbiddenTerms'>): Problem[] {
  const steps = new Set<string>();
  const out: Problem[] = [];
  const safe = (t: string): string => safeLine(t, naming);
  for (const ev of kernel.events(runId)) {
    if (ev.kind !== 'step_done' && ev.kind !== 'step_replayed') continue;
    const d = JSON.parse(ev.data) as Record<string, unknown>;
    if (d['agent'] !== agent || (ev.kind === 'step_replayed' && d['status'] !== 'done')) continue;
    const stepKey = d['stepKey'];
    const n = d['skipped'];
    if (typeof stepKey !== 'string' || steps.has(stepKey) || typeof n !== 'number' || !Number.isSafeInteger(n) || n < 1) continue;
    steps.add(stepKey);
    const notes = (Array.isArray(d['skippedNotes']) ? d['skippedNotes'] : []).filter((x): x is string => typeof x === 'string');
    for (const note of notes) out.push({ kind: 'mail-quarantined', agent, item: 'gmail alert', reason: safe(note) });
    if (n > notes.length) out.push({ kind: 'mail-quarantined', agent, item: 'gmail alert', reason: `${n - notes.length} more alert emails were set aside (only the first ${notes.length} are listed)` });
  }
  return out;
}
