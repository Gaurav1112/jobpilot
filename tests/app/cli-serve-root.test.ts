import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const repo = join(import.meta.dirname, '../..');

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });

describe('jobpilot serve on a profiles root with no active profile', () => {
  it('starts and answers 200 "No profiles yet" instead of exiting 2', async () => {
    const root = mkdtempSync(join(tmpdir(), 'jobpilot-serve-root-'));
    mkdirSync(join(root, 'profiles'));
    const port = await freePort();
    const env: NodeJS.ProcessEnv = { ...process.env, JOBPILOT_ROOT: root, VITEST: 'true' };
    delete env['JOBPILOT_HOME'];
    delete env['JOBPILOT_PROFILE'];
    const child = spawn(process.execPath, ['--import', 'tsx', join(repo, 'src/bin.ts'), 'serve', '--port', String(port)], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    const exited = new Promise<number | null>((resolve) => child.once('exit', (c) => resolve(c)));
    try {
      let res: Response | undefined;
      for (let i = 0; i < 100 && res === undefined; i++) {
        try {
          res = await fetch(`http://127.0.0.1:${port}/`);
        } catch {
          if (child.exitCode !== null) break;
          await new Promise((r) => setTimeout(r, 200));
        }
      }
      expect(res, `server never answered; stderr: ${stderr}`).toBeDefined();
      expect((res as Response).status).toBe(200);
      expect(await (res as Response).text()).toMatch(/No profiles yet/);
      expect(child.exitCode).toBeNull();
    } finally {
      child.kill('SIGKILL');
      await exited;
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});
