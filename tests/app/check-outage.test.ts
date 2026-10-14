import { describe, expect, it } from 'vitest';
import { checkOutage, CHECK_OUTAGE_ENV } from '../../src/app/check-outage.js';
import type { FetchLike } from '../../src/kernel/providers.js';

const ok: FetchLike = async () => ({ status: 200, text: async () => 'ok' });

describe('the check-only outage hook (JOBPILOT_CHECK_OUTAGE)', () => {
  it('is inert unless the variable is set', () => {
    expect(CHECK_OUTAGE_ENV).toBe('JOBPILOT_CHECK_OUTAGE');
    expect(checkOutage({})).toBeNull();
    expect(checkOutage({ [CHECK_OUTAGE_ENV]: '' })).toBeNull();
  });

  it('+S/N: from S seconds after the first request, for N seconds, every request fails as offline (ENOTFOUND) and the online check says no', async () => {
    let t = 1_000_000;
    const hook = checkOutage({ [CHECK_OUTAGE_ENV]: '+10/15' }, () => t);
    if (hook === null) throw new Error('expected a hook');
    const fetch = hook.fetch(ok);
    const online = hook.online(async () => true);
    await expect(fetch('https://a.test/', { signal: new AbortController().signal, headers: {}, redirect: 'manual' })).resolves.toMatchObject({ status: 200 }); // t0, the window starts at t0 + 10 s
    t += 10_000;
    const failed = await fetch('https://a.test/', { signal: new AbortController().signal, headers: {}, redirect: 'manual' }).catch((e: unknown) => e);
    expect(failed).toBeInstanceOf(TypeError);
    expect((failed as { cause?: { code?: string } }).cause?.code).toBe('ENOTFOUND');
    expect(await online()).toBe(false);
    t += 15_000;
    await expect(fetch('https://a.test/', { signal: new AbortController().signal, headers: {}, redirect: 'manual' })).resolves.toMatchObject({ status: 200 });
    expect(await online()).toBe(true);
    expect(hook.describe).toMatch(/check-only/);
  });

  it('an ISO start time works; a malformed value refuses to run', () => {
    expect(checkOutage({ [CHECK_OUTAGE_ENV]: '2026-10-14T13:00:00.000Z/15' })).not.toBeNull();
    for (const bad of ['15', '+x/15', '+1/0', '+1/-3', 'tomorrow/5', '+1/15/2']) expect(() => checkOutage({ [CHECK_OUTAGE_ENV]: bad }), bad).toThrow(/JOBPILOT_CHECK_OUTAGE/);
  });
});
