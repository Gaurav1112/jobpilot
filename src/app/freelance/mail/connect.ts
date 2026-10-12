import { execFile } from 'node:child_process';
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Secrets } from '../../secrets.js';
import { CLIENT_FILE, GMAIL_LABEL, SECRET } from './google.js';
import { authUrl, exchangeCode, newPkce, startLoopback, type FormPost, type GmailClient } from './oauth.js';
import { ALERT_PARSERS } from './parsers/index.js';

/**
 * `jobpilot gmail connect|status|disconnect` (Task 13). No line printed here holds the client id, client secret,
 * refresh token or access token; they live only in the Keychain (service `jobpilot`) and, during the connect, in memory.
 */

export const CONNECT_TIMEOUT_MS = 5 * 60_000;

export interface MailCommandDeps {
  /** The jobpilot home: the client JSON is `<home>/secrets/google-oauth-client.json`. */
  readonly home: string;
  readonly secrets: Secrets;
}

export interface ConnectDeps extends MailCommandDeps {
  /** The token endpoint POST (`realFormPost`); tests inject a fake. */
  readonly post: FormPost;
  /** Opens the consent page in the user's browser (`open <url>`); tests drive the loopback reply instead. */
  readonly open: (url: string) => Promise<void>;
  /** Asks a y/N question and returns the answer. */
  readonly ask: (question: string) => Promise<string>;
  readonly out: (line: string) => void;
  readonly timeoutMs?: number;
}

/** `open <url>` through /usr/bin/open (argv, not a shell). */
export const openInBrowser = (url: string): Promise<void> =>
  new Promise((resolve, reject) => execFile('/usr/bin/open', [url], (err) => (err ? reject(new Error('could not open the browser')) : resolve())));

export const clientFile = (home: string): string => join(home, ...CLIENT_FILE);

/**
 * The Desktop OAuth client from Google's JSON (`installed.client_id`, `installed.client_secret`, a loopback
 * redirect). A "web" client or a missing field is refused: the loopback flow needs a Desktop client.
 */
export function readClientFile(path: string): GmailClient {
  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error(`${path} is not valid JSON; save the client JSON Google gives you as it is`);
  }
  const installed = typeof doc === 'object' && doc !== null ? (doc as { installed?: unknown }).installed : undefined;
  if (typeof installed !== 'object' || installed === null) throw new Error(`${path} is not a Desktop app client (no "installed" section); create an OAuth client of type Desktop app`);
  const i = installed as { client_id?: unknown; client_secret?: unknown; redirect_uris?: unknown };
  if (typeof i.client_id !== 'string' || i.client_id === '' || typeof i.client_secret !== 'string' || i.client_secret === '') throw new Error(`${path} lacks client_id or client_secret`);
  const redirects = Array.isArray(i.redirect_uris) ? i.redirect_uris.filter((u): u is string => typeof u === 'string') : [];
  if (!redirects.some((u) => /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/?$/.test(u))) throw new Error(`${path} has no loopback redirect (http://localhost); create an OAuth client of type Desktop app`);
  return { clientId: i.client_id, clientSecret: i.client_secret };
}

/**
 * The connect flow: read the client (the JSON once, else the Keychain from an earlier connect), open the consent page,
 * wait at most `timeoutMs` (5 minutes) for the loopback reply, exchange the code, store the client and the refresh
 * token in the Keychain, then offer to delete the JSON (default: keep).
 */
export async function connectGmail(d: ConnectDeps): Promise<void> {
  const path = clientFile(d.home);
  const fromFile = existsSync(path);
  let client: GmailClient;
  if (fromFile) {
    if ((statSync(path).mode & 0o077) !== 0) d.out(`warning: ${path} can be read by other users; run chmod 600 on it`);
    client = readClientFile(path);
  } else {
    const clientId = d.secrets.get(SECRET.clientId);
    const clientSecret = d.secrets.get(SECRET.clientSecret);
    if (clientId === undefined || clientSecret === undefined) {
      throw new Error(`no OAuth client: save the Desktop app client JSON from Google Cloud as ${path} (chmod 600), then run jobpilot gmail connect`);
    }
    client = { clientId, clientSecret };
    d.out('using the OAuth client already in the Keychain');
  }
  const pkce = newPkce();
  const loopback = await startLoopback(pkce.state, d.timeoutMs ?? CONNECT_TIMEOUT_MS);
  try {
    d.out('opening Google in your browser: sign in and allow read-only Gmail access (gmail.readonly); waiting up to 5 minutes');
    await d.open(authUrl({ clientId: client.clientId, redirectUri: loopback.redirectUri, pkce }));
    const code = await loopback.code;
    const { refreshToken } = await exchangeCode(d.post, { ...client, code, redirectUri: loopback.redirectUri, verifier: pkce.verifier });
    d.secrets.set(SECRET.clientId, client.clientId);
    d.secrets.set(SECRET.clientSecret, client.clientSecret);
    d.secrets.set(SECRET.refresh, refreshToken);
  } finally {
    loopback.close();
  }
  d.out(`Gmail connected (read-only); the client and the refresh token are in the Keychain (service jobpilot). jobpilot reads only the label ${GMAIL_LABEL}`);
  if (!fromFile) return;
  const answer = (await d.ask(`Delete ${path} now that the client is in the Keychain? [y/N] `)).trim().toLowerCase();
  if (answer === 'y' || answer === 'yes') {
    rmSync(path);
    d.out(`deleted ${path}`);
  } else {
    d.out(`kept ${path} (0600); delete it whenever you like, the Keychain has the client`);
  }
}

/** Connected yes/no, the label and the parsers; never a value. */
export function gmailStatus(d: MailCommandDeps): string[] {
  const connected = d.secrets.has(SECRET.refresh);
  const lines = [
    `connected: ${connected ? 'yes' : 'no'}${connected ? '' : ' (run jobpilot gmail connect)'}`,
    `label: ${GMAIL_LABEL} (messages from the last 3 days, read-only)`,
    `client in the Keychain: ${d.secrets.has(SECRET.clientId) && d.secrets.has(SECRET.clientSecret) ? 'yes' : 'no'}`,
    `client JSON on disk: ${existsSync(clientFile(d.home)) ? clientFile(d.home) : 'none'}`,
    `alert parsers: ${ALERT_PARSERS.length === 0 ? 'none yet - send one alert email per sender to enable' : ALERT_PARSERS.map((p) => p.id).join(', ')}`,
  ];
  return lines;
}

/** Deletes the three Keychain items. Google's own grant stays until removed at myaccount.google.com/permissions. */
export function disconnectGmail(d: MailCommandDeps): string[] {
  const removed = [SECRET.refresh, SECRET.clientId, SECRET.clientSecret].filter((n) => d.secrets.delete(n));
  return [
    removed.length === 0 ? 'nothing to remove: Gmail was not connected' : `removed ${removed.length} Keychain item${removed.length === 1 ? '' : 's'} (${removed.join(', ')})`,
    'to revoke the grant at Google too, remove jobpilot under myaccount.google.com/permissions',
  ];
}
