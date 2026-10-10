import type { Envelope } from '../kernel/envelope.js';
import { StateMachine } from '../kernel/state-machine.js';
import type { Tracker } from '../kernel/supervisor.js';

export type AppJobState =
  | 'DISCOVERED' | 'NORMALIZED' | 'REJECTED' | 'SCORED' | 'BELOW_FLOOR' | 'PLANNED' | 'RENDERED' | 'READY' | 'BLOCKED';
export type AppJobEvent = 'normalized' | 'rejected' | 'scored' | 'below_floor' | 'planned' | 'rendered' | 'qa_passed' | 'qa_failed' | 'blocked';

export const JOB_TRACKER_KIND = 'app-job';

/**
 * One job's way through the daily pipeline. A job enters at DISCOVERED (its RawPosting carries no job key yet) and
 * moves on its Posting. Rejection and a score under minFit are successful ends: the job was assessed. Any quarantine
 * of a step holding the job blocks it.
 */
export const appJobMachine = new StateMachine<AppJobState, AppJobEvent>({
  id: 'app-job',
  initial: 'DISCOVERED',
  terminal: ['REJECTED', 'BELOW_FLOOR', 'READY', 'BLOCKED'],
  success: ['REJECTED', 'BELOW_FLOOR', 'READY'],
  transitions: [
    { from: 'DISCOVERED', on: 'normalized', to: 'NORMALIZED' },
    { from: 'NORMALIZED', on: 'rejected', to: 'REJECTED' },
    { from: 'NORMALIZED', on: 'scored', to: 'SCORED' },
    { from: 'NORMALIZED', on: 'below_floor', to: 'BELOW_FLOOR' },
    { from: 'SCORED', on: 'planned', to: 'PLANNED' },
    { from: 'PLANNED', on: 'rendered', to: 'RENDERED' },
    { from: 'RENDERED', on: 'qa_passed', to: 'READY' },
    { from: 'RENDERED', on: 'qa_failed', to: 'BLOCKED' },
    { from: '*', on: 'blocked', to: 'BLOCKED' },
  ],
});

const JOB_KEY = /^[0-9a-f]{16}$/;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const keyIn = (v: unknown): string | null => (isObj(v) && typeof v['jobKey'] === 'string' && JOB_KEY.test(v['jobKey']) ? v['jobKey'] : null);

/**
 * The job key of any app envelope that carries a posting (or names its job), else null. Never throws: unknown types,
 * RawPosting, CareerLink, seeds and malformed payloads are simply not followed.
 */
export function jobKeyOf(env: Pick<Envelope, 'type' | 'payload'>): string | null {
  const p = env.payload;
  switch (env.type) {
    case 'Posting@1':
      return keyIn(p);
    case 'EligibilityVerdict@1':
    case 'Scored@1':
      return isObj(p) ? keyIn(p['posting']) : null;
    case 'Evidence@1':
      return isObj(p) && isObj(p['scored']) ? keyIn(p['scored']['posting']) : null;
    case 'ResumePlan@1':
    case 'CoverPlan@1':
    case 'Rendered@1':
    case 'QaReport@1':
      return keyIn(p);
    default:
      return null;
  }
}

/** The job tracker. `minFit` (the pack's targets.minFit) splits a Scored output into SCORED and BELOW_FLOOR. */
export function makeJobTracker(opts: { readonly minFit: number }): Tracker {
  return {
    kind: JOB_TRACKER_KIND,
    machine: appJobMachine,
    keyOf: jobKeyOf,
    eventFor(_agentId, outcome, env): AppJobEvent | null {
      if (outcome === 'quarantined') return 'blocked';
      const p = env.payload as Record<string, unknown>;
      switch (env.type) {
        case 'Posting@1':
          return 'normalized';
        case 'EligibilityVerdict@1':
          return p['verdict'] === 'rejected' ? 'rejected' : null;
        case 'Scored@1':
          return typeof p['score'] === 'number' && p['score'] >= opts.minFit ? 'scored' : 'below_floor';
        case 'ResumePlan@1':
          return 'planned';
        case 'Rendered@1':
          return 'rendered';
        case 'QaReport@1':
          return p['ok'] === true ? 'qa_passed' : 'qa_failed';
        default:
          return null;
      }
    },
  };
}
