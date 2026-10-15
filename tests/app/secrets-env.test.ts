import { describe, expect, it } from 'vitest';
import { runEnv } from '../../src/app/run-env.js';
import { envSecretName, envSecrets } from '../../src/app/secrets.js';
import { gmailRunAccess } from '../../src/app/freelance/mail/oauth.js';

describe('env-backed secrets (hosted mode)', () => {
  it('maps keychain names to environment names', () => {
    expect(envSecretName('gmail.refresh')).toBe('JOBPILOT_SECRET_GMAIL_REFRESH');
    expect(envSecretName('hosted.state_key')).toBe('JOBPILOT_SECRET_HOSTED_STATE_KEY');
    expect(envSecretName('a-b.c')).toBe('JOBPILOT_SECRET_A_B_C');
  });

  it('reads values, treats empty as absent, and is read-only', () => {
    const s = envSecrets({ JOBPILOT_SECRET_GMAIL_REFRESH: 'r-fake', JOBPILOT_SECRET_GMAIL_CLIENT_ID: '' });
    expect(s.get('gmail.refresh')).toBe('r-fake');
    expect(s.has('gmail.refresh')).toBe(true);
    expect(s.get('gmail.client_id')).toBeUndefined();
    expect(s.has('gmail.client_id')).toBe(false);
    expect(() => s.set('gmail.refresh', 'x')).toThrow('hosted mode stores no secrets');
    expect(() => s.delete('gmail.refresh')).toThrow('hosted mode stores no secrets');
  });

  it('refuses an invalid name with the keychain message', () => {
    expect(() => envSecrets({}).get('Bad Name')).toThrow('invalid secret name');
    expect(() => envSecretName('')).toThrow('invalid secret name');
  });

  it('works under gmailRunAccess unchanged', () => {
    const s = envSecrets({ JOBPILOT_SECRET_GMAIL_CLIENT_ID: 'id-fake', JOBPILOT_SECRET_GMAIL_CLIENT_SECRET: 's-fake', JOBPILOT_SECRET_GMAIL_REFRESH: 'r-fake' });
    expect(gmailRunAccess(s).connected).toBe(true);
    expect(gmailRunAccess(envSecrets({})).connected).toBe(false);
  });

  it('runEnv accepts hosted or unset and refuses a typo', () => {
    expect(runEnv({})).toBe('local');
    expect(runEnv({ JOBPILOT_RUN_ENV: '' })).toBe('local');
    expect(runEnv({ JOBPILOT_RUN_ENV: 'hosted' })).toBe('hosted');
    expect(() => runEnv({ JOBPILOT_RUN_ENV: 'cloud' })).toThrow('must be "hosted" or unset');
  });
});
