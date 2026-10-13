import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { offlineProviders } from '../../src/app/offline.js';

const dir = mkdtempSync(join(tmpdir(), 'jp-offline-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('offlineProviders: recorded responses', () => {
  writeFileSync(join(dir, 'page.html'), '<title>ok</title>');
  writeFileSync(join(dir, 'wall.html'), '<title>Just a moment...</title>');
  writeFileSync(
    join(dir, 'index.json'),
    JSON.stringify({
      'https://a.test/': 'page.html',
      'https://a.test/wall': { status: 403, file: 'wall.html' },
      'https://a.test/old': { status: 301, location: 'https://a.test/' },
    }),
  );
  const { fetch } = offlineProviders(dir);
  const init = { signal: new AbortController().signal, redirect: 'manual' as const, headers: {} };

  it('a plain mapping is a 200; a recorded response keeps its status, body and Location', async () => {
    const ok = await fetch('https://a.test/', init);
    expect([ok.status, await ok.text(), ok.headers?.get('location')]).toEqual([200, '<title>ok</title>', null]);
    const wall = await fetch('https://a.test/wall', init);
    expect([wall.status, await wall.text()]).toEqual([403, '<title>Just a moment...</title>']);
    const moved = await fetch('https://a.test/old', init);
    expect([moved.status, await moved.text(), moved.headers?.get('location')]).toEqual([301, '', 'https://a.test/']);
    expect((await fetch('https://a.test/none', init)).status).toBe(404);
  });

  it('refuses an entry that is neither a file name nor {status, file?, location?}', () => {
    const bad = mkdtempSync(join(tmpdir(), 'jp-offline-bad-'));
    writeFileSync(join(bad, 'index.json'), JSON.stringify({ 'https://a.test/': { file: 'x.html' } }));
    expect(() => offlineProviders(bad)).toThrow(/must map to a file name or \{status, file\?, location\?\}/);
    rmSync(bad, { recursive: true, force: true });
  });
});
