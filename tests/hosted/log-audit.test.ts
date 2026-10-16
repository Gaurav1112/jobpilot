import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { auditLog, WRAPPER_STEP } from '../../src/app/hosted/log-audit.js';

const LOG = readFileSync(resolve(import.meta.dirname, '../fixtures/hosted/run-log.txt'), 'utf8');
const CANARY = 'zz-canary~??>>@example.invalid';
const stamp = '2026-10-15T01:59:59.0000000Z';

describe('auditLog', () => {
  it('finds the planted canary in raw, base64, base64url and URL-encoded form', () => {
    expect(auditLog(LOG, [CANARY]).hits).toBe(4);
    expect(auditLog(LOG, ['not-in-the-log-at-all']).hits).toBe(0);
  });

  it('counts no non-template line in the wrapper step of the fixture', () => {
    expect(LOG).toContain(`\t${WRAPPER_STEP}\t`);
    expect(auditLog(LOG, [CANARY]).nonTemplateLines).toBe(0);
  });

  it('counts a stray line in the wrapper step but not in another step', () => {
    const inWrapper = `${LOG}daily\t${WRAPPER_STEP}\t${stamp} Acme Corp is hiring\n`;
    const inSetup = `${LOG}daily\tSet up job\t${stamp} Acme Corp is hiring\n`;
    expect(auditLog(inWrapper, [CANARY]).nonTemplateLines).toBe(1);
    expect(auditLog(inSetup, [CANARY]).nonTemplateLines).toBe(0);
  });

  it('counts a value printed inside the wrapper step as a hit and a stray line', () => {
    const r = auditLog(`${LOG}daily\t${WRAPPER_STEP}\t${stamp} hello Acme Corp\n`, ['Acme Corp']);
    expect(r).toEqual({ hits: 1, nonTemplateLines: 1 });
  });

  it('does not put a value in its result', () => {
    expect(JSON.stringify(auditLog(LOG, [CANARY]))).not.toContain('canary');
  });
});
