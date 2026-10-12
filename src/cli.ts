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
import { loadRunPack, preparePipeline, resolvePdftotext } from './app/kernel.js';
import { withLock } from './app/lock.js';
import { migrateDesk } from './app/migrate-desk.js';
import { osascriptNotifier } from './app/notify.js';
import { ForbiddenTermError } from './app/pack/load.js';
import { assertNoForbiddenStrict } from './app/pack/rules.js';
import { formatImportReport, importPack, planImport } from './app/pack/import.js';
import { homePaths, jobpilotHome } from './app/pack/paths.js';
import type { Fact } from './app/pack/schema.js';
import { diskDocCheck } from './app/docs-check.js';
import { overrideFact } from './app/project.js';
import { formatSummary, istMonth, nonceOf, rebuildDocs } from './app/run.js';
import { forbiddenTermsAt, redactedError, runCommand, runFreelanceCommand } from './app/run-command.js';
import { AppStore } from './app/store/app-store.js';
import { dailyDue } from './app/due.js';
import { installSchedule, runNow, scheduleStatus, uninstallSchedule } from './app/schedule.js';
import { DEFAULT_PORT, serveDashboard } from './app/web/server.js';
import { networksList, networksPack } from './app/freelance/networks-command.js';

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
    // final I9: every CLI error goes through the one redactor (`redactText`), with the home pack's forbidden terms
    console.error(`error: ${redactedError(e, forbiddenTermsAt(homePaths(jobpilotHome()).pack))}`);
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
      nonce = nonceOf(app);
    } finally {
      app.close();
    }
  }
  return loadRunPack(paths.pack, overridesAt(paths.db), istMonth(systemClock.now()), nonce);
}

program
  .command('run')
  .description('Run the daily pipeline, project the results into the app tables and post the notification. Exit 0: clean; 1: some step failed or was quarantined (see problems); 2: the run could not run')
  .option('--offline-fixtures <dir>', 'answer every request from <dir>/index.json (URL -> file); nothing is fetched')
  .option('--refresh', 'fetch every source again even if today\'s run already did (career listings are re-read; unchanged career job pages still replay)')
  .option('--no-notify', 'do not post the macOS notification (nothing is marked announced)')
  .option('--if-due', "run only if today's run is owed (from 07:00 IST, none completed today, failed attempts spaced an hour and at most 3); else print why and exit 0. The scheduled job uses this")
  .action(async (o: { offlineFixtures?: string; refresh?: boolean; notify: boolean; ifDue?: boolean }) => {
    process.exitCode = await runCommand(
      { ...(o.offlineFixtures !== undefined ? { offlineFixtures: o.offlineFixtures } : {}), ...(o.refresh ? { refresh: true } : {}), notify: o.notify, ...(o.ifDue ? { ifDue: true } : {}) },
      { home: jobpilotHome(), clock: systemClock, notifier: osascriptNotifier, out: (l) => console.log(l), err: (l) => console.error(l) },
    );
  });

program
  .command('run-freelance')
  .description('Run the freelance pipeline (gigs and contracts), project the results into the gig tables and post the notification; nothing is ever submitted. Exit 0: clean; 1: some step failed or was quarantined (see problems); 2: the run could not run')
  .option('--offline-fixtures <dir>', 'answer every request from <dir>/index.json (URL -> file); nothing is fetched')
  .option('--no-notify', 'do not post the macOS notification (nothing is marked announced)')
  .option('--if-due', 'run only if this half-day\'s run is owed (from 07:30 and 19:30 IST, none completed in the window, failed attempts spaced an hour and at most 3); else print why and exit 0. The scheduled job uses this')
  .action(async (o: { offlineFixtures?: string; notify: boolean; ifDue?: boolean }) => {
    process.exitCode = await runFreelanceCommand(
      { ...(o.offlineFixtures !== undefined ? { offlineFixtures: o.offlineFixtures } : {}), notify: o.notify, ...(o.ifDue ? { ifDue: true } : {}) },
      { home: jobpilotHome(), clock: systemClock, notifier: osascriptNotifier, out: (l) => console.log(l), err: (l) => console.error(l) },
    );
  });

const pack = program.command('pack').description('User pack tools');
pack
  .command('check')
  .description('Validate the pack as today\'s run would load it, prove the wiring and pacing, and print the pack hash')
  .action(() =>
    guarded(() => {
      // m8, final I8: `loadRunPack` re-checks user edits after the import for undrawable characters and forbidden
      // terms (strictly, in every pack file but naming.yaml) and throws on any, exactly as the run would refuse.
      const loaded = todaysPack();
      const prepared = preparePipeline(loaded.pack);
      const careers = loaded.pack.watchlist.filter((w) => w.ats === 'careers').length;
      console.log(`pack ok: ${homePaths(jobpilotHome()).pack}`);
      console.log(`pack hash ${loaded.packHash}`);
      console.log(`full pack hash ${loaded.fullPackHash}`);
      console.log(`experience as of ${loaded.asOf}; ${loaded.pack.facts.length} facts; watchlist ${loaded.pack.watchlist.length} entries (${careers} careers); feeds ${loaded.pack.feeds.enabled.join(', ') || 'none'}`);
      console.log(`pipeline ${prepared.compiled.pipeline.id}@${prepared.compiled.pipeline.version}: ${prepared.registry.list().length} agents; policy ${prepared.policyHash.slice(0, 12)}`);
    }),
  );

const collect = (v: string, prev: string[]): string[] => [...prev, v];
pack
  .command('import')
  .description('Build the user pack once from career-ops facts, the resume text and the Application Desk export (fails, writing nothing, on any forbidden term)')
  .requiredOption('--career-ops <dir>', 'the career-ops repo (reads profile/facts.yaml)')
  .requiredOption('--resume-text <file>', 'resume experience text with "Title | Employer | City, Country | Mon YYYY - Mon YYYY" role headers')
  .requiredOption('--desk <dir>', 'the Application Desk export (settings/answers.json, jobs/*.json)')
  .option('--out <packDir>', 'the pack directory to create (default: $JOBPILOT_HOME/pack)')
  .option('--forbid <term>', 'a forbidden term (the client name); repeatable, at least one', collect, [])
  .option('--employer-display <raw=display>', 'show employer <raw> as <display>; repeatable', collect, [])
  .requiredOption('--name <name>', 'contact name')
  .requiredOption('--email <email>', 'contact email')
  .requiredOption('--phone <phone>', 'contact phone')
  .requiredOption('--city <city>', 'contact city')
  .option('--link <url>', 'a contact link; repeatable, at least one', collect, [])
  .requiredOption('--as-of <YYYY-MM>', 'the experience month written to experience.yaml (the daily run uses the current month)')
  .requiredOption('--available-from <text>', 'answers available_from, e.g. "1 November 2026"')
  .requiredOption('--notice-period <text>', 'answers notice_period, e.g. "30 days"')
  .requiredOption('--floor-inr <amount>', 'the base salary floor in INR a year, e.g. 1200000 (equity never counts)')
  .option('--education-text <file>', 'one "qualification | institution | YYYY-MM..YYYY-MM" per line (status user-stated)')
  .option('--claimable-title <title>', 'a title the candidate can truthfully claim, added to the ongoing roles\' titles; repeatable', collect, [])
  .option('--extra-watchlist <yaml>', 'extra watchlist entries ({watchlist: [...]}); they replace Desk entries for the same board')
  .option('--fx-file <yaml>', 'fx rates ({asOf, toINR}); default: pinned rates dated 1970-01-01 (the dashboard warns)')
  .option('--force', 'replace an existing pack, moving it to <out>.bak-<timestamp> first')
  .option('--allow-unplaced', 'proceed even when citeable facts sit under an employer no resume role names (normally an error)')
  .option('--dry-run', 'run every input check and print the summary; write nothing')
  .action(
    (o: {
      careerOps: string; resumeText: string; desk: string; out?: string; forbid: string[]; employerDisplay: string[];
      name: string; email: string; phone: string; city: string; link: string[]; asOf: string; availableFrom: string;
      noticePeriod: string; floorInr: string; educationText?: string; claimableTitle: string[]; extraWatchlist?: string;
      fxFile?: string; force?: boolean; allowUnplaced?: boolean; dryRun?: boolean;
    }) =>
      guarded(async () => {
        const floor = /^\d+$/.test(o.floorInr.trim()) ? Number(o.floorInr.trim()) : Number.NaN;
        const opts = {
          careerOps: o.careerOps,
          resumeText: o.resumeText,
          desk: o.desk,
          out: o.out ?? homePaths(jobpilotHome()).pack,
          forbid: o.forbid,
          employerDisplay: o.employerDisplay,
          contact: { name: o.name, email: o.email, phone: o.phone, city: o.city, links: o.link },
          asOf: o.asOf,
          availableFrom: o.availableFrom,
          noticePeriod: o.noticePeriod,
          floorInr: floor,
          educationText: o.educationText,
          claimableTitles: o.claimableTitle,
          extraWatchlist: o.extraWatchlist,
          fxFile: o.fxFile,
          force: o.force === true,
          allowUnplaced: o.allowUnplaced === true,
          now: systemClock.now(),
          lockHome: jobpilotHome(),
        };
        const report = o.dryRun === true ? planImport(opts) : await importPack(opts);
        for (const line of formatImportReport(report)) console.log(line);
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
          assertNoForbiddenStrict(line, p.naming);
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
          // rereview R3: documents citing a fact that is no longer citeable are set aside at once (one transaction)
          const { stale, restored } = overrideFact(app, p.facts, id, status, systemClock.now(), diskDocCheck(paths.out));
          console.log(`${id}: ${fact.status} -> ${status}`);
          if (stale.length > 0) console.log(`documents of ${stale.length} job(s) cite it and are set aside until the next run makes them again`);
          if (restored.length > 0) console.log(`documents of ${restored.length} job(s) are offered again`);
        } finally {
          app.close();
        }
      }),
    );
}

const networks = program.command('networks').description('Vetted freelance networks: application packs built from your verified facts');
networks
  .command('list')
  .description('List the network files in pack/networks/')
  .action(() =>
    guarded(() => {
      for (const l of networksList(todaysPack())) console.log(l);
    }),
  );
networks
  .command('pack [ids...]')
  .description('Write out/networks/<id>/ (resume.pdf, resume.docx, profile.txt, checklist.md) for each network, only from verified facts; nothing is submitted')
  .option('--all', 'every network in pack/networks/')
  .action((ids: string[], o: { all?: boolean }) =>
    guarded(async () => {
      if (o.all === true && ids.length > 0) throw new Error('pass network ids or --all, not both');
      const paths = homePaths(jobpilotHome());
      const pdftotext = resolvePdftotext();
      process.exitCode = await withLock(paths.home, 'networks pack', async () =>
        networksPack(o.all === true ? 'all' : ids, todaysPack(), join(paths.out, 'networks'), { out: (l) => console.log(l), err: (l) => console.error(l), pdftotext }),
      );
    }),
  );

const docs = program.command('docs').description('Document tools');
docs
  .command('rebuild')
  .description('Re-render the documents of every job in the latest daily run from stored plans; nothing is fetched or re-evaluated')
  .action(() =>
    guarded(async () => {
      const summary = await rebuildDocs({ home: jobpilotHome(), clock: systemClock });
      console.log(formatSummary(summary));
      if (summary.exitCode !== 0) process.exitCode = summary.exitCode;
    }),
  );

program
  .command('serve')
  .description('Serve the dashboard on http://127.0.0.1:<port> (this machine only)')
  .option('--port <n>', 'port to listen on', String(DEFAULT_PORT))
  .action((o: { port: string }) =>
    guarded(() => {
      const port = /^\d{1,5}$/.test(o.port) ? Number(o.port) : Number.NaN;
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('--port must be a number from 1 to 65535');
      const server = serveDashboard({ home: jobpilotHome(), clock: systemClock, port }, (url) => console.log(`jobpilot dashboard on ${url} (Ctrl-C to stop)`));
      server.on('error', (e) => {
        console.error(`error: ${e.message}`);
        process.exit(1);
      });
    }),
  );

/** Whether today's daily run is owed, as one line; a DB that cannot be read is named, not thrown. */
function dueOrError(now: string): string {
  try {
    const d = dailyDue(jobpilotHome(), now);
    return d.due ? `owed: ${d.reason}` : d.reason;
  } catch (e) {
    return `unknown: the database cannot be read (${e instanceof Error ? e.message : String(e)})`;
  }
}
const schedule = program.command('schedule').description('launchd jobs: the 07:00 IST daily run and the always-on dashboard (macOS)');
const scheduleOpts = () => {
  if (process.getuid === undefined) throw new Error('schedule needs a POSIX user id (macOS)');
  return { node: process.execPath, repo: root, home: jobpilotHome(), uid: process.getuid() };
};
schedule
  .command('install')
  .description('Write both launchd plists to ~/Library/LaunchAgents and load them (safe to repeat)')
  .action(() =>
    guarded(() => {
      const r = installSchedule(scheduleOpts());
      for (const p of r.plists) console.log(`wrote ${p}`);
      const owed = dueOrError(new Date().toISOString());
      console.log(`daily run: from 07:00 IST, checked at login and every half hour, so a Mac asleep at 07:00 runs soon after it wakes; next run ${owed.startsWith('owed') ? 'now (today\'s run is owed)' : r.nextRun}`);
      console.log('dashboard: http://127.0.0.1:4317 (starts now and at login)');
      console.log(`logs: ${r.logs.join(', ')}`);
    }),
  );
schedule
  .command('uninstall')
  .description('Unload both jobs and delete their plists')
  .action(() =>
    guarded(() => {
      for (const p of uninstallSchedule(scheduleOpts())) console.log(`removed ${p}`);
    }),
  );
schedule
  .command('status')
  .description('Whether each job is loaded, its state and last exit code, and where its plist and log are')
  .action(() =>
    guarded(() => {
      for (const s of scheduleStatus(scheduleOpts())) {
        console.log(`${s.label}: ${s.loaded ? `loaded, state ${s.state ?? 'unknown'}, last exit code ${s.lastExitCode ?? 'none yet'}` : 'not loaded'}`);
        console.log(`  plist ${s.plistPath}`);
        console.log(`  log   ${s.logPath}`);
      }
      console.log(`today's daily run: ${dueOrError(new Date().toISOString())}`);
    }),
  );
schedule
  .command('run-now')
  .description('Start the daily job now through launchd (a manual test of the scheduled command)')
  .action(() =>
    guarded(() => {
      runNow(scheduleOpts());
      console.log(`started com.jobpilot.daily (run --if-due): ${dueOrError(new Date().toISOString())}`);
      console.log('it runs only when today\'s run is owed; "jobpilot run" always runs. Follow it with: tail -f ' + join(homePaths(jobpilotHome()).logs, 'daily.log'));
    }),
  );

await program.parseAsync();
