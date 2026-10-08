/** Consecutive-failure breakers, per run. Keys are `agent:<id>` or `team:<id>`.
 * An open breaker stays open for the rest of the run; `success` resets the failure count but never closes an open breaker. */
export class Breakers {
  private readonly fails = new Map<string, number>();
  private readonly open = new Set<string>();

  isOpen(key: string): boolean {
    return this.open.has(key);
  }

  success(key: string): void {
    this.fails.set(key, 0);
  }

  /** Returns true when this failure opens the breaker. */
  failure(key: string, threshold: number): boolean {
    const n = (this.fails.get(key) ?? 0) + 1;
    this.fails.set(key, n);
    if (n >= threshold && !this.open.has(key)) {
      this.open.add(key);
      return true;
    }
    return false;
  }
}
