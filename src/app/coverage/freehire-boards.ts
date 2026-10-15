import { createHash } from 'node:crypto';
import { platformClient } from '../agents/sources/platforms/client.js';
import { normalCompanyName } from './names.js';
import type { Platform } from './types.js';

/**
 * freehire's board id (catalogue `board:` field, or a row's external_id prefix) → jobpilot's ref for the platform, or
 * null when jobpilot cannot read that board shape (counted by the caller, never guessed):
 * - workday `host/site` → `host/<host's first label>/site`; `host/tenant/site` (myworkdaysite) unchanged;
 * - icims `slug` → `careers-<slug>.icims.com`; a dotted vanity host (the "careers-home" product) → null;
 * - personio `slug` → `<slug>.jobs.personio.de`;
 * - teamtailor `slug` → `<slug>.teamtailor.com`, a host unchanged;
 * - successfactors host, eightfold `host/domain`, oracle `host/siteNumber`, zohorecruit host: unchanged;
 * - lever, greenhouse: lower-cased; every other platform: unchanged.
 * The result must then pass `platformClient(platform).refOf(ref, null)`; otherwise null.
 */
export function refOfFreehireBoard(platform: Platform, board: string): string | null {
  let ref: string;
  switch (platform) {
    case 'workday': {
      const parts = board.split('/');
      const host = parts[0] ?? '';
      if (parts.length === 2) ref = `${host}/${host.split('.')[0] ?? ''}/${parts[1] ?? ''}`;
      else if (parts.length === 3) ref = board;
      else return null;
      break;
    }
    case 'icims':
      if (board.includes('.')) return null;
      ref = `careers-${board.toLowerCase()}.icims.com`;
      break;
    case 'personio':
      ref = board.includes('.') ? board : `${board.toLowerCase()}.jobs.personio.de`;
      break;
    case 'teamtailor':
      ref = board.includes('.') ? board : `${board.toLowerCase()}.teamtailor.com`;
      break;
    case 'lever':
    case 'greenhouse':
      ref = board.toLowerCase();
      break;
    default:
      ref = board;
  }
  const client = platformClient(platform);
  return client === null ? null : client.refOf(ref, null);
}

const squash = (s: string): string => s.replace(/[^\p{L}\p{N}]+/gu, '');
const HOST_LIKE = /\b[a-z0-9-]+\.[a-z]{2,}\b/iu;

/**
 * D2, a real company name: not empty, no `/`, no host-like token (`\b[a-z0-9-]+\.[a-z]{2,}\b`), and not just the
 * board's own identifier echoed back. The identifiers are the board id, its host part and that host's first label
 * (`12jlkfsk` for board `12jlkfsk`; `egug.fa.us2.oraclecloud.com/CX` for an Oracle tenant). A name is that echo when
 * it is spelled out from a multi-word slug (spaces and dashes removed: `Getinz People` for `getinz-people`), or when a
 * single word equals the identifier exactly (`tilthq` for `tilthq`). A single word that differs only by capitals
 * (`Twilio` for `twilio`) is a proper name: freehire did not just echo the slug.
 */
export function isRealCompanyName(company: string | null, board: string): company is string {
  if (company === null) return false;
  const name = company.trim();
  if (name === '' || name.includes('/') || HOST_LIKE.test(name)) return false;
  const host = board.split('/')[0] ?? board;
  const ids = new Set([board, host, host.split('.')[0] ?? host]);
  const key = squash(normalCompanyName(name));
  const multiWord = /[\s-]/u.test(name);
  for (const id of ids) {
    if (id === '') continue;
    if (name === id) return false;
    if (squash(normalCompanyName(id)) === key && (multiWord || /[\s-]/u.test(id))) return false;
  }
  return true;
}

/** D3: the registry key of a freehire-sourced board, never a real domain. */
export const freehireCompanyKey = (platform: Platform, ref: string): string =>
  `fh-${createHash('sha256').update(`${platform} ${ref}`).digest('hex').slice(0, 16)}.freehire`;
