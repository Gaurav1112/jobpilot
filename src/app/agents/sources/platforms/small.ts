import { bamboohr } from './bamboohr.js';
import { breezy } from './breezy.js';
import type { FeedBoard } from './feed-board.js';
import { gem } from './gem.js';
import { personio } from './personio.js';
import { pinpoint } from './pinpoint.js';
import { recruitee } from './recruitee.js';
import { rippling } from './rippling.js';
import { teamtailor } from './teamtailor.js';
import { workable } from './workable.js';

/** The nine small ATS platforms of Task 9, in registry order: one feed board each (`feed-board.ts`). */
export const SMALL_PLATFORMS: readonly FeedBoard<string>[] = [workable, recruitee, teamtailor, personio, bamboohr, breezy, pinpoint, rippling, gem];

export const SMALL_PLATFORM_NAMES = ['workable', 'recruitee', 'teamtailor', 'personio', 'bamboohr', 'breezy', 'pinpoint', 'rippling', 'gem'] as const;
export type SmallPlatform = (typeof SMALL_PLATFORM_NAMES)[number];
