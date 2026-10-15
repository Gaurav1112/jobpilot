export const SIGTERM_STOP = 'stopped: deadline (SIGTERM)';

/**
 * Hosted runs only (the Mac never installs it): one SIGTERM listener, so the runner's deadline stops a pipeline
 * cooperatively between steps (the supervisor's `pauseBefore`) instead of killing it. The returned function answers
 * the reason once SIGTERM came, else null.
 */
export function sigtermStop(proc: NodeJS.Process = process): () => string | null {
  let stopped = false;
  proc.on('SIGTERM', () => {
    stopped = true;
  });
  return () => (stopped ? SIGTERM_STOP : null);
}
