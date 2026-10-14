import { statSync } from 'node:fs';
import Database from 'better-sqlite3';
import { fullChainCheck } from '../../src/app/chain-status.js';
import { AppStore } from '../../src/app/store/app-store.js';
import { JOB_STATUSES } from '../../src/app/store/schema.js';
import { canonicalJson } from '../../src/kernel/canonical.js';
import { eventHash, GENESIS_HASH } from '../../src/kernel/store/store.js';
import { Store } from '../../src/kernel/store/store.js';

/**
 * dashboard-perf governance: a large SYNTHETIC jobpilot database, built deterministically (a seeded PRNG, no network,
 * no clock, no LLM), for the performance budget gate (`node --run perf`) and the before/after measurements.
 *
 * Its shape follows the real home measured in perf-research.md (a): jobs whose descriptions dominate the table (a few KB
 * each, in overflow pages), most of them rejected (the default view keeps a few percent), a third of them cross-source
 * duplicates; a hash-chained event log whose rows are mostly `step_done` and `transition_rejected`; envelopes by the
 * real type mix; runs written day by day, so jobs, events and envelopes pages interleave across the file as they do
 * in a real one. Every name, domain and text is generated from fictional word lists: no personal data.
 */
export interface SynthSpec {
  readonly jobs: number;
  readonly envelopes: number;
  readonly events: number;
  /** Mean envelope body size in bytes (real: ~9 KB; smaller keeps the gate's disk use and build time down). */
  readonly envelopeBytes: number;
  /** How many daily runs the rows are spread over. `jobpilot audit` ran before the last one: /runs has its events to check. */
  readonly runs: number;
  readonly seed: number;
}

export const BUDGET_SPEC: SynthSpec = { jobs: 20_000, envelopes: 300_000, events: 500_000, envelopeBytes: 3_000, runs: 10, seed: 20261014 };

function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SYLLABLES = ['ka', 'lo', 'mi', 'ten', 'dra', 'vor', 'sel', 'qui', 'pan', 'rho', 'zet', 'ul', 'bri', 'cas', 'dun', 'fey', 'gor', 'hin'];
const WORDS = ['build', 'services', 'platform', 'distributed', 'systems', 'team', 'backend', 'java', 'kotlin', 'go', 'kafka', 'design', 'review', 'ownership', 'scale', 'reliability', 'customers', 'remote', 'india', 'growth', 'data', 'pipelines', 'cloud', 'mentoring', 'quality', 'latency'];
const TITLES = ['Senior Backend Engineer', 'Staff Engineer', 'Platform Engineer', 'Backend Developer', 'Data Engineer', 'Site Reliability Engineer', 'Engineering Manager', 'Software Engineer II', 'Principal Engineer'];
const SOURCES = ['greenhouse', 'lever', 'ashby', 'remotive', 'workday', 'careers'];
const ENVELOPE_TYPES: readonly (readonly [string, number])[] = [
  ['RawPosting@1', 0.3], ['EligibilityVerdict@1', 0.28], ['Posting@1', 0.28], ['Scored@1', 0.07], ['Rendered@1', 0.01], ['CoverPlan@1', 0.01], ['ResumePlan@1', 0.01], ['Evidence@1', 0.01], ['QaReport@1', 0.01], ['GigPosting@1', 0.02],
];
const DAY0 = Date.parse('2026-09-01T01:30:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();

/** Builds the database at `path` (which must not exist). Returns the build time and the file size. */
export function buildSyntheticDb(path: string, spec: SynthSpec = BUDGET_SPEC): { buildMs: number; bytes: number } {
  const t0 = performance.now();
  AppStore.open(path).close(); // the current schema, migrations and all
  const rnd = prng(spec.seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)] as T;
  const word = (): string => pick(SYLLABLES) + pick(SYLLABLES) + (rnd() < 0.5 ? pick(SYLLABLES) : '');
  const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
  // one long deterministic text; descriptions and bodies are slices of it
  const block = Array.from({ length: 400_000 }, () => pick(WORDS)).join(' ');
  const text = (len: number): string => {
    const at = Math.floor(rnd() * (block.length - len - 1));
    return block.slice(at, at + len);
  };
  const companies = Array.from({ length: 1_500 }, () => `${cap(word())} ${pick(['Labs', 'Systems', 'Technologies', 'Cloud', 'Software', 'Works'])}`);

  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = OFF');
  const insJob = db.prepare(
    `INSERT INTO jobs (job_key, source, source_id, dedupe_key, duplicate_of, company, title, url, ats, location, remote, comp, comp_min_inr, comp_max_inr,
       comp_basis, score, breakdown, verdict, reasons, notes, jd_text, terms, recommended_format, docs_state, docs_detail, posted_at, first_seen, last_seen,
       status, note, applied_at, notified_at, unplaced, cited_facts)
     VALUES (@job_key, @source, @source_id, @dedupe_key, @duplicate_of, @company, @title, @url, @ats, @location, @remote, @comp, @comp_min_inr, @comp_max_inr,
       @comp_basis, @score, @breakdown, @verdict, @reasons, @notes, @jd_text, NULL, @recommended_format, @docs_state, NULL, @posted_at, @first_seen, @last_seen,
       @status, '', @applied_at, @notified_at, '[]', NULL)`,
  );
  const insEnv = db.prepare(`INSERT INTO envelopes (envelope_id, step_key, idx, type, body) VALUES (?, ?, 0, ?, ?)`);
  const insEvent = db.prepare(`INSERT INTO events (seq, run_id, at, kind, data, policy_hash, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  const insRun = db.prepare(`INSERT INTO runs_summary (run_id, at, counts, pack_hash, policy_hash, warnings, problems) VALUES (?, ?, ?, ?, ?, '[]', ?)`);
  const policy = 'a'.repeat(64);

  const keys: string[] = [];
  const primaries: { key: string; source: string }[] = [];
  let prev = GENESIS_HASH;
  let seq = 0;
  let envN = 0;
  const per = (total: number, r: number): number => Math.floor((total * (r + 1)) / spec.runs) - Math.floor((total * r) / spec.runs);
  for (let r = 0; r < spec.runs; r++) {
    const runId = `daily-${iso(DAY0 + r * 86_400_000).slice(0, 10)}-1`;
    const at = iso(DAY0 + r * 86_400_000);
    db.transaction(() => {
      // jobs first seen this run
      for (let i = 0; i < per(spec.jobs, r); i++) {
        const n = keys.length;
        const key = n.toString(16).padStart(16, '0');
        const source = pick(SOURCES);
        const dupOf = primaries.length > 50 && rnd() < 0.3 ? pick(primaries) : undefined;
        const dup = dupOf !== undefined && dupOf.source !== source ? dupOf.key : null;
        const v = rnd();
        const verdict = v < 0.85 ? 'rejected' : v < 0.95 ? 'eligible' : v < 0.98 ? 'review' : null;
        const comp = rnd() < 0.4 ? Math.floor(1_000_000 + rnd() * 9_000_000) : null;
        const company = pick(companies);
        insJob.run({
          job_key: key, source, source_id: `${source}-${n}`, dedupe_key: `dk${n}`, duplicate_of: dup, company, title: pick(TITLES),
          url: `https://jobs.${company.split(' ')[0]?.toLowerCase()}.example/p/${n}`, ats: source, location: pick(['Remote, India', 'Bengaluru', 'Pune', 'Remote']),
          remote: JSON.stringify({ structured: 'remote', countries: ['india'], signals: [] }),
          comp: comp === null ? null : JSON.stringify({ min: Math.floor(comp / 2), max: comp, currency: 'INR', period: 'year', basis: 'base' }),
          comp_min_inr: comp === null ? null : Math.floor(comp / 2), comp_max_inr: comp, comp_basis: comp === null ? null : 'base',
          score: rnd() < 0.1 ? null : Math.round(rnd() * 1200) / 10, breakdown: JSON.stringify([{ label: 'title', points: 40 }, { label: 'strong:java', points: 4 }]),
          verdict, reasons: verdict === 'rejected' ? JSON.stringify(['G-LOCATION', 'G-OFFICE']) : '[]', notes: rnd() < 0.1 ? JSON.stringify(['office/hybrid: Pune']) : '[]',
          // descriptions: 2-14 KB, mean ~6 KB (real: 73 MB over 12k jobs)
          jd_text: text(2_000 + Math.floor(rnd() * rnd() * 24_000)),
          recommended_format: rnd() < 0.2 ? 'pdf' : null, docs_state: pick(['none', 'none', 'none', 'ready', 'blocked', 'below-floor']),
          posted_at: at.slice(0, 10), first_seen: at, last_seen: iso(DAY0 + (spec.runs - 1) * 86_400_000),
          status: rnd() < 0.8 ? 'new' : pick(JOB_STATUSES), applied_at: null, notified_at: rnd() < 0.5 ? at : null,
        });
        keys.push(key);
        if (dup === null) primaries.push({ key, source });
      }
      // this run's envelopes
      for (let i = 0; i < per(spec.envelopes, r); i++) {
        let x = rnd();
        let type = 'Posting@1';
        for (const [t, w] of ENVELOPE_TYPES) {
          if ((x -= w) < 0) {
            type = t;
            break;
          }
        }
        const jobKey = pick(keys);
        const body = canonicalJson({ envelopeId: `e${envN}`, index: 0, parents: [], producer: { agentId: 'synthetic', contractHash: 'h', version: '1.0.0' }, stepKey: `s${envN}`, type, payload: { jobKey, text: text(Math.floor(spec.envelopeBytes * (0.5 + rnd()))) } });
        insEnv.run(`e${envN}`, `s${envN}`, type, body);
        envN++;
      }
      // this run's events, hash-chained
      for (let i = 0; i < per(spec.events, r); i++) {
        seq++;
        const kind = rnd() < 0.65 ? 'step_done' : 'transition_rejected';
        const row = { run_id: runId, at, kind, data: canonicalJson({ agent: pick(['normalizer', 'eligibility', 'scorer-lexicon', 'src-greenhouse']), stepKey: `s${seq}`, outputs: [`e${seq}`], item: pick(keys), note: text(300) }), policy_hash: policy };
        const hash = eventHash(prev, row);
        insEvent.run(seq, row.run_id, row.at, row.kind, row.data, row.policy_hash, prev, hash);
        prev = hash;
      }
      db.prepare(`INSERT INTO chain_head (id, seq, hash, count) VALUES (1, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET seq = excluded.seq, hash = excluded.hash, count = excluded.count`).run(seq, prev, seq);
      const problems = Array.from({ length: 20 }, (_, i) => ({ kind: pick(['failed', 'gone', 'input_rejected']), agent: 'normalizer', item: keys[i] ?? '', reason: text(80) }));
      insRun.run(runId, at, JSON.stringify({ byAgent: { normalizer: { done: 1000, failed: 3, gone: 2, inputRejected: 0, quarantined: 0, skipped: 0, replayed: 0 } }, totals: { done: 1000, failed: 3, gone: 2 } }), 'b'.repeat(64), policy, JSON.stringify(problems));
    })();
    // `jobpilot audit` ran before the last run's share of events: /runs has one run's events to check
    if (r === spec.runs - 2 || (spec.runs === 1 && r === 0)) {
      const k = Store.open(path);
      try {
        fullChainCheck(k, iso(DAY0 + r * 86_400_000 + 3_600_000));
      } finally {
        k.close();
      }
    }
  }
  db.pragma('wal_checkpoint(TRUNCATE)');
  db.close();
  return { buildMs: performance.now() - t0, bytes: statSync(path).size };
}
