import { HIMALAYAS_FEED } from './agents/sources/himalayas.js';
import { JOBICY_FEED } from './agents/sources/jobicy.js';

/** Feed name (feeds.yaml `enabled`) -> the source agent that fetches it. A feed not listed here is a pack error. */
export const FEED_SOURCES: Readonly<Record<string, string>> = { [HIMALAYAS_FEED]: 'src-himalayas', [JOBICY_FEED]: 'src-jobicy' };

export const knownFeeds = (): string[] => Object.keys(FEED_SOURCES).sort();
