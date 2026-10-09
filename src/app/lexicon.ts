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
 *
 * Ambiguous words (task 7 fix round 1): `go`, `react`, `spark`, `spring`, `node`, `rust`, `ruby` are also English
 * words (or a cluster node), so a bare occurrence counts only when one of these holds:
 * 1. qualified: its tech qualifier follows at once (after a space, or attached as in "ReactJS", "React.js"); see
 *    QUALIFIERS ("Spring Boot", "Spark Streaming", "React Native", "Go services", "Ruby on Rails");
 * 2. a list item with a tech neighbour: before it is a line start (optionally a bullet), one of `, / | ; ( :`, or
 *    and/or/&; after it is one of `, / | ; ) .`, the end of the text or line, or and/or; and the same segment (bounded
 *    by a newline or a sentence-ending `.`) holds another lexicon term or a known language word (LANGUAGE_WORDS)
 *    ("Kotlin, Swift, Java, and React"; not "companies can react faster", not "spring, summer");
 * 3. a skill phrase comes right before it: experience in/with, proficient/proficiency in, knowledge of, using,
 *    written in, familiar/familiarity with ("deep knowledge of Go");
 * 4. (fix round 3) a known tech term is directly beside it, joined by one connector (`, / & + |`, and/or, or a line
 *    break with an optional bullet): "Go and Postgres", "Flink/Spark", "Ruby/Rails", "Go\nPostgres";
 * 5. (fix round 3) it is the single item after a heading label: "Backend: Go", "Tech stack: React";
 * 6. (fix round 3) a skill noun follows it: skills, experience, expertise, developer(s), engineer(s).
 * On a bullet line (`-`, `•`, `*`, `·` or `1.`), the list segment is the whole contiguous bullet block, so one item per
 * line still has its neighbours.
 * A `go` followed by a hyphen and a letter ("go-to-market", "go-getter") never counts, nor "go/no-go" or "no-go".
 * `ai` is stricter: it never counts alone, only inside the compounds of AI_COMPOUND (ai/ml, generative ai, genai, ai
 * platform ...). "AI-powered tools" and "embrace AI" do not count; "llm" and "large language model" are ordinary
 * synonyms in the pack.
 */

export interface TermGroup {
  readonly key: string;
  readonly synonyms: readonly string[];
}

/**
 * Tech words that make a list a tech list (and a neighbour an ambiguous word can lean on), whatever the pack's lexicon
 * holds: languages, plus ecosystem words (fix round 3, I-R2).
 */
export const LANGUAGE_WORDS: readonly string[] = [
  'java', 'kotlin', 'python', 'typescript', 'javascript', 'scala', 'c++', 'c#', 'swift', 'sql',
  'hibernate', 'jpa', 'maven', 'gradle', 'express', 'rails', 'django', 'flask', 'mysql', 'graphql', 'flink', 'airflow',
  'redux', 'vue', 'angular', 'nestjs', 'junit', 'jvm',
];

/** The qualifiers that make each ambiguous word unambiguous when they follow it. */
/** Following words that make any ambiguous word a skill ("Strong Go skills", "React experience"). */
const SKILL_NOUN = 'skills?|experience|expertise|developers?|engineers?';
const QUALIFIERS: Readonly<Record<string, string>> = {
  go: 'lang|language|programming|developers?|engineers?|services?|microservices?|code|backend|modules?|runtime|stack|routines?|apis?',
  react: 'js|\\.js|native|hooks|redux|components?|query|router',
  spark: 'streaming|sql|jobs?|clusters?|applications?|pipelines?',
  spring: 'boot|framework|cloud|mvc|data|batch|security|webflux',
  node: 'js|\\.js',
  rust: 'on rails|lang|programming',
  ruby: 'on rails|lang|programming',
};

const AI_COMPOUND = new RegExp(
  '(?<![\\p{L}\\p{N}_])(?:ai/ml|ml/ai|ai/llm|generative[ \\t-]+ai|genai|agentic[ \\t-]+ai|applied[ \\t-]+ai|' +
    'ai[ \\t-]+(?:engineer|engineering|platform|systems?|infrastructure|agents?|applications?|services?|features?|products?|models?|pipelines?))(?![\\p{L}\\p{N}_])',
  'iu',
);

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

/** The plain rule: the term as a whole word, no context needed. */
function plainHas(text: string, term: string): boolean {
  const re = termRe(term);
  re.lastIndex = 0;
  return re.test(text.toLowerCase());
}

const LIST_BEFORE = /(?:^|\n)[ \t]*(?:[-*•·][ \t]*|\d+[.)][ \t]*)?$|[,/|;(:][ \t]*$|(?<![\p{L}\p{N}_])(?:and|or|&)[ \t]+$/iu;
const LIST_AFTER = /^[ \t]*(?:[,/|;).]|\n|$)|^[ \t]+(?:and|or)(?![\p{L}\p{N}_])/iu;
const SKILL_BEFORE = /(?<![\p{L}\p{N}_])(?:experience (?:in|with)|proficien(?:t|cy) in|knowledge of|using|written in|familiar(?:ity)? with)[ \t]+$/iu;
/** A heading label right before a single item: "Backend: Go", "Tech stack: React". */
const LABEL_BEFORE = /(?<![\p{L}\p{N}_])(?:tech(?:nolog(?:y|ies))?(?: stack)?|stack|languages?|backend|frontend|skills?|tools?)[ \t]*:[ \t]*$/iu;
/** A connector between two neighbouring terms: `,` `/` `&` `+` `|`, and/or, or a line break (optionally a bullet). */
const CONNECTOR = '(?:[ \\t]*[,/&+|][ \\t]*|[ \\t]+(?:and|or)[ \\t]+|[ \\t]*\\n[ \\t]*(?:[-*•·][ \\t]*|\\d+[.)][ \\t]*)?)';
const CONNECTOR_AFTER = new RegExp(`^${CONNECTOR}`, 'iu');
const CONNECTOR_BEFORE = new RegExp(`${CONNECTOR}$`, 'iu');
const BULLET_LINE = /^[ \t]*(?:[-*•·]|\d+[.)])[ \t]+\S/;

const anchored = new Map<string, readonly [RegExp, RegExp]>();
/** [starts-with, ends-with] regexes for a neighbour term. */
function anchoredRe(term: string): readonly [RegExp, RegExp] {
  let r = anchored.get(term);
  if (r === undefined) {
    const src = termSource(term);
    r = [new RegExp(`^${src}`, 'iu'), new RegExp(`${src}$`, 'iu')];
    anchored.set(term, r);
  }
  return r;
}

/** A known tech term directly beside the word, joined by one connector ("Go and Postgres", "Flink/Spark", "Go\nPostgres"). */
function besideTech(before: string, after: string, others: readonly string[]): boolean {
  const a = CONNECTOR_AFTER.exec(after);
  const next = a === null ? null : after.slice(a[0].length, a[0].length + 40);
  const b = CONNECTOR_BEFORE.exec(before);
  const prev = b === null ? null : before.slice(Math.max(0, before.length - b[0].length - 40), before.length - b[0].length);
  return others.some((n) => (next !== null && anchoredRe(n)[0].test(next)) || (prev !== null && anchoredRe(n)[1].test(prev)));
}

/** A segment ends at a newline or a sentence-ending dot (one followed by space or the end), not the dot in "Node.js". */
const SEGMENT_END = /\n|\.(?=\s|$)/g;

function segmentAround(text: string, start: number, end: number): string {
  // On a bullet line, the segment is the whole contiguous bullet block (fix round 3, I-R2).
  const lineStart = text.lastIndexOf('\n', start - 1) + 1;
  const lineEndAt = text.indexOf('\n', end);
  const lineEnd = lineEndAt < 0 ? text.length : lineEndAt;
  if (BULLET_LINE.test(text.slice(lineStart, lineEnd))) {
    const lines = text.split('\n');
    let offset = 0;
    let index = 0;
    for (; index < lines.length; index++) {
      if (offset + (lines[index] ?? '').length >= start) break;
      offset += (lines[index] ?? '').length + 1;
    }
    let first = index;
    let last = index;
    while (first > 0 && BULLET_LINE.test(lines[first - 1] ?? '')) first--;
    while (last + 1 < lines.length && BULLET_LINE.test(lines[last + 1] ?? '')) last++;
    const blockStart = lines.slice(0, first).reduce((n, l) => n + l.length + 1, 0);
    const blockEnd = lines.slice(0, last + 1).reduce((n, l) => n + l.length + 1, 0) - 1;
    return `${text.slice(blockStart, start)} \u0000 ${text.slice(end, blockEnd)}`;
  }
  let from = 0;
  let to = text.length;
  for (const m of text.matchAll(SEGMENT_END)) {
    const at = m.index ?? 0;
    if (at < start) from = at + 1;
    else if (at >= end) {
      to = at;
      break;
    }
  }
  return `${text.slice(from, start)} \u0000 ${text.slice(end, to)}`;
}

function ambiguousHas(text: string, word: string, neighbours: readonly string[]): boolean {
  if (word === 'ai') return AI_COMPOUND.test(text);
  const qualifier = new RegExp(`^(?:[ \\t]+|[-.]?)(?:${QUALIFIERS[word] ?? '(?!)'}|${SKILL_NOUN})(?![\\p{L}\\p{N}_])`, 'iu');
  const occurrence = new RegExp(`(?<![\\p{L}\\p{N}_])${word}`, 'giu');
  const others = neighbours.filter((n) => n.trim().toLowerCase() !== word && n.replace(/[\s-]+/g, '') !== '');
  for (const m of text.matchAll(occurrence)) {
    const start = m.index ?? 0;
    const end = start + word.length;
    const before = text.slice(0, start);
    const after = text.slice(end);
    if (qualifier.test(after)) return true;
    if (WORD.test(after[0] ?? '')) continue; // inside a longer word ("Google", "gopher")
    if (word === 'go' && (/^-\p{L}/u.test(after) || /^\/no[- ]?go\b/i.test(after) || /\bno[- ]?$/i.test(before))) continue;
    if (SKILL_BEFORE.test(before)) return true;
    if (LABEL_BEFORE.test(before) && LIST_AFTER.test(after)) return true;
    if (besideTech(before, after, others)) return true;
    if (LIST_BEFORE.test(before) && LIST_AFTER.test(after)) {
      const segment = segmentAround(text, start, end);
      if (others.some((n) => plainHas(segment, n))) return true;
    }
  }
  return false;
}

const isAmbiguous = (t: string): boolean => t === 'ai' || Object.hasOwn(QUALIFIERS, t);

/**
 * Whether `term` occurs in `text` under the rules above. `neighbours` are the terms that make a list a tech list for
 * an ambiguous word (by default the language words; `termsIn` adds the whole lexicon).
 */
export function hasTerm(text: string, term: string, neighbours: readonly string[] = LANGUAGE_WORDS): boolean {
  // A term with no letter, digit or symbol in it (a stray "" in the pack) would match everywhere: it matches nothing.
  if (term.replace(/[\s-]+/g, '') === '') return false;
  const t = term.trim().toLowerCase();
  return isAmbiguous(t) ? ambiguousHas(text, t, neighbours) : plainHas(text, t);
}

/** Whether any of `terms` occurs in `text`. */
export const anyTermIn = (text: string, terms: readonly string[], neighbours: readonly string[] = LANGUAGE_WORDS): boolean =>
  terms.some((t) => hasTerm(text, t, neighbours));

/** Every key and synonym of `groups`: the neighbours that make a list a tech list. */
export const lexiconTerms = (groups: readonly TermGroup[]): string[] => groups.flatMap((g) => [g.key, ...g.synonyms]);

/**
 * The keys of the groups whose key or any synonym occurs in `text`, each once, sorted. `allGroups` (default `groups`)
 * are the lexicon terms that count as tech neighbours in a list: pass every tier so a medium word can vouch for a
 * strong one.
 */
export function termsIn(text: string, groups: readonly TermGroup[], allGroups: readonly TermGroup[] = groups): string[] {
  const neighbours = [...LANGUAGE_WORDS, ...lexiconTerms(allGroups)];
  const keys = groups.filter((g) => anyTermIn(text, [g.key, ...g.synonyms], neighbours)).map((g) => g.key);
  return [...new Set(keys)].sort();
}
