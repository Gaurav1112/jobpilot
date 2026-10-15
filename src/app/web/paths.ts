const BASE = /^(?:|\/p\/[a-z][a-z0-9-]{1,31})$/;
/** '' (a single home) or /p/<profile id> (one profile of a profiles root). */
export function checkBase(base: string): string {
  if (!BASE.test(base)) throw new Error(`dashboard base path ${JSON.stringify(base)} must be '' or /p/<profile id>`);
  return base;
}
/** A dashboard path under the base: u('/p/asha', '/jobs/1') = '/p/asha/jobs/1'; u('', p) = p. */
export function u(base: string, path: string): string {
  if (!path.startsWith('/')) throw new Error(`dashboard path must start with /: ${path}`);
  return base === '' ? path : `${base}${path}`;
}
/** A profile's dashboard home under the profiles root. */
export const profileHref = (id: string): string => u(`/p/${id}`, '/');
