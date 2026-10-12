import { dedupeKey, jobKey } from '../text/norm.js';

/** A gig's identity: `jobKey('gig:<platform>', sourceId)`, so a gig key never equals a job key for the same ids. */
export function gigKey(platform: string, sourceId: string): string {
  return jobKey(`gig:${platform}`, sourceId);
}

/** Links one gig listed twice; a missing client is the empty company. Never an identity. */
export function gigDedupeKey(client: string | null, title: string): string {
  return dedupeKey(client ?? '', title, '');
}
