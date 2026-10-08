export interface Clock {
  now(): string;
}

export const systemClock: Clock = { now: () => new Date().toISOString() };

export function fixedClock(iso: string): Clock {
  return { now: () => iso };
}
