/**
 * The honest user agent (G-NO-EVASION, hosted spec S10): a constant picked by where the process runs, read once at
 * module load from JOBPILOT_RUN_ENV, never configurable. `+hosted` on the GitHub runner, `+local` everywhere else.
 */
export const LOCAL_UA = 'jobpilot/0.1 (+local)';
export const HOSTED_UA = 'jobpilot/0.1 (+hosted)';
export const userAgentFor = (env: NodeJS.ProcessEnv): string => (env['JOBPILOT_RUN_ENV'] === 'hosted' ? HOSTED_UA : LOCAL_UA);
export const USER_AGENT = userAgentFor(process.env);
