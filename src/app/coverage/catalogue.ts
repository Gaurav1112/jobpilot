import { z } from 'zod';
import { freehireCompanyKey } from './freehire-boards.js';
import { Platform, type PlatformGuess } from './types.js';

/**
 * The vendored freehire board catalogue (MIT, snapshot `96b53a2c`) as a weekly coverage seed (sources-x Task 7, D3, D4).
 * Nothing here reads the network: `assets/freehire/catalogue-seed.jsonl` is regenerated at build time by
 * `scripts/freehire-catalogue.ts`. Each week the coverage run sends at most CATALOGUE_PER_WEEK boards that the registry
 * does not hold yet straight to the board verifier (no locate, no detect), as `freehire`-sourced guesses.
 */
export const CATALOGUE_SEED = new URL('../../../assets/freehire/catalogue-seed.jsonl', import.meta.url);
export const CATALOGUE_SIGNATURE = 'freehire-catalogue:96b53a2c';
export const CATALOGUE_PER_WEEK = 300;

export const CatalogueEntry = z
  .object({
    platform: Platform,
    ref: z.string().min(1),
    boardUrl: z.string().url(),
    company: z.string().min(1),
    board: z.string().min(1),
    evidence: z.number().int().positive(),
    example: z.object({ title: z.string(), location: z.string().nullable(), url: z.string() }).strict(),
  })
  .strict();
export type CatalogueEntry = z.infer<typeof CatalogueEntry>;

/** Every line parsed; a bad line is an error naming its number (the file is vendored: a bad line is a build bug). */
export function loadCatalogue(text: string): CatalogueEntry[] {
  const out: CatalogueEntry[] = [];
  text.split('\n').forEach((raw, i) => {
    if (raw.trim() === '') return;
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch (e) {
      throw new Error(`catalogue seed line ${i + 1}: not JSON (${e instanceof Error ? e.message : String(e)})`);
    }
    const r = CatalogueEntry.safeParse(json);
    if (!r.success) throw new Error(`catalogue seed line ${i + 1}: ${r.error.issues[0]?.message ?? 'invalid'} at ${r.error.issues[0]?.path.join('.') ?? ''}`);
    out.push(r.data);
  });
  return out;
}

/** `<platform> <ref lower-cased>`: the registry/verify dedupe key. */
export const boardKey = (platform: string, ref: string): string => `${platform} ${ref.toLowerCase()}`;

/** The PlatformGuess of one freehire-sourced board (catalogue or discovery), D3. */
export function freehireGuess(o: { platform: Platform; ref: string; boardUrl: string; company: string; source: 'freehire' | 'freehire-discovery'; week: string; why: string; signature: string }): PlatformGuess {
  const candidate = { companyKey: freehireCompanyKey(o.platform, o.ref), name: o.company, website: '', careersUrl: null, source: o.source, runDate: o.week };
  return {
    site: { candidate, careersUrl: null, method: 'none', evidence: o.why },
    platform: o.platform,
    slug: o.ref,
    boardUrl: o.boardUrl,
    signature: o.signature,
    routedFrom: null,
    evidence: [`detected: ${o.platform} ${o.ref} (${o.signature})`],
  };
}

const guessOf = (e: CatalogueEntry, week: string): PlatformGuess =>
  freehireGuess({ platform: e.platform, ref: e.ref, boardUrl: e.boardUrl, company: e.company, source: 'freehire', week, why: `freehire catalogue, ${e.evidence} India or remote tech posting(s) seen: ${e.example.title}`, signature: CATALOGUE_SIGNATURE });

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * This week's catalogue guesses (D4): entries whose boardKey is not in `known` (the registry's, any status, plus this
 * run's other verify inputs), by evidence desc, then platform, then ref; the first `limit`. `left` counts the rest.
 */
export function catalogueGuesses(entries: readonly CatalogueEntry[], known: ReadonlySet<string>, week: string, limit = CATALOGUE_PER_WEEK): { readonly guesses: PlatformGuess[]; readonly left: number } {
  const seen = new Set<string>();
  const fresh = entries.filter((e) => {
    const k = boardKey(e.platform, e.ref);
    if (known.has(k) || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  fresh.sort((a, b) => b.evidence - a.evidence || cmp(a.platform, b.platform) || cmp(a.ref, b.ref));
  return { guesses: fresh.slice(0, limit).map((e) => guessOf(e, week)), left: Math.max(0, fresh.length - limit) };
}

/** The guesses of recorded board keys (a resumed run), in the recorded order; a key the catalogue no longer holds is dropped. */
export function freehireGuesses(entries: readonly CatalogueEntry[], keys: readonly string[], week: string): PlatformGuess[] {
  const by = new Map(entries.map((e) => [boardKey(e.platform, e.ref), e]));
  return keys.flatMap((k) => {
    const e = by.get(k);
    return e === undefined ? [] : [guessOf(e, week)];
  });
}

/** The guesses without a repeated board: the first of a boardKey wins, order kept. */
export function dedupeGuesses(guesses: readonly PlatformGuess[]): PlatformGuess[] {
  const seen = new Set<string>();
  return guesses.filter((g) => {
    const k = boardKey(g.platform ?? '', g.slug ?? '');
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
