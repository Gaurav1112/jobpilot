import { describe, expect, it } from 'vitest';
import { ZERO_COST, type Envelope } from '../../src/kernel/envelope.js';
import { jobMachine } from '../../src/kernel/machines/job.js';
import { verifyChain } from '../../src/kernel/store/audit.js';
import { Store } from '../../src/kernel/store/store.js';

const env = (stepKey: string, index: number): Envelope => ({
  envelopeId: `${stepKey}-${index}`, stepKey, index, type: 'T@1',
  producer: { agentId: 'a', version: '1.0.0', contractHash: 'h' }, parents: [], payload: { i: index },
  handoff: { guarantees: [], dataClass: 'P0', obligations: [], pins: { policyHash: 'p' } }, guardrails: [], cost: ZERO_COST,
});

describe('Store', () => {
  it('migrates a fresh database and records the schema version', () => {
    const s = Store.open(':memory:');
    expect(s.db.pragma('user_version', { simple: true })).toBe(1);
  });

  it('finishes a step atomically with its envelopes and cost', () => {
    const s = Store.open(':memory:');
    s.markRunning({ stepKey: 'k', agentId: 'a', version: '1.0.0', contractHash: 'h', inputEnvelopeId: 'in' });
    s.finishStep({ runId: 'r', stepKey: 'k', agentId: 'a', status: 'done', envelopes: [env('k', 1), env('k', 0)], cost: { usd: 0.01, inputTokens: 3, outputTokens: 4 } });
    expect(s.getStep('k')?.status).toBe('done');
    expect(s.envelopesOfStep('k').map((e) => e.index)).toEqual([0, 1]);
    expect(s.runCost('r')).toBeCloseTo(0.01);
    expect(s.runCost('r', 'other')).toBe(0);
  });

  it('counts attempts across re-runs of the same step', () => {
    const s = Store.open(':memory:');
    const st = { stepKey: 'k', agentId: 'a', version: '1.0.0', contractHash: 'h', inputEnvelopeId: 'in' };
    s.markRunning(st);
    s.markRunning(st);
    expect(s.getStep('k')?.attempts).toBe(2);
  });

  it('drains the queue in stage, agent, envelope order and ignores duplicate enqueues', () => {
    const s = Store.open(':memory:');
    s.enqueue('r', 2, 'b', 'e1');
    s.enqueue('r', 1, 'z', 'e9');
    s.enqueue('r', 1, 'a', 'e5');
    s.enqueue('r', 1, 'a', 'e5');
    expect(s.nextQueued('r')).toMatchObject({ agent_id: 'a', envelope_id: 'e5' });
    s.markQueue('r', 'a', 'e5', 'done');
    expect(s.nextQueued('r')).toMatchObject({ agent_id: 'z' });
    expect(s.queueCounts('r')).toMatchObject({ pending: 2, done: 1 });
  });

  it('applies a transition once per (entity, step, event), however often it is replayed', () => {
    const s = Store.open(':memory:');
    expect(s.applyTransition('job-1', 'job', 'k1', 'discovered', jobMachine)).toBe('DISCOVERED');
    expect(s.applyTransition('job-1', 'job', 'k1', 'discovered', jobMachine)).toBeUndefined();
    expect(s.entityState('job-1')).toBe('DISCOVERED');
  });
});

describe('audit chain', () => {
  it('verifies an untouched chain and catches an edited event', () => {
    const s = Store.open(':memory:');
    s.appendEvent('r', '2026-10-08T00:00:00Z', 'run_started', { n: 1 }, 'p');
    s.appendEvent('r', '2026-10-08T00:00:01Z', 'step_done', { n: 2 }, 'p');
    s.appendEvent('r', '2026-10-08T00:00:02Z', 'run_finished', { n: 3 }, 'p');
    expect(verifyChain(s)).toEqual({ ok: true, events: 3 });
    s.db.prepare(`UPDATE events SET data = '{"n":99}' WHERE seq = 2`).run();
    expect(verifyChain(s)).toMatchObject({ ok: false, brokenAt: 2 });
  });

  it('catches a deleted event', () => {
    const s = Store.open(':memory:');
    for (let i = 0; i < 3; i++) s.appendEvent('r', 't', 'k', { i }, 'p');
    s.db.prepare(`DELETE FROM events WHERE seq = 2`).run();
    expect(verifyChain(s)).toMatchObject({ ok: false, brokenAt: 3 });
  });
});
