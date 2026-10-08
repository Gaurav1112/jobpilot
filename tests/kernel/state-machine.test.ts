import { describe, expect, it } from 'vitest';
import { Breakers } from '../../src/kernel/breaker.js';
import { InvalidTransition } from '../../src/kernel/errors.js';
import { jobMachine } from '../../src/kernel/machines/job.js';
import { StateMachine } from '../../src/kernel/state-machine.js';

describe('job state machine', () => {
  it('walks the happy path to TRACKING', () => {
    const events = ['discovered', 'normalized', 'deduped', 'prefiltered', 'scored', 'ranked', 'shortlisted', 'tailored', 'rendered', 'qa_passed', 'awaiting_approval', 'approved', 'submitting', 'submitted', 'tracking'] as const;
    let s = jobMachine.def.initial;
    for (const e of events) s = jobMachine.next(s, e);
    expect(s).toBe('TRACKING');
    expect(jobMachine.isTerminal(s)).toBe(true);
  });

  it('QA retry: RENDERED -qa_failed-> TAILORED_RETRY -rendered-> RENDERED_RETRY -qa_passed-> QA_PASSED', () => {
    let s: typeof jobMachine.def.initial = 'RENDERED';
    s = jobMachine.next(s, 'qa_failed');
    expect(s).toBe('TAILORED_RETRY');
    s = jobMachine.next(s, 'rendered');
    expect(s).toBe('RENDERED_RETRY');
    s = jobMachine.next(s, 'qa_passed');
    expect(s).toBe('QA_PASSED');
  });

  it('QA retry: RENDERED -qa_failed-> TAILORED_RETRY -rendered-> RENDERED_RETRY -qa_failed-> QUARANTINED', () => {
    let s: typeof jobMachine.def.initial = 'RENDERED';
    s = jobMachine.next(s, 'qa_failed');
    expect(s).toBe('TAILORED_RETRY');
    s = jobMachine.next(s, 'rendered');
    expect(s).toBe('RENDERED_RETRY');
    s = jobMachine.next(s, 'qa_failed');
    expect(s).toBe('QUARANTINED');
  });

  it('QA retry is bounded: TAILORED_RETRY -qa_failed throws', () => {
    expect(() => jobMachine.next('TAILORED_RETRY', 'qa_failed')).toThrow(InvalidTransition);
  });

  it('NEEDS_HUMAN exits to SUBMITTED or DECLINED', () => {
    expect(jobMachine.next('NEEDS_HUMAN', 'submitted')).toBe('SUBMITTED');
    expect(jobMachine.next('NEEDS_HUMAN', 'declined')).toBe('DECLINED');
  });

  it('quarantines from any non-terminal state on a trip', () => {
    expect(jobMachine.next('SCORED', 'trip')).toBe('QUARANTINED');
  });

  it('throws on a transition not in the table, including from terminal states', () => {
    expect(() => jobMachine.next('NEW', 'approved')).toThrow(InvalidTransition);
    expect(() => jobMachine.next('TRACKING', 'trip')).toThrow(InvalidTransition);
  });

  it('rejects malformed tables', () => {
    expect(() => new StateMachine({ id: 'x', initial: 'A', terminal: ['B'], transitions: [{ from: 'B', on: 'go', to: 'A' }] })).toThrow(/terminal/);
    expect(() => new StateMachine({ id: 'x', initial: 'A', terminal: [], transitions: [{ from: 'A', on: 'go', to: 'A' }, { from: 'A', on: 'go', to: 'A' }] })).toThrow(/duplicate/);
  });
});

describe('breakers', () => {
  it('opens after the threshold of consecutive failures and resets on success', () => {
    const b = new Breakers();
    expect(b.failure('agent:x', 3)).toBe(false);
    b.success('agent:x');
    expect(b.failure('agent:x', 3)).toBe(false);
    expect(b.failure('agent:x', 3)).toBe(false);
    expect(b.failure('agent:x', 3)).toBe(true);
    expect(b.isOpen('agent:x')).toBe(true);
    expect(b.failure('agent:x', 3)).toBe(false);
  });

  it('once open, success does not close the breaker (isOpen stays true)', () => {
    const b = new Breakers();
    b.failure('agent:x', 1);
    expect(b.isOpen('agent:x')).toBe(true);
    b.success('agent:x');
    expect(b.isOpen('agent:x')).toBe(true);
  });
});
