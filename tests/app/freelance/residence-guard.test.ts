import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freelanceRefusal } from '../../../src/app/freelance/run.js';
import { residenceAt } from '../../../src/app/kernel.js';
import { runFreelanceCommand } from '../../../src/app/run-command.js';
import { AppStore } from '../../../src/app/store/app-store.js';
import { createDashboard } from '../../../src/app/web/server.js';
import { Sessions } from '../../../src/app/web/security.js';

const repo = join(import.meta.dirname, '../../..');
let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'jobpilot-flguard-'));
  cpSync(join(repo, 'tests/fixtures/pack'), join(home, 'pack'), { recursive: true });
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const liveIn = (code: string): void => {
  const elig = readFileSync(join(home, 'pack/eligibility.yaml'), 'utf8').replace('residence: IN', `residence: ${code}`);
  writeFileSync(join(home, 'pack/eligibility.yaml'), elig);
};

describe('freelance outside India', () => {
  it('IN runs as before; DE is refused by name', () => {
    expect(freelanceRefusal('IN')).toBeNull();
    expect(freelanceRefusal('DE')).toBe('the freelance pipeline is India-scoped in this version (residence is DE); nothing ran');
  });
  it('run-freelance exits 2 for a DE profile and writes no run', async () => {
    const elig = readFileSync(join(home, 'pack/eligibility.yaml'), 'utf8').replace('residence: IN', 'residence: DE');
    writeFileSync(join(home, 'pack/eligibility.yaml'), elig);
    const err: string[] = [];
    const code = await runFreelanceCommand({ notify: false, offlineFixtures: join(repo, 'tests/fixtures/freelance-e2e') }, { home, clock: { now: () => '2026-10-15T02:30:00.000Z' }, notifier: async () => {}, out: () => {}, err: (l) => err.push(l) });
    expect(code).toBe(2);
    expect(err.join('\n')).toContain('India-scoped in this version (residence is DE)');
  });
});

describe('freelance outside India: the rest of the surface', () => {
  it('the refusal names the canonical code (lower case, UK) and the run records nothing', async () => {
    expect(freelanceRefusal('in')).toBeNull();
    expect(freelanceRefusal('UK')).toBe('the freelance pipeline is India-scoped in this version (residence is GB); nothing ran');
    liveIn('DE');
    const posted: string[] = [];
    const code = await runFreelanceCommand({ notify: true, offlineFixtures: join(repo, 'tests/fixtures/freelance-e2e') }, { home, clock: { now: () => '2026-10-15T02:30:00.000Z' }, notifier: async (l) => void posted.push(l), out: () => {}, err: () => {} });
    expect(code).toBe(2);
    expect(posted).toEqual(['jobpilot run-freelance failed: the freelance pipeline is India-scoped in this version (residence is DE); nothing ran']);
    const app = AppStore.open(join(home, 'jobpilot.db'));
    try {
      expect(app.latestGigRun()).toBeUndefined();
      expect(app.kernel.db.prepare(`SELECT COUNT(*) AS n FROM runs`).get()).toEqual({ n: 0 });
    } finally {
      app.close();
    }
  });
  it('schedule install reads the residence leniently: a broken pack counts as IN (installed, as today)', () => {
    expect(residenceAt(join(home, 'pack'), '2026-10')).toBe('IN');
    liveIn('DE');
    expect(residenceAt(join(home, 'pack'), '2026-10')).toBe('DE');
    writeFileSync(join(home, 'pack/eligibility.yaml'), 'residence: [\n');
    expect(residenceAt(join(home, 'pack'), '2026-10')).toBeUndefined();
    expect(residenceAt(join(home, 'no-such-pack'), '2026-10')).toBeUndefined();
    expect(existsSync(join(home, 'jobpilot.db'))).toBe(false);
  });
  it('the Freelance tab shows the one-line notice instead of the list; IN keeps its list', async () => {
    AppStore.open(join(home, 'jobpilot.db'), { schema: 'migrate' }).close();
    const raw = createDashboard({ home, clock: { now: () => '2026-10-15T02:30:00.000Z' }, sessions: new Sessions(Buffer.alloc(32, 7)) });
    const get = async (p: string): Promise<string> => (await raw.request(p, { headers: { host: 'localhost' } })).text();
    const notice = 'The freelance pipeline is India-scoped in this version (residence is DE).';
    const inPage = await get('/freelance');
    expect(inPage).not.toContain('India-scoped');
    expect(inPage).toContain('jobpilot never bids or applies for you');
    liveIn('DE');
    for (const p of ['/freelance', '/freelance?tab=gigs', '/freelance?tab=review']) {
      const page = await get(p);
      expect(page).toContain(notice);
      expect(page).not.toContain('jobpilot never bids or applies for you');
    }
  });
});
