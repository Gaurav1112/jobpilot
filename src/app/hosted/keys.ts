import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRunPack } from '../kernel.js';
import { istMonth } from '../run.js';
import type { Secrets } from '../secrets.js';
import { packFiles, sealFiles, type Sealed } from './bundle.js';
import { HOSTED_RETENTION_YAML } from './config.js';
import type { GhRunner } from './github.js';
import { decodeKey, keyIdOf } from './jpst.js';

export const STATE_KEY_SECRET = 'hosted.state_key';
export const PACK_KEY_SECRET = 'hosted.pack_key';

/** Keychain name -> Actions secret name (P8). */
export const ACTIONS_SECRETS: readonly (readonly [string, string])[] = [
  ['STATE_KEY', STATE_KEY_SECRET],
  ['PACK_KEY', PACK_KEY_SECRET],
  ['GMAIL_CLIENT_ID', 'gmail.client_id'],
  ['GMAIL_CLIENT_SECRET', 'gmail.client_secret'],
  ['GMAIL_REFRESH', 'gmail.refresh'],
];

/** The stored key, decoded; an error that names the secret (never its value) when it is missing or malformed. */
export function storedKey(secrets: Secrets, name: string, label: string): Buffer {
  const v = secrets.get(name);
  if (v === undefined) throw new Error(`${label} is not set (${name}); run: jobpilot hosted keys new`);
  return decodeKey(v, label);
}

/**
 * `hosted keys new`: two fresh 32-byte keys into the secret store, then the recovery sheet, the only place a key is
 * ever printed (by the user's own command in their own terminal).
 */
export function keysNew(secrets: Secrets, out: (line: string) => void): void {
  if (secrets.has(STATE_KEY_SECRET)) throw new Error('hosted keys new: hosted.state_key already exists; rotation is not in this build');
  const state = randomBytes(32);
  const pack = randomBytes(32);
  secrets.set(STATE_KEY_SECRET, state.toString('base64'));
  secrets.set(PACK_KEY_SECRET, pack.toString('base64'));
  out('jobpilot hosted keys: recovery sheet (shown once; keep it offline, never in a repo or a chat)');
  out(`STATE_KEY (id ${keyIdOf(state)}): ${state.toString('base64')}`);
  out(`PACK_KEY  (id ${keyIdOf(pack)}): ${pack.toString('base64')}`);
  out('Losing STATE_KEY loses the hosted state. Next: jobpilot hosted secrets sync --repo <owner>/<data repo>');
}

/** `hosted secrets sync`: `gh secret set <NAME> --repo R` with the value on stdin only; output carries names only. */
export async function secretsSync(secrets: Secrets, repo: string, gh: GhRunner, out: (line: string) => void): Promise<void> {
  let failed = 0;
  for (const [name, source] of ACTIONS_SECRETS) {
    const value = secrets.get(source);
    if (value === undefined) {
      out(`skipped ${name} (not in the keychain)`);
      continue;
    }
    const r = await gh(['secret', 'set', name, '--repo', repo], { stdin: value });
    if (r.status !== 0) {
      failed += 1;
      out(`failed ${name} (gh exit ${r.status})`);
    } else {
      out(`set ${name}`);
    }
  }
  if (failed > 0) throw new Error(`hosted secrets sync: ${failed} secret${failed === 1 ? '' : 's'} not set`);
}

export interface PackPushResult extends Sealed {
  readonly file: string;
}

/**
 * `hosted pack push`: validates the pack (both run modes load it), seals it with the pack key and the hosted
 * `retention.yaml` into `<data>/pack/pack.jpst` (write-then-rename). An invalid pack writes nothing.
 */
export async function packPush(o: { pack: string; data: string; key: Buffer; now: string }): Promise<PackPushResult> {
  loadRunPack(o.pack, {}, istMonth(o.now), undefined, 'daily');
  loadRunPack(o.pack, {}, istMonth(o.now), undefined, 'freelance');
  const dir = join(o.data, 'pack');
  const scratch = mkdtempSync(join(tmpdir(), 'jp-packpush-'));
  try {
    mkdirSync(dir, { recursive: true });
    const tmp = join(dir, `pack.jpst.tmp-${randomBytes(4).toString('hex')}`);
    try {
      const sealed = await sealFiles(packFiles(o.pack, scratch, { 'retention.yaml': HOSTED_RETENTION_YAML }), tmp, o.key);
      const file = join(dir, 'pack.jpst');
      renameSync(tmp, file);
      return { ...sealed, file };
    } finally {
      if (existsSync(tmp)) rmSync(tmp, { force: true });
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
