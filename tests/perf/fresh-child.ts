import { createDashboard, warmDashboard } from '../../src/app/web/server.js';
import { Sessions } from '../../src/app/web/security.js';

/** The cold-process probe of the perf gate: argv = <home> <now> <route>. Prints one JSON line. */
const [home, now, route] = process.argv.slice(2) as [string, string, string];
const app = createDashboard({ home, clock: { now: () => now }, sessions: new Sessions(Buffer.alloc(32, 7)) });
const warmMs = await warmDashboard(app, 'localhost');
const t = performance.now();
const res = await app.request(route, { headers: { host: 'localhost', cookie: 'jp_sid=' + 'ef'.repeat(16) } });
await res.text();
process.stdout.write(`${JSON.stringify({ status: res.status, ms: performance.now() - t, warmMs })}\n`);
