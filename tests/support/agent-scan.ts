import { posix } from 'node:path';
import ts from 'typescript';

/**
 * Containment scan for agent code, done on the syntax tree rather than with regexes, so spacing, comments,
 * parentheses, optional calls, tagged templates and unicode escapes cannot hide a reference.
 *
 * Scope: this is a guard against accidental or naive bypass in first-party agent code (it catches every form in
 * its self-tests), not a sandbox. Deliberate obfuscation can defeat any static scan. Untrusted plugin code is
 * isolated by the worker-thread sandbox planned for the plugin SDK (sub-project 11); the scan is only an extra check.
 */

/** Agent code: everything an agent's run() can execute. The kernel, evals, CLI and demo wiring are the trusted side. */
export const isAgentCode = (path: string) =>
  path.startsWith('src/agents/') || path.startsWith('src/app/agents/') || path === 'src/demo/agents.ts' || path === 'src/demo/types.ts';

/**
 * Shared app modules agent code may import: message types and predicates (zod plus kernel definitions), the
 * import-free safe-regex compiler for user-supplied patterns, the load-more label rule, and the normalizer's pure
 * text helpers (HTML to text, normalisation, the comp parser), and the pure pack rules. Each is scanned like agent code.
 */
export const APP_ALLOWED = [
  'src/app/types.ts',
  'src/app/pack/regex.ts',
  'src/app/browser/labels.ts',
  'src/app/text/html.ts',
  'src/app/text/norm.ts',
  'src/app/comp/parse.ts',
  'src/app/comp/floor.ts',
  'src/app/lexicon.ts',
  // The pure pack rules (citeable, the forbidden-term check, employer display names) the writing team applies.
  'src/app/pack/rules.ts',
  // Task 10: the pure document model, the cover p4 fill, the HTML preview and the ATS profiles.
  'src/app/render/model.ts',
  'src/app/render/fill.ts',
  'src/app/render/html.ts',
  'src/app/ats-profiles.ts',
  // Task 7 fix round 2: the pure bot-wall detector the coverage gate and the Eightfold adapter share (no imports).
  'src/app/challenge.ts',
  // Task 8: the pure sitemap reader (moved from the coverage locator) the daily page adapters share.
  'src/app/text/sitemap.ts',
  // Task 9: the pure linear XML reader the Teamtailor and Personio feed adapters share.
  'src/app/text/xml-lite.ts',
  // Career-sites Task 10: the pure ATS job id reader (no imports) the normalizer and the Posting type use.
  'src/app/text/ats-id.ts',
  // Profiles Task 12: the pure place tables norm.ts reads (base places, per-country tables, and the data compiled from
  // src/app/geo/data/**.yaml by scripts/gen-geo.ts; no file I/O at run time).
  'src/app/geo/base.ts',
  'src/app/geo/places.ts',
  'src/app/geo/data.generated.ts',
  // Profiles Task 13: the pure residence scope (country, regions, offsets, notes) eligibility derives from the pack.
  'src/app/geo/residence.ts',
  // Profiles Task 18: the pure currency table (no imports) and the per-locale pay reader eligibility uses for a profile
  // outside the default currencies (it imports only the normalizer's pay wording, the posting type and the table).
  'src/app/comp/currencies.ts',
  'src/app/comp/locale.ts',
];

/**
 * Trusted render libraries (Task 10) agent code may import but which are not scanned as agent code: they wrap pdfkit
 * and docx, and use node:crypto (the PDF trailer ID) and node:zlib (the DOCX zip). In exchange they are held to their
 * own rule (`scanRenderLib`): imports only from `RENDER_LIB_IMPORTS`, no file, network, process, clock or randomness.
 * They return bytes; only the broker's files capability writes them.
 */
export const RENDER_LIBS = ['src/app/render/pdf.ts', 'src/app/render/docx.ts', 'src/app/render/fonts.ts'];
export const RENDER_LIB_IMPORTS = ['pdfkit', 'docx', 'node:crypto', 'node:zlib', './model.js', './fonts.js'];
/** The font loader alone may read files, and only through `readFileSync` of the vendored fonts. */
const FONT_LOADER = 'src/app/render/fonts.ts';
const RENDER_LIB_FORBIDDEN = /\b(fetch|process|globalThis|require|eval|Function|XMLHttpRequest|WebSocket|Date\.now|Math\.random|performance|setTimeout|setInterval)\b|new Date\(\s*\)/;

/** Problems in a render library's source: a disallowed import, or a forbidden global, clock or randomness. */
export const scanRenderLib = (file: string, text: string): string[] => {
  const problems: string[] = [];
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  sf.forEachChild((node) => {
    const spec = declarationSpecifier(node);
    const fsRead = file === FONT_LOADER && spec === 'node:fs' && /^import \{ readFileSync \} from 'node:fs';$/.test(node.getText(sf));
    if (spec !== undefined && !RENDER_LIB_IMPORTS.includes(spec) && !fsRead) problems.push(`${file}: import of ${spec}`);
    if (ts.isImportEqualsDeclaration(node)) problems.push(`${file}: import-equals`);
  });
  const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  code.split('\n').forEach((line, i) => {
    const m = RENDER_LIB_FORBIDDEN.exec(line);
    if (m) problems.push(`${file}:${i + 1}: ${m[0]}`);
  });
  if (/\bimport\s*\(/.test(code)) problems.push(`${file}: dynamic import`);
  return problems;
};

/** The only kernel modules agent code may import: definitions, never providers, broker, store, executor or fakes. */
const KERNEL_ALLOWED = ['agent', 'contract', 'errors', 'types', 'predicates', 'data-class'].map((m) => `src/kernel/${m}.ts`);
const PACKAGES_ALLOWED = ['zod'];

/** Globals that reach the network, the process, or code built from strings. Agent code may not name them at all. */
const FORBIDDEN_GLOBALS = new Set([
  'fetch', 'WebSocket', 'XMLHttpRequest', 'EventSource', 'process', 'global', 'globalThis', 'Reflect', 'eval', 'Function',
  'require', 'module', 'Buffer', 'Deno', 'Bun',
]);

/** Whether agent code at `file` (repo-relative) may import `spec`. */
export const allowedSpecifier = (file: string, spec: string): boolean => {
  if (!spec.startsWith('.')) return PACKAGES_ALLOWED.includes(spec);
  const target = posix.join(posix.dirname(file), spec.replace(/[?#].*$/s, '')).replace(/\.js$/, '.ts');
  return KERNEL_ALLOWED.includes(target) || APP_ALLOWED.includes(target) || RENDER_LIBS.includes(target) || isAgentCode(target);
};

/** The module specifier of an import/export declaration, if it has a string one. */
const declarationSpecifier = (node: ts.Node): string | undefined => {
  if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
    return node.moduleSpecifier.text;
  }
  return undefined;
};

/** An identifier that names a property or member, or an imported binding of an allowed module, rather than a value in scope. */
const isMemberName = (file: string, id: ts.Identifier): boolean => {
  const p = id.parent;
  if (ts.isPropertyAccessExpression(p) && p.name === id) return true;
  if (ts.isQualifiedName(p) && p.right === id) return true;
  if ((ts.isPropertyAssignment(p) || ts.isMethodDeclaration(p) || ts.isGetAccessorDeclaration(p) || ts.isSetAccessorDeclaration(p)) && p.name === id) return true;
  if ((ts.isPropertyDeclaration(p) || ts.isPropertySignature(p) || ts.isMethodSignature(p)) && p.name === id) return true;
  if (ts.isImportSpecifier(p) || ts.isExportSpecifier(p)) {
    const decl = ts.isImportSpecifier(p) ? p.parent.parent.parent : p.parent.parent;
    const spec = declarationSpecifier(decl);
    return spec !== undefined && allowedSpecifier(file, spec);
  }
  return false;
};

/** Every containment problem in agent source `text` at repo-relative `file`, as `<file>:<line>: <reason>`. */
export const scanAgentSource = (file: string, text: string): string[] => {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const problems: string[] = [];
  const at = (node: ts.Node, reason: string) =>
    problems.push(`${file}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}: ${reason}`);

  const parseErrors = (sf as unknown as { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? [];
  if (parseErrors.length > 0) return [`${file}:1: does not parse (${ts.flattenDiagnosticMessageText(parseErrors[0]?.messageText, ' ')})`];

  const checkSpecifier = (node: ts.Node, spec: string) => {
    if (!allowedSpecifier(file, spec)) at(node, `import of ${spec}`);
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const spec = declarationSpecifier(node);
      if (spec !== undefined) checkSpecifier(node, spec);
      else if (node.moduleSpecifier) at(node, 'non-literal module specifier');
    } else if (ts.isImportEqualsDeclaration(node)) {
      const ref = node.moduleReference;
      if (ts.isExternalModuleReference(ref) && ts.isStringLiteral(ref.expression)) checkSpecifier(node, ref.expression.text);
      else at(node, 'import-equals without a literal module specifier');
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [arg, ...rest] = node.arguments;
      if (arg && rest.length === 0 && ts.isStringLiteral(arg)) checkSpecifier(node, arg.text);
      else at(node, 'dynamic import without a single string literal');
    } else if (ts.isMetaProperty(node)) {
      at(node, `${node.getText(sf)} is not allowed`);
    } else if (ts.isPropertyAccessExpression(node) && node.name.text === 'constructor') {
      at(node, 'access to .constructor');
    } else if (
      ts.isElementAccessExpression(node) &&
      (ts.isStringLiteral(node.argumentExpression) || ts.isNoSubstitutionTemplateLiteral(node.argumentExpression)) &&
      node.argumentExpression.text === 'constructor'
    ) {
      at(node, 'access to [constructor]');
    } else if (ts.isBindingElement(node) && [node.propertyName, node.name].some((n) => n && ts.isIdentifier(n) && n.text === 'constructor')) {
      at(node, 'destructuring of constructor');
    } else if (
      ts.isCallExpression(node) &&
      node.arguments.some((a) => (ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a)) && a.text === 'constructor')
    ) {
      at(node, "'constructor' passed as an argument");
    } else if (ts.isIdentifier(node) && FORBIDDEN_GLOBALS.has(node.text) && !isMemberName(file, node)) {
      at(node, `reference to ${node.text}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return problems;
};
