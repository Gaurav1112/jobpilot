import type { Envelope } from '../kernel/envelope.js';
import type { Store } from '../kernel/store/store.js';
import { assertNoForbidden, ForbiddenTermError } from './pack/rules.js';
import type { Naming } from './pack/schema.js';

/**
 * One item the run did not carry through: a failed step (with `gone` and `input_rejected` told apart), a quarantined
 * step, or a step skipped because a breaker was open. Review I1: every one is named in the run summary, counted in
 * the notification and kept in `runs_summary`.
 */
export interface Problem {
  readonly kind: 'failed' | 'gone' | 'input_rejected' | 'quarantined' | 'skipped';
  readonly agent: string;
  /** What the step was working on: the board (company and ats:slug), the career link, the posting or the job. */
  readonly item: string;
  readonly reason: string;
}

const MAX_TEXT = 200;
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
    default: {
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
export function runProblems(kernel: Store, runId: string, naming: Pick<Naming, 'forbiddenTerms'>): Problem[] {
  const last = new Map<string, StepEvent>();
  for (const ev of kernel.events(runId)) {
    if (!['step_failed', 'step_quarantined', 'step_skipped', 'step_replayed'].includes(ev.kind)) continue;
    const data = JSON.parse(ev.data) as Record<string, unknown>;
    if (ev.kind === 'step_replayed' && data['status'] !== 'quarantined') continue;
    // Events name their input envelope; an older event without it is tied through its step row.
    const envelopeId = typeof data['envelopeId'] === 'string' ? data['envelopeId'] : kernel.getStep(s(data['stepKey']))?.input_envelope_id;
    if (typeof data['agent'] === 'string' && envelopeId) last.set(`${data['agent']}\u0000${envelopeId}`, { kind: ev.kind, data });
  }
  const out: Problem[] = [];
  for (const q of kernel.queueItems(runId)) {
    if (q.status === 'done' || q.status === 'pending') continue;
    const e = last.get(`${q.agent_id}\u0000${q.envelope_id}`);
    const error = e?.kind === 'step_failed' ? s(e.data['error']) : undefined;
    const kind: Problem['kind'] =
      q.status === 'skipped' ? 'skipped' : q.status === 'quarantined' ? 'quarantined' : error === 'gone' ? 'gone' : error === 'input_rejected' ? 'input_rejected' : 'failed';
    let item: string;
    try {
      item = itemOf(kernel.getEnvelope(q.envelope_id));
    } catch {
      item = `envelope ${q.envelope_id}`;
    }
    const safe = (t: string): string => {
      const line = oneLine(t);
      try {
        assertNoForbidden(line, naming);
        return line;
      } catch (err) {
        if (err instanceof ForbiddenTermError) return '[hidden: contains a forbidden term]';
        throw err;
      }
    };
    out.push({ kind, agent: q.agent_id, item: safe(item), reason: safe(reasonOf(e, kernel)) });
  }
  return out;
}
