/**
 * Term matching for the lexicon scorer and the title rules. Pure: no imports, no I/O, so agent code may use it (the
 * containment scan reads this file like agent code).
 *
 * Rules, all case-insensitive (a blank term matches nothing):
 * - A term matches as a whole word. Its letters and symbols are literal (`c++`, `c#`, `.net`, `node.js` are escaped),
 *   and a space or hyphen inside a term matches any run of spaces or hyphens, or none ("sde-3" matches "SDE 3" and
 *   "SDE3"; "event-driven" matches "event driven").
 * - The boundary on each side depends on the term's own edge character:
 *   - a letter or digit edge needs no letter, digit or underscore next to it ("java" is not in "javascript");
 *   - a symbol edge on the right (`c++`, `c#`) also needs no further `+` or `#` ("c+++" is not c++);
 *   - a `.` edge on the left (`.net`) needs no letter, digit, underscore or dot before it, so a domain name
 *     ("example.net") is not .NET, except after `asp` or `vb` ("ASP.NET", "VB.NET" are .NET).
 * - The term `go` is an English word as well as a language, so it needs context on top of the word boundary. It is
 *   never followed by a hyphen and a letter ("go-to-market", "go-getter"), and one of these holds:
 *   - it is a list item: before it is a line start (optionally a bullet), `,` `/` `(` `|` `;` `:` or `and`/`or`/`&`,
 *     and after it is `,` `/` `)` `|` `;` `.`, the end of the line, or `and`/`or` ("Java, Go, Python", "Go/Rust",
 *     "Python and Go", "- Go");
 *   - a language word follows: lang, language, programming, developer(s), engineer(s), service(s),
 *     microservice(s), code, backend, module(s), runtime, stack, routine(s), api(s) ("Go services");
 *   - a skill phrase precedes: in, with, using, write, writing, written in, knowledge of, proficient in,
 *     proficiency in ("experience in Go").
 *   So "good", "Google", "ready to go", "go live", "go above and beyond" and "on the go" are not Go; "golang" (a
 *   synonym) always is.
 */

export interface TermGroup {
  readonly key: string;
  readonly synonyms: readonly string[];
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const WORD = /[\p{L}\p{N}_]/u;

function termSource(term: string): string {
  const t = term.trim().toLowerCase();
  const body = t
    .split(/[\s-]+/)
    .filter((p) => p !== '')
    .map(escapeRe)
    .join('[\\s-]*');
  const first = t[0] ?? '';
  const last = t[t.length - 1] ?? '';
  const left = WORD.test(first) ? '(?<![\\p{L}\\p{N}_])' : first === '.' ? '(?:(?<![\\p{L}\\p{N}_.])|(?<=(?<![\\p{L}\\p{N}_])(?:asp|vb)))' : '';
  const right = WORD.test(last) ? '(?![\\p{L}\\p{N}_])' : '(?![\\p{L}\\p{N}_+#])';
  return `${left}${body}${right}`;
}

const cache = new Map<string, RegExp>();
function termRe(term: string): RegExp {
  let re = cache.get(term);
  if (re === undefined) {
    re = new RegExp(termSource(term), 'giu');
    cache.set(term, re);
  }
  return re;
}

const GO_LIST_BEFORE = /(?:^|\n)[ \t]*(?:[-*•·][ \t]*)?$|[,/(|;:][ \t]*$|(?<![\p{L}\p{N}_])(?:and|or|&)[ \t]+$/iu;
const GO_LIST_AFTER = /^[ \t]*(?:[,/)|;.]|\n|$)|^[ \t]+(?:and|or)(?![\p{L}\p{N}_])/iu;
const GO_LANGUAGE_AFTER =
  /^[ \t]+(?:lang|language|programming|developers?|engineers?|services?|microservices?|code|backend|modules?|runtime|stack|routines?|apis?)(?![\p{L}\p{N}_])/iu;
const GO_SKILL_BEFORE = /(?<![\p{L}\p{N}_])(?:in|with|using|write|writing|written in|knowledge of|proficient in|proficiency in)[ \t]+$/iu;
const GO_RE = /(?<![\p{L}\p{N}_])go(?![\p{L}\p{N}_])/giu;

function hasGo(text: string): boolean {
  for (const m of text.matchAll(GO_RE)) {
    const at = m.index ?? 0;
    // Everything before and after, so `^` and `$` are the real start and end of the text.
    const before = text.slice(0, at);
    const after = text.slice(at + 2);
    if (/^-\p{L}/u.test(after)) continue;
    const list = GO_LIST_BEFORE.test(before) && GO_LIST_AFTER.test(after);
    if (list || GO_LANGUAGE_AFTER.test(after) || GO_SKILL_BEFORE.test(before)) return true;
  }
  return false;
}

/** Whether `term` occurs in `text` under the rules above. */
export function hasTerm(text: string, term: string): boolean {
  // A term with no letter, digit or symbol in it (a stray "" in the pack) would match everywhere: it matches nothing.
  if (term.replace(/[\s-]+/g, '') === '') return false;
  if (term.trim().toLowerCase() === 'go') return hasGo(text);
  const re = termRe(term);
  re.lastIndex = 0;
  return re.test(text.toLowerCase());
}

/** Whether any of `terms` occurs in `text`. */
export const anyTermIn = (text: string, terms: readonly string[]): boolean => terms.some((t) => hasTerm(text, t));

/** The keys of the groups whose key or any synonym occurs in `text`, each once, sorted. */
export function termsIn(text: string, groups: readonly TermGroup[]): string[] {
  const keys = groups.filter((g) => anyTermIn(text, [g.key, ...g.synonyms])).map((g) => g.key);
  return [...new Set(keys)].sort();
}
