import { StateMachine } from '../state-machine.js';

export type JobState =
  | 'NEW' | 'DISCOVERED' | 'NORMALIZED' | 'DEDUPED' | 'PREFILTER_REJECTED' | 'PREFILTERED' | 'SCORED' | 'RANKED' | 'PARKED'
  | 'SHORTLISTED' | 'TAILORED' | 'RENDERED' | 'QA_PASSED' | 'AWAITING_APPROVAL' | 'APPROVED' | 'DECLINED' | 'EXPIRED'
  | 'SUBMITTING' | 'SUBMITTED' | 'NEEDS_HUMAN' | 'SUBMIT_FAILED' | 'TRACKING' | 'QUARANTINED';

export type JobEvent =
  | 'discovered' | 'normalized' | 'deduped' | 'prefilter_rejected' | 'prefiltered' | 'scored' | 'ranked' | 'parked'
  | 'shortlisted' | 'tailored' | 'rendered' | 'qa_passed' | 'qa_failed' | 'awaiting_approval' | 'approved' | 'declined'
  | 'expired' | 'submitting' | 'submitted' | 'needs_human' | 'submit_failed' | 'tracking' | 'trip';

/** Spec §6.3. A transition not in this table throws. */
export const jobMachine = new StateMachine<JobState, JobEvent>({
  id: 'job',
  initial: 'NEW',
  terminal: ['PREFILTER_REJECTED', 'PARKED', 'DECLINED', 'EXPIRED', 'SUBMIT_FAILED', 'TRACKING', 'QUARANTINED'],
  transitions: [
    { from: 'NEW', on: 'discovered', to: 'DISCOVERED' },
    { from: 'DISCOVERED', on: 'normalized', to: 'NORMALIZED' },
    { from: 'NORMALIZED', on: 'deduped', to: 'DEDUPED' },
    { from: 'DEDUPED', on: 'prefilter_rejected', to: 'PREFILTER_REJECTED' },
    { from: 'DEDUPED', on: 'prefiltered', to: 'PREFILTERED' },
    { from: 'PREFILTERED', on: 'scored', to: 'SCORED' },
    { from: 'SCORED', on: 'ranked', to: 'RANKED' },
    { from: 'RANKED', on: 'parked', to: 'PARKED' },
    { from: 'RANKED', on: 'shortlisted', to: 'SHORTLISTED' },
    { from: 'SHORTLISTED', on: 'tailored', to: 'TAILORED' },
    { from: 'TAILORED', on: 'rendered', to: 'RENDERED' },
    { from: 'RENDERED', on: 'qa_passed', to: 'QA_PASSED' },
    { from: 'RENDERED', on: 'qa_failed', to: 'TAILORED' },
    { from: 'QA_PASSED', on: 'awaiting_approval', to: 'AWAITING_APPROVAL' },
    { from: 'AWAITING_APPROVAL', on: 'approved', to: 'APPROVED' },
    { from: 'AWAITING_APPROVAL', on: 'declined', to: 'DECLINED' },
    { from: 'AWAITING_APPROVAL', on: 'expired', to: 'EXPIRED' },
    { from: 'APPROVED', on: 'submitting', to: 'SUBMITTING' },
    { from: 'SUBMITTING', on: 'submitted', to: 'SUBMITTED' },
    { from: 'SUBMITTING', on: 'needs_human', to: 'NEEDS_HUMAN' },
    { from: 'SUBMITTING', on: 'submit_failed', to: 'SUBMIT_FAILED' },
    { from: 'SUBMITTED', on: 'tracking', to: 'TRACKING' },
    { from: '*', on: 'trip', to: 'QUARANTINED' },
  ],
});
