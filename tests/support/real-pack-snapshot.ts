import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { decideEligibility } from '../../src/app/agents/eligibility.js';
import { scorePosting } from '../../src/app/agents/scorer-lexicon.js';
import { COVER_P4 } from '../../src/app/agents/writing/templates.js';
import { resolvePdftotext } from '../../src/app/kernel.js';
import { offlineProviders } from '../../src/app/offline.js';
import { loadPack } from '../../src/app/pack/load.js';
import { fillP4 } from '../../src/app/render/fill.js';
import { runDaily } from '../../src/app/run.js';
import type { EligibilityVerdict, Posting } from '../../src/app/types.js';
import { outTreeHashes, snapshot } from './identity-snapshot.js';

const root = join(import.meta.dirname, '../..');
const CLOCK = '2026-10-09T01:30:00.000Z';

/**
 * The real-pack comparison (profiles P1 byte-identity protocol, check 3). Everything runs on a COPY of `packDir` in a
 * temp home, offline: the daily run on tests/fixtures/e2e (feeds forced to himalayas, as the strict golden does), every
 * eligibility eval posting through eligibility and the scorer, and the cover letter's availability sentence. The text
 * holds the pack's verdicts, so it is written only under the scratchpad and never committed.
 */
export async function realPackSnapshot(packDir: string): Promise<string> {
  const home = mkdtempSync(join(tmpdir(), 'jobpilot-realpack-'));
  try {
    cpSync(packDir, join(home, 'pack'), { recursive: true });
    writeFileSync(join(home, 'pack/feeds.yaml'), 'enabled: [himalayas]\n');
    const offline = offlineProviders(join(root, 'tests/fixtures/e2e'));
    const r = await runDaily({ home, clock: { now: () => CLOCK }, fetch: offline.fetch, browser: offline.browser, sleep: async () => {}, pdftotext: resolvePdftotext(), codeHash: 'identity0000fixed' });
    const { pack } = loadPack(join(home, 'pack'), {}, { asOf: '2026-10', mode: 'daily' });
    const { contact: _c, answers: _a, ...pub } = pack;
    const decisions = readFileSync(join(root, 'evals/datasets/eligibility.jsonl'), 'utf8').split('\n').filter((l) => l.trim() !== '').map((l) => {
      const { id, input } = JSON.parse(l) as { id: string; input: Posting };
      const d = decideEligibility(input, pub);
      const s = d.verdict === 'eligible' || d.verdict === 'review' ? scorePosting({ posting: input, ...d } as EligibilityVerdict, pub) : null;
      return { id, ...d, score: s?.score ?? null, breakdown: s?.breakdown ?? null };
    });
    const p4 = fillP4(COVER_P4, pack.answers, pack.contact.city, pack.eligibility.officeCities ?? []);
    return `${JSON.stringify({ status: r.report.status, packHash: r.packHash, fullPackHash: r.fullPackHash, db: snapshot(join(home, 'jobpilot.db')), out: outTreeHashes(join(home, 'out')), decisions, p4 }, null, 2)}\n`;
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

if (process.argv[1]?.endsWith('real-pack-snapshot.ts')) {
  const { values } = parseArgs({ options: { pack: { type: 'string' }, out: { type: 'string' } } });
  if (values.pack === undefined || values.out === undefined) throw new Error('usage: real-pack-snapshot.ts --pack <dir> --out <file>');
  writeFileSync(values.out, await realPackSnapshot(values.pack), { mode: 0o600 });
}
