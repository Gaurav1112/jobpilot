import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import Database from 'better-sqlite3';

export const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

export interface Snapshot {
  readonly steps: string[];
  readonly envelopes: string[];
  readonly jobs: string;
  readonly docs: string[];
  readonly companies: number;
}

export function snapshot(db: string): Snapshot {
  const d = new Database(db, { readonly: true });
  try {
    const steps = (d.prepare('SELECT agent_id, step_key, status, error_code FROM steps ORDER BY agent_id, step_key').all() as { agent_id: string; step_key: string; status: string; error_code: string | null }[]).map(
      (r) => `${r.agent_id} ${r.step_key} ${r.status} ${r.error_code ?? '-'}`,
    );
    const envelopes = (d.prepare('SELECT envelope_id, step_key, idx, type, body FROM envelopes ORDER BY envelope_id').all() as { envelope_id: string; step_key: string; idx: number; type: string; body: string }[]).map((r) => {
      const body = JSON.parse(r.body) as { payload?: unknown };
      return `${r.envelope_id} ${r.step_key} ${r.idx} ${r.type} ${sha(JSON.stringify(body.payload ?? null))}`;
    });
    const jobs = sha(JSON.stringify(d.prepare('SELECT * FROM jobs ORDER BY job_key').all()));
    const docs = (d.prepare('SELECT * FROM job_docs ORDER BY 1, 2, 3').all() as Record<string, unknown>[]).map((r) => JSON.stringify(r));
    const companies = (d.prepare('SELECT COUNT(*) AS n FROM companies').get() as { n: number }).n;
    return { steps, envelopes, jobs, docs, companies };
  } finally {
    d.close();
  }
}

/** Every file under `out`, as `"<posix relPath> <sha256>"`, sorted: the documents' bytes, not only their DB rows. */
export function outTreeHashes(out: string): string[] {
  const lines: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else lines.push(`${relative(out, p).split(sep).join('/')} ${sha(readFileSync(p).toString('latin1'))}`);
    }
  };
  walk(out);
  return lines.sort();
}
