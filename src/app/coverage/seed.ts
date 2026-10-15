import { gunzipSync } from 'node:zlib';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { defineAgent, type AgentContext } from '../../kernel/agent.js';
import { defineContract } from '../../kernel/contract.js';
import { KernelError } from '../../kernel/errors.js';
import type { AppStore } from '../store/app-store.js';
import { CompanyCandidate, CoverageRequest, type CandidateSource } from './types.js';

/**
 * The company seed (spec §3): the deterministic list of candidate companies for the weekly coverage run. One
 * `CoverageRequest@1` per source; each answer is that source's `CompanyCandidate@1` values, one per `companyKey`,
 * sorted by it. `mergeCandidates` joins the four lists (the coverage pipeline does that between the seed and the
 * locator). No clock, no randomness, no model.
 *
 * Sources:
 * - `picks`  : `items` = `pack.companies` (the user's companies.yaml), handed in by the app layer.
 * - `jobs`   : `items` = `seedItemsFromJobs(app)`: the distinct companies seen in daily runs.
 * - `remoteintech`: ONE request for the repo archive (see REMOTEINTECH_URL), not 884 file fetches.
 * - `yc`     : the yc-oss `hiring.json` list.
 */

export const REMOTEINTECH_HOST = 'codeload.github.com';
export const REMOTEINTECH_URL = `https://${REMOTEINTECH_HOST}/remoteintech/remote-jobs/tar.gz/refs/heads/main`;
export const YC_HOST = 'yc-oss.github.io';
export const YC_URL = `https://${YC_HOST}/api/companies/hiring.json`;

/** Size caps for the archive. Live on 2026-10-13: 2.6 MB compressed, 4.9 MB expanded, 884 company files. */
export const MAX_COMPRESSED_BYTES = 20_000_000;
export const MAX_EXPANDED_BYTES = 80_000_000;

/**
 * The registrable domain is found by a fixed rule, not the full Public Suffix List:
 * 1. a host with 3 or more labels whose TLD is a 2-letter ccTLD and whose second-to-last label is one of
 *    `CC_SECOND_LEVEL` (`co`, `com`, `org`, `ac`, `gov`, ...) is registered one label deeper: `foo.co.za` is
 *    `foo.co.za`, `www.bar.com.mx` is `bar.com.mx`, `jobs.x.gov.uk` is `x.gov.uk`;
 * 2. a hosting suffix (`HOSTING_SUFFIXES`: GitHub Pages, Vercel, Netlify, ...) gives each tenant its own key:
 *    `x.github.io` is `x.github.io`;
 * 3. `MULTI_PART_SUFFIXES` are explicit additions (kept for the suffixes the brief named);
 * 4. any other host is its last two labels (`www.okta.com` is `okta.com`).
 * A host that IS a suffix (`co.uk`, `github.io`, `co.za`) has no registrable domain (null; the caller notes it).
 * A ccTLD second level outside the set (say `foo.ltd.xx`) would be keyed as `ltd.xx`: extend the sets, never guess.
 */
const CC_SECOND_LEVEL: ReadonlySet<string> = new Set(['co', 'com', 'org', 'net', 'gov', 'ac', 'edu', 'ne', 'or', 'go', 'gob', 'nic', 'mil', 'ltd', 'plc', 'sch']);
export const HOSTING_SUFFIXES: ReadonlySet<string> = new Set([
  'herokuapp.com', 'netlify.app', 'pages.dev', 'web.app', 'vercel.app', 'github.io', 'firebaseapp.com', 'azurewebsites.net', 'onrender.com',
  // Task 11 fix round 1: more shared hosts whose tenants are different companies (a three-label one included)
  'workers.dev', 'sites.google.com', 'gitlab.io', 'webflow.io', 'wixsite.com', 'myshopify.com', 'blogspot.com', 'wordpress.com', 'notion.site',
  'framer.website', 'framer.app', 'surge.sh', 'fly.dev', 'appspot.com', 'azurestaticapps.net', 'readthedocs.io', 'carrd.co', 'netlify.com',
]);
export const MULTI_PART_SUFFIXES: ReadonlySet<string> = new Set([
  'co.in', 'co.uk', 'com.au', 'com.br', 'co.jp', 'co.nz', 'com.sg', 'com.cn', 'org.uk', 'ac.in', 'net.in', 'firm.in', 'gen.in', 'ind.in',
]);

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/u;

/** The registrable domain of a host, lowercase, or null for an IP, `localhost`, a single label or a bare suffix. */
export function registrableDomain(host: string): string | null {
  const h = host.trim().toLowerCase().replace(/\.+$/u, '');
  if (h === '' || h === 'localhost' || h.includes(':') || h.startsWith('[') || IPV4.test(h)) return null;
  const labels = h.split('.');
  if (labels.length < 2 || labels.some((l) => l === '')) return null;
  // a shared hosting suffix (of any length): the tenant label under it is the domain; the bare suffix has none
  for (const suffix of HOSTING_SUFFIXES) {
    if (h === suffix) return null;
    if (h.endsWith(`.${suffix}`)) return labels.slice(-(suffix.split('.').length + 1)).join('.');
  }
  const tld = labels[labels.length - 1] as string;
  const second = labels[labels.length - 2] as string;
  const last2 = `${second}.${tld}`;
  if (HOSTING_SUFFIXES.has(last2) || MULTI_PART_SUFFIXES.has(last2) || (/^[a-z]{2}$/u.test(tld) && CC_SECOND_LEVEL.has(second))) {
    return labels.length >= 3 ? labels.slice(-3).join('.') : null;
  }
  return last2;
}

/** `https://host` for a website string (a missing scheme means https), plus its registrable domain; or why not. */
export function resolveWebsite(raw: string): { readonly origin: string; readonly key: string } | { readonly reason: string } {
  const t = raw.trim();
  if (t === '') return { reason: 'no website' };
  let u: URL;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//iu.test(t) ? t : `https://${t}`);
  } catch {
    return { reason: `website is not a URL: ${t.slice(0, 80)}` };
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { reason: `website is not http(s): ${t.slice(0, 80)}` };
  const key = registrableDomain(u.hostname);
  if (key === null) return { reason: `website host has no registrable domain: ${u.hostname}` };
  return { origin: u.origin, key };
}

const httpUrlOrNull = (raw: unknown): string | null => {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  try {
    const u = new URL(raw.trim());
    return u.protocol === 'https:' || u.protocol === 'http:' ? raw.trim() : null;
  } catch {
    return null;
  }
};

/**
 * What one source yields. `skipped` counts entries that could not be read at all (checked against the total for
 * the all-failed rule); `notes` are further things worth reporting that are not failures, e.g. a pick with no website.
 */
export interface Parsed {
  readonly candidates: CompanyCandidate[];
  readonly skipped: string[];
  readonly notes: string[];
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const collision = (where: string, dropped: CompanyCandidate, kept: CompanyCandidate): string =>
  `${where}: "${dropped.name}" (${dropped.source}) dropped, ${dropped.companyKey} is held by "${kept.name}" (${kept.source})`;

/** One candidate per companyKey (the first by name wins), sorted by companyKey. Every drop is named in `notes`. */
function finish(candidates: readonly CompanyCandidate[], notes: string[]): CompanyCandidate[] {
  const sorted = [...candidates].sort((a, b) => cmp(a.companyKey, b.companyKey) || cmp(a.name, b.name));
  const out: CompanyCandidate[] = [];
  for (const c of sorted) {
    const last = out[out.length - 1];
    if (last !== undefined && last.companyKey === c.companyKey) notes.push(collision('same key', c, last));
    else out.push(c);
  }
  return out;
}

/** A source with entries where every one failed is schema drift: fail the step instead of reporting no companies. */
function checkAllFailed(source: string, what: string, total: number, skipped: number): void {
  if (total > 0 && skipped === total) throw new KernelError('invalid_output', `${source}: all ${total} ${what} failed to parse`);
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const RANK: Record<CandidateSource, number> = { pick: 0, remoteintech: 1, yc: 2, jobs: 3, freehire: 4, 'freehire-discovery': 5 };

/**
 * Joins the sources: one candidate per companyKey, the highest source wins (pick > remoteintech > yc > jobs; ties by
 * name), and its name, website and careersUrl are used as they are. Sorted by companyKey, independent of input order.
 * `onDropped` receives a note for every candidate that lost its key to another (naming both); none is dropped silently.
 */
export function mergeCandidates(all: readonly CompanyCandidate[], onDropped?: (note: string) => void): CompanyCandidate[] {
  const best = new Map<string, CompanyCandidate>();
  const drops: { readonly dropped: CompanyCandidate; readonly keptKey: string }[] = [];
  for (const c of all) {
    const cur = best.get(c.companyKey);
    if (cur === undefined) best.set(c.companyKey, c);
    else if (RANK[c.source] < RANK[cur.source] || (c.source === cur.source && cmp(c.name, cur.name) < 0)) {
      best.set(c.companyKey, c);
      drops.push({ dropped: cur, keptKey: c.companyKey });
    } else drops.push({ dropped: c, keptKey: c.companyKey });
  }
  if (onDropped !== undefined) {
    const notes = drops.map((d) => collision('merge', d.dropped, best.get(d.keptKey) as CompanyCandidate));
    for (const n of notes.sort(cmp)) onDropped(n);
  }
  return [...best.values()].sort((a, b) => cmp(a.companyKey, b.companyKey));
}

// ---------------------------------------------------------------------------------------------------------------
// tar
// ---------------------------------------------------------------------------------------------------------------

export interface TarFile {
  readonly name: string;
  readonly data: Uint8Array;
}

const bad = (message: string): KernelError => new KernelError('invalid_output', `tar: ${message}`);

function cString(b: Uint8Array): string {
  const nul = b.indexOf(0);
  return Buffer.from(nul < 0 ? b : b.subarray(0, nul)).toString('utf8');
}

function octal(b: Uint8Array, what: string): number {
  if (((b[0] ?? 0) & 0x80) !== 0) throw bad(`unsupported binary ${what} field`);
  const s = cString(b).trim();
  if (s === '') return 0;
  if (!/^[0-7]+$/u.test(s)) throw bad(`bad ${what} field`);
  return Number.parseInt(s, 8);
}

/** The `path` record of a pax extended header (`<len> path=<value>\n` records); everything else is ignored. */
function paxPath(data: Uint8Array): string | undefined {
  const buf = Buffer.from(data);
  let pos = 0;
  let path: string | undefined;
  while (pos < buf.length) {
    const sp = buf.indexOf(0x20, pos);
    if (sp < 0) break;
    const len = Number.parseInt(buf.subarray(pos, sp).toString('ascii'), 10);
    if (!Number.isFinite(len) || len <= sp - pos + 1 || pos + len > buf.length) throw bad('bad pax record');
    const rec = buf.subarray(sp + 1, pos + len - 1).toString('utf8');
    const eq = rec.indexOf('=');
    if (eq > 0 && rec.slice(0, eq) === 'path') path = rec.slice(eq + 1);
    pos += len;
  }
  return path;
}

/**
 * A minimal ustar reader. 512-byte headers; name (plus the ustar prefix), size and typeflag are read, the checksum is
 * verified. Regular files (typeflag `0`, NUL or `7`) whose full name `keep` accepts are returned, in archive order.
 * A GNU long name (`L`) and a pax `path` record (`x`) rename the next entry; pax global headers (`g`), GNU long link
 * names (`K`), directories, links and every other type are skipped. A binary (base-256) size, a bad checksum or a
 * truncated archive is `invalid_output`. The end is the first all-zero block (or the end of the data).
 */
export function readTar(tar: Uint8Array, keep: (name: string) => boolean): TarFile[] {
  const buf = Buffer.from(tar.buffer, tar.byteOffset, tar.byteLength);
  const out: TarFile[] = [];
  let pos = 0;
  let override: string | undefined;
  while (pos < buf.length) {
    const h = buf.subarray(pos, pos + 512);
    if (h.every((b) => b === 0)) break;
    if (h.length < 512) throw bad('truncated header');
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : (h[i] as number);
    if (sum !== octal(h.subarray(148, 156), 'checksum')) throw bad(`checksum mismatch at offset ${pos}`);
    const size = octal(h.subarray(124, 136), 'size');
    const type = String.fromCharCode(h[156] as number);
    const dataStart = pos + 512;
    if (dataStart + size > buf.length) throw bad(`truncated data for ${cString(h.subarray(0, 100))}`);
    const data = buf.subarray(dataStart, dataStart + size);
    pos = dataStart + Math.ceil(size / 512) * 512;
    if (type === 'L') {
      override = cString(data);
      continue;
    }
    if (type === 'x') {
      override = paxPath(data) ?? override;
      continue;
    }
    if (type === 'g' || type === 'K') continue;
    const prefix = cString(h.subarray(345, 500));
    const own = cString(h.subarray(0, 100));
    const name = override ?? (prefix !== '' && cString(h.subarray(257, 262)) === 'ustar' ? `${prefix}/${own}` : own);
    override = undefined;
    if ((type === '0' || type === '\0' || type === '7') && keep(name)) out.push({ name, data });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// remoteintech
// ---------------------------------------------------------------------------------------------------------------

/** `<archive root>/src/companies/<slug>.md`, as in the archive of 2026-10-13. */
const COMPANY_FILE = /^[^/.][^/]*\/src\/companies\/[^/]+\.md$/u;
const FRONTMATTER = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/u;

/** The archive's company files as candidates. Caps: 20 MB compressed, 80 MB expanded (`invalid_output` beyond). */
export function parseRemoteIntech(gz: Uint8Array, runDate: string): Parsed {
  if (gz.byteLength > MAX_COMPRESSED_BYTES) throw new KernelError('invalid_output', `remoteintech: archive exceeds ${MAX_COMPRESSED_BYTES / 1_000_000} MB compressed`);
  let tar: Buffer;
  try {
    tar = gunzipSync(gz, { maxOutputLength: MAX_EXPANDED_BYTES });
  } catch (e) {
    if ((e as { code?: unknown }).code === 'ERR_BUFFER_TOO_LARGE') {
      throw new KernelError('invalid_output', `remoteintech: archive exceeds ${MAX_EXPANDED_BYTES / 1_000_000} MB expanded`);
    }
    throw new KernelError('invalid_output', 'remoteintech: body is not a valid gzip archive');
  }
  const files = readTar(tar, (n) => COMPANY_FILE.test(n)).sort((a, b) => cmp(a.name, b.name));
  if (files.length === 0) throw new KernelError('invalid_output', 'remoteintech: no company files under */src/companies/ (archive layout changed?)');
  const candidates: CompanyCandidate[] = [];
  const skipped: string[] = [];
  const notes: string[] = [];
  for (const f of files) {
    const base = f.name.slice(f.name.lastIndexOf('/') + 1);
    const fm = FRONTMATTER.exec(Buffer.from(f.data).toString('utf8'));
    if (fm === null) {
      skipped.push(`remoteintech ${base}: no frontmatter`);
      continue;
    }
    let meta: unknown;
    try {
      meta = parseYaml(fm[1] as string, { maxAliasCount: 10 });
    } catch {
      skipped.push(`remoteintech ${base}: frontmatter is not valid YAML`);
      continue;
    }
    const title = isRecord(meta) ? (typeof meta.title === 'number' ? String(meta.title) : meta.title) : undefined;
    if (!isRecord(meta) || typeof title !== 'string' || title.trim() === '') {
      skipped.push(`remoteintech ${base}: frontmatter has no title`);
      continue;
    }
    const site = resolveWebsite(typeof meta.website === 'string' ? meta.website : '');
    if ('reason' in site) {
      skipped.push(`remoteintech ${base}: ${site.reason}`);
      continue;
    }
    candidates.push({ companyKey: site.key, name: title.trim(), website: site.origin, careersUrl: httpUrlOrNull(meta.careers_url), source: 'remoteintech', runDate });
  }
  checkAllFailed('remoteintech', 'company files', files.length, skipped.length);
  return { candidates: finish(candidates, notes), skipped, notes };
}

// ---------------------------------------------------------------------------------------------------------------
// yc
// ---------------------------------------------------------------------------------------------------------------

/**
 * The yc-oss hiring list. Kept: `status === 'Active'` and `isHiring === true`; other companies are filtered, not
 * skipped. An entry that is kept but has no usable website, or is not an object with a name, status and isHiring, is skipped.
 */
export function parseYc(json: unknown, runDate: string): Parsed {
  if (!Array.isArray(json)) throw new KernelError('invalid_output', 'yc: expected a JSON array of companies');
  const candidates: CompanyCandidate[] = [];
  const skipped: string[] = [];
  json.forEach((c: unknown, i: number) => {
    if (!isRecord(c) || typeof c.name !== 'string' || c.name.trim() === '' || typeof c.status !== 'string' || typeof c.isHiring !== 'boolean') {
      skipped.push(`yc entry ${i}: missing name, status or isHiring`);
      return;
    }
    if (c.status !== 'Active' || !c.isHiring) return;
    const site = resolveWebsite(typeof c.website === 'string' ? c.website : '');
    if ('reason' in site) {
      skipped.push(`yc ${c.name.trim()}: ${site.reason}`);
      return;
    }
    candidates.push({ companyKey: site.key, name: c.name.trim(), website: site.origin, careersUrl: null, source: 'yc', runDate });
  });
  checkAllFailed('yc', 'entries', json.length, skipped.length);
  if (candidates.length === 0) throw new KernelError('invalid_output', `yc: no Active, hiring company with a website among ${json.length} entries`);
  const notes: string[] = [];
  return { candidates: finish(candidates, notes), skipped, notes };
}

// ---------------------------------------------------------------------------------------------------------------
// picks and jobs (items come from the app layer)
// ---------------------------------------------------------------------------------------------------------------

const PickItem = z.object({ name: z.string().trim().min(1), website: z.string().optional(), careersUrl: z.string().optional() });
const JobItem = z.object({ name: z.string().trim().min(1), website: z.string().nullable() });

function fromItems<T extends { readonly name: string; readonly website?: string | null | undefined; readonly careersUrl?: string | undefined }>(
  source: 'picks' | 'jobs',
  as: CandidateSource,
  schema: z.ZodType<T>,
  items: unknown,
  runDate: string,
): Parsed {
  if (!Array.isArray(items)) throw new KernelError('invalid_output', `${source}: items must be an array`);
  const candidates: CompanyCandidate[] = [];
  const skipped: string[] = [];
  const notes: string[] = [];
  let unkeyed = 0;
  items.forEach((raw: unknown, i: number) => {
    const p = schema.safeParse(raw);
    if (!p.success) {
      skipped.push(`${source} item ${i}: not a company`);
      return;
    }
    const it = p.data;
    const site = resolveWebsite(it.website ?? '');
    if ('reason' in site) {
      // Most seen-job companies have no website: one count for them, a note per pick.
      if (source === 'jobs' && (it.website ?? '') === '') unkeyed++;
      else notes.push(`${source} ${it.name}: ${site.reason}`);
      return;
    }
    const careersUrl = httpUrlOrNull(it.careersUrl);
    if (it.careersUrl !== undefined && it.careersUrl.trim() !== '' && careersUrl === null) notes.push(`${source} ${it.name}: careersUrl is not an http(s) URL, ignored`);
    candidates.push({ companyKey: site.key, name: it.name, website: site.origin, careersUrl, source: as, runDate });
  });
  if (unkeyed > 0) notes.push(`jobs: ${unkeyed} companies have no known website`);
  checkAllFailed(source, 'items', items.length, skipped.length);
  return { candidates: finish(candidates, notes), skipped, notes };
}

export const parsePicksItems = (items: unknown, runDate: string): Parsed => fromItems('picks', 'pick', PickItem, items, runDate);
export const parseJobsItems = (items: unknown, runDate: string): Parsed => fromItems('jobs', 'jobs', JobItem, items, runDate);

/**
 * Registrable domains of ATS vendors and job boards. A job from the `careers` source can sit on one of these, and
 * then its host says nothing about the employer (every Lever company would share `lever.co`), so it is not a website.
 */
export const SHARED_HOSTS: ReadonlySet<string> = new Set([
  'greenhouse.io', 'lever.co', 'ashbyhq.com', 'workable.com', 'myworkdayjobs.com', 'smartrecruiters.com', 'icims.com', 'bamboohr.com',
  'recruitee.com', 'teamtailor.com', 'personio.de', 'personio.com', 'breezy.hr', 'pinpointhq.com', 'rippling.com', 'jobvite.com',
  'linkedin.com', 'indeed.com', 'naukri.com', 'himalayas.app', 'wellfound.com',
]);

/**
 * SELECT-only: the distinct companies in the `jobs` table, sorted by name. `website` is `https://<host>` of the
 * company's own careers page when a job came from the `careers` source (the smallest such host, for determinism)
 * and that host is not a shared ATS or job-board domain; otherwise null.
 */
export function seedItemsFromJobs(app: AppStore): { name: string; website: string | null }[] {
  const rows = app.kernel.db.prepare(`SELECT company, url, source, ats FROM jobs ORDER BY company, url`).all() as { company: string; url: string; source: string; ats: string }[];
  const byName = new Map<string, string | null>();
  for (const r of rows) {
    const name = r.company.trim();
    if (name === '') continue;
    if (!byName.has(name)) byName.set(name, null);
    if (r.source !== 'careers' && r.ats !== 'careers') continue;
    let host: string;
    try {
      host = new URL(r.url).hostname.toLowerCase();
    } catch {
      continue;
    }
    const key = registrableDomain(host);
    if (key === null || SHARED_HOSTS.has(key)) continue;
    const cur = byName.get(name) ?? null;
    const site = `https://${host}`;
    if (cur === null || site < cur) byName.set(name, site);
  }
  return [...byName].map(([name, website]) => ({ name, website })).sort((a, b) => cmp(a.name, b.name));
}

/**
 * Task 11: the registry's own picks (source `pick`: added on the dashboard, or a pick verified earlier) that are not in
 * `companies.yaml`, as picks seed items, so the weekly run verifies a company the user added on the dashboard and keeps
 * re-verifying it. A rejected company is left out (it is never verified again); a pick whose key a `companies.yaml`
 * entry already holds is left out (the file's entry seeds it). SELECT-only; by key.
 */
export function registryPickItems(app: AppStore, packPicks: readonly { readonly website?: string | undefined }[]): { name: string; website: string; careersUrl?: string }[] {
  const inPack = new Set(packPicks.map((p) => resolveWebsite(p.website ?? '')).flatMap((r) => ('key' in r ? [r.key] : [])));
  return app
    .listCompanies({ source: 'pick' })
    .filter((c) => c.status !== 'rejected' && c.userOverride !== 'rejected' && !inPack.has(c.companyKey))
    .map((c) => ({ name: c.name, website: c.website, ...(c.careersUrl !== null ? { careersUrl: c.careersUrl } : {}) }));
}

// ---------------------------------------------------------------------------------------------------------------
// the agent
// ---------------------------------------------------------------------------------------------------------------

export const companySeedContract = defineContract({
  id: 'company-seed',
  // 1.1.0: a 429 is no longer retried (final review N1: a refusal is never retried around)
  version: '1.2.0',
  description: 'Builds the candidate companies for a coverage run from one source',
  skills: ['company-seed'],
  team: 'coverage-seed',
  kind: 'io',
  consumes: CoverageRequest,
  produces: CompanyCandidate,
  capabilities: { http: true },
  egress: [REMOTEINTECH_HOST, YC_HOST],
  dataClasses: { in: ['P0'], out: ['P0'] },
  budget: { usdPerCall: 0, usdPerRun: 0 },
  timeoutMs: 60_000,
  retry: { max: 2, on: ['overloaded', 'network', 'timeout'], backoffMs: [2000, 8000] },
});

function http(ctx: AgentContext): NonNullable<AgentContext['http']> {
  if (!ctx.http) throw new KernelError('policy_denied', 'no http capability issued');
  return ctx.http;
}

const refused = (source: string, host: string, status: number): KernelError => new KernelError('invalid_output', `${source}: ${host} returned ${status}`);

export const companySeed = defineAgent(companySeedContract, async (req, ctx) => {
  let parsed: Parsed;
  switch (req.source) {
    case 'picks':
      parsed = parsePicksItems(req.items, req.runDate);
      break;
    case 'jobs':
      parsed = parseJobsItems(req.items, req.runDate);
      break;
    case 'remoteintech': {
      const { status, bytes } = await http(ctx).getBytes(REMOTEINTECH_URL);
      if (status >= 400) throw refused('remoteintech', REMOTEINTECH_HOST, status);
      parsed = parseRemoteIntech(bytes, req.runDate);
      break;
    }
    case 'yc': {
      const { status, json } = await http(ctx).getJson(YC_URL);
      if (status >= 400) throw refused('yc', YC_HOST, status);
      parsed = parseYc(json, req.runDate);
      break;
    }
  }
  const notes = [...parsed.skipped, ...parsed.notes];
  if (notes.length > 0) ctx.skipped(notes);
  return parsed.candidates;
});
