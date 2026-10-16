import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { AppStore } from '../store/app-store.js';
import { storeCompactCommand } from '../store/compact-command.js';
import { HOSTED_RETENTION_YAML, type HostedConfig } from './config.js';
import type { GitHubClient } from './github.js';
import { acquireLease, releaseLease, type Holder } from './state.js';
import { LAPTOP_LEASE_MINUTES, lastDoneOf, laptopHolder, publishHome, type PublishOutcome } from './sync.js';

/**
 * `hosted seed --from <home>` (spec 3.3): copy the source DB with SQLite's online backup API from a READ-ONLY
 * connection into a new temp home, copy out/ and the attempts files, then migrate and compact THE COPY (hosted
 * retention), and publish it as generation 1 on a fresh `state` branch. The source is never written: its bytes, mtime
 * and user_version stay as they were, and a -wal/-shm this process created beside it is removed again.
 */
export async function seedHome(o: { from: string; work: string; now: string }): Promise<{ home: string; dbBytes: number; outFiles: number }> {
  const srcDb = join(o.from, 'jobpilot.db');
  if (!existsSync(srcDb)) throw new Error(`hosted seed: there is no jobpilot.db in ${o.from}`);
  const home = join(o.work, 'home');
  if (existsSync(home) && readdirSync(home).length > 0) throw new Error('hosted seed: the work folder already holds a seeded home');
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const dstDb = join(home, 'jobpilot.db');

  const side = [`${srcDb}-wal`, `${srcDb}-shm`];
  const existed = side.map((f) => existsSync(f));
  const src = new Database(srcDb, { readonly: true, fileMustExist: true });
  try {
    await src.backup(dstDb);
  } finally {
    src.close();
    for (const [i, f] of side.entries()) if (existed[i] !== true && existsSync(f)) rmSync(f, { force: true });
  }

  // out/ and the attempt files travel with the state (the same set a state bundle holds, minus logs)
  let outFiles = 0;
  if (existsSync(join(o.from, 'out'))) {
    cpSync(join(o.from, 'out'), join(home, 'out'), {
      recursive: true,
      filter: (s) => {
        if (statSync(s).isFile()) outFiles++;
        return true;
      },
    });
  }
  for (const e of readdirSync(o.from, { withFileTypes: true })) {
    if (e.isFile() && (e.name === 'coverage-start.json' || /^[A-Za-z0-9._-]*-attempts\.json$/.test(e.name))) cpSync(join(o.from, e.name), join(home, e.name));
  }

  // migrate and compact the COPY only; its pack/ holds just the retention policy and is never bundled
  AppStore.open(dstDb, { schema: 'migrate' }).close();
  mkdirSync(join(home, 'pack'), { recursive: true, mode: 0o700 });
  writeFileSync(join(home, 'pack', 'retention.yaml'), HOSTED_RETENTION_YAML);
  const lines: string[] = [];
  const code = await storeCompactCommand({
    home,
    clock: { now: () => o.now },
    out: (l) => lines.push(l),
    err: (l) => lines.push(l),
    apply: true,
    includeIncomplete: true,
    vacuum: true,
  });
  if (code !== 0) throw new Error(`hosted seed: compacting the copy failed (${lines.at(-1) ?? 'no output'})`);
  return { home, dbBytes: statSync(dstDb).size, outFiles };
}

/** Seeds, then publishes the copy as generation 1. Refuses when the `state` branch already has a generation. */
export async function seedAndPublish(o: {
  gh: GitHubClient;
  key: Buffer;
  from: string;
  work: string;
  now: string;
  codeSha: string;
  state: HostedConfig['state'];
}): Promise<PublishOutcome> {
  const existing = await o.gh.readState();
  if (existing !== null && existing.pointer.gen > 0) throw new Error('hosted seed: state exists (generation ' + existing.pointer.gen + '); use hosted push');
  const seeded = await seedHome({ from: o.from, work: o.work, now: o.now });
  if (existing === null) await o.gh.initState('init');
  const holder: Holder = laptopHolder();
  const until = new Date(Date.parse(o.now) + LAPTOP_LEASE_MINUTES * 60_000).toISOString();
  const base = await acquireLease(o.gh, holder, o.now, until);
  const archiveDir = join(seeded.home, 'archive');
  const archiveSegments = existsSync(archiveDir) ? readdirSync(archiveDir).sort() : [];
  let out: PublishOutcome | undefined;
  try {
    out = await publishHome({
      gh: o.gh,
      key: o.key,
      home: seeded.home,
      tmpDir: join(o.work, 'tmp'),
      base,
      holder,
      now: o.now,
      codeSha: o.codeSha,
      lastDone: lastDoneOf(join(seeded.home, 'jobpilot.db')),
      state: o.state,
      budget: base.pointer.budget,
      archiveSegments,
    });
    return out;
  } finally {
    if (out === undefined || !out.ok) await releaseLease(o.gh, holder).catch(() => undefined);
  }
}
