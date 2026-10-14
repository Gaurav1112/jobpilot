export const ERROR_CODES = [
  'rate_limit',
  'overloaded',
  'timeout',
  'network',
  'invalid_output',
  'policy_denied',
  'budget_exceeded',
  /** A CAPTCHA or bot wall answered a browser render. Never retried: jobpilot does not evade. */
  'challenged',
  /**
   * The item no longer exists at its source (a job page or board that answers 404 or 410, or a job that redirects
   * away from a job page). Never retried, and it does not count towards agent or team breakers: breakers measure the
   * health of a service, not item-level data. It is still a failed step, reported as gone.
   */
  'gone',
  /**
   * A deterministic refusal decided by the step's input alone (a posting whose title the documents cannot carry, say):
   * running the step again on the same input would always refuse again. Never retried, and, like `gone`, it neither
   * trips nor resets a breaker, since it says nothing about the health of the agent. A refusal caused by the user's
   * pack is not this: it hits every item, so it stays `invalid_output` and the breaker stops it.
   */
  'input_rejected',
  'unknown',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

/** Only these may appear in a contract's retry.on list. */
export const RETRYABLE: ReadonlySet<ErrorCode> = new Set(['rate_limit', 'overloaded', 'timeout', 'network']);

export class KernelError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    /**
     * For a `network` failure: the system error code of its cause when the provider gave one (`ENOTFOUND`,
     * `ECONNRESET`, `CERT_HAS_EXPIRED`, ...), so a caller can tell a host that does not exist from an outage.
     */
    readonly sysCode?: string,
  ) {
    super(message);
    this.name = 'KernelError';
  }
}

export class WiringError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`pipeline wiring is invalid:\n- ${problems.join('\n- ')}`);
    this.name = 'WiringError';
  }
}

export class PolicyViolation extends Error {
  constructor(readonly violations: readonly string[]) {
    super(`user policy may only tighten product policy:\n- ${violations.join('\n- ')}`);
    this.name = 'PolicyViolation';
  }
}

export class InvalidTransition extends Error {
  constructor(machine: string, from: string, on: string) {
    super(`${machine}: no transition from ${from} on ${on}`);
    this.name = 'InvalidTransition';
  }
}

export function classify(err: unknown): ErrorCode {
  if (err instanceof KernelError) return err.code;
  if (typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'TimeoutError') return 'timeout';
  return 'unknown';
}
