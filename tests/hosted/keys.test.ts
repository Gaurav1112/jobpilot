import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { openInto } from '../../src/app/hosted/bundle.js';
import { HOSTED_RETENTION_YAML } from '../../src/app/hosted/config.js';
import type { GhRunner } from '../../src/app/hosted/github.js';
import { decodeKey, keyIdOf, readHeaderOf } from '../../src/app/hosted/jpst.js';
import { keysNew, packPush, secretsSync } from '../../src/app/hosted/keys.js';
import { keychain, type SecretsRunner } from '../../src/app/secrets.js';
import { FIXTURE_PACK } from '../support/hosted-home.js';

const root = mkdtempSync(join(tmpdir(), 'jp-keys-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** A keychain in a Map: understands the three `security` calls the secrets module makes. */
function fakeKeychain(): { run: SecretsRunner; items: Map<string, string>; argv: string[][] } {
  const items = new Map<string, string>();
  const argv: string[][] = [];
  const run: SecretsRunner = (_cmd, args, stdin) => {
    argv.push([...args]);
    if (args[0] === '-i') {
      const m = /-a (\S+) -w "(.*)"\n$/s.exec(stdin ?? '');
      if (!m) return { status: 1, stdout: '', stderr: '' };
      items.set(m[1] as string, (m[2] as string).replace(/\\(.)/g, '$1'));
      return { status: 0, stdout: '', stderr: '' };
    }
    const name = args[args.indexOf('-a') + 1] as string;
    const v = items.get(name);
    if (v === undefined) return { status: 44, stdout: '', stderr: '' };
    return { status: 0, stdout: args.includes('-w') ? `${v}\n` : '', stderr: '' };
  };
  return { run, items, argv };
}

describe('hosted keys new', () => {
  it('stores two 32-byte keys and prints exactly the recovery sheet', () => {
    const kc = fakeKeychain();
    const lines: string[] = [];
    keysNew(keychain(kc.run), (l) => lines.push(l));
    const state = decodeKey(kc.items.get('hosted.state_key') as string, 'STATE_KEY');
    const pack = decodeKey(kc.items.get('hosted.pack_key') as string, 'PACK_KEY');
    expect(state.length).toBe(32);
    expect(pack.length).toBe(32);
    expect(state.equals(pack)).toBe(false);
    expect(lines).toEqual([
      'jobpilot hosted keys: recovery sheet (shown once; keep it offline, never in a repo or a chat)',
      `STATE_KEY (id ${keyIdOf(state)}): ${state.toString('base64')}`,
      `PACK_KEY  (id ${keyIdOf(pack)}): ${pack.toString('base64')}`,
      'Losing STATE_KEY loses the hosted state. Next: jobpilot hosted secrets sync --repo <owner>/<data repo>',
    ]);
  });

  it('a second run refuses and changes nothing', () => {
    const kc = fakeKeychain();
    keysNew(keychain(kc.run), () => undefined);
    const before = [...kc.items.entries()];
    const lines: string[] = [];
    expect(() => keysNew(keychain(kc.run), (l) => lines.push(l))).toThrow(/rotation is not in this build/);
    expect([...kc.items.entries()]).toEqual(before);
    expect(lines).toEqual([]);
  });
});

describe('hosted secrets sync', () => {
  const recorder = (): { gh: GhRunner; calls: { args: string[]; stdin: string | undefined }[] } => {
    const calls: { args: string[]; stdin: string | undefined }[] = [];
    return { calls, gh: (args, o) => { calls.push({ args: [...args], stdin: o?.stdin }); return Promise.resolve({ status: 0, stdout: '', stderr: '' }); } };
  };

  it('pipes each value to gh on stdin, never in argv, and prints names only', async () => {
    const kc = fakeKeychain();
    for (const [n, v] of [['hosted.state_key', 'VALUE-STATE-1'], ['hosted.pack_key', 'VALUE-PACK-2'], ['gmail.client_id', 'VALUE-CID-3'], ['gmail.client_secret', 'VALUE-CSEC-4']] as const) kc.items.set(n, v);
    const { gh, calls } = recorder();
    const out: string[] = [];
    await secretsSync(keychain(kc.run), 'example-user/jobpilot-data', gh, (l) => out.push(l));
    expect(calls[0]).toEqual({ args: ['secret', 'set', 'STATE_KEY', '--repo', 'example-user/jobpilot-data'], stdin: 'VALUE-STATE-1' });
    expect(calls.map((c) => c.args[2])).toEqual(['STATE_KEY', 'PACK_KEY', 'GMAIL_CLIENT_ID', 'GMAIL_CLIENT_SECRET']);
    for (const c of calls) for (const a of c.args) expect(a).not.toMatch(/VALUE-/);
    expect(out).toEqual(['set STATE_KEY', 'set PACK_KEY', 'set GMAIL_CLIENT_ID', 'set GMAIL_CLIENT_SECRET', 'skipped GMAIL_REFRESH (not in the keychain)']);
    expect(out.join('\n')).not.toMatch(/VALUE-/);
  });

  it('a failing gh is reported by name and fails the command', async () => {
    const kc = fakeKeychain();
    kc.items.set('hosted.state_key', 'VALUE-STATE-1');
    const out: string[] = [];
    const gh: GhRunner = () => Promise.resolve({ status: 1, stdout: '', stderr: 'VALUE-STATE-1 leaked' });
    await expect(secretsSync(keychain(kc.run), 'example-user/jobpilot-data', gh, (l) => out.push(l))).rejects.toThrow(/1 secret not set/);
    expect(out[0]).toBe('failed STATE_KEY (gh exit 1)');
    expect(out.join('\n')).not.toMatch(/VALUE-/);
  });
});

describe('hosted pack push', () => {
  const key = decodeKey(Buffer.alloc(32, 7).toString('base64'), 'PACK_KEY');
  const NOW = '2026-11-02T02:07:00.000Z';

  it('seals the fixture pack under the pack key with the hosted retention.yaml', async () => {
    const data = join(root, 'data1');
    const r = await packPush({ pack: FIXTURE_PACK, data, key, now: NOW });
    expect(r.file).toBe(join(data, 'pack', 'pack.jpst'));
    expect(readdirSync(join(data, 'pack'))).toEqual(['pack.jpst']);
    expect(readHeaderOf(r.file).keyId).toBe(keyIdOf(key));
    expect(r.keyId).toBe(keyIdOf(key));
    const dir = join(root, 'opened1');
    const names = await openInto(r.file, key, dir, { sha256: r.sha256, bytes: r.bytes });
    expect(names).toContain('retention.yaml');
    expect(readFileSync(join(dir, 'retention.yaml'), 'utf8')).toBe(HOSTED_RETENTION_YAML);
    expect(names).toContain('roles.yaml');
  });

  it('an invalid pack throws before any file is written', async () => {
    const bad = join(root, 'badpack');
    cpSync(FIXTURE_PACK, bad, { recursive: true });
    writeFileSync(join(bad, 'roles.yaml'), 'not: [valid\n');
    const data = join(root, 'data2');
    await expect(packPush({ pack: bad, data, key, now: NOW })).rejects.toThrow();
    expect(existsSync(data)).toBe(false);
  });
});
