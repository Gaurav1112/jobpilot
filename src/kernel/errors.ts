export const ERROR_CODES = [
  'rate_limit',
  'overloaded',
  'timeout',
  'network',
  'invalid_output',
  'policy_denied',
  'budget_exceeded',
  'unknown',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

/** Only these may appear in a contract's retry.on list. */
export const RETRYABLE: ReadonlySet<ErrorCode> = new Set(['rate_limit', 'overloaded', 'timeout', 'network']);

export class KernelError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
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
