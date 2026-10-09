import { coverWriter } from './cover-writer.js';
import { evidenceMatcher } from './evidence-matcher.js';
import { qaGate } from './qa-gate.js';
import { renderer } from './renderer.js';
import { resumePlanner } from './resume-planner.js';

/** The grounded writing team (Tasks 9 and 10), in pipeline order. */
export const writingAgents = [evidenceMatcher, resumePlanner, coverWriter, renderer, qaGate] as const;
