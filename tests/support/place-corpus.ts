import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const repo = join(import.meta.dirname, '../..');
/** Eval sets whose inputs carry location or description text (jobs at the top level, gigs under `gig`/`raw`). */
const DATASETS = ['eligibility.jsonl', 'gig-eligibility.jsonl', 'gig-eligibility-reviewed.jsonl', 'gig-normalizer.jsonl', 'freehire-rows.jsonl'];
const KEYS = new Set(['locationText', 'descriptionText', 'title', 'location', 'description', 'country']);

/** Every string under a text key at any depth of `v` (strings in arrays under those keys too). */
function collect(v: unknown, into: Set<string>, key?: string): void {
  if (typeof v === 'string') {
    if (key !== undefined && KEYS.has(key)) into.add(v);
  } else if (Array.isArray(v)) {
    for (const x of v) collect(x, into, key);
  } else if (v !== null && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) collect(x, into, k);
  }
}

/** Every location and description text in the eligibility and normalizer eval sets, plus fixed edge cases: the place corpus. */
export function placeCorpus(): string[] {
  const texts = new Set<string>(['Remote (except India)', 'India (excluding Mumbai)', 'Bengaluru or Singapore', 'Indianapolis, IN', 'USA1', 'Anywhere in India', 'Pune, Maharashtra', 'Delhi, NY', 'Remote - Worldwide', 'Southeast Asia', 'Berlin, Germany', 'Toronto, ON, Canada']);
  for (const f of DATASETS) {
    for (const l of readFileSync(join(repo, 'evals/datasets', f), 'utf8').split('\n').filter((x) => x.trim() !== '')) {
      collect((JSON.parse(l) as { input: unknown }).input, texts);
    }
  }
  return [...texts].sort();
}
