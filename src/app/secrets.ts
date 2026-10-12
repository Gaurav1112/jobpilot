import { spawnSync } from 'node:child_process';

/**
 * The macOS Keychain, through `/usr/bin/security`, for jobpilot's few secrets (Task 13: the Gmail OAuth client and its
 * refresh token). Every item is a generic password with service `jobpilot` and the secret's name as its account.
 *
 * Values never appear in argv, where `ps` and process accounting could see them:
 * - **store**: `security add-generic-password -w <value>` would put the value in argv, and the bare `-w` prompt form
 *   reads from the terminal (`/dev/tty`), not stdin. So the value goes through `security -i`, which reads the whole
 *   command from **stdin**: `add-generic-password -U -s jobpilot -a <name> -w "<value>"`. In that mode a backslash
 *   escapes the next character, so `\` and `"` are escaped; a value with a control character (a line break would end
 *   the command) is refused. Checked by hand against a throwaway keychain (2026-10-12).
 * - **read**: `find-generic-password ... -w` prints only the value on stdout; argv holds the name alone.
 * - **test**: `find-generic-password` without `-w` reads only the item's attributes (no value, no Keychain prompt).
 * - **delete**: `delete-generic-password`.
 * Exit status 44 is "the item could not be found". An error message names the secret and the exit status, never the
 * value, stdout or stderr of a store.
 *
 * The item is created by `/usr/bin/security`, which the Keychain trusts for it by default, so a later read by the same
 * tool (a scheduled run) needs no prompt. Everything goes through a runner, so tests never reach the real Keychain.
 */
export const KEYCHAIN_SERVICE = 'jobpilot';
export const SECURITY_BIN = '/usr/bin/security';
const NOT_FOUND = 44;
const NAME = /^[a-z][a-z0-9._-]{0,63}$/;
const MAX_VALUE = 8192;

export type SecretsRunner = (cmd: string, args: readonly string[], stdin?: string) => { status: number; stdout: string; stderr: string };

export const realSecretsRunner: SecretsRunner = (cmd, args, stdin) => {
  const r = spawnSync(cmd, [...args], { encoding: 'utf8', input: stdin ?? '', stdio: ['pipe', 'pipe', 'pipe'], timeout: 30_000 });
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.error ? String(r.error.message) : (r.stderr ?? '') };
};

function checkName(name: string): void {
  if (!NAME.test(name)) throw new Error(`keychain: invalid secret name ${JSON.stringify(name)}`);
}

const firstLine = (s: string): string => s.split('\n').find((l) => l.trim() !== '')?.trim() ?? '';

/** The secret's value, or undefined when there is no such item. */
export function getSecret(name: string, run: SecretsRunner = realSecretsRunner): string | undefined {
  checkName(name);
  const r = run(SECURITY_BIN, ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', name, '-w']);
  if (r.status === NOT_FOUND) return undefined;
  if (r.status !== 0) throw new Error(`keychain: reading ${name} failed (security exit ${r.status}${firstLine(r.stderr) === '' ? '' : `: ${firstLine(r.stderr)}`})`);
  // `-w` prints the value and one line feed.
  return r.stdout.endsWith('\n') ? r.stdout.slice(0, -1) : r.stdout;
}

/** Whether the item exists; reads its attributes only, never its value. */
export function hasSecret(name: string, run: SecretsRunner = realSecretsRunner): boolean {
  checkName(name);
  const r = run(SECURITY_BIN, ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', name]);
  if (r.status === NOT_FOUND) return false;
  if (r.status !== 0) throw new Error(`keychain: looking up ${name} failed (security exit ${r.status})`);
  return true;
}

/** Creates or replaces the item (`-U`); the value reaches `security` on stdin only. */
export function setSecret(name: string, value: string, run: SecretsRunner = realSecretsRunner): void {
  checkName(name);
  if (value === '') throw new Error(`keychain: refusing to store an empty value for ${name}`);
  if (/[\u0000-\u001F\u007F]/.test(value)) throw new Error(`keychain: refusing to store ${name}: the value has a control character`);
  if (value.length > MAX_VALUE) throw new Error(`keychain: refusing to store ${name}: the value is longer than ${MAX_VALUE} characters`);
  const quoted = value.replace(/[\\"]/g, (c) => `\\${c}`);
  const r = run(SECURITY_BIN, ['-i'], `add-generic-password -U -s ${KEYCHAIN_SERVICE} -a ${name} -w "${quoted}"\n`);
  if (r.status !== 0) throw new Error(`keychain: storing ${name} failed (security exit ${r.status})`);
}

/** Deletes the item; false when there was none. */
export function deleteSecret(name: string, run: SecretsRunner = realSecretsRunner): boolean {
  checkName(name);
  const r = run(SECURITY_BIN, ['delete-generic-password', '-s', KEYCHAIN_SERVICE, '-a', name]);
  if (r.status === NOT_FOUND) return false;
  if (r.status !== 0) throw new Error(`keychain: deleting ${name} failed (security exit ${r.status}${firstLine(r.stderr) === '' ? '' : `: ${firstLine(r.stderr)}`})`);
  return true;
}

/** The four operations bound to one runner, for code that is handed its secrets store. */
export interface Secrets {
  get(name: string): string | undefined;
  has(name: string): boolean;
  set(name: string, value: string): void;
  delete(name: string): boolean;
}

export function keychain(run: SecretsRunner = realSecretsRunner): Secrets {
  return {
    get: (n) => getSecret(n, run),
    has: (n) => hasSecret(n, run),
    set: (n, v) => setSecret(n, v, run),
    delete: (n) => deleteSecret(n, run),
  };
}
