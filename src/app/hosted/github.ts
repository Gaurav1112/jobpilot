import { spawn } from 'node:child_process';
import { copyFileSync, linkSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { Pointer } from './pointer.js';
import { EMPTY_POINTER, parsePointer, pointerJson } from './pointer.js';

export interface StateHead { readonly commit: string; readonly pointer: Pointer }
export interface ReleaseAsset { readonly name: string; readonly size: number; readonly digest: string | null }
export interface Release { readonly tag: string; readonly createdAt: string; readonly assets: readonly ReleaseAsset[] }
export type CasResult = { readonly ok: true; readonly commit: string } | { readonly ok: false };
export interface RepoFacts {
  readonly private: boolean;
  readonly defaultWorkflowPermissions: 'read' | 'write' | null;
  readonly secretNames: readonly string[];
}

export interface GitHubClient {
  readonly repo: string;
  readState(): Promise<StateHead | null>;
  readStateFile(path: string): Promise<string | null>;
  /** One commit on `state` whose parent is `parent`, writing `files` (other files kept), moved fast-forward only. */
  casState(parent: string, files: Readonly<Record<string, string>>, message: string): Promise<CasResult>;
  /** Creates the orphan `state` branch with `pointer.json` = EMPTY_POINTER; refuses when it exists. */
  initState(message: string): Promise<StateHead>;
  createRelease(tag: string): Promise<void>;
  uploadAsset(tag: string, file: string, name: string): Promise<void>;
  release(tag: string): Promise<Release | null>;
  listReleases(): Promise<Release[]>;
  downloadAsset(tag: string, name: string, toFile: string): Promise<void>;
  deleteRelease(tag: string): Promise<void>;
  findOpenIssue(label: string, title: string): Promise<number | null>;
  openIssue(title: string, body: string, labels: readonly string[]): Promise<number>;
  commentIssue(n: number, body: string): Promise<void>;
  jobStartedAt(runId: string): Promise<string | null>;
  previousRunId(workflowFile: string, runId: string): Promise<string | null>;
  runLog(runId: string): Promise<string | null>;
  repoFacts(): Promise<RepoFacts>;
}

export type GhRunner = (
  args: readonly string[],
  o?: { readonly stdin?: string; readonly timeoutMs?: number },
) => Promise<{ status: number; stdout: string; stderr: string }>;

/** spawn('gh', args) with the caller's environment (the token stays there); no shell. */
export const realGhRunner: GhRunner = (args, o) =>
  new Promise((resolve, reject) => {
    const child = spawn('gh', [...args], { stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const timer = setTimeout(() => child.kill('SIGKILL'), o?.timeoutMs ?? 120_000);
    child.stdout.on('data', (b: Buffer) => out.push(b));
    child.stderr.on('data', (b: Buffer) => err.push(b));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ status: code ?? 1, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') });
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(o?.stdin ?? '');
  });

type Json = Record<string, unknown>;
const enc = (p: string): string => p.split('/').map(encodeURIComponent).join('/');
const isNotFound = (stderr: string): boolean => /\b404\b|not found/i.test(stderr);
const isUnprocessable = (stderr: string): boolean => /\b422\b/.test(stderr);

export function ghCliClient(repo: string, run: GhRunner = realGhRunner): GitHubClient {
  const R = `repos/${repo}`;
  const fail = (args: readonly string[], status: number): Error => {
    const name = args[0] === 'api' ? 'api' : `${args[0] ?? ''} ${args[1] ?? ''}`.trim();
    return new Error(`gh ${name} failed (exit ${status})`); // stderr can echo request bodies: never included
  };
  /** Runs gh; returns stdout, or null for a status the caller lists as tolerated. */
  async function call(args: readonly string[], o?: { stdin?: string; tolerate?: (stderr: string) => boolean }): Promise<string | null> {
    const r = await run(args, o?.stdin === undefined ? undefined : { stdin: o.stdin });
    if (r.status === 0) return r.stdout;
    if (o?.tolerate?.(r.stderr)) return null;
    throw fail(args, r.status);
  }
  const json = async (args: readonly string[], o?: { stdin?: string; tolerate?: (s: string) => boolean }): Promise<Json | null> => {
    const out = await call(args, o);
    return out === null ? null : (JSON.parse(out) as Json);
  };
  const send = (method: string, path: string, body: unknown, tolerate?: (s: string) => boolean): Promise<Json | null> =>
    json(['api', '--method', method, path, '--input', '-'], { stdin: JSON.stringify(body), ...(tolerate ? { tolerate } : {}) });

  const headSha = async (): Promise<string | null> => {
    const ref = await json(['api', `${R}/git/ref/heads/state`], { tolerate: isNotFound });
    return ref === null ? null : String((ref['object'] as Json)['sha']);
  };
  const fileAt = async (path: string, sha: string): Promise<string | null> => {
    const f = await json(['api', `${R}/contents/${enc(path)}?ref=${sha}`], { tolerate: isNotFound });
    if (f === null) return null;
    return Buffer.from(String(f['content']).replace(/\s/g, ''), 'base64').toString('utf8');
  };
  const toRelease = (j: Json): Release => ({
    tag: String(j['tag_name']),
    createdAt: String(j['created_at']),
    assets: ((j['assets'] as Json[] | undefined) ?? []).map((a) => ({
      name: String(a['name']),
      size: Number(a['size']),
      digest: typeof a['digest'] === 'string' ? a['digest'] : null,
    })),
  });

  return {
    repo,
    async readState() {
      const sha = await headSha();
      if (sha === null) return null;
      const text = await fileAt('pointer.json', sha);
      if (text === null) throw new Error('state branch has no pointer.json');
      return { commit: sha, pointer: parsePointer(text) };
    },
    async readStateFile(path) {
      const sha = await headSha();
      return sha === null ? null : fileAt(path, sha);
    },
    async casState(parent, files, message) {
      const parentCommit = await json(['api', `${R}/git/commits/${parent}`]);
      const baseTree = String(((parentCommit as Json)['tree'] as Json)['sha']);
      const tree = await send('POST', `${R}/git/trees`, {
        base_tree: baseTree,
        tree: Object.entries(files).map(([path, content]) => ({ path, mode: '100644', type: 'blob', content })),
      });
      const commit = await send('POST', `${R}/git/commits`, { message, tree: String((tree as Json)['sha']), parents: [parent] });
      const sha = String((commit as Json)['sha']);
      const moved = await send('PATCH', `${R}/git/refs/heads/state`, { sha, force: false }, isUnprocessable);
      return moved === null ? { ok: false } : { ok: true, commit: sha };
    },
    async initState(message) {
      if ((await headSha()) !== null) throw new Error('the state branch already exists');
      const tree = await send('POST', `${R}/git/trees`, {
        tree: [{ path: 'pointer.json', mode: '100644', type: 'blob', content: pointerJson(EMPTY_POINTER) }],
      });
      const commit = await send('POST', `${R}/git/commits`, { message, tree: String((tree as Json)['sha']), parents: [] });
      const sha = String((commit as Json)['sha']);
      const ref = await send('POST', `${R}/git/refs`, { ref: 'refs/heads/state', sha }, isUnprocessable);
      if (ref === null) throw new Error('the state branch already exists');
      return { commit: sha, pointer: EMPTY_POINTER };
    },
    async createRelease(tag) {
      await call(['release', 'create', tag, '--repo', repo, '--title', tag, '--notes', '']);
    },
    async uploadAsset(tag, file, name) {
      // gh names an asset by its file name (`file#label` only sets a label), so stage a link or copy called `name`.
      if (basename(file) === name) return void (await call(['release', 'upload', tag, file, '--repo', repo]));
      const stage = mkdtempSync(join(tmpdir(), 'jp-asset-'));
      try {
        const staged = join(stage, name);
        try {
          linkSync(file, staged);
        } catch {
          copyFileSync(file, staged);
        }
        await call(['release', 'upload', tag, staged, '--repo', repo]);
      } finally {
        rmSync(stage, { recursive: true, force: true });
      }
    },
    async release(tag) {
      const j = await json(['api', `${R}/releases/tags/${enc(tag)}`], { tolerate: isNotFound });
      return j === null ? null : toRelease(j);
    },
    async listReleases() {
      const out = (await call(['api', '--paginate', `${R}/releases`])) ?? '[]';
      const arr = JSON.parse(out.replace(/\]\s*\[/g, ',').trim() || '[]') as Json[];
      return arr.map(toRelease);
    },
    async downloadAsset(tag, name, toFile) {
      await call(['release', 'download', tag, '--repo', repo, '--pattern', name, '--output', toFile, '--clobber']);
    },
    async deleteRelease(tag) {
      await call(['release', 'delete', tag, '--repo', repo, '--yes', '--cleanup-tag'], { tolerate: isNotFound });
    },
    async findOpenIssue(label, title) {
      const out = await call(['issue', 'list', '--repo', repo, '--label', label, '--state', 'open', '--json', 'number,title']);
      const list = JSON.parse(out ?? '[]') as { number: number; title: string }[];
      return list.find((i) => i.title === title)?.number ?? null;
    },
    async openIssue(title, body, labels) {
      const args = ['issue', 'create', '--repo', repo, '--title', title, '--body-file', '-'];
      for (const l of labels) args.push('--label', l);
      const out = (await call(args, { stdin: body })) ?? '';
      const m = /(\d+)\s*$/.exec(out);
      if (!m) throw new Error('gh issue create failed (no issue number)');
      return Number(m[1]);
    },
    async commentIssue(n, body) {
      await call(['issue', 'comment', String(n), '--repo', repo, '--body-file', '-'], { stdin: body });
    },
    async jobStartedAt(runId) {
      const j = await json(['api', `${R}/actions/runs/${runId}/jobs`], { tolerate: isNotFound });
      const first = (j?.['jobs'] as Json[] | undefined)?.[0];
      return typeof first?.['started_at'] === 'string' ? first['started_at'] : null;
    },
    async previousRunId(workflowFile, runId) {
      const out = await call(['run', 'list', '--repo', repo, '--workflow', workflowFile, '--status', 'completed', '--json', 'databaseId,createdAt', '--limit', '20']);
      const list = JSON.parse(out ?? '[]') as { databaseId: number }[];
      const before = list.map((r) => r.databaseId).filter((id) => id < Number(runId));
      return before.length === 0 ? null : String(Math.max(...before));
    },
    async runLog(runId) {
      return call(['run', 'view', runId, '--repo', repo, '--log'], { tolerate: () => true });
    },
    async repoFacts() {
      const info = (await json(['api', R])) as Json;
      const perms = await json(['api', `${R}/actions/permissions/workflow`], { tolerate: () => true });
      const p = perms?.['default_workflow_permissions'];
      const names = JSON.parse((await call(['secret', 'list', '--repo', repo, '--json', 'name'])) ?? '[]') as { name: string }[];
      return {
        private: info['private'] === true,
        defaultWorkflowPermissions: p === 'read' || p === 'write' ? p : null,
        secretNames: names.map((n) => n.name),
      };
    },
  };
}
