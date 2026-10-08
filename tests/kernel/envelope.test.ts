import { describe, expect, it } from 'vitest';
import { makeEnvelopeId, nextObligations, openObligations } from '../../src/kernel/envelope.js';

describe('obligations', () => {
  const contract = (id: string, adds: { id: string; dischargedBy: string }[], discharges: string[]) => ({
    id,
    obligations: { adds, discharges },
  });

  it('adds new obligations and keeps them sorted', () => {
    const out = nextObligations([], contract('a', [{ id: 'z.one', dischargedBy: 'x' }, { id: 'a.two', dischargedBy: 'y' }], []));
    expect(out.map((o) => o.id)).toEqual(['a.two', 'z.one']);
    expect(out.every((o) => !o.discharged)).toBe(true);
  });

  it('discharges only when this agent is the named discharger', () => {
    const open = [{ id: 'needs-human-approval', dischargedBy: 'approval-desk', discharged: false }];
    expect(nextObligations(open, contract('someone-else', [], ['needs-human-approval']))[0]?.discharged).toBe(false);
    expect(nextObligations(open, contract('approval-desk', [], ['needs-human-approval']))[0]?.discharged).toBe(true);
  });

  it('lists what is still open', () => {
    expect(
      openObligations({
        handoff: {
          guarantees: [],
          dataClass: 'P0',
          pins: { policyHash: 'h' },
          obligations: [
            { id: 'a', dischargedBy: 'x', discharged: true },
            { id: 'b', dischargedBy: 'y', discharged: false },
          ],
        },
      }),
    ).toEqual(['b']);
  });

  it('derives envelope ids from the step key and index only', () => {
    expect(makeEnvelopeId('k', 0)).toBe(makeEnvelopeId('k', 0));
    expect(makeEnvelopeId('k', 0)).not.toBe(makeEnvelopeId('k', 1));
  });
});
