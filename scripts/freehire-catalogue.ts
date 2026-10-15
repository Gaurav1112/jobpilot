/**
 * Build-time regeneration of the vendored freehire board seed (`assets/freehire/`). Nothing at run time reads freehire.
 *
 *   node --run catalogue:freehire -- --date 2026-10-16 --cache <dir> [--tarball <file>] [--offline] [--out assets/freehire]
 *
 * Input: the board catalogue (`sources/*.yml`) of freehire (MIT) at one pinned commit, whose CONTENT is pinned by a
 * digest (GitHub does not promise stable archive bytes), and freehire's documented keyless search API, queried once
 * per platform and location query for jobpilot's own India / worldwide-remote tech evidence (decision D1: raw
 * `location` and `title` only, through `evidenceOf`; no LLM-filled field is read). Every API body is cached under its
 * URL's sha256, and its body hash is listed in the manifest, so `--offline` replays the whole pass byte-identically.
 * No clock is read: `--date` is the only date in the outputs.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { gunzipSync } from 'node:zlib';
import { parse } from 'yaml';
import { platformClient } from '../src/app/agents/sources/platforms/client.js';
import { boardOfRow, checkPage, evidenceOf, FREEHIRE_API, stripTracking, type FreehireRow } from '../src/app/coverage/freehire-api.js';
import { isRealCompanyName, refOfFreehireBoard } from '../src/app/coverage/freehire-boards.js';
import type { Platform } from '../src/app/coverage/types.js';
import { readUstar } from './ustar.js';

export const CATALOGUE_COMMIT = '96b53a2c7b1e545bbad0868e16ec85a2eba4f36a';
export const CATALOGUE_CONTENT_SHA256 = '384b6c4fbdd22e75e25bf6f0d8903c897e7be569359a9cf1da72b889cd13c084';
export const CATALOGUE_FILES: readonly string[] = [
  'ashby', 'bamboohr', 'breezy', 'eightfold', 'freshteam', 'gem', 'greenhouse', 'icims', 'jazzhr', 'lever', 'manatal', 'oracle', 'personio',
  'pinpoint', 'recruitee', 'rippling', 'smartrecruiters', 'successfactors', 'teamtailor', 'workable', 'workday', 'zohorecruit',
];
export const EVIDENCE_QUERIES: readonly string[] = ['india bengaluru bangalore', 'worldwide anywhere global international'];
export const EVIDENCE_MAX_REQUESTS = 2000;
export const SEED_HARD_CAP_BYTES = 2 * 1024 * 1024;
export const SEED_TARGET_BYTES = 1024 * 1024;
export const REQUEST_SPACING_MS = 2000;
export const USER_AGENT = 'jobpilot/0.1 (+local)';
const TARBALL_URL = `https://codeload.github.com/strelov1/freehire/tar.gz/${CATALOGUE_COMMIT}`;
const RULE = 'sources-x D1/D2 (docs/superpowers/plans/2026-10-15-sources-expansion.md)';
const PAGE = 100;
const WINDOW = 10_000;
const MAX_TAR_BYTES = 800_000_000;

export interface Deps {
  readonly fetch: (url: string | URL, init?: RequestInit) => Promise<Response>;
  readonly sleep: (ms: number) => Promise<void>;
  readonly log: (line: string) => void;
  readonly env: Readonly<Record<string, string | undefined>>;
}
const defaults = (): Deps => ({ fetch: (u, i) => fetch(u, i), sleep: (ms) => new Promise((r) => setTimeout(r, ms)), log: (l) => console.log(l), env: process.env });

export interface Result {
  readonly bytes: number;
  readonly kept: number;
  readonly requests: number;
}

const sha256 = (b: string | Buffer): string => createHash('sha256').update(b).digest('hex');
/** Code-unit order, never locale-dependent. */
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The digest of the catalogue's content: for each file in the given order, `<name>.yml\n<sha256 of its bytes>\n`. */
export function contentDigest(files: readonly { readonly name: string; readonly data: Buffer }[]): string {
  return sha256(files.map((f) => `${f.name}\n${sha256(f.data)}\n`).join(''));
}

export function evidenceUrl(platform: string, query: string, offset: number): string {
  return `${FREEHIRE_API}/jobs/search?source=${platform}&q=${encodeURIComponent(query)}&q_fields=location&sort=created_at&order=asc&limit=${PAGE}&offset=${offset}`;
}

interface Entry {
  readonly company: string | null;
  readonly board: string;
}

function entriesOf(name: string, text: string): Entry[] {
  // failsafe: every scalar stays a string, so a numeric board id (`12345`) is not turned into a number
  const doc: unknown = parse(text, { schema: 'failsafe' });
  if (doc === null || doc === undefined) return [];
  if (!Array.isArray(doc)) throw new Error(`${name}.yml is not a list`);
  return doc.map((e: unknown, i) => {
    if (typeof e !== 'object' || e === null) throw new Error(`${name}.yml entry ${i} is not a mapping`);
    const { company, board } = e as Record<string, unknown>;
    if (typeof board !== 'string' || board === '') throw new Error(`${name}.yml entry ${i} has no board`);
    return { company: typeof company === 'string' ? company : null, board };
  });
}

interface Evidence {
  readonly rows: Map<string, FreehireRow>;
}

export async function run(argv: readonly string[], overrides: Partial<Deps> = {}): Promise<Result> {
  const deps = { ...defaults(), ...overrides };
  const { values } = parseArgs({
    args: [...argv],
    options: {
      date: { type: 'string' },
      cache: { type: 'string' },
      tarball: { type: 'string' },
      offline: { type: 'boolean', default: false },
      out: { type: 'string', default: 'assets/freehire' },
      'content-sha256-override': { type: 'string' },
    },
    strict: true,
  });
  const date = values.date;
  if (date === undefined || !/^\d{4}-\d{2}-\d{2}$/u.test(date)) throw new Error('--date YYYY-MM-DD is required (the only date in the outputs; no clock is read)');
  if (values.cache === undefined) throw new Error('--cache <dir> is required');
  const cache = resolve(values.cache);
  const out = resolve(values.out);
  const offline = values.offline === true;
  const override = values['content-sha256-override'];
  if (override !== undefined && deps.env['NODE_ENV'] !== 'test') throw new Error('--content-sha256-override is TEST ONLY: refused unless NODE_ENV=test');
  const expectedDigest = override ?? CATALOGUE_CONTENT_SHA256;
  mkdirSync(cache, { recursive: true });

  // 1. the tarball
  let tarRaw: Buffer;
  if (values.tarball !== undefined) tarRaw = readFileSync(resolve(values.tarball));
  else {
    const saved = join(cache, `${CATALOGUE_COMMIT}.tar.gz`);
    if (existsSync(saved)) tarRaw = readFileSync(saved);
    else {
      if (offline) throw new Error(`offline: the tarball is not in the cache (${saved}) and no --tarball was given`);
      const res = await deps.fetch(TARBALL_URL, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(120_000) });
      if (res.status !== 200) throw new Error(`HTTP ${res.status} from ${TARBALL_URL}`);
      tarRaw = Buffer.from(await res.arrayBuffer());
      writeFileSync(saved, tarRaw);
    }
  }
  const tar = tarRaw[0] === 0x1f && tarRaw[1] === 0x8b ? gunzipSync(tarRaw, { maxOutputLength: MAX_TAR_BYTES }) : tarRaw;
  const files = readUstar(tar);

  // 2. the pinned content
  const platformFiles = CATALOGUE_FILES.map((name) => {
    const hit = files.find((f) => new RegExp(`^[^/]+/sources/${name}\\.yml$`, 'u').test(f.path));
    if (hit === undefined) throw new Error(`the tarball has no sources/${name}.yml`);
    return { name: `${name}.yml`, platform: name, data: hit.data };
  });
  const digest = contentDigest(platformFiles);
  if (digest !== expectedDigest) throw new Error(`catalogue content digest mismatch: expected ${expectedDigest}, computed ${digest}`);
  const license = files.find((f) => /^[^/]+\/LICENSE$/u.test(f.path));
  if (license === undefined) throw new Error('the tarball has no LICENSE');

  // 3. the entries
  const entries = new Map<string, Entry[]>();
  for (const f of platformFiles) entries.set(f.platform, entriesOf(f.platform, f.data.toString('utf8')));

  // 4. the evidence pass (read-through cache; replays offline)
  const responses: string[] = [];
  const windowCapped: { platform: string; query: string; total: number }[] = [];
  const evidence = new Map<string, Evidence>();
  let network = 0;
  async function page(url: string): Promise<{ rows: FreehireRow[]; total: number }> {
    if (responses.length >= EVIDENCE_MAX_REQUESTS) throw new Error(`evidence pass over ${EVIDENCE_MAX_REQUESTS} requests at ${url}; tighten the pass, never truncate`);
    const file = join(cache, `${sha256(url)}.json`);
    let body: string;
    if (existsSync(file)) body = readFileSync(file, 'utf8');
    else {
      if (offline) throw new Error(`offline: page missing from the cache: ${url}`);
      if (network > 0) await deps.sleep(REQUEST_SPACING_MS);
      network += 1;
      let res: Response;
      try {
        res = await deps.fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' }, signal: AbortSignal.timeout(60_000) });
      } catch (e) {
        throw new Error(`${url}: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (res.status !== 200) throw new Error(`HTTP ${res.status} from ${url} (aborted, never retried)`);
      body = await res.text();
    }
    const checked = checkPage(body);
    if (!checked.ok) throw new Error(`${url}: ${checked.why}`);
    if (!existsSync(file)) writeFileSync(file, body);
    responses.push(sha256(body));
    return { rows: checked.rows, total: checked.total };
  }
  for (const f of platformFiles) {
    const platform = f.platform;
    if ((entries.get(platform) ?? []).length === 0) continue;
    const ev: Evidence = { rows: new Map() };
    evidence.set(platform, ev);
    for (const query of EVIDENCE_QUERIES) {
      let total = Number.POSITIVE_INFINITY;
      for (let offset = 0; offset < total && offset + PAGE <= WINDOW; offset += PAGE) {
        const p = await page(evidenceUrl(platform, query, offset));
        if (offset === 0) total = p.total;
        for (const row of p.rows) if (evidenceOf(row) !== null) ev.rows.set(`${row.source}\u0000${row.external_id}`, row);
      }
      if (total > WINDOW) {
        windowCapped.push({ platform, query, total });
        deps.log(`window-capped: ${platform} "${query}" has ${total} matches; only the first ${WINDOW} are readable`);
      }
    }
  }

  // 5. the seed
  const counts: Record<string, { entries: number; unnamed: number; untranslatable: number; noEvidence: number; duplicates: number; kept: number }> = {};
  const best = new Map<string, { evidence: number; line: Record<string, unknown>; company: string }>();
  for (const f of platformFiles) {
    const platform = f.platform as Platform;
    const list = entries.get(platform) ?? [];
    if (list.length === 0) continue;
    const c = { entries: list.length, unnamed: 0, untranslatable: 0, noEvidence: 0, duplicates: 0, kept: 0 };
    counts[platform] = c;
    const byBoard = new Map<string, FreehireRow[]>();
    for (const row of evidence.get(platform)?.rows.values() ?? []) {
      const b = boardOfRow(row);
      if (b === null || b.platform !== platform) continue;
      const k = b.board.toLowerCase();
      byBoard.set(k, [...(byBoard.get(k) ?? []), row]);
    }
    for (const e of list) {
      if (!isRealCompanyName(e.company, e.board)) { c.unnamed += 1; continue; }
      const ref = refOfFreehireBoard(platform, e.board);
      const client = platformClient(platform);
      if (ref === null || client === null) { c.untranslatable += 1; continue; }
      const rows = byBoard.get(e.board.toLowerCase()) ?? [];
      if (rows.length === 0) { c.noEvidence += 1; continue; }
      const newest = [...rows].sort((a, b) => cmp(b.created_at, a.created_at) || cmp(a.external_id, b.external_id))[0] as FreehireRow;
      const line = {
        platform, ref, boardUrl: client.boardUrl(ref), company: e.company, board: e.board, evidence: rows.length,
        example: { title: newest.title, location: newest.location, url: stripTracking(newest.url) },
      };
      const key = `${platform}\u0000${ref}`;
      const prior = best.get(key);
      if (prior === undefined) { best.set(key, { evidence: rows.length, line, company: e.company }); continue; }
      c.duplicates += 1;
      if (rows.length > prior.evidence || (rows.length === prior.evidence && cmp(e.company, prior.company) < 0)) best.set(key, { evidence: rows.length, line, company: e.company });
    }
  }
  const sorted = [...best.entries()].sort(([a], [b]) => cmp(a, b));
  for (const [key] of sorted) (counts[key.slice(0, key.indexOf('\u0000'))] as { kept: number }).kept += 1;
  const seed = sorted.map(([, v]) => `${JSON.stringify(v.line)}\n`).join('');
  const bytes = Buffer.byteLength(seed);
  if (bytes > SEED_HARD_CAP_BYTES) throw new Error(`seed over the 2 MB budget: ${bytes} bytes; tighten the rule, never truncate`);
  if (bytes > SEED_TARGET_BYTES) deps.log(`NOTE: the seed is ${bytes} bytes, over the 1 MB target (the hard cap is 2 MB); report it to the controller`);

  const manifest = {
    source: 'github.com/strelov1/freehire',
    commit: CATALOGUE_COMMIT,
    contentSha256: digest,
    license: 'MIT',
    generatedOn: date,
    rule: RULE,
    queries: [...EVIDENCE_QUERIES],
    requests: responses.length,
    responses,
    windowCapped,
    platforms: Object.fromEntries(Object.entries(counts).sort(([a], [b]) => cmp(a, b))),
    bytes,
  };
  const notice =
    `assets/freehire/catalogue-seed.jsonl is derived from the board catalogue of freehire\n` +
    `(https://github.com/strelov1/freehire), commit ${CATALOGUE_COMMIT}, sources/*.yml,\n` +
    `filtered by jobpilot's rule (see manifest.json). The source adapters for JazzHR, Zoho Recruit, Manatal and Freshteam\n` +
    `were written with freehire's adapters (commit 3957f7b) as a reference.\n\n${license.data.toString('utf8')}`;

  // 6. write, only now
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'catalogue-seed.jsonl'), seed);
  writeFileSync(join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(out, 'NOTICE'), notice);
  for (const [p, c] of Object.entries(manifest.platforms)) deps.log(`${p}: ${JSON.stringify(c)}`);
  deps.log(`requests ${responses.length} (network ${network}), kept ${sorted.length}, seed ${bytes} bytes, window-capped ${windowCapped.length}`);
  return { bytes, kept: sorted.length, requests: responses.length };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run(process.argv.slice(2)).catch((e: unknown) => {
    console.error(`catalogue:freehire aborted: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  });
}
