import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

  it('records the largest single call per step and reports the per-agent maximum for a run', () => {
    const s = Store.open(':memory:');
    for (const [k, max] of [['k1', 0.1], ['k2', 0.4], ['k3', 0.2]] as const) {
      s.markRunning({ stepKey: k, agentId: 'a', version: '1.0.0', contractHash: 'h', inputEnvelopeId: 'in' });
      s.finishStep({ runId: 'r', stepKey: k, agentId: 'a', status: 'done', envelopes: [], cost: { usd: max, inputTokens: 0, outputTokens: 0 }, maxCallUsd: max });
    }
    expect(s.maxCallCost('r', 'a')).toBeCloseTo(0.4, 10);
    expect(s.maxCallCost('r', 'other')).toBe(0);
    expect(s.maxCallCost('other-run', 'a')).toBe(0);
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
    expect(s.applyTransition('job-1', 'job', 'k1', 'discovered', jobMachine, 'done')).toBe('DISCOVERED');
    expect(s.applyTransition('job-1', 'job', 'k1', 'discovered', jobMachine, 'done')).toBeUndefined();
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

describe('audit chain anchor', () => {
  const three = (): Store => {
    const s = Store.open(':memory:');
    for (let i = 0; i < 3; i++) s.appendEvent('r', 't', 'k', { i }, 'p');
    return s;
  };

  it('detects a truncated tail', () => {
    const s = three();
    s.db.prepare(`DELETE FROM events WHERE seq = 3`).run();
    expect(verifyChain(s)).toMatchObject({ ok: false, reason: expect.stringMatching(/chain head/) });
  });

  it('detects all events being deleted', () => {
    const s = three();
    s.db.prepare(`DELETE FROM events`).run();
    expect(verifyChain(s)).toMatchObject({ ok: false, brokenAt: 0, reason: expect.stringMatching(/chain head/) });
  });

  it('advances the head with each append and checks an expected head', () => {
    const s = Store.open(':memory:');
    expect(s.chainHead()).toBeUndefined();
    s.appendEvent('r', 't', 'k', { i: 0 }, 'p');
    const h1 = s.chainHead();
    s.appendEvent('r', 't', 'k', { i: 1 }, 'p');
    s.appendEvent('r', 't', 'k', { i: 2 }, 'p');
    const head = s.chainHead();
    expect(h1).toMatchObject({ seq: 1, count: 1 });
    expect(head).toMatchObject({ seq: 3, count: 3 });
    expect(head?.hash).not.toBe(h1?.hash);
    expect(verifyChain(s, { hash: 'bad', count: 3 })).toEqual({ ok: false, headMismatch: true, events: 3, reason: 'chain head differs from the expected head' });
    expect(verifyChain(s, { hash: 'bad', count: 3 })).not.toHaveProperty('brokenAt');
    expect(verifyChain(s, { hash: head?.hash ?? '', count: 3 })).toEqual({ ok: true, events: 3 });
  });
});

describe('migrations', () => {
  it('does not rerun migrations on reopen and refuses a newer schema', () => {
    const dir = mkdtempSync(join(tmpdir(), 'store-'));
    try {
      const path = join(dir, 'a.db');
      const a = Store.open(path);
      a.close();
      const b = Store.open(path);
      expect(b.db.pragma('user_version', { simple: true })).toBe(1);
      b.db.pragma('user_version = 99');
      b.close();
      expect(() => Store.open(path)).toThrow(/newer than this jobpilot/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('step finishing', () => {
  const st = { stepKey: 'k', agentId: 'a', version: '1.0.0', contractHash: 'h', inputEnvelopeId: 'in' };
  const cost = { usd: 0.01, inputTokens: 3, outputTokens: 4 };
  const fin = (s: Store, envelopes: Envelope[]): void =>
    s.finishStep({ runId: 'r', stepKey: 'k', agentId: 'a', status: 'done', envelopes, cost });
  const count = (s: Store, t: string): number => (s.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;

  it('refuses to finish a step that is not running and writes nothing', () => {
    const s = Store.open(':memory:');
    expect(() => fin(s, [env('k', 0)])).toThrow(/not running/);
    expect(count(s, 'envelopes')).toBe(0);
    expect(count(s, 'cost_ledger')).toBe(0);
  });

  it('refuses a second finish of a done step and leaves cost unchanged', () => {
    const s = Store.open(':memory:');
    s.markRunning(st);
    fin(s, [env('k', 0)]);
    expect(() => fin(s, [env('k', 0)])).toThrow(/not running/);
    expect(s.runCost('r')).toBeCloseTo(0.01);
    expect(count(s, 'cost_ledger')).toBe(1);
  });

  it('rolls back when two envelopes share an id', () => {
    const s = Store.open(':memory:');
    s.markRunning(st);
    expect(() => fin(s, [env('k', 0), env('k', 0)])).toThrow();
    expect(count(s, 'envelopes')).toBe(0);
    expect(s.getStep('k')?.status).toBe('running');
  });

  it('refreshes the contract hash when a step is marked running again', () => {
    const s = Store.open(':memory:');
    s.markRunning(st);
    s.markRunning({ ...st, contractHash: 'h2' });
    expect(s.getStep('k')?.contract_hash).toBe('h2');
  });

  it('refuses a dump with an unsafe table or order', () => {
    const s = Store.open(':memory:');
    expect(() => s.dump('steps', 'step_key; DROP TABLE steps')).toThrow(/refused/);
    expect(() => s.dump('events' as 'steps', 'step_key')).toThrow(/refused/);
  });
});

describe('finishStep with its event', () => {
  const st = { stepKey: 'k', agentId: 'a', version: '1.0.0', contractHash: 'h', inputEnvelopeId: 'in' };
  const ev = { at: '2026-10-08T00:00:00Z', kind: 'step_done', data: { stepKey: 'k' }, policyHash: 'p' };
  const fin = (s: Store): void =>
    s.finishStep({ runId: 'r', stepKey: 'k', agentId: 'a', status: 'done', envelopes: [], cost: ZERO_COST, event: ev });

  it('appends exactly one event in the same transaction', () => {
    const s = Store.open(':memory:');
    s.markRunning(st);
    fin(s);
    const events = s.events('r');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'step_done', at: ev.at, policy_hash: 'p', data: '{"stepKey":"k"}' });
    expect(s.chainHead()).toMatchObject({ count: 1 });
    expect(verifyChain(s)).toEqual({ ok: true, events: 1 });
  });

  it('appends no event when the step is not running', () => {
    const s = Store.open(':memory:');
    expect(() => fin(s)).toThrow(/not running/);
    expect(s.events()).toHaveLength(0);
    expect(s.chainHead()).toBeUndefined();
  });
});
