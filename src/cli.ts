import { join } from 'node:path';

// A native addon built for another Node ABI segfaults instead of failing; refuse early and say why.
const major = Number(process.versions.node.split('.')[0]);
if (major < 24) {
  console.error(`jobpilot needs Node 24 or newer; this is Node ${process.versions.node} (${process.execPath}).`);
  process.exit(1);
}

import { Command } from 'commander';
import { checkDrift, exportContracts } from './kernel/contracts-export.js';
import { systemClock } from './kernel/clock.js';
import { PRODUCT_POLICY_V1 } from './kernel/policy.js';
import { Registry } from './kernel/registry.js';
import { verifyChain } from './kernel/store/audit.js';
import { Store } from './kernel/store/store.js';
import { failedGates, runEval } from './evals/runner.js';
import { demoEvalSpecs } from './demo/evals.js';
import { demoKernel } from './demo/kernel.js';
import { demoAgents } from './demo/pipeline.js';

const root = join(import.meta.dirname, '..');
const allAgents = () => {
  const r = new Registry();
  for (const a of demoAgents) r.register(a);
  return r;
};

const program = new Command().name('jobpilot').description('Deterministic multi-agent job search kernel');

program
  .command('demo')
  .description('Run the two-agent demo pipeline end to end')
  .option('--db <path>', 'SQLite file', 'jobpilot.db')
  .option('--count <n>', 'items to generate', '5')
  .option('--run <id>', 'run id', `run-${new Date().toISOString().slice(0, 10)}`)
  .action(async (o: { db: string; count: string; run: string }) => {
    const k = demoKernel({ dbPath: o.db, clock: systemClock });
    const report = await k.supervisor.start(o.run, [{ count: Number(o.count), prefix: 'demo' }]);
    console.log(JSON.stringify(report, null, 2));
    k.store.close();
  });

program
  .command('resume <runId>')
  .description('Continue a crashed run; finished steps are replayed, not re-run')
  .option('--db <path>', 'SQLite file', 'jobpilot.db')
  .action(async (runId: string, o: { db: string }) => {
    const k = demoKernel({ dbPath: o.db, clock: systemClock });
    console.log(JSON.stringify(await k.supervisor.resume(runId), null, 2));
    k.store.close();
  });

const audit = program.command('audit').description('Audit log tools');
audit
  .command('verify')
  .description('Walk the hash-chained event log')
  .option('--db <path>', 'SQLite file', 'jobpilot.db')
  .action((o: { db: string }) => {
    const store = Store.open(o.db);
    const r = verifyChain(store);
    console.log(r.ok ? `audit chain intact: ${r.events} events` : `audit chain BROKEN at event ${r.brokenAt}: ${r.reason}`);
    store.close();
    if (!r.ok) process.exitCode = 1;
  });

const contracts = program.command('contracts').description('Agent contract tools');
contracts
  .command('export')
  .description('Write every contract as JSON Schema into contracts-out/')
  .action(() => {
    for (const p of exportContracts(allAgents(), join(root, 'contracts-out'))) console.log(`wrote ${p}`);
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
    for (const spec of demoEvalSpecs(join(root, 'evals/datasets'))) {
      reports.push(await runEval(spec, { providers: { fetch: async () => ({ status: 404, text: async () => '' }) }, policy: PRODUCT_POLICY_V1 }));
    }
    for (const r of reports) console.log(`${r.pass ? 'PASS' : 'FAIL'} ${r.agentId}@${r.version} ${r.metric}=${r.score.toFixed(3)} (min ${r.min}, n=${r.n})`);
    const failed = failedGates(reports);
    if (failed.length > 0) process.exitCode = 1;
  });

await program.parseAsync();
