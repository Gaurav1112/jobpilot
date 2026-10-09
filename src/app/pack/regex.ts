const MAX_PATTERN_LENGTH = 200;

/**
 * Static safety check for user-supplied regex sources. Rejects over-long patterns and the classic
 * catastrophic-backtracking shape: an unboundedly quantified group whose body itself contains a
 * quantifier or an alternation, e.g. `(a+)+`, `(a*)*`, `(a|a)+`. Returns an error message or null.
 */
export function unsafeRegexReason(source: string): string | null {
  if (source.length > MAX_PATTERN_LENGTH) return `pattern longer than ${MAX_PATTERN_LENGTH} characters`;
  // Each open group records whether its body so far holds a quantifier or an alternation.
  const stack: boolean[] = [];
  let inClass = false;
  for (let i = 0; i < source.length; i++) {
    const c = source[i] as string;
    if (c === '\\') {
      i++;
      continue;
    }
    if (inClass) {
      if (c === ']') inClass = false;
      continue;
    }
    if (c === '[') {
      inClass = true;
    } else if (c === '(') {
      stack.push(false);
    } else if (c === '|') {
      if (stack.length > 0) stack[stack.length - 1] = true;
    } else if (c === '+' || c === '*' || c === '{' || (c === '?' && source[i - 1] !== '(')) {
      if (stack.length > 0 && !(c === '{' && !/^\{\d+(,\d*)?\}/.test(source.slice(i)))) stack[stack.length - 1] = true;
    } else if (c === ')') {
      const body = stack.pop() ?? false;
      const rest = source.slice(i + 1);
      if (body && /^([+*]|\{\d+,\})/.test(rest)) return 'nested quantifier (catastrophic backtracking risk)';
      // A closed group that was itself quantified or alternated counts as quantified content for its parent.
      if (body && stack.length > 0) stack[stack.length - 1] = true;
    }
  }
  return null;
}

/**
 * The one way to compile a user-supplied pattern (roleDeny, a careers linkPattern): fixed flags 'iu',
 * safety-checked. Throws on unsafe or invalid input. This module imports nothing, so agent code may use it.
 */
export function compileSafePattern(pattern: string): RegExp {
  const reason = unsafeRegexReason(pattern);
  if (reason !== null) throw new Error(reason);
  return new RegExp(pattern, 'iu');
}

/** The roleDeny name for `compileSafePattern`. */
export const compileRoleDeny = compileSafePattern;
