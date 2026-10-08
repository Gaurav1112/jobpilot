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

  it('allows one QA retry loop back to TAILORED', () => {
    expect(jobMachine.next('RENDERED', 'qa_failed')).toBe('TAILORED');
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
});
