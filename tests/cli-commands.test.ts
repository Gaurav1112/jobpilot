import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fakeLlm } from '../src/kernel/fakes.js';
import { demoKernel } from '../src/demo/kernel.js';
import { Store } from '../src/kernel/store/store.js';

const root = join(import.meta.dirname, '..');
const cli = (...args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', join(root, 'src/bin.ts'), ...args], { cwd: root, encoding: 'utf8' });

let dir: string;
let db: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'jobpilot-cli-'));
  db = join(dir, 'j.db');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('jobpilot quarantined / release', () => {
  it('lists quarantined steps and releases one by step key', async () => {
    const k = demoKernel({ dbPath: db, llm: fakeLlm(() => JSON.stringify({ score: 99, reason: 'too keen' })) });
    await k.supervisor.start('run-1', [{ count: 2, prefix: 'demo' }]);
    const keys = k.store.quarantinedSteps().map((s) => s.step_key);
    k.store.close();
    expect(keys).toHaveLength(2);

    const listed = cli('quarantined', '--db', db);
    expect(listed.status).toBe(0);
    for (const key of keys) expect(listed.stdout).toContain(key);
    expect(listed.stdout).toContain('demo-scorer');
    expect(listed.stdout).toContain('G-POST');

    const released = cli('release', keys[0]!, '--db', db);
    expect(released.status).toBe(0);
    expect(released.stdout).toContain(keys[0]);
    const again = cli('release', keys[0]!, '--db', db);
    expect(again.status).toBe(1);

    const store = Store.open(db);
    expect(store.quarantinedSteps().map((s) => s.step_key)).toEqual([keys[1]]);
    const ev = store.events().find((e) => e.kind === 'quarantine_released');
    expect(ev?.run_id).toMatch(/^release-\d{4}-\d{2}-\d{2}$/);
    store.close();
  });

  it('says so when nothing is quarantined', () => {
    execFileSync(process.execPath, ['--import', 'tsx', join(root, 'src/bin.ts'), 'demo', '--db', db, '--run', 'r1', '--count', '1'], { cwd: root });
    const listed = cli('quarantined', '--db', db);
    expect(listed.status).toBe(0);
    expect(listed.stdout).toContain('no quarantined steps');
  });
});
