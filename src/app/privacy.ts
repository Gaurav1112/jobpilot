import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { parse } from 'yaml';
import { REMOVED_DIR } from './profiles/commands.js';
import { listProfiles } from './profiles/meta.js';
import { isProfilesRoot, jobpilotRoot, profileHome } from './profiles/root.js';

/**
 * The privacy gate (profiles spec §8): before anything is pushed to the public repo, no profile's forbidden terms,
 * contact details or pay floor may appear in it. A miss is the failure that matters, so every term is matched in the
 * forms people actually write it, and a home that cannot be checked is a problem, never "clean".
 */

/** Every home whose data must stay private; never needs an active profile. */
export function privacyHomes(env: NodeJS.ProcessEnv = process.env): { label: string; home: string }[] {
  const explicit = env['JOBPILOT_HOME'];
  const named = explicit !== undefined && explicit !== '';
  // a home that is one profile of a profiles root widens to the whole root: the other profiles must not be skipped
  if (named && basename(dirname(explicit)) === 'profiles' && isProfilesRoot(dirname(dirname(explicit)))) return rootHomes(dirname(dirname(explicit)));
  if (named && !(isProfilesRoot(explicit) && !existsSync(join(explicit, 'pack')))) return [{ label: 'home', home: explicit }];
  const root = named ? explicit : jobpilotRoot(env);
  return isProfilesRoot(root) ? rootHomes(root) : [{ label: 'home', home: root }];
}

function rootHomes(root: string): { label: string; home: string }[] {
  const out = listProfiles(root).map((p) => {
    try {
      return { label: p.id, home: profileHome(root, p.id) };
    } catch {
      return { label: p.id, home: join(root, 'profiles', p.id) }; // an odd id still counts; its problems are reported
    }
  });
  const removed = join(root, REMOVED_DIR);
  if (existsSync(removed))
    for (const d of readdirSync(removed).sort()) {
      if (d.startsWith('.') || !lstatSync(join(removed, d)).isDirectory()) continue;
      out.push({ label: `removed:${d.replace(/-\d{8}T\d{6}Z$/, '')}`, home: join(removed, d) });
    }
  return out;
}

const PACK_FILES = ['naming.yaml', 'contact.yaml', 'offers.yaml'] as const;
type PackFile = (typeof PACK_FILES)[number];

function readPack(home: string): { docs: Record<PackFile, Record<string, unknown>>; problems: string[] } {
  const docs = { 'naming.yaml': {}, 'contact.yaml': {}, 'offers.yaml': {} } as Record<PackFile, Record<string, unknown>>;
  if (!existsSync(join(home, 'pack'))) return { docs, problems: ['no pack folder'] };
  const problems: string[] = [];
  for (const f of PACK_FILES) {
    const p = join(home, 'pack', f);
    if (!existsSync(p)) continue;
    try {
      const v = parse(readFileSync(p, 'utf8')) as unknown;
      if (v === null || v === undefined) continue;
      if (typeof v !== 'object' || Array.isArray(v)) problems.push(`${f} is not a mapping`);
      else docs[f] = v as Record<string, unknown>;
    } catch {
      problems.push(`${f} does not parse`);
    }
  }
  return { docs, problems };
}

const scalars = (v: unknown): string[] =>
  (Array.isArray(v) ? v : [v]).flatMap((x) => (typeof x === 'string' ? [x] : typeof x === 'number' && Number.isFinite(x) ? [String(x)] : []));
const group = (n: number, indian: boolean): string => {
  const s = String(n);
  if (!indian) return s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const last3 = s.slice(-3);
  const rest = s.slice(0, -3);
  return rest === '' ? last3 : `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last3}`;
};

/** The pack phone without any extension; '' when absent. */
const rawPhone = (home: string): string => scalars(readPack(home).docs['contact.yaml']['phone'])[0]?.replace(/\s*(?:ext\.?|extn\.?|x|#)\s*\d+\s*$/i, '').trim() ?? '';

/** The contact phone as digits only ('' when absent). */
export function phoneOf(home: string): string {
  return rawPhone(home).replace(/\D/g, '');
}

/** The phone without its country code: the digits after a written `+CC`/`00CC` group, else the last ten; '' if none. */
function nationalOf(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  const intl = /^\s*(?:\+|00)\s*(\d{1,3})[^\d]/.exec(raw);
  const national = intl !== null ? digits.slice((raw.trim().startsWith('00') ? 2 : 0) + (intl[1] as string).length) : digits.length > 10 ? digits.slice(-10) : digits.replace(/^0+/, '');
  return national.replace(/^0+/, '');
}

const floorOf = (home: string): { amount?: number; problem?: string } => {
  const f = readPack(home).docs['offers.yaml']['floor'];
  const raw = typeof f === 'object' && f !== null ? (f as { amount?: unknown }).amount : undefined;
  if (raw === undefined || raw === null) return {};
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\s*\d[\d,_ ]*\s*$/.test(raw) ? Number(raw.replace(/[,_ ]/g, '')) : Number.NaN;
  return Number.isSafeInteger(n) && n > 0 ? { amount: n } : { problem: 'the pay floor is not a whole number, so it is not checked' };
};

/** Lower-cased, de-duplicated terms, in a fixed order: forbidden terms, name, email, phone, links, floor forms. */
export function privacyTermsOf(home: string): string[] {
  const { docs } = readPack(home);
  const contact = docs['contact.yaml'];
  const phone = phoneOf(home);
  const { amount } = floorOf(home);
  const terms = [
    ...scalars(docs['naming.yaml']['forbiddenTerms']),
    ...scalars(contact['name']),
    ...scalars(contact['email']),
    ...(phone.length >= 7 ? [phone] : []),
    ...scalars(contact['links']).map((l) => l.trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/^www\./i, '').replace(/\/+$/, '')),
    ...(amount !== undefined ? [String(amount), group(amount, false), group(amount, true)] : []),
  ].map((t) => t.trim().toLowerCase());
  return [...new Set(terms)].filter((t) => t.length >= 2);
}

/** Why a home cannot be fully checked ('' problems = fully checked). Never names a value. */
export function privacyProblemsOf(home: string): string[] {
  const { problems } = readPack(home);
  if (problems.includes('no pack folder')) return problems;
  const out = [...problems];
  if (phoneOf(home).length > 20) out.push('the phone has more than 20 digits, so it is not checked');
  const floor = floorOf(home).problem;
  if (floor !== undefined) out.push(floor);
  if (out.length === 0 && privacyTermsOf(home).length === 0) out.push('no terms to check');
  return out;
}

// --- matching -------------------------------------------------------------------------------------------------------

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');
const NOT_WORD = '(?<![\\p{L}\\p{N}])';
const END_WORD = '(?![\\p{L}\\p{N}])';
/** Up to 3 separators between phone digits: any non-alphanumeric character (not a line break), or an HTML space. */
const PHONE_SEP = '(?:[^\\p{L}\\p{N}\\n]|&nbsp;){0,3}';
/** Between the words of a name: whitespace (a line break too), a slug's - or ., markdown emphasis, an HTML space or a short tag. */
const WORD_SEP = '(?:[\\s*_~`|>.-]|&nbsp;|<[^>\\n]{0,20}>)+';
/** Group separators in a written amount (NFKC has already folded no-break and thin spaces into plain spaces). */
const GROUP_SEP = "[,. _']";
/** After an amount: no more digits, except a decimal part that is all zeros. */
const AMOUNT_END = `(?=[.,]0{1,2}(?!\\d)|(?![.,_' ]?\\d))`;
const AMOUNT_START = `(?<!\\d|\\d${GROUP_SEP})`;

const digitsWith = (d: string, between: string): string => [...d].join(between);

/** A number as written in words: 12 lakh / 12L / 12 LPA, 1.2 crore, 1.2M / 1.2 million, 1200k (exact values only). */
function amountWords(n: number): string[] {
  // A whole-word unit (lakh, LPA, million, crore) needs only the number to stand alone. A one- or two-letter unit
  // (12L, 1.2M, 1200k) is two or three characters that occur by chance in base64 and binary files, so its number must
  // also open the text or follow a space, a currency sign or code, or opening punctuation.
  const CURRENCY = '(?:inr|rs\\.?|usd|eur|gbp)';
  const longStart = `(?:(?<=${CURRENCY})|(?<![\\p{L}\\p{N}.]))`;
  const shortStart = `(?<=^|[\\s₹$€£¥(\\[:="'*~>]|${CURRENCY})`;
  const unit = (div: number, long: string, short: string): string[] => {
    const v = n / div;
    if (v < 1 || Math.round(v * 100) !== v * 100) return [];
    const num = `${esc(String(v))}(?:\\.0+)?\\s*-?\\s*`;
    return [`${longStart}${num}(?:${long})${END_WORD}`, ...(short === '' ? [] : [`${shortStart}${num}(?:${short})${END_WORD}`])];
  };
  return [...unit(1e5, 'lakhs?|lacs?|lpa', 'l'), ...unit(1e7, 'crores?', 'cr'), ...unit(1e6, 'millions?', 'mn|m'), ...(n % 1000 === 0 ? unit(1e3, 'thousand', 'k') : [])];
}

type Matcher = (text: string) => boolean;
const anyOf = (patterns: string[]): Matcher => {
  const re = new RegExp(patterns.map((p) => `(?:${p})`).join('|'), 'u');
  return (text) => re.test(text);
};

/** How each term is found in normalised, lower-cased text; one matcher per term, in privacyTermsOf's order. */
function matchersOf(home: string): Matcher[] {
  const { docs } = readPack(home);
  const contact = docs['contact.yaml'];
  const name = scalars(contact['name'])[0]?.trim().toLowerCase();
  const email = scalars(contact['email'])[0]?.trim().toLowerCase();
  const phone = phoneOf(home);
  const national = nationalOf(rawPhone(home));
  const { amount } = floorOf(home);
  return privacyTermsOf(home).map((t): Matcher => {
    if (phone.length >= 7 && phone.length <= 20 && t === phone) {
      const forms = [`(?<!\\d)(?:00${PHONE_SEP})?${digitsWith(phone, PHONE_SEP)}(?!\\d)`];
      if (national.length >= 7 && national !== phone) forms.push(`(?<!\\d)(?:0${PHONE_SEP})?${digitsWith(national, PHONE_SEP)}(?!\\d)`);
      return anyOf(forms);
    }
    if (amount !== undefined && t === String(amount)) return anyOf([`${AMOUNT_START}${t}${AMOUNT_END}`, ...amountWords(amount)]);
    if (amount !== undefined && (t === group(amount, false) || t === group(amount, true))) return anyOf([`${AMOUNT_START}${t.split(',').join(GROUP_SEP)}${AMOUNT_END}`]);
    if (t === email && t.includes('@')) {
      const [local, domain] = [t.slice(0, t.lastIndexOf('@')), t.slice(t.lastIndexOf('@') + 1)];
      const at = '(?:@|%40|&#0*64;|&#x0*40;|\\\\u0040|\\s*[[(]\\s*at\\s*[\\])]\\s*|\\s+at\\s+)';
      const dot = '(?:\\.|\\s*[[(]\\s*dot\\s*[\\])]\\s*|\\s+dot\\s+)';
      return anyOf([`${esc(local)}${at}${domain.split('.').map(esc).join(dot)}`]);
    }
    const words = t.split(/\s+/);
    if (words.length > 1) {
      const forms = [words.map(esc).join(WORD_SEP)];
      if (t === name) forms.push(`${esc(words.at(-1) as string)},?${WORD_SEP}${words.slice(0, -1).map(esc).join(WORD_SEP)}`);
      return anyOf(forms);
    }
    if (t.length < 4) return anyOf([`${NOT_WORD}${esc(t)}${END_WORD}`]); // a short term only as a whole word
    return (text) => text.includes(t);
  });
}

/** One text form for matching: NFKC (full-width digits, no-break spaces), no zero-width characters, ASCII digits. */
const DEVANAGARI_ZERO = 0x966;
export function normaliseForScan(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\u2060\uFEFF\u00AD]/g, '')
    .replace(/[\u0966-\u096F]/g, (c) => String(c.charCodeAt(0) - DEVANAGARI_ZERO))
    .toLowerCase();
}

function decode(buf: Buffer, name: string): string {
  let b = buf;
  if (b[0] === 0x1f && b[1] === 0x8b) {
    try {
      b = gunzipSync(b);
    } catch {
      /* not really gzip: read the bytes as they are */
    }
  }
  if (b[0] === 0xff && b[1] === 0xfe) return b.subarray(2).toString('utf16le');
  if (b[0] === 0xfe && b[1] === 0xff) return Buffer.from(b.subarray(2)).swap16().toString('utf16le');
  void name;
  return b.toString('utf8');
}

const DOCUMENT_EXT = /\.(?:pdf|docx?|xlsx?|pptx?|odt|ods|odp|rtf|zip|jar|7z|rar|tar|tgz|bz2|xz)$/i;

export interface FolderScan {
  /** `<path> (<label>, term #<n>)`, or `… in the path)`; a path segment that matches any term is shown as [hidden]. */
  readonly hits: string[];
  /** Files the scan could not read as text: symlinks (not followed) and document/archive formats. */
  readonly notScanned: string[];
  /** Git-ignored files and folders left out (skipIgnored): git never publishes them. */
  readonly ignoredSkipped: number;
}

/** Paths git ignores under a work tree, relative to it (folders end in /); empty when `dir` is not in a work tree. */
function gitIgnored(dir: string): Set<string> {
  try {
    const out = execFileSync('git', ['-C', dir, 'ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'], { maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'] });
    return new Set(out.toString('utf8').split('\0').filter((l) => l !== ''));
  } catch {
    return new Set();
  }
}

export class PrivacyScanError extends Error {}

type Homes = readonly { label: string; home: string }[];

/** The matchers of every home, and how a hit is written: file, profile and term number, never the term. */
function scanner(homes: Homes) {
  const sets = homes.map((h) => ({ label: h.label, matchers: matchersOf(h.home) }));
  const anyTerm = (s: string): boolean => sets.some((x) => x.matchers.some((m) => m(s)));
  /** A path with every segment that matches any term shown as [hidden], so a hit never prints the term. */
  const shown = (rel: string): string => rel.split('/').map((seg) => (anyTerm(normaliseForScan(seg)) ? '[hidden]' : seg)).join('/');
  const textHits = (where: string, text: string, out: Set<string>): void => {
    const t = normaliseForScan(text);
    for (const s of sets) s.matchers.forEach((m, i) => {
      if (m(t)) out.add(`${where} (${s.label}, term #${i + 1})`);
    });
  };
  /** Hits in the path's own segments, each reported at the first segment that holds it. */
  const pathHits = (prefix: string, rel: string, out: Set<string>): void => {
    const segs = rel.split('/');
    segs.forEach((seg, k) => {
      const at = `${prefix}${shown(segs.slice(0, k + 1).join('/'))}`;
      for (const s of sets) s.matchers.forEach((m, i) => {
        if (m(normaliseForScan(seg))) out.add(`${at} (${s.label}, term #${i + 1}, in the path)`);
      });
    });
  };
  return { shown, textHits, pathHits };
}

export function scanFolder(dir: string, homes: Homes, opts: { skipIgnored?: boolean } = {}): FolderScan {
  const { shown, textHits, pathHits } = scanner(homes);
  const hits = new Set<string>();
  const notScanned: string[] = [];
  const ignored = opts.skipIgnored === true ? gitIgnored(dir) : new Set<string>();
  let ignoredSkipped = 0;
  const walk = (p: string): void => {
    for (const name of readdirSync(p).sort()) {
      if (name === 'node_modules' || name === '.git') continue;
      const f = join(p, name);
      const rel = relative(dir, f).split(sep).join('/');
      if (ignored.has(rel) || ignored.has(`${rel}/`)) {
        ignoredSkipped++;
        continue;
      }
      let st;
      try {
        st = lstatSync(f);
      } catch (e) {
        throw new PrivacyScanError(`${shown(rel)}: ${(e as NodeJS.ErrnoException).code ?? 'unreadable'}`);
      }
      pathHits('', rel, hits);
      if (st.isSymbolicLink()) {
        notScanned.push(`${shown(rel)} (a symlink, not followed)`);
        continue;
      }
      if (st.isDirectory()) {
        walk(f);
        continue;
      }
      if (!st.isFile()) continue;
      if (DOCUMENT_EXT.test(name)) notScanned.push(`${shown(rel)} (a document format whose text may be compressed)`);
      let text: string;
      try {
        text = decode(readFileSync(f), name);
      } catch (e) {
        throw new PrivacyScanError(`${shown(rel)}: ${(e as NodeJS.ErrnoException).code ?? 'unreadable'}`);
      }
      textHits(shown(rel), text, hits);
    }
  };
  walk(dir);
  return { hits: [...hits].sort(), notScanned: notScanned.sort(), ignoredSkipped };
}

/**
 * What a push would publish: every commit in `range` (git rev-list syntax; the root commit included), its message,
 * and every file version (blob) it adds or changes, scanned once per blob. A term added in one commit and deleted in
 * the next is still found, in the commit that added it. Author and committer are not scanned: they are the public
 * identity the repo is published under. Hits read `<sha7> <path>|message (<label>, term #<n>)`.
 */
export function scanGit(repoDir: string, range: string, homes: Homes): { hits: string[]; commits: number } {
  const git = (args: string[]): Buffer => {
    try {
      return execFileSync('git', ['-C', repoDir, ...args], { maxBuffer: 1 << 30, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      const why = String((e as { stderr?: Buffer }).stderr ?? '').split('\n')[0] || 'failed';
      throw new PrivacyScanError(`git ${args[0]}: ${why}`);
    }
  };
  const { shown, textHits, pathHits } = scanner(homes);
  const hits = new Set<string>();
  const seen = new Set<string>();
  const shas = git(['rev-list', '--reverse', range, '--']).toString('utf8').split('\n').filter((l) => l !== '');
  for (const sha of shas) {
    const short = sha.slice(0, 7);
    textHits(`${short} message`, git(['log', '-1', '--format=%B', sha]).toString('utf8'), hits);
    // -m --first-parent: a merge is compared with its first parent, so a conflict resolution's new blobs count too
    const fields = git(['diff-tree', '-r', '--root', '--no-commit-id', '--no-renames', '-m', '--first-parent', '-z', sha]).toString('utf8').split('\0');
    for (let i = 0; i + 1 < fields.length; i += 2) {
      const [, , newMode, , blob, status] = /^:(\d+) (\d+) ([0-9a-f]+) ([0-9a-f]+) ([A-Z])/.exec(fields[i] as string) ?? [];
      const path = fields[i + 1] as string;
      if (status === undefined || status === 'D' || blob === undefined || newMode === '160000') continue;
      pathHits(`${short} `, path, hits);
      if (seen.has(blob)) continue;
      seen.add(blob);
      textHits(`${short} ${shown(path)}`, decode(git(['cat-file', 'blob', blob]), path), hits);
    }
  }
  return { hits: [...hits].sort(), commits: shas.length };
}

export function scanForTerms(dir: string, homes: Homes): string[] {
  return scanFolder(dir, homes).hits;
}
