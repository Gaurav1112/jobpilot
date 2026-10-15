import { serve, type ServerType } from '@hono/node-server';
import { Hono } from 'hono';
import type { Clock } from '../../kernel/clock.js';
import { listProfiles } from '../profiles/meta.js';
import { profileHome, readActiveProfile } from '../profiles/root.js';
import { allowedHosts, type Sessions } from './security.js';
import { buildDashboard, securityHeaders, type DashboardDeps } from './server.js';

export interface RootDeps {
  readonly root: string;
  readonly clock: Clock;
  readonly port?: number | (() => number | undefined);
  readonly busyTimeoutMs?: number;
  readonly gmailConnected?: (home: string) => boolean;
  readonly onSchemaNewer?: () => void;
  readonly resolve?: DashboardDeps['resolve'];
  readonly sessionsOf?: (home: string) => Sessions;
}

/** One dashboard for every profile of a root (profiles spec §3): /p/<id>/… is that profile's own dashboard. */
export function createRootDashboard(deps: RootDeps): Hono {
  const app = new Hono();
  const subs = new Map<string, Hono>();
  const portOf = (): number | undefined => (typeof deps.port === 'function' ? deps.port() : deps.port);
  const ids = (): string[] => listProfiles(deps.root).map((p) => p.id);
  const sub = (id: string): Hono => {
    let s = subs.get(id);
    if (s === undefined) {
      const home = profileHome(deps.root, id);
      s = buildDashboard(
        {
          home,
          clock: deps.clock,
          basePath: `/p/${id}`,
          profiles: () => ({ ids: ids(), current: id }),
          ...(deps.port !== undefined ? { port: deps.port } : {}),
          ...(deps.busyTimeoutMs !== undefined ? { busyTimeoutMs: deps.busyTimeoutMs } : {}),
          ...(deps.gmailConnected !== undefined ? { gmailConnected: () => deps.gmailConnected?.(home) ?? false } : {}),
          ...(deps.onSchemaNewer !== undefined ? { onSchemaNewer: deps.onSchemaNewer } : {}),
          ...(deps.resolve !== undefined ? { resolve: deps.resolve } : {}),
          ...(deps.sessionsOf !== undefined ? { sessions: deps.sessionsOf(home) } : {}),
        },
        {},
      ) as unknown as Hono;
      subs.set(id, s);
    }
    return s;
  };
  app.use('*', async (c, next) => {
    const host = (c.req.header('host') ?? '').toLowerCase();
    if (!allowedHosts(portOf()).has(host) || new URL(c.req.url).host.toLowerCase() !== host) return c.text('This dashboard only answers on 127.0.0.1.', 403);
    await next();
    securityHeaders(c);
  });
  app.get('/', (c) => {
    const all = ids();
    if (all.length === 0) return c.html('<!doctype html><title>jobpilot</title><p>No profiles yet: run <code>jobpilot profile create &lt;id&gt;</code>.</p>');
    const active = readActiveProfile(deps.root);
    return c.redirect(`/p/${active !== undefined && all.includes(active) ? active : all[0]}/`, 302);
  });
  app.get('/p/:id', (c) => c.redirect(`/p/${c.req.param('id')}/`, 301));
  app.all('/p/:id/*', (c) => {
    const id = c.req.param('id');
    if (!ids().includes(id)) return c.text('no such profile', 404);
    const url = new URL(c.req.url);
    url.pathname = url.pathname.slice(`/p/${id}`.length) || '/';
    return sub(id).fetch(new Request(url, c.req.raw));
  });
  return app;
}

export function serveRoot(deps: RootDeps & { readonly port?: number }, onListen?: (url: string) => void): ServerType {
  let bound: number | undefined = deps.port !== undefined && deps.port !== 0 ? deps.port : undefined;
  const app = createRootDashboard({ ...deps, port: () => bound ?? -1 });
  return serve({ fetch: app.fetch, hostname: '127.0.0.1', port: deps.port ?? 4317 }, (info) => {
    bound = info.port;
    onListen?.(`http://127.0.0.1:${info.port}/`);
  });
}
