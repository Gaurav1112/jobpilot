import { createHash } from 'node:crypto';
import { chmodSync, cpSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppStore } from '../../src/app/store/app-store.js';
import { planCompaction, type RetentionPolicy } from '../../src/app/store/retention.js';
import type { Envelope } from '../../src/kernel/envelope.js';
import { jobRow } from './app-fixtures.js';

/** Retention tests: a small, realistic history (runs, queue, steps with their step_done events, envelopes), fictional data. */
export const root = join(import.meta.dirname, '../..');
export const NOW = '2026-10-14T06:00:00.000Z';
export const homes: string[] = [];

export const sha = (s: string | Buffer): string => createHash('sha256').update(s).digest('hex');

export function env(stepKey: string, index: number, type: string, payload: unknown): Envelope {
  return {
    envelopeId: sha(`${stepKey}:${index}`), stepKey, index, type, payload, parents: [],
    producer: { agentId: 'test', version: '1.0.0', contractHash: 'h' }, handoff: { obligations: [] } as unknown as Envelope['handoff'], guardrails: [], cost: { usd: 0, inputTokens: 0, outputTokens: 0 },
  };
}

/** A tiny but realistic history: per daily run a seed, a source step, a normalizer and a renderer step. */
export function history(home: string): { app: AppStore; ids: Record<string, string> } {
  const app = AppStore.open(join(home, 'jobpilot.db'));
  const k = app.kernel;
  const ids: Record<string, string> = {};
  const step = (runId: string, agent: string, input: Envelope, outputs: { type: string; payload: unknown }[]): Envelope[] => doneStep(app, runId, agent, input, outputs);
  const day = (date: string, jobs: readonly string[], status: 'completed' | 'running' = 'completed'): void => {
    const runId = `daily-${date}`;
    k.startRun(runId, 'jobpilot-daily@1.0.0', 'p', `${date}T01:30:00.000Z`);
    const seed = env(`seed-${runId}`, 0, 'DiscoveryRequest@1', { runDate: date, ats: 'greenhouse' });
    k.putSeed(seed.stepKey, seed, '1.0.0', 'h');
    k.enqueue(runId, 0, 'src-greenhouse', seed.envelopeId);
    k.markQueue(runId, 'src-greenhouse', seed.envelopeId, 'done');
    const raws = step(runId, 'src-greenhouse', seed, jobs.map((j) => ({ type: 'RawPosting@1', payload: { jobKey: j, date, text: 'x'.repeat(500) } })));
    for (const [i, raw] of raws.entries()) {
      const j = jobs[i] as string;
      const [posting] = step(runId, 'normalizer', raw, [{ type: 'Posting@1', payload: { jobKey: j, date } }]) as [Envelope];
      const [rendered] = step(runId, 'renderer', posting, [{ type: 'Rendered@1', payload: { jobKey: j, date, files: [{ path: `${j}/resume.pdf`, sha256: sha(`${j}${date}`) }], plan: { date } } }]) as [Envelope];
      ids[`posting ${j} ${date}`] = posting.envelopeId;
      ids[`rendered ${j} ${date}`] = rendered.envelopeId;
      ids[`raw ${j} ${date}`] = raw.envelopeId;
    }
    ids[`seed ${date}`] = seed.envelopeId;
    if (status === 'completed') {
      k.finishRun(runId, `${date}T02:00:00.000Z`);
      app.recordRun({ runId, at: `${date}T02:00:00.000Z`, counts: {}, packHash: 'x', policyHash: 'p' });
    }
  };
  for (const j of ['1111111111111111', '2222222222222222', '3333333333333333']) app.upsertJob(jobRow({ jobKey: j, sourceId: j, dedupeKey: j, at: '2026-10-01T01:30:00.000Z' }));
  day('2026-10-01', ['1111111111111111', '2222222222222222', '3333333333333333']);
  day('2026-10-02', ['2222222222222222', '3333333333333333']);
  day('2026-10-03', ['3333333333333333']);
  day('2026-10-04', ['3333333333333333']);
  // job 1: its current documents are day 1's (never re-rendered); job 2: last seen on day 2, inside the 14-day window
  app.putDocs('1111111111111111', [{ kind: 'resume', format: 'pdf', path: '1111111111111111/resume.pdf', sha256: sha('11111111111111112026-10-01'), pages: 1, qaOk: true }]);
  app.kernel.db.prepare(`UPDATE jobs SET last_seen = ? WHERE job_key = '2222222222222222'`).run('2026-10-02T01:30:00.000Z');
  app.kernel.db.prepare(`UPDATE jobs SET last_seen = ? WHERE job_key = '1111111111111111'`).run('2026-09-01T01:30:00.000Z');
  return { app, ids };
}

export function newHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'jobpilot-retention-'));
  homes.push(home);
  chmodSync(home, 0o700);
  cpSync(join(root, 'tests/fixtures/pack'), join(home, 'pack'), { recursive: true });
  return home;
}
export const KEEP2: RetentionPolicy = { version: 1, keep: { daily: 2, freelance: 1, coverage: 1, rebuild: 1 } };
export const plan = (app: AppStore, includeIncomplete = false, policy = KEEP2) => planCompaction(app, { now: NOW, policy, policyHash: 'ph', includeIncomplete });
export const tableDump = (app: AppStore): string => app.kernel.dump('envelopes', 'envelope_id') + app.kernel.dump('steps', 'step_key');
export const archived = (p: ReturnType<typeof plan>): Set<string> => new Set(p.envelopeIds);
export const clock = { now: () => NOW };
export const quiet = { out: () => {}, err: () => {} };


/** One done step of `agent` on `input`, as the executor writes it: step row, envelopes and its step_done event, queued in `runId`. */
export function doneStep(app: AppStore, runId: string, agent: string, input: Envelope, outputs: { type: string; payload: unknown }[]): Envelope[] {
  const k = app.kernel;
  const stepKey = sha(`${agent}|${input.envelopeId}`);
  k.markRunning({ stepKey, agentId: agent, version: '1.0.0', contractHash: 'h', inputEnvelopeId: input.envelopeId });
  const envs = outputs.map((o, i) => env(stepKey, i, o.type, o.payload));
  k.finishStep({ runId, stepKey, agentId: agent, status: 'done', envelopes: envs, cost: { usd: 0, inputTokens: 0, outputTokens: 0 }, event: { at: NOW, kind: 'step_done', data: { agent, stepKey }, policyHash: 'p' } });
  k.enqueue(runId, 1, agent, input.envelopeId);
  k.markQueue(runId, agent, input.envelopeId, 'done');
  return envs;
}
