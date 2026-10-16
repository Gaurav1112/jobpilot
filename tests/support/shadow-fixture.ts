import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalJson } from '../../src/kernel/canonical.js';
import type { Digest } from '../../src/app/hosted/digest.js';
import type { LedgerEntry } from '../../src/app/hosted/budget.js';
import type { VerifyRecord } from '../../src/app/hosted/generations.js';

/** A fictional key padded to 16 characters. */
export const key = (s: string): string => s.padStart(16, '0');
export const DAYS = ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08'] as const;
const CODE_SHA = 'a'.repeat(40);
const PACK_HASH = 'b'.repeat(64);

export interface ShadowFixture {
  /** date to digest, per side. */
  mac: Map<string, { daily?: Digest | undefined; freelance?: Digest | undefined }>;
  hosted: Map<string, { daily?: Digest | undefined; freelance?: Digest | undefined }>;
  ledger: LedgerEntry[];
  verify: VerifyRecord[];
}

const keys = (...xs: string[]): string[] => xs.map(key).sort();

function digest(date: string, env: 'hosted' | 'local', pipeline: 'daily' | 'freelance', rest: Partial<Digest>): Digest {
  return {
    v: 1,
    date,
    env,
    pipeline,
    runId: pipeline === 'daily' ? `daily-${date}` : `freelance-${date}-am`,
    startedAt: `${date}T01:00:00.000Z`,
    codeSha: CODE_SHA,
    packHash: PACK_HASH,
    sources: {},
    eligible: [],
    toDecide: [],
    gigs: {},
    ...rest,
  };
}

/** The BASE fixture: seven comparable days (see the plan's Task 17). */
export function baseFixture(): ShadowFixture {
  const fx: ShadowFixture = { mac: new Map(), hosted: new Map(), ledger: [], verify: [] };
  const billed = [44, 45, 46, 47, 48, 50, 52];
  DAYS.forEach((date, i) => {
    const last = i === DAYS.length - 1;
    const g = keys('g1', 'g2', 'g3', 'g4', 'g5', 'g6', 'g7', 'g8', 'g9', 'g10');
    const gigs = { remotive: keys('r1', 'r2'), hn: keys('n1', 'n2') };
    fx.mac.set(date, {
      daily: digest(date, 'local', 'daily', {
        sources: {
          greenhouse: { postings: g, problems: [] },
          himalayas: { postings: keys('h1', 'h2', 'h3', 'h4', 'h5', 'h6'), problems: [] },
          lever: { postings: keys('l1', 'l2'), problems: [] },
        },
        eligible: keys('g1', 'g2', 'g3', 'g4', 'h1'),
        toDecide: keys('g1', 'g2', 'g3', 'g4', 'h1'),
      }),
      freelance: digest(date, 'local', 'freelance', { gigs }),
    });
    fx.hosted.set(date, {
      daily: digest(date, 'hosted', 'daily', {
        sources: {
          greenhouse: { postings: g, problems: [] },
          himalayas: { postings: last ? keys('h2', 'h3', 'h4', 'h7') : keys('h1', 'h2', 'h3', 'h4'), problems: ['challenged'] },
          lever: { postings: [], problems: [] },
        },
        eligible: last ? keys('g1', 'g2', 'g3', 'g4') : keys('g1', 'g2', 'g3', 'g4', 'h1'),
        toDecide: last ? keys('g1', 'g2', 'g3', 'g4') : keys('g1', 'g2', 'g3', 'g4', 'h1'),
        billedMinutes: billed[i] as number,
      }),
      freelance: digest(date, 'hosted', 'freelance', { gigs }),
    });
    const hour = i === 2 ? '04:50' : '03:00'; // 10:20 IST on day 3, else 08:30 IST
    fx.ledger.push({
      runId: String(1000 + i),
      workflow: 'daily',
      startedAt: `${date}T01:30:00.000Z`,
      billedMinutes: billed[i] as number,
      outcome: 'committed',
      date,
      gen: i + 2,
      committedAt: `${date}T${hour}:00.000Z`,
      pipelines: { daily: 0, freelance: 0 },
      audit: { runId: String(1000 + i), hits: 0, nonTemplateLines: 0 },
    });
    fx.verify.push({ v: 1, gen: i + 2, ok: true, checks: { sha256: true, decrypt: true, quickCheck: true, audit: true }, code: null });
  });
  return fx;
}

/** Writes `mac/`, `hosted/`, `ledger/`, `verify/` under `dir` for the BASE fixture, after `mutate` edits the in-memory objects. */
export function buildShadowFixture(dir: string, mutate?: (fx: ShadowFixture) => void): ShadowFixture {
  const fx = baseFixture();
  mutate?.(fx);
  for (const sub of ['mac', 'hosted', 'ledger', 'verify']) mkdirSync(join(dir, sub), { recursive: true });
  for (const [side, map] of [['mac', fx.mac], ['hosted', fx.hosted]] as const) {
    for (const [date, d] of map) {
      for (const p of ['daily', 'freelance'] as const) {
        const dg = d[p];
        if (dg !== undefined) writeFileSync(join(dir, side, `${date}-${p}.json`), `${canonicalJson(dg)}\n`);
      }
    }
  }
  const byMonth = new Map<string, LedgerEntry[]>();
  for (const e of fx.ledger) byMonth.set(e.startedAt.slice(0, 7), [...(byMonth.get(e.startedAt.slice(0, 7)) ?? []), e]);
  for (const [m, es] of byMonth) writeFileSync(join(dir, 'ledger', `${m}.jsonl`), es.map((e) => `${JSON.stringify(e)}\n`).join(''));
  for (const v of fx.verify) writeFileSync(join(dir, 'verify', `verify-g${String(v.gen).padStart(6, '0')}.json`), `${canonicalJson(v)}\n`);
  return fx;
}
