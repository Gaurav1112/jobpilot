import { coverWriter } from './cover-writer.js';
import { evidenceMatcher } from './evidence-matcher.js';
import { resumePlanner } from './resume-planner.js';

/** The grounded writing team (Task 9), in pipeline order. */
export const writingAgents = [evidenceMatcher, resumePlanner, coverWriter] as const;
