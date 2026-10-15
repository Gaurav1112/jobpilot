import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { machinePacer, pacerFile } from '../../src/app/pacer.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'jobpilot-pacer-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A fake clock that sleeping advances: deterministic. */
function fakeTime(start = Date.parse('2026-10-15T00:00:00.000Z')) {
  let t = start;
  const waits: number[] = [];
  return { clock: { now: () => new Date(t).toISOString() }, sleep: async (ms: number) => { waits.push(ms); t += ms; }, waits, at: () => t - start };
}

describe('machinePacer', () => {
  it('two pacers on one file (two processes, two profiles) space one host by the interval', async () => {
    const time = fakeTime();
    const file = join(dir, 'pacer.db');
    const a = machinePacer(file, 2000, 'http', time.clock, time.sleep);
    const b = machinePacer(file, 2000, 'http', time.clock, time.sleep);
    await a.wait('Boards.Greenhouse.io');
    await b.wait('boards.greenhouse.io');
    await a.wait('boards.greenhouse.io');
    expect(time.waits).toEqual([2000, 2000]);
    await b.wait('api.lever.co'); // another host: no wait
    expect(time.waits).toEqual([2000, 2000]);
    a.close();
    b.close();
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });
  it('a wider per-request interval widens, never narrows; http and browser slots are separate', async () => {
    const time = fakeTime();
    const file = join(dir, 'pacer.db');
    const h = machinePacer(file, 2000, 'http', time.clock, time.sleep);
    const br = machinePacer(file, 5000, 'browser', time.clock, time.sleep);
    await h.wait('x.example.com');
    await h.wait('x.example.com', 5000);
    await h.wait('x.example.com', 100);
    await br.wait('x.example.com');
    expect(time.waits).toEqual([5000, 2000]);
  });
  it('real processes on one file never come closer than the interval', async () => {
    const file = join(dir, 'pacer.db');
    const child = (): Promise<number[]> => new Promise((resolve, reject) => {
      const code = `import { machinePacer } from ${JSON.stringify(join(import.meta.dirname, '../../src/app/pacer.ts'))};
const p = machinePacer(${JSON.stringify(file)}, 300, 'http', { now: () => new Date().toISOString() }, (ms) => new Promise((r) => setTimeout(r, ms)));
const at = []; for (let i = 0; i < 3; i++) { await p.wait('h.example.com'); at.push(Date.now()); }
console.log(JSON.stringify(at));`;
      const c = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'inherit'] });
      let out = '';
      c.stdout.on('data', (d: Buffer) => (out += d.toString()));
      c.on('close', (s) => (s === 0 ? resolve(JSON.parse(out) as number[]) : reject(new Error(`exit ${s}`))));
    });
    const [x, y] = await Promise.all([child(), child()]);
    const all = [...(x as number[]), ...(y as number[])].sort((a, b) => a - b);
    for (let i = 1; i < all.length; i++) expect((all[i] as number) - (all[i - 1] as number)).toBeGreaterThanOrEqual(290);
  }, 30_000);
  it('the file: JOBPILOT_PACER_FILE, else the root, else an explicit home', () => {
    expect(pacerFile({ JOBPILOT_PACER_FILE: '/p/x.db', HOME: '/Users/x' })).toBe('/p/x.db');
    expect(pacerFile({ JOBPILOT_ROOT: dir, HOME: '/Users/x' })).toBe(join(dir, 'pacer.db'));
    expect(pacerFile({ JOBPILOT_HOME: join(dir, 'h'), HOME: '/Users/x' })).toBe(join(dir, 'h', 'pacer.db'));
  });
});
