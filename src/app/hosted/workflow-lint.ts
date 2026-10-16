import { parse } from 'yaml';

export const ALLOWED_ACTIONS = ['actions/checkout', 'actions/setup-node', 'actions/cache'] as const;
export const WRAPPER_STEP_NAME = 'jobpilot hosted run';

const TIMEZONE = 'Asia/Kolkata';
const PERMISSIONS: Record<string, string> = { contents: 'write', issues: 'write', actions: 'read' };
const USES = /^([^@\s]+)@([0-9a-f]{40})$/;
const SECRET_ENV = /JOBPILOT_SECRET_|GH_TOKEN/;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);
const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Spec §7 "Workflow lint": the problems found (empty = clean). */
export function lintWorkflow(yamlText: string): string[] {
  let doc: unknown;
  try {
    doc = parse(yamlText);
  } catch {
    return ['the workflow is not valid YAML'];
  }
  if (!isObj(doc)) return ['the workflow is not a YAML mapping'];
  const problems: string[] = [];

  // Triggers. YAML 1.1 parsers read `on` as true; the yaml package keeps the string.
  const on = doc['on'] ?? doc['true'];
  if (!isObj(on)) problems.push('on: triggers must be a mapping of schedule and workflow_dispatch');
  else {
    for (const k of Object.keys(on)) if (k !== 'schedule' && k !== 'workflow_dispatch') problems.push(`on: trigger ${k} is not allowed (only schedule and workflow_dispatch)`);
    const schedule = on['schedule'];
    if (schedule !== undefined) {
      if (!Array.isArray(schedule)) problems.push('on.schedule must be a list');
      else
        schedule.forEach((entry: unknown, i: number) => {
          const e = isObj(entry) ? entry : {};
          if (e['timezone'] !== TIMEZONE) problems.push(`on.schedule[${i}]: timezone must be ${TIMEZONE}`);
          const minute = typeof e['cron'] === 'string' ? (e['cron'].trim().split(/\s+/)[0] ?? '') : '';
          if (!/^\d+$/.test(minute) || Number(minute) === 0) problems.push(`on.schedule[${i}]: the minute field must be a number other than 0 (got ${minute === '' ? 'none' : minute})`);
        });
    }
  }

  if (!sameJson(doc['concurrency'], { group: 'jobpilot-state', 'cancel-in-progress': false })) problems.push('concurrency must be exactly { group: jobpilot-state, cancel-in-progress: false }');

  const exactPerms = isObj(doc['permissions']) && Object.keys(doc['permissions']).length === Object.keys(PERMISSIONS).length && Object.entries(PERMISSIONS).every(([k, v]) => (doc['permissions'] as Obj)[k] === v);
  if (!exactPerms) problems.push('permissions must be exactly { contents: write, issues: write, actions: read }');

  const jobs = isObj(doc['jobs']) ? doc['jobs'] : {};
  if (Object.keys(jobs).length === 0) problems.push('jobs: no job found');
  let wrapperSteps = 0;
  for (const [jobName, jobRaw] of Object.entries(jobs)) {
    const job = isObj(jobRaw) ? jobRaw : {};
    const timeout = job['timeout-minutes'];
    const timeoutOk = typeof timeout === 'number' && Number.isInteger(timeout) && timeout >= 1 && timeout <= 350;
    if (!timeoutOk) problems.push(`jobs.${jobName}: timeout-minutes must be a whole number from 1 to 350`);
    if (job['permissions'] !== undefined) {
      const p = job['permissions'];
      const up = !isObj(p) || Object.entries(p).some(([k, v]) => PERMISSIONS[k] === undefined || (v !== 'read' && v !== 'write' && v !== 'none') || (v === 'write' && PERMISSIONS[k] !== 'write'));
      if (up) problems.push(`jobs.${jobName}: permissions must not raise the top-level permissions`);
    }
    if (isObj(job['env']) && Object.values(job['env']).some((v) => String(v).includes('secrets.'))) problems.push(`jobs.${jobName}: secrets are allowed only in the env of the ${WRAPPER_STEP_NAME} step`);
    const steps = Array.isArray(job['steps']) ? job['steps'] : [];
    steps.forEach((raw: unknown, i: number) => {
      const step = isObj(raw) ? raw : {};
      const name = typeof step['name'] === 'string' ? step['name'] : `step ${i + 1}`;
      const where = `jobs.${jobName} step "${name}"`;
      const isWrapper = step['name'] === WRAPPER_STEP_NAME;
      if (isWrapper) wrapperSteps++;
      if (typeof step['uses'] === 'string') {
        const uses = step['uses'];
        const m = USES.exec(uses);
        if (uses.includes('upload-artifact')) problems.push(`${where}: upload-artifact is not allowed`);
        else if (m === null || !(ALLOWED_ACTIONS as readonly string[]).includes(m[1] as string)) problems.push(`${where}: uses ${uses} must be one of ${ALLOWED_ACTIONS.join(', ')} pinned to a 40-hex commit`);
      }
      if (typeof step['run'] === 'string') {
        const run = step['run'];
        if (/\bset\s+-[A-Za-z]*x/.test(run)) problems.push(`${where}: run contains set -x`);
        if (run.includes('upload-artifact')) problems.push(`${where}: run mentions upload-artifact`);
        if (run.includes('${{ secrets.') || /\$\{\{\s*secrets\./.test(run)) problems.push(`${where}: run contains a secrets expression (use the wrapper step env)`);
      }
      const env = isObj(step['env']) ? step['env'] : {};
      if (isWrapper) {
        if (timeoutOk && String(env['JOBPILOT_JOB_TIMEOUT_MINUTES']) !== String(timeout)) problems.push(`${where}: JOBPILOT_JOB_TIMEOUT_MINUTES must equal the job's timeout-minutes (${String(timeout)})`);
      } else {
        for (const [k, v] of Object.entries(env)) {
          if (SECRET_ENV.test(k) || SECRET_ENV.test(String(v))) problems.push(`${where}: env must not mention JOBPILOT_SECRET_ or GH_TOKEN`);
          else if (String(v).includes('secrets.')) problems.push(`${where}: secrets are allowed only in the env of the ${WRAPPER_STEP_NAME} step`);
        }
      }
      // `secrets.` anywhere else in the step (with:, if:, ...), outside run and env
      const rest = JSON.stringify({ ...step, run: undefined, env: undefined });
      if (rest.includes('secrets.')) problems.push(`${where}: secrets are allowed only in the env of the ${WRAPPER_STEP_NAME} step`);
    });
  }
  if (wrapperSteps === 0) problems.push(`no step named ${WRAPPER_STEP_NAME}`);
  return problems;
}
