import { join } from 'node:path';
import { loadJsonl, type EvalSpec } from '../evals/runner.js';
import { demoSource } from './agents.js';

export function demoEvalSpecs(datasetDir: string): EvalSpec[] {
  return [
    {
      agent: demoSource,
      cases: loadJsonl(join(datasetDir, 'demo-source.jsonl')),
      project: (outs) => outs.map((o) => (o as { id: string }).id),
      metric: 'exactMatch',
      min: 1,
    },
  ];
}
