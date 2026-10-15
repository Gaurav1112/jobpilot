import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildWebHome, fixtureApp, GOLDEN_ROUTES, normalise, removeWebHome, type WebHome } from '../support/web-fixture.js';

/**
 * Golden HTML per route (UX upgrade A0, amendment 1): the fictional fixture home, a fixed clock and session, the CSRF
 * token written as `x`. One reviewable diff per view: a task that changes markup regenerates these with `-u` and its
 * commit carries the diff; any other task must leave them byte-identical.
 */
let w: WebHome;
beforeAll(() => {
  w = buildWebHome();
});
afterAll(() => removeWebHome(w.home));

describe('golden HTML per route', () => {
  for (const [name, path, status] of GOLDEN_ROUTES) {
    it(`${name} (${path})`, async () => {
      const r = await fixtureApp(w.home).request(path);
      expect(r.status).toBe(status);
      await expect(normalise(await r.text())).toMatchFileSnapshot(`./__golden__/${name}.html`);
    });
  }
});
