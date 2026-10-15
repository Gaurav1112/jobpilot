import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DigestSchema, type Digest } from '../digest.js';

export interface Counts {
  readonly mac: number;
  readonly hosted: number;
  readonly both: number;
  readonly macOnly: number;
  readonly hostedOnly: number;
  /** both / mac, null when mac is 0. */
  readonly recall: number | null;
}
export interface SourceRow extends Counts {
  readonly source: string;
  /** How many of the Mac's eligible keys are among this source's Mac postings (the C3 share). */
  readonly macEligible: number;
  readonly problems: { readonly mac: readonly string[]; readonly hosted: readonly string[] };
}
export interface DayRow {
  readonly date: string;
  readonly comparable: boolean;
  readonly why: 'pack-differs' | 'mac-missing' | 'hosted-missing' | null;
  readonly codeDiffers: boolean;
  /** Sorted by source id. */
  readonly sources: readonly SourceRow[];
  readonly eligible: Counts;
  readonly toDecide: Counts;
  /** The am freelance digests; zero counts when either is missing. */
  readonly gigs: Counts;
}

const byCode = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function counts(mac: readonly string[], hosted: readonly string[]): Counts {
  const m = new Set(mac);
  const h = new Set(hosted);
  let both = 0;
  for (const k of m) if (h.has(k)) both += 1;
  return { mac: m.size, hosted: h.size, both, macOnly: m.size - both, hostedOnly: h.size - both, recall: m.size === 0 ? null : both / m.size };
}

const flatGigs = (d: Digest): string[] => Object.entries(d.gigs).flatMap(([platform, keys]) => keys.map((k) => `${platform}/${k}`));

export function compareDay(
  date: string,
  d: { readonly mac?: Digest | undefined; readonly hosted?: Digest | undefined; readonly macGigs?: Digest | undefined; readonly hostedGigs?: Digest | undefined },
): DayRow {
  const { mac, hosted } = d;
  const why: DayRow['why'] = mac === undefined ? 'mac-missing' : hosted === undefined ? 'hosted-missing' : mac.packHash !== hosted.packHash ? 'pack-differs' : null;
  const ids = [...new Set([...Object.keys(mac?.sources ?? {}), ...Object.keys(hosted?.sources ?? {})])].sort(byCode);
  const macEligible = new Set(mac?.eligible ?? []);
  const sources = ids.map((source): SourceRow => ({
    source,
    macEligible: (mac?.sources[source]?.postings ?? []).filter((k) => macEligible.has(k)).length,
    ...counts(mac?.sources[source]?.postings ?? [], hosted?.sources[source]?.postings ?? []),
    problems: { mac: [...(mac?.sources[source]?.problems ?? [])].sort(byCode), hosted: [...(hosted?.sources[source]?.problems ?? [])].sort(byCode) },
  }));
  return {
    date,
    comparable: why === null,
    why,
    codeDiffers: mac !== undefined && hosted !== undefined && mac.codeSha !== hosted.codeSha,
    sources,
    eligible: counts(mac?.eligible ?? [], hosted?.eligible ?? []),
    toDecide: counts(mac?.toDecide ?? [], hosted?.toDecide ?? []),
    gigs: d.macGigs !== undefined && d.hostedGigs !== undefined ? counts(flatGigs(d.macGigs), flatGigs(d.hostedGigs)) : counts([], []),
  };
}

const FILE = /^(\d{4}-\d{2}-\d{2})-(daily|freelance)\.json$/;

/** Reads `<date>-daily.json` / `<date>-freelance.json` from a folder, keyed `<date>-<pipeline>`; each file must parse as a Digest and carry the env given. */
export function readDigests(dir: string, env: 'hosted' | 'local'): Map<string, Digest> {
  const out = new Map<string, Digest>();
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir).sort(byCode)) {
    const m = FILE.exec(name);
    if (m === null) continue;
    let digest: Digest;
    try {
      digest = DigestSchema.parse(JSON.parse(readFileSync(join(dir, name), 'utf8'))) as Digest;
    } catch (e) {
      throw new Error(`${name}: not a valid digest (${e instanceof Error ? e.message.split('\n')[0] : String(e)})`);
    }
    if (digest.env !== env) throw new Error(`${name}: env is ${digest.env}, expected ${env}`);
    if (digest.date !== m[1] || digest.pipeline !== m[2]) throw new Error(`${name}: names ${digest.date} ${digest.pipeline}`);
    out.set(`${m[1]}-${m[2]}`, digest);
  }
  return out;
}

/** `days` consecutive dates from `from` (YYYY-MM-DD). */
export const dates = (from: string, days: number): string[] =>
  Array.from({ length: days }, (_, i) => new Date(Date.parse(`${from}T00:00:00.000Z`) + i * 86_400_000).toISOString().slice(0, 10));
