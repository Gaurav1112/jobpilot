import type { GitHubClient, StateHead } from './github.js';
import type { GenRecord, Pointer } from './pointer.js';
import { pointerJson } from './pointer.js';

export type Holder = `actions:${string}` | `laptop:${string}`;

export class StateBusy extends Error {
  constructor(
    readonly holder: string,
    readonly until: string,
  ) {
    super(`state is leased by ${holder} until ${until}`);
    this.name = 'StateBusy';
  }
}
/** Another writer moved the pointer (spec 6, "CAS push rejected"). */
export class StateConflict extends Error {
  constructor(message = 'state conflict: another writer moved the pointer') {
    super(message);
    this.name = 'StateConflict';
  }
}
export const CAS_RETRIES = 3;
const HISTORY_MAX = 30;

const isLive = (lease: Pointer['lease'], now: string): boolean => lease !== null && Date.parse(lease.until) >= Date.parse(now);

async function readHead(gh: GitHubClient): Promise<StateHead> {
  const head = await gh.readState();
  if (head === null) throw new Error('the state branch does not exist (run hosted init)');
  return head;
}

/** Runs `step` on a fresh head; a rejected CAS re-reads, at most CAS_RETRIES times, then StateConflict. */
async function withCas(gh: GitHubClient, step: (head: StateHead) => Promise<StateHead | 'retry'>): Promise<StateHead> {
  for (let attempt = 0; attempt <= CAS_RETRIES; attempt++) {
    const r = await step(await readHead(gh));
    if (r !== 'retry') return r;
  }
  throw new StateConflict(`state conflict: the pointer kept moving (${CAS_RETRIES} retries)`);
}

/** Takes the lease when it is free or expired (spec 3.3 table), in one CAS commit; StateBusy otherwise. */
export function acquireLease(gh: GitHubClient, holder: Holder, now: string, until: string): Promise<StateHead> {
  return withCas(gh, async (head) => {
    const { lease } = head.pointer;
    if (lease !== null && isLive(lease, now)) throw new StateBusy(lease.holder, lease.until);
    const pointer: Pointer = { ...head.pointer, lease: { holder, until } };
    const r = await gh.casState(head.commit, { 'pointer.json': pointerJson(pointer) }, `lease ${holder}`);
    return r.ok ? { commit: r.commit, pointer } : 'retry';
  });
}

/** gen G to G+1 with the new record, history (max 30) and the lease cleared; `files` (shadow digests) ride in the same commit. */
export function commitGeneration(
  gh: GitHubClient,
  base: StateHead,
  holder: Holder,
  rec: GenRecord,
  o: { readonly files?: Readonly<Record<string, string>>; readonly sizeHard: boolean; readonly budget: Pointer['budget'] },
): Promise<StateHead> {
  const g = base.pointer.gen;
  if (rec.gen !== g + 1) throw new Error(`commitGeneration: record gen ${rec.gen} is not ${g + 1}`);
  return withCas(gh, async (head) => {
    const p = head.pointer;
    if (p.lease?.holder !== holder) throw new StateConflict(`state conflict: the lease is no longer ${holder}'s`);
    if (p.gen !== g) throw new StateConflict(`state conflict: gen moved from ${g} to ${p.gen}`);
    // after a rollback, history may still hold generations above G: they are replaced by the new line.
    const history = [rec, ...p.history.filter((h) => h.gen < rec.gen)].slice(0, HISTORY_MAX);
    const pointer: Pointer = { ...p, gen: rec.gen, current: rec, lease: null, budget: o.budget, sizeHard: o.sizeHard, history };
    const r = await gh.casState(head.commit, { ...(o.files ?? {}), 'pointer.json': pointerJson(pointer) }, `generation ${rec.gen}`);
    return r.ok ? { commit: r.commit, pointer } : 'retry';
  });
}

/** Clears our lease, gen unchanged; false when the lease is no longer ours. */
export async function releaseLease(gh: GitHubClient, holder: Holder): Promise<boolean> {
  let released = false;
  await withCas(gh, async (head) => {
    if (head.pointer.lease?.holder !== holder) return head;
    const pointer: Pointer = { ...head.pointer, lease: null };
    const r = await gh.casState(head.commit, { 'pointer.json': pointerJson(pointer) }, `release ${holder}`);
    if (!r.ok) return 'retry';
    released = true;
    return { commit: r.commit, pointer };
  });
  return released;
}

/** Appends lines to `ledger/<YYYY-MM>.jsonl` (or writes other state files) without touching the pointer. */
export async function appendStateFiles(
  gh: GitHubClient,
  edit: (head: StateHead, read: (p: string) => Promise<string | null>) => Promise<Readonly<Record<string, string>>>,
  message: string,
): Promise<void> {
  await withCas(gh, async (head) => {
    const files = await edit(head, (p) => gh.readStateFile(p));
    if (Object.keys(files).length === 0) return head;
    const r = await gh.casState(head.commit, files, message);
    return r.ok ? { commit: r.commit, pointer: head.pointer } : 'retry';
  });
}

/** gen = K from `history` (no live lease); refuses a schema below the current one without `withCode`. */
export function rollbackTo(gh: GitHubClient, k: number, now: string, o: { readonly withCode?: string }): Promise<StateHead> {
  return withCas(gh, async (head) => {
    const p = head.pointer;
    if (p.lease !== null && isLive(p.lease, now)) throw new StateBusy(p.lease.holder, p.lease.until);
    const target = p.history.find((h) => h.gen === k);
    if (!target) throw new Error(`rollback: generation ${k} is not in history`);
    const cur = p.current?.schema;
    if (cur && (target.schema.kernel < cur.kernel || target.schema.app < cur.app) && !o.withCode) {
      throw new Error(
        `rollback below schema ${cur.kernel}.${cur.app} needs the code that wrote it: pass --with-code <sha> and set code.lock to it`,
      );
    }
    const pointer: Pointer = { ...p, gen: target.gen, current: target, lease: null };
    const r = await gh.casState(head.commit, { 'pointer.json': pointerJson(pointer) }, `rollback to ${k}`);
    return r.ok ? { commit: r.commit, pointer } : 'retry';
  });
}
