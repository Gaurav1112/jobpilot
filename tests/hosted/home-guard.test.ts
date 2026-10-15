import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DefaultHomeError, refuseDefaultHome } from '../../src/app/hosted/home-guard.js';

const base = realpathSync(mkdtempSync(join(tmpdir(), 'jp-guard-')));
const def = join(base, 'default-home');
mkdirSync(join(def, 'inner'), { recursive: true });
const sibling = join(base, 'other');
mkdirSync(sibling);
const link = join(base, 'link');
symlinkSync(def, link);

describe('refuseDefaultHome', () => {
  it('refuses the default home, a symlink to it, a dotted path and a folder inside it', () => {
    for (const p of [def, link, `${base}/./default-home`, join(def, 'inner'), join(link, 'inner'), join(def, 'not-yet')]) {
      expect(() => refuseDefaultHome(p, 'seed', def), p).toThrow(DefaultHomeError);
    }
  });

  it('passes a sibling and names the command in the message', () => {
    expect(() => refuseDefaultHome(sibling, 'seed', def)).not.toThrow();
    expect(() => refuseDefaultHome(def, 'push', def)).toThrow(`hosted push: refusing to write the default home ${def}; pass another --home (the Mac's home stays as it is)`);
  });
});
