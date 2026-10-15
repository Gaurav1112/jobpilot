import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { keychainServiceOf } from '../../../src/app/profiles/keychain.js';
import { writeMeta } from '../../../src/app/profiles/meta.js';
import { keychain, type SecretsRunner } from '../../../src/app/secrets.js';

let dir: string | undefined;
afterEach(() => {
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe('the Keychain service per profile', () => {
  it('passes the profile\'s service to security', () => {
    const calls: string[][] = [];
    const run: SecretsRunner = (cmd, args, stdin) => {
      calls.push([cmd, ...args, stdin ?? '']);
      return { status: 44, stdout: '', stderr: '' };
    };
    keychain(run, 'jobpilot.lena').get('gmail.refresh');
    keychain(run).has('gmail.refresh');
    expect(calls[0]).toEqual(['/usr/bin/security', 'find-generic-password', '-s', 'jobpilot.lena', '-a', 'gmail.refresh', '-w', '']);
    expect(calls[1]?.[3]).toBe('jobpilot');
  });
  it('refuses a service outside jobpilot[.<id>]', () => {
    expect(() => keychain(() => ({ status: 0, stdout: '', stderr: '' }), 'login').get('x')).toThrow(/invalid keychain service/);
  });
  it('an adopted profile keeps service jobpilot; others use jobpilot.<id>; a home without meta uses jobpilot', () => {
    dir = mkdtempSync(join(tmpdir(), 'jobpilot-kc-'));
    const a = join(dir, 'owner');
    const b = join(dir, 'lena');
    mkdirSync(a);
    mkdirSync(b);
    writeMeta(a, { id: 'owner', createdAt: '2026-10-15T08:00:00.000Z', keychainService: 'jobpilot', adopted: true });
    writeMeta(b, { id: 'lena', createdAt: '2026-10-15T08:00:00.000Z', keychainService: 'jobpilot.lena', adopted: false });
    expect([keychainServiceOf(a), keychainServiceOf(b), keychainServiceOf(dir)]).toEqual(['jobpilot', 'jobpilot.lena', 'jobpilot']);
  });
});
