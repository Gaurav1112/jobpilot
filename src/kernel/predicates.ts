export interface Predicate<T = unknown> {
  /** Dotted lower-case name, e.g. `text.sanitised`. Guarantees and requirements match by id. */
  readonly id: string;
  readonly description: string;
  readonly test: (payload: T) => boolean;
}

export function definePredicate<T>(id: string, description: string, test: (payload: T) => boolean): Predicate<T> {
  if (!/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/.test(id)) {
    throw new TypeError(`predicate id must be dotted lower-case, e.g. text.sanitised: ${id}`);
  }
  return Object.freeze({ id, description, test });
}
