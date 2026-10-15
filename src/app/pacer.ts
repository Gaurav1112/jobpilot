import { closeSync, existsSync, openSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { HostPacer } from '../kernel/broker.js';
import type { Clock } from '../kernel/clock.js';
import { normalizeHost } from '../kernel/policy.js';
import { resolveHome } from './profiles/root.js';

/**
 * The machine-wide politeness pacer (profiles spec §3, §8): every jobpilot process on this Mac, of every profile,
 * spaces its requests to one host through one SQLite file, so more profiles never means more pressure on a host. The
 * rule is createHostPacer's (slot = max(now, last + gap), claimed before sleeping), made atomic across processes by a
 * BEGIN IMMEDIATE transaction. Times are UTC epoch milliseconds from the injected clock.
 */
export type PacerFactory = (minIntervalMs: number, kind: 'http' | 'browser') => HostPacer;

export function pacerFile(env: NodeJS.ProcessEnv = process.env, profile?: string): string {
  const f = env['JOBPILOT_PACER_FILE'];
  if (f !== undefined && f !== '') return f;
  const h = resolveHome({ profile, env });
  return join(h.mode === 'explicit' ? h.home : h.root, 'pacer.db');
}

const DAY_MS = 86_400_000;

export function machinePacer(file: string, minIntervalMs: number, kind: 'http' | 'browser', clock: Clock, sleep: (ms: number) => Promise<void>): HostPacer & { close(): void } {
  if (!existsSync(file)) closeSync(openSync(file, 'a', 0o600));
  const db = new Database(file, { timeout: 10_000 });
  db.pragma('journal_mode = WAL');
  db.exec('CREATE TABLE IF NOT EXISTS host_slots (key TEXT PRIMARY KEY, slot_ms INTEGER NOT NULL)');
  db.prepare('DELETE FROM host_slots WHERE slot_ms < ?').run(Date.parse(clock.now()) - DAY_MS);
  const get = db.prepare('SELECT slot_ms FROM host_slots WHERE key = ?');
  const put = db.prepare('INSERT INTO host_slots (key, slot_ms) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET slot_ms = excluded.slot_ms');
  const claim = db.transaction((key: string, now: number, gap: number): number => {
    const last = (get.get(key) as { slot_ms: number } | undefined)?.slot_ms;
    const slot = last === undefined ? now : Math.max(now, last + gap);
    put.run(key, slot);
    return slot;
  });
  return {
    async wait(host, wider) {
      const now = Date.parse(clock.now());
      const gap = wider !== undefined && Number.isFinite(wider) && wider > minIntervalMs ? wider : minIntervalMs;
      const slot = claim.immediate(`${kind}:${normalizeHost(host)}`, now, gap);
      if (slot > now) await sleep(slot - now);
    },
    close: () => db.close(),
  };
}

export function machinePacerFactory(file: string, clock: Clock, sleep: (ms: number) => Promise<void>): PacerFactory {
  return (ms, kind) => machinePacer(file, ms, kind, clock, sleep);
}
