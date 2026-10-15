import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { CasResult, GitHubClient, Release, RepoFacts, StateHead } from './github.js';
import { EMPTY_POINTER, parsePointer, pointerJson } from './pointer.js';

export interface DirHooks {
  readonly now?: () => string;
  /** Runs just before a CAS decides; a test uses it to let a second writer commit first. */
  readonly beforeCas?: (parent: string) => Promise<void> | void;
}

interface Commit { parent: string | null; message: string; files: Record<string, string> }
interface Meta { tag: string; createdAt: string; assets: { name: string; size: number; digest: string }[] }
interface Issue { number: number; title: string; body: string; labels: string[]; comments: string[]; state: 'open' | 'closed' }
interface RunFile { workflow: string; startedAt: string; log: string }

const sha256 = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');
const readJson = <T>(p: string, fallback: T): T => (existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as T) : fallback);
const writeJson = (p: string, v: unknown): void => {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, `${JSON.stringify(v, null, 2)}\n`);
};

/** The GitHubClient on a folder: the backend of every test and of the dry runs. */
export function dirGitHub(dir: string, hooks: DirHooks = {}): GitHubClient {
  const now = hooks.now ?? ((): string => new Date().toISOString());
  const headFile = join(dir, 'state', 'head');
  const commitFile = (sha: string): string => join(dir, 'state', 'commits', `${sha}.json`);
  const head = (): string | null => (existsSync(headFile) ? readFileSync(headFile, 'utf8').trim() : null);
  const commitAt = (sha: string): Commit => JSON.parse(readFileSync(commitFile(sha), 'utf8')) as Commit;
  const store = (c: Commit): string => {
    const sha = sha256(JSON.stringify([c.parent, c.message, Object.entries(c.files).sort(([a], [b]) => (a < b ? -1 : 1))]));
    writeJson(commitFile(sha), c);
    return sha;
  };
  const setHead = (sha: string): void => {
    mkdirSync(dirname(headFile), { recursive: true });
    writeFileSync(headFile, `${sha}\n`);
  };
  const relDir = (tag: string): string => join(dir, 'releases', tag);
  const metaOf = (tag: string): Meta | null => (existsSync(join(relDir(tag), 'meta.json')) ? readJson<Meta | null>(join(relDir(tag), 'meta.json'), null) : null);
  const issuesFile = join(dir, 'issues.json');
  const issues = (): Issue[] => readJson<Issue[]>(issuesFile, []);
  const runs = (): { id: string; run: RunFile }[] => {
    const d = join(dir, 'runs');
    if (!existsSync(d)) return [];
    return readdirSync(d)
      .filter((f) => f.endsWith('.json'))
      .map((f) => ({ id: f.slice(0, -5), run: readJson<RunFile>(join(d, f), { workflow: '', startedAt: '', log: '' }) }));
  };

  return {
    repo: 'dir/state',
    async readState(): Promise<StateHead | null> {
      const h = head();
      if (h === null) return null;
      const text = commitAt(h).files['pointer.json'];
      if (text === undefined) throw new Error('state branch has no pointer.json');
      return { commit: h, pointer: parsePointer(text) };
    },
    async readStateFile(path) {
      const h = head();
      return h === null ? null : (commitAt(h).files[path] ?? null);
    },
    async casState(parent, files, message): Promise<CasResult> {
      await hooks.beforeCas?.(parent);
      if (head() !== parent) return { ok: false };
      const commit = store({ parent, message, files: { ...commitAt(parent).files, ...files } });
      setHead(commit);
      return { ok: true, commit };
    },
    async initState(message) {
      if (head() !== null) throw new Error('the state branch already exists');
      const commit = store({ parent: null, message, files: { 'pointer.json': pointerJson(EMPTY_POINTER) } });
      setHead(commit);
      return { commit, pointer: EMPTY_POINTER };
    },
    async createRelease(tag) {
      if (metaOf(tag)) throw new Error(`release ${tag} already exists`);
      writeJson(join(relDir(tag), 'meta.json'), { tag, createdAt: now(), assets: [] } satisfies Meta);
    },
    async uploadAsset(tag, file, name) {
      const meta = metaOf(tag);
      if (!meta) throw new Error(`release ${tag} does not exist`);
      if (meta.assets.some((a) => a.name === name)) throw new Error(`asset ${name} already exists on ${tag}`);
      copyFileSync(file, join(relDir(tag), name));
      meta.assets.push({ name, size: statSync(file).size, digest: `sha256:${sha256(readFileSync(file))}` });
      writeJson(join(relDir(tag), 'meta.json'), meta);
    },
    async release(tag): Promise<Release | null> {
      return metaOf(tag);
    },
    async listReleases() {
      const d = join(dir, 'releases');
      if (!existsSync(d)) return [];
      return readdirSync(d)
        .map((t) => metaOf(t))
        .filter((m): m is Meta => m !== null)
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
    },
    async downloadAsset(tag, name, toFile) {
      const src = join(relDir(tag), name);
      if (!metaOf(tag)?.assets.some((a) => a.name === name) || !existsSync(src)) throw new Error(`asset ${name} not found on ${tag}`);
      mkdirSync(dirname(toFile), { recursive: true });
      copyFileSync(src, toFile);
    },
    async deleteRelease(tag) {
      rmSync(relDir(tag), { recursive: true, force: true });
    },
    async findOpenIssue(label, title) {
      return issues().find((i) => i.state === 'open' && i.title === title && i.labels.includes(label))?.number ?? null;
    },
    async openIssue(title, body, labels) {
      const all = issues();
      const number = all.reduce((m, i) => Math.max(m, i.number), 0) + 1;
      all.push({ number, title, body, labels: [...labels], comments: [], state: 'open' });
      writeJson(issuesFile, all);
      return number;
    },
    async commentIssue(n, body) {
      const all = issues();
      const issue = all.find((i) => i.number === n);
      if (!issue) throw new Error(`issue ${n} not found`);
      issue.comments.push(body);
      writeJson(issuesFile, all);
    },
    async jobStartedAt(runId) {
      return runs().find((r) => r.id === runId)?.run.startedAt ?? null;
    },
    async previousRunId(workflowFile, runId) {
      const me = runs().find((r) => r.id === runId);
      const before = runs()
        .filter((r) => r.run.workflow === workflowFile && r.id !== runId && (me ? r.run.startedAt < me.run.startedAt : true))
        .sort((a, b) => (a.run.startedAt < b.run.startedAt ? 1 : -1));
      return before[0]?.id ?? null;
    },
    async runLog(runId) {
      return runs().find((r) => r.id === runId)?.run.log ?? null;
    },
    async repoFacts(): Promise<RepoFacts> {
      return readJson<RepoFacts>(join(dir, 'facts.json'), { private: true, defaultWorkflowPermissions: 'read', secretNames: [] });
    },
  };
}
