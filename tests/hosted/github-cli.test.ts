import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type GhRunner, ghCliClient } from '../../src/app/hosted/github.js';
import { EMPTY_POINTER, pointerJson } from '../../src/app/hosted/pointer.js';

const TOKEN = 'ghp_fake_never_in_argv';
type Call = { args: readonly string[]; stdin: string | undefined };
type Reply = { status?: number; stdout?: string; stderr?: string };

function fake(script: (args: readonly string[]) => Reply): { run: GhRunner; calls: Call[] } {
  const calls: Call[] = [];
  const run: GhRunner = async (args, o) => {
    calls.push({ args, stdin: o?.stdin });
    const r = script(args);
    return { status: r.status ?? 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  };
  return { run, calls };
}
process.env['GH_TOKEN'] = TOKEN;
const b64 = (s: string): string => Buffer.from(s).toString('base64');
const R = 'repos/example-user/example-data';

describe('ghCliClient argv', () => {
  it('readState: ref, then pointer.json at that sha', async () => {
    const { run, calls } = fake((a) =>
      a[1]?.includes('/git/ref/') ? { stdout: JSON.stringify({ object: { sha: 'c0ffee' } }) } : { stdout: JSON.stringify({ content: b64(pointerJson(EMPTY_POINTER)) }) },
    );
    const s = await ghCliClient('example-user/example-data', run).readState();
    expect(s).toEqual({ commit: 'c0ffee', pointer: EMPTY_POINTER });
    expect(calls.map((c) => c.args)).toEqual([
      ['api', `${R}/git/ref/heads/state`],
      ['api', `${R}/contents/pointer.json?ref=c0ffee`],
    ]);
  });

  it('a 404 on the state ref is null', async () => {
    const { run } = fake(() => ({ status: 1, stderr: 'gh: Not Found (HTTP 404)' }));
    expect(await ghCliClient('example-user/example-data', run).readState()).toBeNull();
  });

  it('casState: commit -> tree -> commit -> PATCH, bodies on stdin, 422 is not ok', async () => {
    let patchStatus = 0;
    const { run, calls } = fake((a) => {
      const p = a.join(' ');
      if (p.includes('git/commits/p1')) return { stdout: JSON.stringify({ tree: { sha: 't0' } }) };
      if (p.includes('POST') && p.endsWith('git/trees --input -')) return { stdout: JSON.stringify({ sha: 't1' }) };
      if (p.includes('POST') && p.includes('git/commits --input')) return { stdout: JSON.stringify({ sha: 'n1' }) };
      return patchStatus === 0 ? { stdout: '{}' } : { status: 1, stderr: 'gh: Unprocessable (HTTP 422)' };
    });
    const gh = ghCliClient('example-user/example-data', run);
    expect(await gh.casState('p1', { 'a.txt': 'A' }, 'msg')).toEqual({ ok: true, commit: 'n1' });
    expect(calls.map((c) => c.args)).toEqual([
      ['api', `${R}/git/commits/p1`],
      ['api', '--method', 'POST', `${R}/git/trees`, '--input', '-'],
      ['api', '--method', 'POST', `${R}/git/commits`, '--input', '-'],
      ['api', '--method', 'PATCH', `${R}/git/refs/heads/state`, '--input', '-'],
    ]);
    expect(JSON.parse(calls[1]?.stdin ?? '')).toEqual({ base_tree: 't0', tree: [{ path: 'a.txt', mode: '100644', type: 'blob', content: 'A' }] });
    expect(JSON.parse(calls[2]?.stdin ?? '')).toEqual({ message: 'msg', tree: 't1', parents: ['p1'] });
    expect(JSON.parse(calls[3]?.stdin ?? '')).toEqual({ sha: 'n1', force: false });
    patchStatus = 1;
    expect(await gh.casState('p1', { 'a.txt': 'A' }, 'msg')).toEqual({ ok: false });
  });

  it('releases, issues, runs, facts: exact argv, bodies on stdin', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jp-ghcli-'));
    const file = join(dir, 'state.jpst');
    writeFileSync(file, 'x');
    const { run, calls } = fake((a) => {
      const p = a.join(' ');
      if (p.startsWith('api repos/example-user/example-data/releases/tags/')) return { stdout: JSON.stringify({ tag_name: 'g1', created_at: '2026-10-15T00:00:00Z', assets: [{ name: 'state.jpst', size: 1, digest: 'sha256:ab' }, { name: 'n', size: 2 }] }) };
      if (p.includes('--paginate')) return { stdout: '[{"tag_name":"g1","created_at":"c","assets":[]}][{"tag_name":"g2","created_at":"d","assets":[]}]' };
      if (a[0] === 'issue' && a[1] === 'list') return { stdout: '[{"number":4,"title":"Other"},{"number":5,"title":"Red"}]' };
      if (a[0] === 'issue' && a[1] === 'create') return { stdout: 'https://github.com/example-user/example-data/issues/9\n' };
      if (p.includes('/actions/runs/77/jobs')) return { stdout: '{"jobs":[{"started_at":"2026-10-15T01:00:00Z"}]}' };
      if (a[0] === 'run' && a[1] === 'list') return { stdout: '[{"databaseId":80,"createdAt":"x"},{"databaseId":76,"createdAt":"y"},{"databaseId":75,"createdAt":"z"}]' };
      if (a[0] === 'run' && a[1] === 'view') return { stdout: 'LOG' };
      if (p === `api ${R}`) return { stdout: '{"private":true}' };
      if (p.includes('actions/permissions/workflow')) return { stdout: '{"default_workflow_permissions":"read"}' };
      if (a[0] === 'secret') return { stdout: '[{"name":"STATE_KEY"}]' };
      return {};
    });
    const gh = ghCliClient('example-user/example-data', run);
    const rep = 'example-user/example-data';
    await gh.createRelease('g1');
    await gh.uploadAsset('g1', file, 'state.jpst');
    expect(await gh.release('g1')).toEqual({ tag: 'g1', createdAt: '2026-10-15T00:00:00Z', assets: [{ name: 'state.jpst', size: 1, digest: 'sha256:ab' }, { name: 'n', size: 2, digest: null }] });
    expect((await gh.listReleases()).map((r) => r.tag)).toEqual(['g1', 'g2']);
    await gh.downloadAsset('g1', 'state.jpst', '/x/y.bin');
    await gh.deleteRelease('g1');
    expect(await gh.findOpenIssue('alert', 'Red')).toBe(5);
    expect(await gh.openIssue('T', 'BODY', ['alert', 'hosted'])).toBe(9);
    await gh.commentIssue(9, 'COMMENT');
    expect(await gh.jobStartedAt('77')).toBe('2026-10-15T01:00:00Z');
    expect(await gh.previousRunId('daily.yml', '77')).toBe('76');
    expect(await gh.runLog('77')).toBe('LOG');
    expect(await gh.repoFacts()).toEqual({ private: true, defaultWorkflowPermissions: 'read', secretNames: ['STATE_KEY'] });

    expect(calls.map((c) => c.args)).toEqual([
      ['release', 'create', 'g1', '--repo', rep, '--title', 'g1', '--notes', ''],
      ['release', 'upload', 'g1', file, '--repo', rep],
      ['api', `${R}/releases/tags/g1`],
      ['api', '--paginate', `${R}/releases`],
      ['release', 'download', 'g1', '--repo', rep, '--pattern', 'state.jpst', '--output', '/x/y.bin', '--clobber'],
      ['release', 'delete', 'g1', '--repo', rep, '--yes', '--cleanup-tag'],
      ['issue', 'list', '--repo', rep, '--label', 'alert', '--state', 'open', '--json', 'number,title'],
      ['issue', 'create', '--repo', rep, '--title', 'T', '--body-file', '-', '--label', 'alert', '--label', 'hosted'],
      ['issue', 'comment', '9', '--repo', rep, '--body-file', '-'],
      ['api', `${R}/actions/runs/77/jobs`],
      ['run', 'list', '--repo', rep, '--workflow', 'daily.yml', '--status', 'completed', '--json', 'databaseId,createdAt', '--limit', '20'],
      ['run', 'view', '77', '--repo', rep, '--log'],
      ['api', R],
      ['api', `${R}/actions/permissions/workflow`],
      ['secret', 'list', '--repo', rep, '--json', 'name'],
    ]);
    expect(calls[7]?.stdin).toBe('BODY');
    expect(calls[8]?.stdin).toBe('COMMENT');
    for (const c of calls) for (const a of c.args) expect(a).not.toContain(TOKEN);
  });

  it('repoPrivate reads only repos/R .private: no secret listing, which GITHUB_TOKEN cannot do (403)', async () => {
    const { run, calls } = fake((a) =>
      a[0] === 'secret' ? { status: 1, stderr: 'HTTP 403: Resource not accessible by integration' } : a.join(' ') === `api ${R}` ? { stdout: '{"private":true}' } : { status: 1 },
    );
    const gh = ghCliClient('example-user/example-data', run);
    expect(await gh.repoPrivate()).toBe(true);
    expect(calls.map((c) => c.args)).toEqual([['api', R]]);
    const pub = ghCliClient('example-user/example-data', fake(() => ({ stdout: '{"private":false}' })).run);
    expect(await pub.repoPrivate()).toBe(false);
  });

  it('other failures say only "gh api failed (exit 1)"; deleteRelease tolerates a missing release', async () => {
    const { run } = fake((a) => (a[0] === 'release' ? { status: 1, stderr: 'release not found' } : { status: 1, stderr: 'SECRET-BODY-ECHO' }));
    const gh = ghCliClient('example-user/example-data', run);
    await expect(gh.repoFacts()).rejects.toThrow(/^gh api failed \(exit 1\)$/);
    await expect(gh.createRelease('t')).rejects.toThrow(/^gh release create failed \(exit 1\)$/);
    await expect(gh.deleteRelease('t')).resolves.toBeUndefined();
    await expect(gh.repoFacts().catch((e: Error) => e.message)).resolves.not.toContain('SECRET');
  });
});
