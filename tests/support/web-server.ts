import type { AddressInfo } from 'node:net';
import { serveDashboard } from '../../src/app/web/server.js';
import { buildWebHome, FIXTURE_NOW, removeWebHome, type WebHome } from './web-fixture.js';

export interface FixtureServer {
  readonly base: string;
  readonly home: WebHome;
  close(): Promise<void>;
}

/** The fixture home served on 127.0.0.1 (a free port), for real-browser suites and screenshots. */
export async function startFixtureServer(now = FIXTURE_NOW): Promise<FixtureServer> {
  const home = buildWebHome();
  const server = serveDashboard({ home: home.home, clock: { now: () => now }, port: 0, busyTimeoutMs: 200 });
  await new Promise<void>((resolve) => (server.listening ? resolve() : server.once('listening', () => resolve())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    base,
    home,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      removeWebHome(home.home);
    },
  };
}
