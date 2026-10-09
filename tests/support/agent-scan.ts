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
 * Shared app modules agent code may import: message types and predicates (zod plus kernel definitions), and the
 * import-free safe-regex compiler for user-supplied patterns. Each is scanned like agent code.
 */
export const APP_ALLOWED = ['src/app/types.ts', 'src/app/pack/regex.ts', 'src/app/browser/labels.ts'];

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
  return KERNEL_ALLOWED.includes(target) || APP_ALLOWED.includes(target) || isAgentCode(target);
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
