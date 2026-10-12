/**
 * The fixed Google endpoints and names of the read-only Gmail ingest (Task 13, spec §4.3). One place, so the agent,
 * the connect flow and the run's authorised fetch cannot drift apart.
 */

/** The only scope jobpilot ever asks for or accepts. */
export const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';

/** Browser only: the user's consent page. jobpilot itself never contacts this host. */
export const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const TOKEN_HOST = 'oauth2.googleapis.com';
export const TOKEN_URL = `https://${TOKEN_HOST}/token`;
export const GMAIL_HOST = 'gmail.googleapis.com';
export const GMAIL_API = `https://${GMAIL_HOST}/gmail/v1/users/me`;

/**
 * The only Gmail paths a request may have: the message list and one message. Anything else on the Gmail host (labels,
 * threads, attachments, any write) is refused before it is sent.
 */
export const GMAIL_READ_PATH = /^\/gmail\/v1\/users\/me\/messages(?:\/[A-Za-z0-9]{1,64})?$/;

/** The one label jobpilot reads. */
export const GMAIL_LABEL = 'jobpilot/gigs';

/** The Keychain items (service `jobpilot`, these accounts). */
export const SECRET = { clientId: 'gmail.client_id', clientSecret: 'gmail.client_secret', refresh: 'gmail.refresh' } as const;

/** Where the user saves the Desktop OAuth client Google gives them, under the jobpilot home. */
export const CLIENT_FILE = ['secrets', 'google-oauth-client.json'] as const;

/** Why the Gmail source is off when there is no refresh token: a disabled source, never a failure. */
export const GMAIL_NOT_CONNECTED = 'Gmail not connected - run jobpilot gmail connect';
