import { existsSync } from 'node:fs';
import { chromium, type Browser } from 'playwright';

/**
 * Real-browser suites (UX upgrade A0, amendment 1): a missing or broken Chromium FAILS the suite. Skipping happens only
 * when the person running the tests says so with JOBPILOT_ALLOW_NO_BROWSER=1, and it is printed.
 */
export const ALLOW_NO_BROWSER_ENV = 'JOBPILOT_ALLOW_NO_BROWSER';
const HINT = `Install it with "node node_modules/playwright/cli.js install chromium", or set ${ALLOW_NO_BROWSER_ENV}=1 to skip on purpose.`;
const allowed = (env: NodeJS.ProcessEnv): boolean => env[ALLOW_NO_BROWSER_ENV] === '1';

export async function launchBrowser(o: { launch?: () => Promise<Browser>; env?: NodeJS.ProcessEnv } = {}): Promise<Browser | undefined> {
  const env = o.env ?? process.env;
  try {
    return await (o.launch ?? (() => chromium.launch()))();
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    if (allowed(env)) {
      console.warn(`[browser] Chromium could not start; skipping on purpose (${ALLOW_NO_BROWSER_ENV}=1): ${why}`);
      return undefined;
    }
    throw new Error(`Chromium is required for this suite and could not start: ${why}\n${HINT}`);
  }
}

export function browserInstalled(o: { executable?: () => string; env?: NodeJS.ProcessEnv } = {}): boolean {
  const path = (o.executable ?? (() => chromium.executablePath()))();
  if (existsSync(path)) return true;
  if (allowed(o.env ?? process.env)) {
    console.warn(`[browser] no Chromium at ${path}; skipping on purpose (${ALLOW_NO_BROWSER_ENV}=1)`);
    return false;
  }
  throw new Error(`Chromium is required for this suite and is not installed at ${path}.\n${HINT}`);
}
