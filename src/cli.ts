import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';

import { Command, InvalidArgumentError } from 'commander';
import { checkDrift, exportContracts } from './kernel/contracts-export.js';
import { systemClock } from './kernel/clock.js';
import { PRODUCT_POLICY_V1 } from './kernel/policy.js';
import { nodeFetch } from './kernel/providers.js';
import { Registry } from './kernel/registry.js';
import { fullChainCheck, readCheckpoint } from './app/chain-status.js';
import { upgradeUnderLock } from './app/upgrade.js';
import { storeCompactCommand, storeRestoreCommand } from './app/store/compact-command.js';
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
import { ForbiddenTermError, type LoadMode } from './app/pack/load.js';
import { assertNoForbiddenStrict } from './app/pack/rules.js';
import { formatImportReport, importPack, planImport } from './app/pack/import.js';
import { homePaths, jobpilotHome, selectedProfile, selectProfile } from './app/pack/paths.js';
import { ProfileError, jobpilotRoot, profileHome, resolveHome } from './app/profiles/root.js';
import { createProfile, removeProfile, useProfile } from './app/profiles/commands.js';
import { listProfiles } from './app/profiles/meta.js';
import type { Fact } from './app/pack/schema.js';
import { diskDocCheck } from './app/docs-check.js';
import { overrideFact } from './app/project.js';
import { formatSummary, istMonth, nonceOf, rebuildDocs } from './app/run.js';
import { forbiddenTermsAt, redactedError, runCommand, runCoverageCommand, runFreelanceCommand } from './app/run-command.js';
import { AppStore, SchemaBehindError } from './app/store/app-store.js';
import { COVERAGE_DUE, DAILY_DUE, FREELANCE_DUE, coverageWeek, due, type DueSpec } from './app/due.js';
import { COVERAGE_LABEL, DAILY_LABEL, FREELANCE_LABEL, installSchedule, profileLabels, runNow, scheduleStatus, uninstallSchedule } from './app/schedule.js';
import { DEFAULT_PORT, serveDashboard } from './app/web/server.js';
import { networksList, networksPack } from './app/freelance/networks-command.js';
import { probeCommand } from './app/freelance/probe.js';
import { coverageProbeCommand, parseDays } from './app/coverage/probe.js';
import { connectGmail, disconnectGmail, gmailStatus, openInBrowser } from './app/freelance/mail/connect.js';
import { gmailRunAccess, realFormPost } from './app/freelance/mail/oauth.js';
import { SECRET } from './app/freelance/mail/google.js';
import { keychain, realSecretsRunner } from './app/secrets.js';
import { profileKeychainService } from './app/profiles/keychain.js';

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
  .description('Run the built-in two-agent demo pipeline end to end on a scratch SQLite file; makes no requests and does not touch your jobpilot home')
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

const audit = program.command('audit').description('Audit log tools: check that a database\'s event history has not been altered');
audit
  .command('verify')
  .description('Walk the whole hash-chained event log and fail if any link is broken; a pass records the full-check checkpoint the dashboard\'s Runs page starts from (coverage also runs this weekly)')
  .option('--db <path>', 'SQLite file (default: the jobpilot home\'s, $JOBPILOT_HOME/jobpilot.db)')
  .option('--expect-head <hash:count>', 'fail unless the chain head is exactly this (detects a truncated or rewritten tail)')
  .option('--no-record', 'open the file read-only and record nothing (a forensic copy)')
  .action((o: { db?: string; expectHead?: string; record: boolean }) => {
    // the same home every other command uses; never a jobpilot.db in the current directory
    const db = o.db ?? homePaths(jobpilotHome()).db;
    if (!existsSync(db)) {
      console.error(`error: no database at ${db}`);
      process.exit(1);
    }
    let expected: { hash: string; count: number } | undefined;
    if (o.expectHead !== undefined) {
      const m = /^([0-9a-fA-F]+):(\d+)$/.exec(o.expectHead);
      if (!m) {
        console.error('--expect-head must look like <hash>:<count>');
        process.exit(1);
      }
      expected = { hash: (m[1] as string).toLowerCase(), count: Number(m[2]) };
    }
    const store = o.record ? Store.open(db) : Store.openReadOnly(db, { forensic: true });
    try {
      // dashboard-perf fix 1: a passing full walk records its checkpoint (a failing one, the broken marker) in a jobpilot
      // home DB, best effort: a record that cannot be written is a warning, the walk's verdict stands
      let recordFailed = false;
      const r = fullChainCheck(store, systemClock.now(), {
        ...(expected !== undefined ? { expectedHead: expected } : {}),
        record: o.record,
        onRecordFailed: (m) => {
          recordFailed = true;
          console.error(`warning: ${m}`);
        },
      });
      if (r.ok) {
        console.log(`audit chain intact: ${r.events} events`);
        const head = store.chainHead();
        if (head) console.log(`head ${head.hash} (${head.count} events)`);
        const cp = o.record && !recordFailed ? readCheckpoint(store.db) : undefined;
        if (!o.record) console.log('not recorded (--no-record)');
        else if (cp !== undefined && head !== undefined && cp.seq === head.seq) console.log(`checkpoint recorded through event ${cp.seq}: the dashboard checks only the events after it`);
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
    // re-review: a command that is not allowed to migrate met a schema behind this code: say so, exit 2
    if (e instanceof SchemaBehindError) {
      console.error(`error: ${e.message}`);
      process.exitCode = 2;
      return;
    }
    // final I9: every CLI error goes through the one redactor (`redactText`), with the home pack's forbidden terms
    let terms: ReturnType<typeof forbiddenTermsAt> = [];
    try {
      terms = forbiddenTermsAt(homePaths(jobpilotHome()).pack);
    } catch {
      // no home resolves (the profile group works on the root): redact with no home terms
    }
    console.error(`error: ${redactedError(e, terms)}`);
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

/**
 * The pack as today's run would load it (this IST month, the user's fact overrides, the kept render nonce). `mode`
 * (final review C1): `strict` for `pack check` (companies.yaml too); `freelance` for the freelance commands (their files strict, companies.yaml lenient); `daily` for the daily-only commands, which
 * a broken freelance file must never stop.
 */
function todaysPack(mode: LoadMode) {
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
  return loadRunPack(paths.pack, overridesAt(paths.db), istMonth(systemClock.now()), nonce, mode);
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
      { home: jobpilotHome(), clock: systemClock, notifier: osascriptNotifier, out: (l) => console.log(l), err: (l) => console.error(l), gmail: () => gmailRunAccess(keychain(realSecretsRunner, profileKeychainService())) },
    );
  });

program
  .command('run-coverage')
  .description('Run the weekly career-site coverage pipeline: seed companies, locate their careers sites, detect the platform, verify the board, and fill the companies registry. Each week it also sends 300 boards of the vendored freehire catalogue to the verifier and runs the freehire discovery stage (at most 10 searches; new boards to the verifier, other postings stored as leads for the review band of the Jobs list) unless --no-freehire. It runs in slices of at most 90 minutes and yields to an owed daily or freelance run; the next start continues the same run. Exit 0: clean; 1: some step failed or was quarantined; 2: the run could not run')
  .option('--offline-fixtures <dir>', 'answer every request from <dir>/index.json (URL -> file); nothing is fetched')
  .option('--no-notify', 'do not post the macOS notification')
  .option('--if-due', 'run only if this coverage week\'s run is owed (from Sunday 06:00 IST through Saturday, none completed that week, failed attempts spaced an hour and at most 3 per week); else print why and exit 0. The scheduled job uses this')
  .option('--limit <n>', 'for checks only: locate every pick plus the first <n> other candidates (companyKey order); the scheduled run never sets it', (v: string) => {
    const n = Number(v);
    if (!Number.isSafeInteger(n) || n < 0) throw new InvalidArgumentError(`--limit must be a whole number, not ${v}`);
    return n;
  })
  .option('--slice-minutes <n>', 'for checks only: pause after <n> minutes instead of the 90-minute slice (the next run-coverage continues the run)', (v: string) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) throw new InvalidArgumentError(`--slice-minutes must be a positive number, not ${v}`);
    return n;
  })
  .option('--no-yield', 'for checks only: never pause for an owed daily or freelance run (the slice limit still applies)')
  .option('--no-freehire', 'leave out the freehire sources of this run (the vendored board catalogue, 300 new boards a week, sent straight to the verifier)')
  .option('--catalogue-limit <n>', 'for checks only: send at most <n> catalogue boards to the verifier this week instead of 300', (v: string) => {
    const n = Number(v);
    if (!Number.isSafeInteger(n) || n < 0) throw new InvalidArgumentError(`--catalogue-limit must be a whole number, not ${v}`);
    return n;
  })
  .action(async (o: { offlineFixtures?: string; notify: boolean; ifDue?: boolean; limit?: number; sliceMinutes?: number; yield: boolean; freehire: boolean; catalogueLimit?: number }) => {
    process.exitCode = await runCoverageCommand(
      {
        ...(o.offlineFixtures !== undefined ? { offlineFixtures: o.offlineFixtures } : {}),
        notify: o.notify,
        ...(o.ifDue ? { ifDue: true } : {}),
        ...(o.limit !== undefined ? { limit: o.limit } : {}),
        ...(o.sliceMinutes !== undefined ? { sliceMs: Math.round(o.sliceMinutes * 60_000) } : {}),
        freehire: o.freehire,
        ...(o.catalogueLimit !== undefined ? { catalogueLimit: o.catalogueLimit } : {}),
      },
      { home: jobpilotHome(), clock: systemClock, notifier: osascriptNotifier, out: (l) => console.log(l), err: (l) => console.error(l), ...(o.yield ? {} : { yieldCheck: () => null }) },
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
      const loaded = todaysPack('strict');
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
  .requiredOption('--floor-inr <amount>', 'the base salary floor in INR a year, e.g. 1234567 (equity never counts)')
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
      const { pack: loaded } = todaysPack('daily');
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
  .description('List every fact with its effective status (also applies a pending database upgrade, under the run lock)')
  .action(() =>
    guarded(async () => {
      const paths = homePaths(jobpilotHome());
      // dashboard-perf review I2: the dashboard never migrates; this is the command its "being upgraded" page names
      if (await upgradeUnderLock(paths.home, 'facts list')) console.error('the database was upgraded to this jobpilot');
      const overrides = overridesAt(paths.db);
      const { pack: p } = todaysPack('daily');
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
        const { pack: p } = todaysPack('daily');
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
      for (const l of networksList(todaysPack('freelance'))) console.log(l);
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
        networksPack(o.all === true ? 'all' : ids, todaysPack('freelance'), join(paths.out, 'networks'), { out: (l) => console.log(l), err: (l) => console.error(l), pdftotext }),
      );
    }),
  );

const sources = program.command('sources').description('Freelance source tools');
sources
  .command('probe')
  .description('Live and read-only: measure each freelance source\'s yield (Freelancer.com, Himalayas, Hacker News, Draft.dev, Prime Intellect, Fractional Jobs and the parked ones) with the fixed score (access + volume + India + pay), polite and sequential. Never part of verify; nothing is submitted or promoted')
  .option('--json', 'machine-readable output')
  .option('--record <dir>', 'save every raw response there as a fixture candidate (refused inside ~/.jobpilot, the jobpilot home or the repo\'s tests/ unless --force)')
  .option('--force', 'allow --record into a refused folder')
  .action((o: { json?: boolean; record?: string; force?: boolean }) =>
    guarded(async () => {
      process.exitCode = await probeCommand({
        home: jobpilotHome(), repoRoot: root, json: o.json === true, ...(o.record !== undefined ? { record: o.record } : {}), force: o.force === true,
        clock: systemClock, sleep: (ms) => new Promise((r) => setTimeout(r, ms)), out: (l) => console.log(l),
      });
    }),
  );

const storeCmd = program.command('store').description('Database maintenance: archive old envelopes (never part of a run or the schedule)');
storeCmd
  .command('compact')
  .description('Archive the envelopes no reader needs (pack/retention.yaml, default: keep the last 3 daily runs plus pins) to $JOBPILOT_HOME/archive/, recorded in the audit chain, then VACUUM. A dry run unless --apply. Takes the run lock without waiting')
  .option('--apply', 'archive for real (default: a dry run that writes nothing)')
  .option('--dry-run', 'print what would be archived and write nothing (the default)')
  .option('--include-incomplete', 'archive stale incomplete runs too (resumable ones are always kept); without it --apply refuses while any run is incomplete')
  .option('--no-vacuum', 'skip the VACUUM that gives the space back')
  .action((o: { apply?: boolean; dryRun?: boolean; includeIncomplete?: boolean; vacuum: boolean }) =>
    guarded(async () => {
      if (o.apply === true && o.dryRun === true) throw new Error('pass --apply or --dry-run, not both');
      process.exitCode = await storeCompactCommand({
        home: jobpilotHome(), clock: systemClock, out: (l) => console.log(l), err: (l) => console.error(l),
        apply: o.apply === true, includeIncomplete: o.includeIncomplete === true, vacuum: o.vacuum,
      });
    }),
  );
storeCmd
  .command('restore [segment]')
  .description('Bring an archived segment back (or --all), byte for byte, after checking its sha256 against its audit-chain event. Takes the run lock without waiting')
  .option('--all', 'every segment in $JOBPILOT_HOME/archive/')
  .action((segment: string | undefined, o: { all?: boolean }) =>
    guarded(async () => {
      if (o.all === true && segment !== undefined) throw new Error('name a segment or pass --all, not both');
      process.exitCode = await storeRestoreCommand({
        home: jobpilotHome(), clock: systemClock, out: (l) => console.log(l), err: (l) => console.error(l), all: o.all === true, ...(segment !== undefined ? { segment } : {}),
      });
    }),
  );

const coverage = program.command('coverage').description('Career-site coverage tools');
coverage
  .command('probe')
  .description('Read-only, no network: companies by status and platform, the NEW jobs only the platform adapters found (not on any existing source) and how many pass your rules (the count includes jobs you skipped or rejected and ones no longer listed), today\'s requests and the latest run\'s problems per platform, and the freehire line (catalogue: boards verified, proposed and left; discovery: boards and leads). Takes the run lock; refuses while another jobpilot process holds it')
  .option('--json', 'machine-readable output (documented in src/app/coverage/probe.ts, version 1)')
  .option('--days <n>', 'the window for new jobs: the last <n> IST days by first seen (1 to 90, default 7)', (v: string) => {
    try {
      return parseDays(v);
    } catch (e) {
      throw new InvalidArgumentError((e as Error).message);
    }
  })
  .action((o: { json?: boolean; days?: number }) =>
    guarded(async () => {
      process.exitCode = await coverageProbeCommand({ home: jobpilotHome(), json: o.json === true, ...(o.days !== undefined ? { days: o.days } : {}), clock: systemClock, out: (l) => console.log(l) });
    }),
  );

/** A y/N question on the terminal; without one (piped input) the answer is the default, "". */
async function askLine(question: string): Promise<string> {
  if (!process.stdin.isTTY) return '';
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

const gmail = program.command('gmail').description('Read-only Gmail alert ingest: jobpilot reads only the label jobpilot/gigs, with the gmail.readonly scope');
gmail
  .command('connect')
  .description('Sign in to Google in your browser (gmail.readonly only) and keep the OAuth client and refresh token in the macOS Keychain; reads ~/.jobpilot/secrets/google-oauth-client.json once and offers to delete it')
  .action(() =>
    guarded(async () => {
      await connectGmail({ home: jobpilotHome(), secrets: keychain(realSecretsRunner, profileKeychainService()), post: realFormPost, open: openInBrowser, ask: askLine, out: (l) => console.log(l) });
    }),
  );
gmail
  .command('status')
  .description('Whether Gmail is connected, the label read and the alert parsers; never shows a token')
  .action(() =>
    guarded(() => {
      for (const l of gmailStatus({ home: jobpilotHome(), secrets: keychain(realSecretsRunner, profileKeychainService()) })) console.log(l);
    }),
  );
gmail
  .command('disconnect')
  .description('Delete the Gmail items from the Keychain (the client and the refresh token)')
  .action(() =>
    guarded(() => {
      for (const l of disconnectGmail({ home: jobpilotHome(), secrets: keychain(realSecretsRunner, profileKeychainService()) })) console.log(l);
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
  .description('Serve the dashboard on http://127.0.0.1:<port> (this machine only; the schedule keeps one running). Tabs: Jobs, Freelance, Companies (approve, reject, undo, add, resolve now), Your facts, Runs')
  .option('--port <n>', 'port to listen on', String(DEFAULT_PORT))
  .action((o: { port: string }) =>
    guarded(() => {
      const port = /^\d{1,5}$/.test(o.port) ? Number(o.port) : Number.NaN;
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('--port must be a number from 1 to 65535');
      const secrets = keychain(realSecretsRunner, profileKeychainService());
      const gmailConnected = (): boolean => {
        try {
          return secrets.has(SECRET.refresh);
        } catch {
          return false;
        }
      };
      // dashboard-perf: a newer jobpilot migrated the DB under this (older) process: exit after answering, so launchd's
      // KeepAlive restarts the dashboard on the checkout's code (a hand-started one just stops, and says why)
      const onSchemaNewer = (): void => {
        console.error('jobpilot dashboard: the database was upgraded by a newer jobpilot; exiting so it restarts on the new code');
        setTimeout(() => process.exit(1), 250).unref();
      };
      const server = serveDashboard({ home: jobpilotHome(), clock: systemClock, port, gmailConnected, onSchemaNewer, resolve: { fetch: nodeFetch } }, (url) => console.log(`jobpilot dashboard on ${url} (Ctrl-C to stop)`));
      server.on('error', (e) => {
        console.error(`error: ${e.message}`);
        process.exit(1);
      });
    }),
  );

/** Whether a pipeline's run is owed, as one line; a DB that cannot be read is named, not thrown. */
function dueOrError(now: string, spec: DueSpec = DAILY_DUE): string {
  try {
    const d = due(spec, jobpilotHome(), now);
    const label = d.window === '' ? '' : `${d.window} window: `;
    return `${label}${d.due ? `owed: ${d.reason}` : d.reason}`;
  } catch (e) {
    return `unknown: the database cannot be read (${e instanceof Error ? e.message : String(e)})`;
  }
}
const schedule = program.command('schedule').description('launchd jobs: the 07:00 IST daily run, the 07:30 and 19:30 IST freelance runs, the weekly Sunday coverage run and the always-on dashboard (macOS)');
const scheduleOpts = () => {
  if (process.getuid === undefined) throw new Error('schedule needs a POSIX user id (macOS)');
  const h = resolveHome({ profile: selectedProfile() });
  return { node: process.execPath, repo: root, home: h.home, uid: process.getuid(), ...(h.mode === 'profile' ? { profile: { id: h.profile as string, root: h.root } } : {}) };
};
schedule
  .command('install')
  .description('Write the four launchd plists to ~/Library/LaunchAgents and load them (safe to repeat). On a home that never ran coverage, the weekly coverage run is first owed from the next Sunday 06:00 IST')
  .option('--coverage-now', 'owe the weekly coverage run at once instead of from the next Sunday 06:00 IST')
  .action((opts: { coverageNow?: boolean }) =>
    guarded(() => {
      const r = installSchedule({ ...scheduleOpts(), coverageNow: opts.coverageNow === true });
      for (const p of r.plists) console.log(`wrote ${p}`);
      const owed = dueOrError(new Date().toISOString());
      console.log(`daily run: from 07:00 IST, checked at login and every half hour, so a Mac asleep at 07:00 runs soon after it wakes; next run ${owed.startsWith('owed') ? 'now (today\'s run is owed)' : r.nextRun}`);
      const fOwed = dueOrError(new Date().toISOString(), FREELANCE_DUE);
      console.log(`freelance run: from 07:30 and 19:30 IST, checked at login and every half hour; ${fOwed.includes('owed:') ? `a window is owed now (${fOwed})` : `now: ${fOwed}`}`);
      const cOwed = dueOrError(new Date().toISOString(), COVERAGE_DUE);
      console.log(
        `coverage run: weekly, owed from Sunday 06:00 IST through Saturday, checked at login and every half hour; ${
          r.coverageFrom !== null ? `the first run is owed from ${r.coverageFrom} (schedule install --coverage-now starts it now)` : cOwed.includes('owed:') ? `owed now (${cOwed})` : `now: ${cOwed}`
        }`,
      );
      console.log('dashboard: http://127.0.0.1:4317 (starts now and at login)');
      if (scheduleOpts().profile !== undefined) console.log(`jobs: ${r.plists.map((p) => p.split('/').pop()?.replace(/\.plist$/, '')).join(', ')}`);
      console.log(`logs: ${r.logs.join(', ')}`);
    }),
  );
schedule
  .command('uninstall')
  .description('Unload all four jobs and delete their plists')
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
      console.log(`freelance run, ${dueOrError(new Date().toISOString(), FREELANCE_DUE)}`);
      console.log(`coverage run, week of ${coverageWeek(new Date().toISOString())}: ${dueOrError(new Date().toISOString(), COVERAGE_DUE)}`);
    }),
  );
schedule
  .command('run-now')
  .description('Start the daily job now through launchd (a manual test of the scheduled command, which runs only if the run is owed); --freelance starts the freelance job, --coverage the weekly coverage job. Follow the log with tail -f on the path it prints')
  .option('--freelance', 'start com.jobpilot.freelance (run-freelance --if-due) instead')
  .option('--coverage', 'start com.jobpilot.coverage (run-coverage --if-due) instead')
  .action((o: { freelance?: boolean; coverage?: boolean }) =>
    guarded(() => {
      if (o.coverage === true) {
        const so = scheduleOpts();
        runNow({ ...so, coverage: true, profile: so.profile?.id });
        console.log(`started ${so.profile === undefined ? COVERAGE_LABEL : profileLabels(so.profile.id).coverage} (run-coverage --if-due): ${dueOrError(new Date().toISOString(), COVERAGE_DUE)}`);
        console.log('it runs only when this coverage week\'s run is owed; "jobpilot run-coverage" always runs. Follow it with: tail -f ' + join(homePaths(jobpilotHome()).logs, 'coverage.log'));
        return;
      }
      const f = o.freelance === true;
      const so = scheduleOpts();
      runNow({ ...so, freelance: f, profile: so.profile?.id });
      const labels = so.profile === undefined ? { daily: DAILY_LABEL, freelance: FREELANCE_LABEL } : profileLabels(so.profile.id);
      console.log(f ? `started ${labels.freelance} (run-freelance --if-due): ${dueOrError(new Date().toISOString(), FREELANCE_DUE)}` : `started ${labels.daily} (run --if-due): ${dueOrError(new Date().toISOString())}`);
      console.log(f ? 'it runs only when the window is owed; "jobpilot run-freelance" always runs. Follow it with: tail -f ' + join(homePaths(jobpilotHome()).logs, 'freelance.log') : 'it runs only when today\'s run is owed; "jobpilot run" always runs. Follow it with: tail -f ' + join(homePaths(jobpilotHome()).logs, 'daily.log'));
    }),
  );

const profileCmd = program.command('profile').description('Profiles: several people on one machine, each with a complete, separate home under ~/.jobpilot/profiles/<id>');
profileCmd.command('list').description('The profiles; * marks the active one').action(() =>
  guarded(() => {
    const rows = listProfiles(jobpilotRoot());
    if (rows.length === 0) console.log('no profiles: this is a single jobpilot home (jobpilot profile adopt <id> turns it into one)');
    for (const r of rows) console.log(`${r.active ? '*' : ' '} ${r.id}${r.adopted ? '  (adopted)' : ''}${r.hasPack ? '' : '  (no pack yet)'}`);
  }),
);
profileCmd.command('create <id>').description('Create an empty profile (or one from a pack folder); the first one becomes active').option('--from-pack <dir>', 'copy this pack folder into the new profile').action((id: string, o: { fromPack?: string }) =>
  guarded(() => {
    for (const l of createProfile({ root: jobpilotRoot(), id, clock: systemClock, ...(o.fromPack !== undefined ? { fromPack: o.fromPack } : {}) })) console.log(l);
  }),
);
profileCmd.command('use <id>').description('Make <id> the active profile (the default for every command and the dashboard)').action((id: string) =>
  guarded(() => {
    for (const l of useProfile({ root: jobpilotRoot(), id })) console.log(l);
  }),
);
profileCmd.command('remove <id>').description('Unload the profile\'s launchd jobs and archive it to ~/.jobpilot/removed/<id>-<time>; nothing is deleted').action((id: string) =>
  guarded(() => {
    const r = jobpilotRoot();
    const unload = (pid: string): void => {
      if (process.getuid === undefined) return;
      uninstallSchedule({ node: process.execPath, repo: root, home: profileHome(r, pid), profile: { id: pid, root: r }, uid: process.getuid() });
    };
    for (const l of removeProfile({ root: r, id, clock: systemClock, unload })) console.log(l);
  }),
);

const PROFILE_HELP = 'the profile to use (default: the active one, see "jobpilot profile use"); not together with JOBPILOT_HOME';
const leafCommands = (c: Command): Command[] => (c.commands.length === 0 ? [c] : c.commands.flatMap(leafCommands));
for (const c of program.commands.filter((c) => c.name() !== 'profile').flatMap(leafCommands)) c.option('--profile <id>', PROFILE_HELP);
program.hook('preAction', (_program, action) => {
  if (action.parent?.name() === 'profile') return; // the profile group works on the root, never on one home
  const id = action.opts()['profile'] as string | undefined;
  selectProfile(id);
  try {
    jobpilotHome(); // resolve now, so a bad profile stops the command before it starts
  } catch (e) {
    if (!(e instanceof ProfileError)) throw e;
    console.error(`error: ${e.message}`);
    process.exit(2);
  }
});

await program.parseAsync();
