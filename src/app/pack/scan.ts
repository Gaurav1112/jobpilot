import { uncoveredGlyph } from '../render/pdf.js';
import { forbiddenTermStrict, type NamingRules } from './rules.js';
import type { Pack } from './schema.js';

/**
 * Pack text checks shared by `pack import` and `pack check` (Task 12): characters the embedded font cannot draw, and
 * forbidden terms, by the one strict check (`forbiddenTermStrict`: word-bounded, glued, split, plural, look-alike). Messages
 * name a field or fact id, a term by its 1-based position and a character by its code point only: never the term,
 * the character or the text around it.
 */

/** The 1-based position of the forbidden term in `text` (`forbiddenTermStrict`), or undefined. */
export function forbiddenTermIn(text: string, naming: Pick<NamingRules, 'forbiddenTerms'>): number | undefined {
  const term = forbiddenTermStrict(text, naming);
  return term === undefined ? undefined : naming.forbiddenTerms.indexOf(term) + 1;
}

/** Every string value under `v`, with its path (`strong[9].display`, `watchlist[1].company`, `titles[0]`). */
function* stringsIn(v: unknown, path: string): Generator<{ path: string; text: string }> {
  if (typeof v === 'string') yield { path, text: v };
  else if (Array.isArray(v)) for (let i = 0; i < v.length; i++) yield* stringsIn(v[i], `${path}[${i}]`);
  else if (v !== null && typeof v === 'object') for (const [k, child] of Object.entries(v)) yield* stringsIn(child, path === '' ? k : `${path}.${k}`);
}

type ScannedPack = Pick<
  Pack,
  'facts' | 'contact' | 'roles' | 'targets' | 'answers' | 'naming' | 'lexicon' | 'watchlist' | 'filters' | 'eligibility' | 'offers' | 'fx' | 'feeds' | 'policyUser'
>;

/** What to write instead of a character Noto Sans cannot draw. */
const GLYPH_HINTS: Readonly<Record<number, string>> = {
  0x2192: "replace with 'to'",
  0x2190: "replace with 'from'",
  0x2194: "replace with 'and'",
  0x21d2: "replace with 'so'",
  0x2265: "replace with 'at least'",
  0x2264: "replace with 'at most'",
  0x2248: "replace with 'about'",
  0x2260: "replace with 'not'",
  0x2713: 'remove it',
  0x2714: 'remove it',
  0x2717: 'remove it',
  0x2605: 'remove it',
  0x09: 'replace with a space',
};

/** One problem per distinct character in `text` the embedded fonts cannot draw: "U+2192 in <where>: <hint>". */
export function glyphProblems(text: string, where: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const ch of text) {
    if (seen.has(ch)) continue;
    seen.add(ch);
    const bad = uncoveredGlyph([ch]);
    if (bad === null) continue;
    out.push(`${bad} in ${where}: ${GLYPH_HINTS[ch.codePointAt(0) ?? 0] ?? 'replace or remove it'} (the embedded font cannot draw it)`);
  }
  return out;
}

/** The answers a document may show (cover letter p4); only these are drawn, so only these are glyph-checked. */
export const DOCUMENT_ANSWERS: readonly string[] = ['available_from', 'notice_period'];

/**
 * Every glyph and forbidden-term problem in the pack's user-edited text (m8): facts (claim, tech, employer, role),
 * contact, roles, claimable titles and answers (all keys and values for terms; the document answers for glyphs).
 * Employers are checked as displayed (through `naming.employerDisplay`), and every `employerDisplay` value.
 * Final I8: every string value of every other pack file but naming.yaml too (the lexicon key, display and synonyms,
 * the watchlist, targets titles, filters, ...), as `<file>: <path> holds forbidden term #<n>`. The daily run and the
 * rebuild refuse to start on any problem (`loadRunPack`).
 * Ids are named only when they are clean.
 */
export function packTextProblems(pack: ScannedPack): string[] {
  const p: string[] = [];
  // Raw employers are allowed in the pack when naming.yaml maps them; what a document shows is the display name.
  const shown = (raw: string): string => (Object.hasOwn(pack.naming.employerDisplay, raw) ? (pack.naming.employerDisplay[raw] as string) : raw);
  const term = (text: string, where: string): void => {
    const n = forbiddenTermIn(text, pack.naming);
    if (n !== undefined) p.push(`${where} holds forbidden term #${n}`);
  };
  pack.facts.forEach((f, i) => {
    const idHit = forbiddenTermIn(f.id, pack.naming);
    const name = idHit === undefined ? `fact ${f.id}` : `fact #${i + 1}`;
    if (idHit !== undefined) p.push(`fact #${i + 1}: the id holds forbidden term #${idHit}`);
    for (const [field, text] of [['claim', f.claim], ['employer', shown(f.employer)], ['role', f.role ?? ''], ...f.tech.map((t) => ['tech', t] as const)] as const) {
      term(text, `${name} ${field}`);
      p.push(...glyphProblems(text, field === 'claim' ? name : `${name} ${field}`));
    }
  });
  for (const [field, value] of [['name', pack.contact.name], ['email', pack.contact.email], ['phone', pack.contact.phone], ['city', pack.contact.city], ...pack.contact.links.map((l, i) => [`links[${i}]`, l] as const)] as const) {
    term(value, `contact.${field}`);
    p.push(...glyphProblems(value, `contact.${field}`));
  }
  pack.roles.forEach((r, i) => {
    for (const [field, value] of [['employer', shown(r.employer)], ['title', r.title], ['location', r.location]] as const) {
      term(value, `role ${i + 1} ${field}`);
      p.push(...glyphProblems(value, `role ${i + 1} ${field}`));
    }
  });
  pack.targets.claimableTitles.forEach((t, i) => {
    term(t, `targets.claimableTitles entry ${i + 1}`);
    p.push(...glyphProblems(t, `targets.claimableTitles entry ${i + 1}`));
  });
  Object.entries(pack.answers).forEach(([key, value], i) => {
    const keyHit = forbiddenTermIn(key, pack.naming) !== undefined;
    const name = keyHit ? `answer #${i + 1}` : `answers.${key}`;
    term(key, `${name} key`);
    term(String(value), name);
    if (DOCUMENT_ANSWERS.includes(key)) p.push(...glyphProblems(String(value), name));
  });
  Object.values(pack.naming.employerDisplay).forEach((display, i) => term(display, `naming.yaml: employerDisplay value ${i + 1}`));
  const { claimableTitles: _claimable, ...targets } = pack.targets;
  const files: readonly (readonly [string, unknown])[] = [
    ['lexicon.yaml', pack.lexicon], ['watchlist.yaml', { watchlist: pack.watchlist }], ['targets.yaml', targets], ['filters.yaml', pack.filters],
    ['eligibility.yaml', pack.eligibility], ['offers.yaml', pack.offers], ['fx.yaml', pack.fx], ['feeds.yaml', pack.feeds], ['policy.user.yaml', pack.policyUser],
  ];
  for (const [file, value] of files) for (const s of stringsIn(value, '')) term(s.text, `${file}: ${s.path}`);
  return p;
}
