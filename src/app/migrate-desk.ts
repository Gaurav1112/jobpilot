import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertNoForbidden, ForbiddenTermError } from './pack/load.js';
import type { Naming } from './pack/schema.js';
import type { AppStore, JobStatus } from './store/app-store.js';
import { JOB_STATUSES } from './store/schema.js';
import { dedupeKey, jobKey } from './text/norm.js';

export const NOTE_REMOVED = '[note removed: contained a forbidden term]';

/** Application Desk doc id prefix → jobpilot source name. The rest of the id is the source id. */
export const DESK_PREFIXES: Readonly<Record<string, string>> = {
  'gh-': 'greenhouse',
  'lv-': 'lever',
  'ab-': 'ashby',
  'wf-': 'wellfound',
  'li-': 'linkedin',
  'nk-': 'naukri',
  'ih-': 'instahyre',
};

export interface DeskReport {
  /** Job files read (every `*.json` in `<dir>/jobs`). */
  readonly read: number;
  readonly inserted: number;
  /** Rows whose posting a run had already found (same source id), now carrying the Desk status. */
  readonly attached: number;
  /** Imported rows that are a cross-source duplicate listing (same dedupe key, another source) of another row. */
  readonly duplicates: number;
  /** Rows whose `(source, sourceId)` was already imported: a re-run. */
  readonly alreadyPresent: number;
  /** Notes replaced by `NOTE_REMOVED`. */
  readonly notesSanitised: number;
  /** `why` texts dropped for holding a forbidden term. */
  readonly whyRemoved: number;
  readonly skipped: { file: string; reason: string }[];
  /** Imported rows (inserted or attached) by their Desk status, and by source. */
  readonly byStatus: Record<string, number>;
  readonly bySource: Record<string, number>;
}

interface DeskRow {
  company: string;
  title: string;
  location: string;
  url: string;
  score: number | null;
  why: string;
  posted: string | null;
  found_at: string;
  status: JobStatus;
  note: string;
  applied_at: string | null;
  updated_at: string | null;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const optStr = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

/** An ISO date-time as UTC `toISOString`, so stored times sort as text; a bare date or unparsable text is kept. */
function isoUtc(s: string): string {
  if (!/T/.test(s)) return s;
  const t = Date.parse(s);
  return Number.isNaN(t) ? s : new Date(t).toISOString();
}

function readRow(file: string, text: string): { id: string; row: DeskRow } | string {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return 'not valid JSON';
  }
  if (!isObj(doc)) return 'not a JSON object';
  const wrapped = isObj(doc['data']) && typeof doc['id'] === 'string';
  const id = wrapped ? (doc['id'] as string) : file.replace(/\.json$/, '');
  const d = wrapped ? (doc['data'] as Record<string, unknown>) : doc;
  for (const k of ['company', 'title', 'url', 'found_at'] as const) {
    if (typeof d[k] !== 'string' || d[k] === '') return `missing ${k} (company, title, url and found_at are required)`;
  }
  const status = d['status'] ?? 'new';
  if (typeof status !== 'string' || !(JOB_STATUSES as readonly string[]).includes(status)) return `unknown status ${String(status)}`;
  return {
    id,
    row: {
      company: d['company'] as string,
      title: d['title'] as string,
      location: typeof d['location'] === 'string' ? d['location'] : '',
      url: d['url'] as string,
      score: typeof d['score'] === 'number' && Number.isFinite(d['score']) ? d['score'] : null,
      why: typeof d['why'] === 'string' ? d['why'] : '',
      posted: optStr(d['posted']),
      found_at: d['found_at'] as string,
      status: status as JobStatus,
      note: typeof d['note'] === 'string' ? d['note'] : '',
      applied_at: optStr(d['applied_at']),
      updated_at: optStr(d['updated_at']),
    },
  };
}

function forbidden(text: string, naming: Naming): boolean {
  try {
    assertNoForbidden(text, naming);
    return false;
  } catch (err) {
    if (err instanceof ForbiddenTermError) return true;
    throw err;
  }
}

/**
 * Imports the Application Desk export (`<dir>/jobs/*.json`, flat rows or `{id, data}`), in file-name order. Each row
 * becomes its own job with docs `none`, its Desk status, note and applied_at, and one `migration` status history entry.
 * The doc id prefix gives the source and the rest the source id; the job key is the normaliser's `jobKey(source,
 * sourceId)`, so a later run that re-finds the posting upserts the same row. The dedupe key (company, title,
 * location) links a cross-source duplicate to its preferred row; same-source rows always stay separate jobs. A status
 * the user set on the dashboard is never overridden (`AppStore.importJob`). Idempotent: a `(source, sourceId)` already
 * imported is left alone. A note holding a forbidden term is replaced by `NOTE_REMOVED`, a `why` holding one is
 * dropped, and a company or title holding one skips the row; all are counted.
 */
export function migrateDesk(dir: string, app: AppStore, opts: { readonly naming: Naming }): DeskReport {
  const jobsDir = join(dir, 'jobs');
  if (!existsSync(jobsDir)) throw new Error(`no jobs directory at ${jobsDir}`);
  const files = readdirSync(jobsDir).filter((f) => f.endsWith('.json')).sort();
  const skipped: { file: string; reason: string }[] = [];
  const byStatus: Record<string, number> = {};
  const bySource: Record<string, number> = {};
  let inserted = 0;
  let attached = 0;
  const imported: string[] = [];
  let alreadyPresent = 0;
  let notesSanitised = 0;
  let whyRemoved = 0;

  for (const file of files) {
    const parsed = readRow(file, readFileSync(join(jobsDir, file), 'utf8'));
    if (typeof parsed === 'string') {
      skipped.push({ file, reason: parsed });
      continue;
    }
    const { id, row } = parsed;
    const prefix = Object.keys(DESK_PREFIXES).find((p) => id.startsWith(p));
    if (prefix === undefined || id.length === prefix.length) {
      skipped.push({ file, reason: `unknown id prefix ${/^[a-z]+-/.exec(id)?.[0] ?? id}` });
      continue;
    }
    if (forbidden(`${row.company}\n${row.title}`, opts.naming)) {
      skipped.push({ file, reason: 'company or title contains a forbidden term' });
      continue;
    }
    const source = DESK_PREFIXES[prefix] as string;
    let note = row.note;
    if (note !== '' && forbidden(note, opts.naming)) {
      note = NOTE_REMOVED;
      notesSanitised += 1;
    }
    let why = row.why;
    if (why !== '' && forbidden(why, opts.naming)) {
      why = '';
      whyRemoved += 1;
    }
    const firstSeen = isoUtc(row.found_at);
    const sourceId = id.slice(prefix.length);
    const key = jobKey(source, sourceId);
    const outcome = app.importJob({
      jobKey: key,
      dedupeKey: dedupeKey(row.company, row.title, row.location),
      source,
      sourceId,
      company: row.company,
      title: row.title,
      url: row.url,
      // The `ats` column keeps the source name: an ATS jobpilot reads (greenhouse, lever, ashby) or a board it never fetches.
      ats: source,
      location: row.location,
      remote: null,
      compMinInr: null,
      compMaxInr: null,
      compBasis: null,
      score: row.score,
      breakdown: null,
      verdict: null,
      reasons: [],
      notes: why === '' ? [] : [why],
      jdText: '',
      terms: null,
      recommendedFormat: null,
      docsState: 'none',
      docsDetail: null,
      postedAt: row.posted,
      at: firstSeen,
      status: row.status,
      note,
      appliedAt: row.applied_at === null ? null : isoUtc(row.applied_at),
      statusAt: isoUtc(row.updated_at ?? row.applied_at ?? row.found_at),
    });
    if (outcome === 'present') {
      alreadyPresent += 1;
      continue;
    }
    if (outcome === 'inserted') inserted += 1;
    else attached += 1;
    imported.push(key);
    byStatus[row.status] = (byStatus[row.status] ?? 0) + 1;
    bySource[source] = (bySource[source] ?? 0) + 1;
  }
  const duplicates = imported.filter((k) => app.getJob(k)?.duplicateOf !== null).length;
  return { read: files.length, inserted, attached, duplicates, alreadyPresent, notesSanitised, whyRemoved, skipped, byStatus: sorted(byStatus), bySource: sorted(bySource) };
}

const sorted = (r: Record<string, number>): Record<string, number> => Object.fromEntries(Object.entries(r).sort(([a], [b]) => (a < b ? -1 : 1)));
