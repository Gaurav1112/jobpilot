import { describe, expect, it } from 'vitest';
import { GITHUB_API_HOST, GITHUB_MAX_REQUESTS_PER_RUN, githubJson, makeGithubHosts } from '../../../src/app/freelance/sources/github.js';
import { srcDraftdevContract } from '../../../src/app/freelance/sources/draftdev.js';
import { KernelError } from '../../../src/kernel/errors.js';
import { githubHost } from '../../support/github-host.js';

const gh = (routes: Record<string, string>, o: { status?: number; body?: string } = {}) => githubHost(srcDraftdevContract(), routes, o);
const URL1 = `https://${GITHUB_API_HOST}/repos/draftdev/jobs/contents/`;
const code = async (p: Promise<unknown>): Promise<{ code: string; message: string }> => {
  try {
    await p;
  } catch (e) {
    if (e instanceof KernelError) return { code: e.code, message: e.message };
    throw e;
  }
  throw new Error('did not throw');
};

describe('githubJson', () => {
  it('one GET, parsed JSON, paced at 2 s or more, counted against the run budget', async () => {
    const h = gh({ [URL1]: '[{"name":"a"}]' });
    const hosts = makeGithubHosts();
    expect(await githubJson(h.ctx, hosts, '/repos/draftdev/jobs/contents/')).toEqual([{ name: 'a' }]);
    expect(h.calls).toEqual([URL1]);
    expect(h.waits.every((w) => w >= 2000)).toBe(true);
    expect(hosts.used).toBe(1);
  });

  it.each([
    [403, 'challenged', 'http-403'],
    [401, 'challenged', 'http-401'],
    [429, 'rate_limit', 'http-429'],
  ])('a %i disables api.github.com for the run; the next ask sends nothing', async (status, why, tag) => {
    const h = gh({}, { status });
    const hosts = makeGithubHosts();
    expect((await code(githubJson(h.ctx, hosts, '/x'))).code).toBe(why);
    expect(hosts.disabled).toBe(tag);
    const again = await code(githubJson(h.ctx, hosts, '/y'));
    expect(again).toMatchObject({ code: 'input_rejected' });
    expect(again.message).toContain(`host-disabled:${tag} on api.github.com`);
    expect(h.calls).toEqual([`https://${GITHUB_API_HOST}/x`]);
  });

  it('a challenge page disables the host', async () => {
    const h = gh({}, { status: 403, body: '<title>Just a moment...</title>' });
    const hosts = makeGithubHosts();
    expect((await code(githubJson(h.ctx, hosts, '/x'))).code).toBe('challenged');
    expect(hosts.disabled).toBe('challenge');
  });

  it('404 is gone, 5xx overloaded, a body that is not JSON invalid_output; none disables the host', async () => {
    const hosts = makeGithubHosts();
    expect((await code(githubJson(gh({}).ctx, hosts, '/nope'))).code).toBe('gone');
    expect((await code(githubJson(gh({}, { status: 502 }).ctx, hosts, '/x'))).code).toBe('overloaded');
    expect((await code(githubJson(gh({ [`https://${GITHUB_API_HOST}/t`]: '<html>' }).ctx, hosts, '/t'))).code).toBe('invalid_output');
    expect(hosts.disabled).toBeUndefined();
  });

  it('the per-run budget is loud and sends nothing', async () => {
    const h = gh({});
    const hosts = makeGithubHosts();
    hosts.used = GITHUB_MAX_REQUESTS_PER_RUN;
    const e = await code(githubJson(h.ctx, hosts, '/x'));
    expect(e.code).toBe('input_rejected');
    expect(e.message).toMatch(/^github-budget: /);
    expect(e.message).toContain(String(GITHUB_MAX_REQUESTS_PER_RUN));
    expect(h.calls).toEqual([]);
  });
});
