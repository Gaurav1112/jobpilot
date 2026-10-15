import type { GitHubClient } from './github.js';
import { isTemplateLine } from './log-gateway.js';

export const ALERT_LABEL = 'jobpilot-alert';
export const ALERTS = {
  'state-failure': 'jobpilot alert: the hosted state was not committed',
  conflict: 'jobpilot alert: another writer moved the hosted state',
  killed: 'jobpilot alert: a hosted pipeline was killed at the deadline',
  'gave-up': 'jobpilot alert: a hosted pipeline gave up for the day',
  budget: 'jobpilot alert: the Actions minutes budget level rose',
  leak: 'jobpilot alert: the log audit found a masked value or a non-template line',
  gmail: 'jobpilot alert: the Gmail source failed on the hosted runner',
  size: 'jobpilot alert: the hosted state is over its size threshold',
  refused: 'jobpilot alert: a hosted run refused to start',
} as const;

/**
 * Comments on the open issue with that title, or opens it (label jobpilot-alert). The body is template lines only:
 * a line that is not one of the gateway's templates is dropped, never written to an issue.
 */
export async function raiseAlert(gh: GitHubClient, kind: keyof typeof ALERTS, lines: readonly string[]): Promise<void> {
  const title = ALERTS[kind];
  const body = lines.filter(isTemplateLine).join('\n');
  const open = await gh.findOpenIssue(ALERT_LABEL, title);
  if (open === null) await gh.openIssue(title, body, [ALERT_LABEL]);
  else await gh.commentIssue(open, body);
}
