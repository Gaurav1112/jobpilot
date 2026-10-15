import type { Browser } from 'playwright';
import { describe, expect, it } from 'vitest';
import { browserInstalled, launchBrowser } from './browser.js';

const broken = async (): Promise<Browser> => {
  throw new Error("Executable doesn't exist at /nowhere/chrome");
};

describe('browser suites fail instead of skipping (UX upgrade A0)', () => {
  it('a Chromium that cannot start fails the suite, naming the install command and the opt-out', async () => {
    await expect(launchBrowser({ launch: broken, env: {} })).rejects.toThrow(
      /Chromium is required.*Executable doesn't exist.*playwright\/cli\.js install chromium.*JOBPILOT_ALLOW_NO_BROWSER=1/s,
    );
  });
  it('JOBPILOT_ALLOW_NO_BROWSER=1 is the only way to skip, and it says so', async () => {
    const warned: string[] = [];
    const orig = console.warn;
    console.warn = (m: string) => warned.push(m);
    try {
      expect(await launchBrowser({ launch: broken, env: { JOBPILOT_ALLOW_NO_BROWSER: '1' } })).toBeUndefined();
    } finally {
      console.warn = orig;
    }
    expect(warned.join('\n')).toMatch(/skipping on purpose \(JOBPILOT_ALLOW_NO_BROWSER=1\)/);
  });
  it('the careers variant checks the executable the same way', () => {
    expect(() => browserInstalled({ executable: () => '/nowhere/chrome', env: {} })).toThrow(/Chromium is required/);
    expect(browserInstalled({ executable: () => '/nowhere/chrome', env: { JOBPILOT_ALLOW_NO_BROWSER: '1' } })).toBe(false);
    expect(browserInstalled({ executable: () => process.execPath, env: {} })).toBe(true);
  });
});
