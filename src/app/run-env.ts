export type RunEnv = 'local' | 'hosted';
export const RUN_ENV_VAR = 'JOBPILOT_RUN_ENV';

/** 'hosted' only for exactly "hosted"; unset or '' is local; anything else is refused (a typo must not silently run local). */
export function runEnv(env: NodeJS.ProcessEnv = process.env): RunEnv {
  const v = env[RUN_ENV_VAR];
  if (v === undefined || v === '') return 'local';
  if (v === 'hosted') return 'hosted';
  throw new Error(`${RUN_ENV_VAR} must be "hosted" or unset`);
}
