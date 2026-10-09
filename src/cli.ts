import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { Command } from 'commander';
import { checkDrift, exportContracts } from './kernel/contracts-export.js';
import { systemClock } from './kernel/clock.js';
import { PRODUCT_POLICY_V1 } from './kernel/policy.js';
import { Registry } from './kernel/registry.js';
import { verifyChain } from './kernel/store/audit.js';
import { Store } from './kernel/store/store.js';
import { failedGates, runEval } from './evals/runner.js';
import { demoEvalSpecs } from './demo/evals.js';
import { appEvalSpecs } from './app/evals.js';
import { demoKernel } from './demo/kernel.js';
import { exportedAgents } from './exported-agents.js';
import { nodeFetch } from './kernel/providers.js';
import type { PlaywrightBrowserProvider } from './app/browser/playwright-provider.js';
import { loadRunPack, preparePipeline } from './app/kernel.js';
import { withLock } from './app/lock.js';
import { migrateDesk } from './app/migrate-desk.js';
import { osascriptNotifier } from './app/notify.js';
import { offlineProviders } from './app/offline.js';
import { assertNoForbidden, ForbiddenTermError } from './app/pack/load.js';
import { homePaths, jobpilotHome } from './app/pack/paths.js';
import type { Fact } from './app/pack/schema.js';
import { dailySeeds } from './app/pipeline.js';
import { formatSummary, istMonth, rebuildDocs, RENDER_NONCE_KEY, runDaily } from './app/run.js';
import { AppStore } from './app/store/app-store.js';

const root = join(import.meta.dirname, '..');
const allAgents = () => {
  const r = new Registry();
  for (const a of exportedAgents) r.register(a);
  return r;
};

/** The detail of a quarantined step is its guardrail verdicts as JSON; show the one that tripped. */
function lastVerdict(detail: string | null): string {
  try {
    const v = (JSON.parse(detail ?? '[]') as { id?: string; detail?: string }[]).at(-1);
    return v ? `${v.id ?? '?'}: ${v.detail ?? ''}` : '';
  } catch {
    return detail ?? '';
  }
}

const program = new Command().name('jobpilot').description('Deterministic multi-agent job search kernel');

program
  .command('demo')
  .description('Run the two-agent demo pipeline end to end')
  .option('--db <path>', 'SQLite file', 'jobpilot.db')
  .option('--count <n>', 'items to generate', '5')
  .option('--run <id>', 'run id', `run-${new Date().toISOString().slice(0, 10)}`)
  .action(async (o: { db: string; count: string; run: string }) => {
    const count = Number(o.count);
    if (!Number.isInteger(count) || count < 1 || count > 50) {
      console.error('--count must be an integer from 1 to 50');
      process.exit(1);
    }
    const k = demoKernel({ dbPath: o.db, clock: systemClock });
    try {
      const report = await k.supervisor.start(o.run, [{ count, prefix: 'demo' }]);
      console.log(JSON.stringify(report, null, 2));
    } finally {
      k.store.close();
    }
  });

program
  .command('resume <runId>')
  .description('Continue a crashed run; finished steps are replayed, not re-run')
  .option('--db <path>', 'SQLite file', 'jobpilot.db')
  .action(async (runId: string, o: { db: string }) => {
    const k = demoKernel({ dbPath: o.db, clock: systemClock });
    try {
      console.log(JSON.stringify(await k.supervisor.resume(runId), null, 2));
    } finally {
      k.store.close();
    }
  });

program
  .command('quarantined')
  .description('List quarantined steps with their last guardrail verdict')
  .option('--db <path>', 'SQLite file', 'jobpilot.db')
  .action((o: { db: string }) => {
    const store = Store.open(o.db);
    try {
      const steps = store.quarantinedSteps();
      if (steps.length === 0) console.log('no quarantined steps');
      for (const s of steps) console.log(`${s.step_key}  ${s.agent_id}  ${lastVerdict(s.detail)}`);
    } finally {
      store.close();
    }
  });

program
  .command('release <stepKey>')
  .description('Release a quarantined step so the next run executes it again')
  .option('--db <path>', 'SQLite file', 'jobpilot.db')
  .action((stepKey: string, o: { db: string }) => {
    const k = demoKernel({ dbPath: o.db, clock: systemClock });
    try {
      const now = systemClock.now();
      // Audited under the policy that quarantined the step; the current one only if that run is unknown.
      const policyHash = k.store.quarantinePolicyHash(stepKey) ?? k.policyHash;
      const r = k.store.releaseQuarantine(stepKey, `release-${now.slice(0, 10)}`, now, policyHash);
      const refs = (xs: readonly { kind: string; entityId: string }[]) => xs.map((x) => `${x.kind}/${x.entityId}`).join(', ');
      if (!r.released) {
        console.error(`nothing is quarantined under ${stepKey}`);
        process.exitCode = 1;
      } else {
        console.log(`released ${stepKey}${r.entities.length > 0 ? ` (entities back: ${refs(r.entities)})` : ''}`);
      }
      if (r.skipped.length > 0) console.log(`left alone (moved on since the trip): ${refs(r.skipped)}`);
    } finally {
      k.store.close();
    }
  });

const audit = program.command('audit').description('Audit log tools');
audit
  .command('verify')
  .description('Walk the hash-chained event log')
  .option('--db <path>', 'SQLite file', 'jobpilot.db')
  .option('--expect-head <hash:count>', 'fail unless the chain head is exactly this (detects a truncated or rewritten tail)')
  .action((o: { db: string; expectHead?: string }) => {
    let expected: { hash: string; count: number } | undefined;
    if (o.expectHead !== undefined) {
      const m = /^([0-9a-fA-F]+):(\d+)$/.exec(o.expectHead);
      if (!m) {
        console.error('--expect-head must look like <hash>:<count>');
        process.exit(1);
      }
      expected = { hash: (m[1] as string).toLowerCase(), count: Number(m[2]) };
    }
    const store = Store.open(o.db);
    try {
      const r = verifyChain(store, expected);
      if (r.ok) {
        console.log(`audit chain intact: ${r.events} events`);
        const head = store.chainHead();
        if (head) console.log(`head ${head.hash} (${head.count} events)`);
      } else if ('headMismatch' in r) {
        const head = store.chainHead();
        console.log(`audit chain intact (${r.events} events) but chain head mismatch: ${r.reason}`);
        console.log(`head ${head?.hash ?? 'none'} (${head?.count ?? 0} events)`);
        process.exitCode = 1;
      } else {
        console.log(`audit chain BROKEN at event ${r.brokenAt}: ${r.reason}`);
        process.exitCode = 1;
      }
    } finally {
      store.close();
    }
  });

const contracts = program.command('contracts').description('Agent contract tools');
contracts
  .command('export')
  .description('Write every contract as JSON Schema into contracts-out/')
  .option('--out <dir>', 'directory to write into', join(root, 'contracts-out'))
  .action((o: { out: string }) => {
    let paths: string[];
    try {
      paths = exportContracts(allAgents(), o.out);
    } catch (e) {
      console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
      process.exitCode = 1;
      return;
    }
    for (const p of paths) console.log(`wrote ${p}`);
  });
contracts
  .command('check')
  .description('Fail if any contract changed without a version bump')
  .action(() => {
    const problems = checkDrift(allAgents(), join(root, 'contracts-out'));
    for (const p of problems) console.error(p);
    if (problems.length > 0) process.exitCode = 1;
    else console.log('contracts match contracts-out/');
  });

program
  .command('eval')
  .description('Run every golden-set eval and enforce its gate')
  .action(async () => {
    const reports = [];
    // The app evals run on the fictional fixture pack, never the user's own.
    const specs = [...demoEvalSpecs(join(root, 'evals/datasets')), ...appEvalSpecs(join(root, 'evals/datasets'), join(root, 'tests/fixtures/pack'))];
    for (const spec of specs) {
      reports.push(await runEval(spec, { providers: { fetch: async () => ({ status: 404, text: async () => '' }) }, policy: PRODUCT_POLICY_V1 }));
    }
    for (const r of reports) console.log(`${r.pass ? 'PASS' : 'FAIL'} ${r.name !== undefined ? `${r.name} via ` : ''}${r.agentId}@${r.version} ${r.metric}=${r.score.toFixed(3)} (min ${r.min}, n=${r.n}${r.packHash !== undefined ? `, pack ${r.packHash.slice(0, 12)}` : ''})`);
    const failed = failedGates(reports);
    if (failed.length > 0) process.exitCode = 1;
  });

/** Runs a command body; any error is printed as one `error:` line and the exit code is 1. */
async function guarded(fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
  } catch (e) {
    console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  }
}

/** The fact overrides from the app DB, without creating the DB when there is none yet. */
function overridesAt(db: string): Record<string, Fact['status']> {
  if (!existsSync(db)) return {};
  const app = AppStore.open(db);
  try {
    return app.factOverrides();
  } finally {
    app.close();
  }
}

/** The pack as today's run would load it (this IST month, the user's fact overrides, the kept render nonce). */
function todaysPack() {
  const paths = homePaths(jobpilotHome());
  let nonce: number | undefined;
  if (existsSync(paths.db)) {
    const app = AppStore.open(paths.db);
    try {
      const v = app.getSetting(RENDER_NONCE_KEY);
      nonce = v === undefined ? undefined : Number(v);
    } finally {
      app.close();
    }
  }
  return loadRunPack(paths.pack, overridesAt(paths.db), istMonth(systemClock.now()), nonce);
}

program
  .command('run')
  .description('Run the daily pipeline, project the results into the app tables and post the notification')
  .option('--offline-fixtures <dir>', 'answer every request from <dir>/index.json (URL -> file); nothing is fetched')
  .option('--no-notify', 'do not post the macOS notification')
  .action(async (o: { offlineFixtures?: string; notify: boolean }) =>
    guarded(async () => {
      const offline = o.offlineFixtures === undefined ? undefined : offlineProviders(o.offlineFixtures);
      // Loaded only for a live run: the browser library is large, and an offline run never renders a live page.
      const live: PlaywrightBrowserProvider | undefined =
        offline === undefined ? new (await import('./app/browser/playwright-provider.js')).PlaywrightBrowserProvider() : undefined;
      try {
        const summary = await runDaily({
          home: jobpilotHome(),
          clock: systemClock,
          fetch: offline?.fetch ?? nodeFetch,
          browser: offline?.browser ?? (live as PlaywrightBrowserProvider),
          notifier: o.notify ? osascriptNotifier : async () => {},
        });
        console.log(formatSummary(summary));
      } finally {
        await live?.close();
      }
    }),
  );

const pack = program.command('pack').description('User pack tools');
pack
  .command('check')
  .description('Validate the pack as today\'s run would load it, prove the wiring and pacing, and print the pack hash')
  .action(() =>
    guarded(() => {
      const loaded = todaysPack();
      const prepared = preparePipeline(loaded.pack);
      const { warnings } = dailySeeds(loaded.pack, '2000-01-01');
      const careers = loaded.pack.watchlist.filter((w) => w.ats === 'careers').length;
      console.log(`pack ok: ${homePaths(jobpilotHome()).pack}`);
      console.log(`pack hash ${loaded.packHash}`);
      console.log(`full pack hash ${loaded.fullPackHash}`);
      console.log(`experience as of ${loaded.asOf}; ${loaded.pack.facts.length} facts; watchlist ${loaded.pack.watchlist.length} entries (${careers} careers); feeds ${loaded.pack.feeds.enabled.join(', ') || 'none'}`);
      console.log(`pipeline ${prepared.compiled.pipeline.id}@${prepared.compiled.pipeline.version}: ${prepared.registry.list().length} agents; policy ${prepared.policyHash.slice(0, 12)}`);
      for (const w of warnings) console.log(`warning: ${w}`);
    }),
  );

const migrate = program.command('migrate').description('One-off imports');
migrate
  .command('desk <dir>')
  .description('Import the Application Desk rows (status, note, applied date), sanitised by the pack naming rules')
  .action((dir: string) =>
    guarded(async () => {
      const paths = homePaths(jobpilotHome());
      if (!existsSync(join(paths.pack, 'naming.yaml'))) {
        throw new Error(`migrate desk needs the pack's naming rules (${join(paths.pack, 'naming.yaml')}) to sanitise the rows; build the pack first`);
      }
      const { pack: loaded } = todaysPack();
      if (loaded.naming.forbiddenTerms.length === 0) throw new Error('naming.yaml lists no forbiddenTerms; refusing to import Desk rows unsanitised');
      await withLock(paths.home, 'migrate desk', async () => {
        const app = AppStore.open(paths.db);
        try {
          console.log(JSON.stringify(migrateDesk(dir, app, { naming: loaded.naming }), null, 2));
        } finally {
          app.close();
        }
      });
    }),
  );

const facts = program.command('facts').description('Fact status overrides (the pack files are never edited)');
facts
  .command('list')
  .description('List every fact with its effective status')
  .action(() =>
    guarded(() => {
      const paths = homePaths(jobpilotHome());
      const overrides = overridesAt(paths.db);
      const { pack: p } = todaysPack();
      const w = Math.max(...p.facts.map((f) => f.id.length), 2);
      for (const f of p.facts) {
        const status = `${f.status}${Object.hasOwn(overrides, f.id) ? ' (override)' : ''}`;
        let line = `${f.id.padEnd(w)}  ${status.padEnd(30)}  ${f.kind.padEnd(10)}  ${f.claim}`;
        try {
          assertNoForbidden(line, p.naming);
        } catch (e) {
          if (!(e instanceof ForbiddenTermError)) throw e;
          line = `${f.id.padEnd(w)}  ${status.padEnd(30)}  ${f.kind.padEnd(10)}  [hidden: contains a forbidden term]`;
        }
        console.log(line);
      }
    }),
  );
for (const [verb, status] of [['verify', 'verified'], ['reject', 'rejected']] as const) {
  facts
    .command(`${verb} <id>`)
    .description(`Mark a fact ${status} (an override; the next run re-runs the steps that read the pack)`)
    .action((id: string) =>
      guarded(() => {
        const paths = homePaths(jobpilotHome());
        const { pack: p } = todaysPack();
        const fact = p.facts.find((f) => f.id === id);
        if (!fact) throw new Error(`unknown fact ${id}`);
        const app = AppStore.open(paths.db);
        try {
          app.setFactOverride(id, status, systemClock.now());
        } finally {
          app.close();
        }
        console.log(`${id}: ${fact.status} -> ${status}`);
      }),
    );
}

const docs = program.command('docs').description('Document tools');
docs
  .command('rebuild [jobKey]')
  .description('Re-render the documents of the latest daily run (only the renderer runs again; nothing is fetched)')
  .option('--all', 'every job of the latest daily run')
  .action((jobKey: string | undefined, o: { all?: boolean }) =>
    guarded(async () => {
      const summary = await rebuildDocs({ home: jobpilotHome(), clock: systemClock, ...(jobKey !== undefined ? { jobKey } : {}), ...(o.all ? { all: true } : {}) });
      console.log(formatSummary(summary));
    }),
  );

await program.parseAsync();
