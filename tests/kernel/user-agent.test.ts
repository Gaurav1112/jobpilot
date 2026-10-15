import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { userAgentFor } from '../../src/kernel/user-agent.js';

const probe = "import('./src/kernel/broker.ts').then(m => console.log(m.HTTP_HEADERS['user-agent']))";
const childUa = (runEnv?: string): string => {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env['JOBPILOT_RUN_ENV'];
  if (runEnv !== undefined) env['JOBPILOT_RUN_ENV'] = runEnv;
  const r = spawnSync(process.execPath, ['--import', 'tsx', '-e', probe], { env, encoding: 'utf8', timeout: 60_000 });
  return r.stdout.trim();
};

describe('the honest user agent by run env (S10)', () => {
  it('is +local unless the env is exactly "hosted"', () => {
    expect(userAgentFor({})).toBe('jobpilot/0.1 (+local)');
    expect(userAgentFor({ JOBPILOT_RUN_ENV: 'hosted' })).toBe('jobpilot/0.1 (+hosted)');
    expect(userAgentFor({ JOBPILOT_RUN_ENV: 'HOSTED' })).toBe('jobpilot/0.1 (+local)');
  });

  it('the broker headers pick it at module load', () => {
    expect(childUa('hosted')).toBe('jobpilot/0.1 (+hosted)');
    expect(childUa()).toBe('jobpilot/0.1 (+local)');
  });
});
