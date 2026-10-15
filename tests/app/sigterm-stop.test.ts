import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SIGTERM_STOP } from '../../src/app/stop.js';

const root = join(import.meta.dirname, '../..');

describe('sigtermStop', () => {
  it('turns SIGTERM into a stop reason instead of the default kill', async () => {
    const child = spawn(process.execPath, ['--import', 'tsx', join(root, 'tests/fixtures/hosted/sigterm-child.ts')], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let sent = false;
    child.stdout.on('data', (d: Buffer) => {
      out += d.toString('utf8');
      if (!sent && out.includes('ready')) {
        sent = true;
        child.kill('SIGTERM');
      }
    });
    const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve) => child.on('exit', (c, s) => resolve([c, s])));
    expect(signal).toBeNull();
    expect(code).toBe(0);
    expect(out.split('\n').map((l) => l.trim())).toContain('stopped: deadline (SIGTERM)');
    expect(SIGTERM_STOP).toBe('stopped: deadline (SIGTERM)');
  }, 30_000);
});
