/**
 * Renders the fixture plan (fictional Asha Rao) with the real renderer into a fresh temp root and prints the six
 * files' sha256s as JSON. `tests/app/render.test.ts` runs it in two separate processes to prove the bytes do not
 * depend on the process (timezone, locale, module load order).
 */
import { commitPending, openPending } from '../../src/kernel/files.js';
import { renderer } from '../../src/app/agents/writing/renderer.js';
import { freezePack, issueContext } from '../../src/kernel/broker.js';
import { fixedClock } from '../../src/kernel/clock.js';
import { PRODUCT_POLICY_V1 } from '../../src/kernel/policy.js';
import { coverPlanOf, fullPack, posting, tempOut } from './render-fixtures.js';

const out = tempOut();
const key = 'd'.repeat(64);
const pack = fullPack({ contact: { ...fullPack().contact, name: 'Αθηνά Ράο', city: 'Pune ₹ 12 LPA' } });
const stage = openPending(out, key);
const ctx = issueContext({
  contract: renderer.contract,
  policy: PRODUCT_POLICY_V1,
  inputClass: 'P0',
  providers: { fetch: async () => ({ status: 404, text: async () => '' }), fileRoots: { out } },
  clock: fixedClock('2026-10-09T00:00:00Z'),
  signal: AbortSignal.timeout(60_000),
  pack: freezePack(pack),
  pendingFiles: stage,
});
const [r] = await renderer.run(coverPlanOf(posting({ company: 'Łódź Systems' }), pack), ctx);
await stage.markFinal();
await commitPending(out, key, PRODUCT_POLICY_V1.maxResponseBytes);
console.log(JSON.stringify(r!.files.map((f) => [f.path, f.sha256])));
