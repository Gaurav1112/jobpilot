import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { parse } from 'yaml';
import { REMOVED_DIR } from './profiles/commands.js';
import { listProfiles } from './profiles/meta.js';
import { isProfilesRoot, jobpilotRoot, profileHome } from './profiles/root.js';

/** Every home whose data must stay private; never needs an active profile. */
export function privacyHomes(env: NodeJS.ProcessEnv = process.env): { label: string; home: string }[] {
  const explicit = env['JOBPILOT_HOME'];
  if (explicit !== undefined && explicit !== '' && !(isProfilesRoot(explicit) && !existsSync(join(explicit, 'pack')))) return [{ label: 'home', home: explicit }];
  const root = explicit !== undefined && explicit !== '' ? explicit : jobpilotRoot(env);
  if (!isProfilesRoot(root)) return [{ label: 'home', home: root }];
  const out = listProfiles(root).map((p) => ({ label: p.id, home: profileHome(root, p.id) }));
  const removed = join(root, REMOVED_DIR);
  if (existsSync(removed)) for (const d of readdirSync(removed).sort()) out.push({ label: `removed:${d.replace(/-\d{8}T\d{6}Z$/, '')}`, home: join(removed, d) });
  return out;
}

const yamlAt = (home: string, file: string): Record<string, unknown> => {
  try {
    const v = parse(readFileSync(join(home, 'pack', file), 'utf8')) as unknown;
    return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : typeof v === 'string' ? [v] : []);
const group = (n: number, indian: boolean): string => {
  const s = String(n);
  if (!indian) return s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const last3 = s.slice(-3);
  const rest = s.slice(0, -3);
  return rest === '' ? last3 : `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last3}`;
};

/** The contact phone as digits only ('' when absent). */
export function phoneOf(home: string): string {
  const v = yamlAt(home, 'contact.yaml')['phone'];
  return typeof v === 'string' ? v.replace(/\D/g, '') : '';
}

export function privacyTermsOf(home: string): string[] {
  const naming = yamlAt(home, 'naming.yaml');
  const contact = yamlAt(home, 'contact.yaml');
  const floor = (yamlAt(home, 'offers.yaml')['floor'] as { amount?: unknown } | null | undefined)?.amount;
  const phone = phoneOf(home);
  const terms = [
    ...strings(naming['forbiddenTerms']),
    ...strings(contact['name']),
    ...strings(contact['email']),
    ...(phone.length >= 7 ? [phone] : []),
    ...strings(contact['links']),
    ...(typeof floor === 'number' && Number.isSafeInteger(floor) ? [String(floor), group(floor, false), group(floor, true)] : []),
  ].map((t) => t.trim().toLowerCase());
  return [...new Set(terms)].filter((t) => t.length >= 4);
}

/**
 * How one term is found in lower-cased text. Words are substrings. Numbers stand alone: a pay floor never counts inside
 * a longer number, an id or a decimal (`1200000` in `71200000098`), and the phone is its digits with any separators
 * between them (`+49-30 000 0000`), never digits glued across lines or found inside a longer number.
 */
function matcherOf(term: string, phone: string): (text: string) => boolean {
  if (term === phone) {
    const re = new RegExp(`(?<!\\d)${[...term].join('[ \\t\\-.()+]*')}(?!\\d)`);
    return (text) => re.test(text);
  }
  if (/^[\d,]+$/.test(term)) {
    const re = new RegExp(`(?<!\\d|\\d[.,])${term}(?![.,]?\\d)`);
    return (text) => re.test(text);
  }
  return (text) => text.includes(term);
}

export function scanForTerms(dir: string, homes: readonly { label: string; home: string }[]): string[] {
  const sets = homes.map((h) => {
    const phone = phoneOf(h.home);
    return { label: h.label, matchers: privacyTermsOf(h.home).map((t) => matcherOf(t, phone)) };
  });
  const hits: string[] = [];
  const walk = (p: string): void => {
    for (const name of readdirSync(p).sort()) {
      if (name === 'node_modules' || name === '.git') continue;
      const f = join(p, name);
      if (statSync(f).isDirectory()) {
        walk(f);
        continue;
      }
      const text = readFileSync(f, 'utf8').toLowerCase();
      for (const s of sets) s.matchers.forEach((matches, i) => {
        if (matches(text)) hits.push(`${relative(dir, f).split(sep).join('/')} (${s.label}, term #${i + 1})`);
      });
    }
  };
  walk(dir);
  return hits;
}
