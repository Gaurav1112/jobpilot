# jobpilot Freelance Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.
>
> **Plan style note (same as the v1 plan).** Each task fixes files, interfaces, exact values and test cases; the
> implementer writes the code test-first (failing test → run → minimal code → run → commit). Read the spec; it is
> binding: `docs/superpowers/specs/2026-10-12-jobpilot-freelance-design.md` (incl. §4.6 validation, §13 decisions).

**Goal:** A separate, LLM-free, scheduled pipeline (`jobpilot-freelance@1.0.0`) that finds remote freelance contracts
and gigs open to India (≤ 20 h/week, ≥ $40/h), and prepares grounded screening documents for each: proposal, pitch +
contract CV, network application pack. It shows everything on the dashboard's `/freelance` tab.

**Architecture:** New agents under `src/app/freelance/`, built on the existing kernel. They reuse the v1 writing core
(`buildEvidence`, `planResume`, renderer, qa-gate checks, G-GROUND, G-NAMING) through gig-shaped adapters. Own wiring,
run ids `freelance-<IST date>-<am|pm>`, own app tables and launchd job; same `JOBPILOT_HOME`, DB and lock. Ranking,
dedupe and source health are pure functions in the projector, as in v1 (dedupe there is `dedupeKey` + projector
grouping), not per-envelope agents.

**Tech stack:** TypeScript on Node 24 (ESM, strict), zod 4.6.5, better-sqlite3, vitest, commander, hono, pdfkit,
docx, all already pinned. **No new dependencies.** Gmail and Upwork OAuth use `fetch` plus the macOS `security` CLI.

## Global Constraints

- Run scripts with `node --run <script>`, never `pnpm <script>` (Volta pnpm runs Node 20 here).
- Node ≥ 24. ESM imports end in `.js`. TypeScript strict. No `any` without a comment saying why.
- **No language-model call anywhere.** No contract declares `capabilities.llm`.
- Every agent is created with `defineContract` + `defineAgent`.
  - The description is ≥ 10 characters and contains no word "and".
  - One skill, one output type.
  - `kind` is `deterministic`, or `io` for fetchers.
- **The engine holds no personal data.** Tests use `tests/fixtures/pack/` (fictional "Asha Rao"); new freelance pack
  files are added there too. The real pack lives only in `~/.jobpilot/pack/`.
- **Forbidden-term rule (from v1, unchanged).** The user's client company name never appears in `src/`, `tests/`,
  `docs/` or any output. `tests/forbidden-terms.test.ts` enforces it, so every recorded fixture must pass it. Employer
  display = the pack's `naming.employerDisplay`.
- **Read-only everywhere. jobpilot never submits, bids, messages, applies or marks mail read.** No contract declares an
  `effect`.
- No scraping of any marketplace. No session-browse in this build. No evasion (no proxies, CAPTCHA solving or UA
  spoofing). The user-agent is honest: `jobpilot/0.1 (+local)`.
- LinkedIn, Indeed and Naukri are read only from the user's own alert emails.
- **A missing value stays missing** (`null` / `unknown` / `review`); nothing is estimated silently. A derived rate
  always carries its method label.
- Freelance rules (spec §5, §13), exact values:
  - `rateFloorUsdHour: 40`
  - `maxHoursPerWeek: 20`
  - `istWindow: "18:00-00:00"`
  - `derivedRateCountsForFloor: true`
  - `fixedBudgetFloorUsd: 500`
  - fit floor `60`
- Freelancer.com `hourly_project_info.commitment` is a default and is **ignored** (spec §4.6).
- Determinism:
  - no `Date.now()` or `Math.random()` in agents (use `ctx.clock`);
  - output order sorted by a stable key;
  - phrasing variants are picked by `parseInt(gigKey.slice(0, 8), 16) % variants.length`.
- `node --run verify` stays green after every task. The existing evals stay at 1.000, except the eligibility cases
  that Task 0 deliberately flips, which are listed there.
- Work on branch `freelance` (from `main` at `ad8585d` or later). Never push.
- Every commit message ends with the trailer: `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`
- Fixture candidates recorded live on 2026-10-12 are in
  `<scratchpad>/probe-out/raw/`.
  - Copy what a task needs into `tests/fixtures/freelance/<platform>/`, trimmed to ≤ 25 items per file.
  - Run the forbidden-terms test after copying.
  - If that directory is gone, re-record with `jobpilot sources probe --record` (Task 12) or by hand with `curl`.

## Deviations from the spec, decided here

- **Bounties are dropped** (spec §4.6 dropped GitHub labels and Algora). `Gig.kind` keeps `'bounty'` for later, but
  no source, planner or tab is built.
- **Ranking, dedupe and source health are pure functions in the projector** (as v1 ranks and dedupes). They are not
  per-envelope agents, because each needs every gig of the run at once. Their rules are the spec's, tested and
  eval'd the same way.
- Remotive is called once a day (am window) to respect its API notice.

## File map

| Path | Responsibility |
|---|---|
| `src/app/agents/eligibility.ts` (modify) | Task 0: full-time B2B contractor passes, with badge note |
| `src/app/freelance/types.ts` | `GigRequest@1`, `RawGig@1`, `Gig@1`, `RatedGig@1`, `GigVerdict@1`, `RiskedGig@1`, `ScoredGig@1`, `GigDocsPlan@1`, `GigRendered@1`, `GigQaReport@1`, predicates |
| `src/app/freelance/keys.ts` | `gigKey`, `gigDedupeKey` |
| `src/app/pack/freelance-schema.ts` | zod for `freelance.yaml`, `platform-rules.yaml`, `networks/*.yaml`; defaults |
| `src/app/freelance/networks.ts` | network application pack builder (Task 2) |
| `src/app/freelance/sources/*.ts` | `src-freelancer`, `src-remotive`, `src-hn`, `src-board-contracts` |
| `src/app/freelance/gig-normalizer.ts`, `rate.ts` | normalisation, rate method |
| `src/app/freelance/gig-eligibility.ts`, `gig-risk.ts`, `gig-scorer.ts`, `rank.ts` | evaluation |
| `src/app/freelance/writing/*.ts` | gig evidence adapter, proposal/pitch planners, phrase bank, gig qa |
| `src/app/freelance/pipeline.ts`, `run.ts`, `project.ts`, `health.ts` | wiring, run, projection, source health |
| `src/app/store/schema.ts` (modify) | additive migrations for gig tables |
| `src/app/web/freelance.ts` | `/freelance` routes |
| `src/app/due.ts` (modify), `src/app/schedule.ts` (modify) | per-pipeline due windows, the second launchd job |
| `src/app/secrets.ts` | macOS keychain wrapper |
| `src/app/freelance/mail/*.ts` | Gmail connect, `src-gig-mail`, per-sender parsers |
| `src/app/freelance/probe.ts` | `jobpilot sources probe` |
| `evals/datasets/gig-*.jsonl` | golden sets |

---

### Task 0: Daily eligibility accepts full-time B2B contractor roles (spec §13 D2)

**Files:**
- Modify: `src/app/agents/eligibility.ts` (`employmentReason`, header comment rule 4)
- Modify: `evals/datasets/eligibility.jsonl` (add cases; flip only the cases listed below)
- Modify: `src/app/web/format.ts` or wherever verdict notes become badges (find with
  `grep -n "NOTE_PAY_UNDISCLOSED\|notes" src/app/web/*.ts`), so the note shows as a badge
- Test: `tests/app/eligibility.test.ts`

**Interfaces:**
- Produces: `export const NOTE_B2B = 'B2B contractor: no PF/benefits';` and
  `export function fullTimeContract(p: Posting): boolean`.

**Rule (exact):** `employmentReason` currently returns `employment:contract` for a contract word in the title, a
structured `contract` type, or a contract phrase. When that would be the result **and the only canonical kind is
`contract`** (not `temporary`, `intern`, `part-time`, `hourly`, `freelance`, `contract-to-hire`, `c2h`), the
posting passes instead when `fullTimeContract(p)` is true. Every other rule then applies unchanged (remote, comp
floor). The verdict gains `NOTE_B2B` in `notes`.

`fullTimeContract(p)` is true when the title or the first 3,000 characters of the description match one of these
(case-insensitive), and none of the short-term patterns below match:
- `/\bcontract type:\s*b2b\b/`, `/\bb2b (?:contract|agreement|contractor)\b/`, `/\bfull[\s-]?time (?:contract|contractor|b2b)\b/`, `/\b(?:contract|contractor)[,\s]+full[\s-]?time\b/`, `/\blong[\s-]term (?:contract|contractor)\b/`
- or `p.comp !== null && p.comp.basis === 'base'` (an annual base salary is stated)

Short-term patterns (these keep the reject): `/\b\d{1,2}[\s-]?(?:months?|weeks?)\b[^.\n]{0,20}\bcontract\b/`, `/\bshort[\s-]term\b/`, `/\bpart[\s-]?time\b/`, `/\bper hour\b|\/\s?h(?:ou)?r\b|\bhourly\b/`.

- [ ] **Step 1: Write failing tests** in `tests/app/eligibility.test.ts` (`describe('D2 full-time B2B')`):
  - A Himalayas-shaped posting: title "Senior Bank & Integrations Engineer", `employmentType: 'Contractor'`,
    description containing "Base Salary: $100K–$175K USD … Contract type: B2B … available across all countries",
    comp `{min:100000,max:175000,currency:'USD',basis:'base'}`, remote structured, countries `['worldwide']` →
    `verdict: 'eligible'`, `notes` contains `NOTE_B2B`.
  - The same with "6-month contract" in the description → `rejected`, `['employment:contract']`.
  - Title "Java Developer (Contract)", no salary, no B2B wording → still `rejected`, `employment:contract`.
  - "Contract type: B2B" plus "hourly rate of $40" → `rejected` (`employment:hourly`, unchanged).
  - B2B full-time with countries `['united states']` and nothing remote-India → `rejected`, `location-outside-india`
    (the next rule now runs).
  - B2B full-time with base max below the floor → `rejected`, `below-floor:<n>`.
  - Contract-to-hire with B2B wording → `rejected`, `employment:contract-to-hire`.
- [ ] **Step 2:** `npx vitest run tests/app/eligibility.test.ts`. Expected: the new cases FAIL.
- [ ] **Step 3:** Implement. Add `NOTE_B2B` to `notes` in `decideEligibility` when the B2B pass was taken.
  `employmentReason` returns `{ reason: string | null; b2b: boolean }` internally; keep the exported `decideEligibility`
  signature.
- [ ] **Step 4:** Run the eval: `node --run jobpilot -- eval`.
  - For every eligibility case that now fails, read it. Flip its expected value only if it is a full-time B2B posting
    by the rule above.
  - List each flipped case id in the commit body.
  - Add the 7 Step 1 postings as golden cases (ids `d2-*`).
- [ ] **Step 5:** Dashboard: show `NOTE_B2B` as a badge on the job row and the job page (reuse the existing note
  rendering). Add a `tests/app/web.test.ts` case asserting the badge text.
- [ ] **Step 6:** `node --run verify` green. Then measure on the real catalogue without a run: a scratch script (in
  the session scratchpad, not the repo) imports `decideEligibility`, loads the user's pack, and re-decides the stored
  contract-rejected rows. It rebuilds each `Posting` from the `jobs` columns. Record "N of M now pass" in the commit
  body.
- [ ] **Step 7: Commit** `feat(eligibility): full-time B2B contractor roles pass with a badge (freelance spec D2)`

---

### Task 1: Freelance types, keys, pack files

**Files:**
- Create: `src/app/freelance/types.ts`, `src/app/freelance/keys.ts`, `src/app/pack/freelance-schema.ts`
- Modify: `src/app/pack/load.ts` (load the new files when present; absent → defaults below; the run pack hash
  covers them), `src/app/pack/defaults.ts`
- Create: `tests/fixtures/pack/freelance.yaml`, `tests/fixtures/pack/platform-rules.yaml`,
  `tests/fixtures/pack/networks/{toptal,arc,braintrust,contra,turing,lemon,gunio,flexiple}.yaml`
- Test: `tests/app/freelance/types.test.ts`, extend `tests/app/pack.test.ts`

**Interfaces (exact):**

```ts
// keys.ts
export function gigKey(platform: string, sourceId: string): string;      // jobKey(`gig:${platform}`, sourceId) from src/app/text/norm.ts
export function gigDedupeKey(client: string | null, title: string): string; // dedupeKey(client ?? '', title, '')

// types.ts — all .strict() zod objects via defineType
GigRequest@1   { platform: Platform, query: string, runDate: IsoDate, half: 'am'|'pm', item?: unknown }
               // item: only for platform 'boards' (one stored daily posting per seed, Task 4)
RawGig@1       { platform: Platform, sourceId: string, raw: unknown }
Gig@1          { gigKey, dedupeKey, platform, sourceId, url, title, description,
                 client: { name, country, paymentVerified, hireRate, spendUsd, reviews, since }  // each nullable
                 kind: 'contract'|'gig'|'bounty'|'network-alert',
                 budget: { type: 'hourly'|'fixed'|'monthly'|'unknown', min: number|null, max: number|null, currency: 'USD'|'INR'|'EUR'|'GBP'|'CAD'|'AUD'|null },
                 hoursPerWeek: { min: number|null, max: number|null, source: 'text'|null },
                 duration: { weeks: number|null, text: string|null },
                 timezone: { required: string|null, overlapText: string|null },
                 location: { countries: string[], worldwide: boolean, text: string|null },
                 skills: string[], postedAt: IsoDateTime|null, bids: number|null }
RatedGig@1     { gig: Gig, rate: { minUsdH: number|null, maxUsdH: number|null,
                 method: 'stated'|'fixed÷stated-hours'|'derived-from-duration'|'monthly÷hours'|'unknown',
                 fxDate: IsoDate|null, budgetUsd: number|null } }
GigVerdict@1   { rated: RatedGig, verdict: 'eligible'|'rejected'|'review', reasons: string[], notes: string[] }
RiskedGig@1    { verdict: GigVerdict, flags: { id: string, detail: string }[] }
ScoredGig@1    { risked: RiskedGig, fit: number, breakdown: Record<string, number>, list: 'contracts'|'gigs'|'review' }
type Platform = 'freelancer'|'remotive'|'hn-freelancer'|'hn-hiring'|'boards'|'gmail'|'upwork'|'reddit'
```

`freelance-schema.ts`:
- `FreelanceFile`: `rateFloorUsdHour`, `maxHoursPerWeek`, `istWindow` (`HH:MM-HH:MM`), `derivedRateCountsForFloor`,
  `fixedBudgetFloorUsd`, `fitFloor` (default 60), `kinds`, and `platforms: Record<Platform, { enabled: boolean,
  queries: string[] }>`.
  - Defaults are the Global Constraints values.
  - `freelancer.queries` default `['java','golang','typescript','node.js','react','aws','kafka','kubernetes','python','llm']`.
- `PlatformRules`: per platform `{ maxChars: number|null, hookChars: number|null, linksAllowed: boolean,
  attachmentsAllowed: boolean, minIntervalMs: number }`.
  - Defaults: freelancer `{maxChars: 1500, hookChars: 150, links false, attachments true, 2000}`;
    upwork `{5000, 220, true, true, 2000}`; plain email/pitch `{2500, null, true, true, 1500}`.
- `NetworkFile`: `{ id, name, url, kind: 'vetted-network', screening: { stage: string, prep: string[] }[],
  profileFields: { id: string, maxChars: number }[], targetTitles: string[], keywords: string[],
  checkedByUser: boolean }`.
  - Shipped starters carry `checkedByUser: false`, and the dashboard says "check before use".

- [ ] **Step 1:** Failing tests:
  - every type parses a minimal valid value and rejects an unknown key;
  - `gigKey('freelancer','40752583')` is 16 hex, stable, and differs from `jobKey('freelancer','40752583')`;
  - `loadPack` on the fixture pack exposes `freelance`, `platformRules`, `networks` (8);
  - a pack without the files loads defaults;
  - `rateFloorUsdHour: -1` refuses with a message naming the file and field.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement. The fixture networks hold fictional-safe, generic screening stages (e.g. Toptal:
  "language & personality", "timed algorithm test", "live coding", "test project"). Write each from the network's
  public "how vetting works" page and cite the URL in the file. If a page can't be read, write `screening: []` and
  leave `checkedByUser: false`.
- [ ] **Step 4:** Run, then `node --run verify`.
- [ ] **Step 5: Commit** `feat(freelance): gig types, keys, freelance pack files`

---

### Task 2: Network application packs (spec §7, build order 1)

**Files:**
- Create: `src/app/freelance/networks.ts`, `src/app/freelance/writing/gig-evidence.ts`
- Modify: `src/cli.ts` (`jobpilot networks list`, `jobpilot networks pack <id> [--all]`)
- Test: `tests/app/freelance/networks.test.ts`

**Interfaces:**
- `gig-evidence.ts`: `export function syntheticPosting(o: { key: string; title: string; company: string; text: string; firstSeen: string }): Posting`.
  - Builds a valid `Posting@1`: `ats: 'feed'`, `source: 'gig'`, `sourceId: key`, `jobKey: gigKey('synthetic', key)`,
    `remote.structured: 'remote'`, `countries: ['worldwide']`, `comp: null`, `yearsRequired: null`.
  - Plus `export function evidenceFor(posting: Posting, pack: WritingPack): Evidence`, which builds the `Scored`
    the way `buildEvidence` expects (score 100, breakdown `{}`) and returns `buildEvidence(scored, pack)`.
- `networks.ts`: `export function networkPack(net: NetworkFile, pack: WritingPack, asOf: string): NetworkPackResult`, where

```ts
interface NetworkPackResult {
  networkId: string;
  resume: ResumePlan;                       // planResume(evidenceFor(syntheticPosting({title: net.targetTitles[0], text: net.keywords.join(', ') …})))
  profile: { id: string; text: string; factIds: string[] }[]; // headline + summary + skills fields, each ≤ field.maxChars
  checklist: { stage: string; prep: string[]; evidence: string[] }[]; // evidence = fact ids whose tech matches the stage text
  problems: string[];                       // resumeProblems(resume, pack) from src/app/guardrails.ts — must be []
  missing: string[];                        // network keywords no fact backs
}
```

- Profile text is built only from `resume.headline`, `resume.summary.text` and `resume.skills` (already grounded),
  cut at whole sentences to `maxChars`. Never truncate mid-sentence; if the first sentence is too long, it is a
  problem.
- CLI writes `out/networks/<id>/{resume.pdf,resume.docx,profile.txt,checklist.md}` with the existing renderer modules
  (`src/app/render/pdf.ts`, `docx.ts`; reuse `modelText` for the text). It runs the same text-layer QA as the qa-gate:
  call the existing check functions the qa-gate uses (factor them out of `qa-gate.ts` into
  `src/app/agents/writing/qa-checks.ts` **without behaviour change**, proven by the existing qa-gate tests staying
  green).
- `checklist.md` starts with "Before your first gig: check your employment contract's moonlighting and IP clauses."
  and shows "Network file not yet checked by you: verify the stages at <url>" when `checkedByUser` is false.

- [ ] **Step 1:** Failing tests on the fixture pack:
  - `networkPack(toptal)` returns `problems: []`;
  - every profile field ≤ its `maxChars`;
  - every profile sentence is a substring of the resume headline, summary or skills line;
  - `missing` lists a keyword the fixture facts lack;
  - a forbidden term in `net.keywords` never reaches the output (G-NAMING via `resumeProblems`);
  - the CLI on a temp home writes the 4 files; `checklist.md` contains the moonlighting line;
  - deterministic: two runs give byte-identical `profile.txt` and `checklist.md`.
- [ ] **Step 2:** Run. FAIL.
- [ ] **Step 3:** Implement (factor `qa-checks.ts` first; run the qa-gate tests).
- [ ] **Step 4:** `node --run verify` green. Then run on the real pack:
  `node --run jobpilot -- networks pack --all`. Open `out/networks/toptal/resume.pdf` with `pdftotext` and check:
  0 forbidden-term hits (strict matcher), and the employer shown as `employerDisplay`.
- [ ] **Step 5: Commit** `feat(freelance): network application packs (CV, profile, vetting checklist) from verified facts`

---

### Task 3: Per-pipeline due windows

**Files:**
- Modify: `src/app/due.ts`, `src/app/run-command.ts`, `tests/app/due.test.ts`

**Interfaces:**
- `export interface DueSpec { pipeline: 'daily'|'freelance'; windows: readonly { fromIst: string; id: string }[]; attemptsFile: string; runPrefix: string }`
- `export const DAILY_DUE: DueSpec = { pipeline: 'daily', windows: [{ fromIst: '07:00', id: '' }], attemptsFile: 'daily-attempts.json', runPrefix: 'daily-' }`
- `export const FREELANCE_DUE: DueSpec = { pipeline: 'freelance', windows: [{ fromIst: '07:30', id: 'am' }, { fromIst: '19:30', id: 'pm' }], attemptsFile: 'freelance-attempts.json', runPrefix: 'freelance-' }`
- `dailyDue(home, now)` keeps working; it becomes `due(DAILY_DUE, home, now)`.
- `due(spec, home, now): Due & { window: string }`:
  - the current window is the latest one whose `fromIst` ≤ now (IST);
  - before the first window → not due;
  - a window is completed by a run `<prefix><date>` (daily) or `<prefix><date>-<window>` (freelance), any ordinal;
  - the attempts file is keyed by `date + window`, so the cap of 3 resets per window.

- [ ] **Step 1:** Failing tests:
  - freelance at 07:29 IST not due;
  - 07:30 due (window `am`);
  - after `freelance-2026-10-12-am` completed: 12:00 not due, 19:30 due (`pm`);
  - 3 failures in `am` → capped in `am` but `pm` due;
  - all existing daily tests pass unchanged.
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** `node --run verify`.
- [ ] **Step 5: Commit** `refactor(due): per-pipeline due windows; freelance owed at 07:30 and 19:30 IST`

---

### Task 4: Sources: Freelancer.com, Remotive, HN, board contracts

**Files:**
- Create: `src/app/freelance/sources/{common,freelancer,remotive,hn,board-contracts}.ts`
- Create fixtures: `tests/fixtures/freelance/freelancer/{java,golang,typescript}.json`, `remotive/software-dev.json`,
  `hn/{threads,freelancer-search,hiring}.json`
- Test: `tests/app/freelance/sources.test.ts`

**Contracts:**
- `gigSourceContract(id, host, description, timeoutMs)`, mirroring `sourceContract` in
  `src/app/agents/sources/common.ts`:
  - `kind: 'io'`, consumes `GigRequest@1`, produces `RawGig@1`, `egress: [host]`;
  - same retry; `skills: ['gig-sourcing']`, `team: 'sourcing'`.
- `src-board-contracts` is `kind: 'deterministic'`, no egress: it converts `GigRequest{platform:'boards', item}`.

**Behaviour (exact):**
- `src-freelancer` answers only `platform: 'freelancer'`.
  - One request per `query`:
    `https://www.freelancer.com/api/projects/0.1/projects/active/?query=<q>&limit=50&full_description=true&job_details=true&sort_field=time_updated`.
  - Emits one `RawGig` per project `id` (sourceId = `String(id)`), deduped across queries (first query wins), sorted by
    sourceId.
  - `raw` keeps: `title, description, preview_description, type, budget, currency{code,exchange_rate}, time_submitted,
    seo_url, jobs[].name, local, bid_stats, owner_id`. It drops `hourly_project_info.commitment` (default, ignored).
  - A response without `result.projects` → `invalid_output`.
- `src-remotive`: one request `https://remotive.com/api/remote-jobs?category=software-dev`, at most **2 calls per IST
  day** (the API notice asks for few calls).
  - Answers only the `am` half. In `pm` it returns `[]`, and the pm run reuses the am outputs through the projector.
  - Keeps jobs whose `job_type` is `contract`, `freelance` or `part_time`.
  - Attribution: the gig's `url` is the Remotive URL (the link back the notice requires).
- `src-hn`: platform `hn-freelancer` or `hn-hiring`.
  - Find the latest thread: `search_by_date?query=%22Seeking%20freelancer%22&tags=story` (freelancer), or
    `search_by_date?tags=story,author_whoishiring` with title `/^Ask HN: Who is hiring\?/` (hiring).
  - Only a thread created within 45 days counts; none → `[]` plus a `ctx.skipped` note "no thread in 45 days".
  - Read `items/<id>`.
  - Freelancer mode keeps top-level comments whose text starts with `SEEKING FREELANCER`.
  - Hiring mode keeps comments whose first 300 characters say `REMOTE` and one of contract / part-time / freelance.
  - sourceId = comment id.
- `src-board-contracts`: `GigRequest.item` is a stored daily `Posting@1` (validated). It emits a `RawGig` with
  `platform: 'boards'`, `sourceId: posting.jobKey`, `raw: posting`.
  - The freelance run (Task 9) seeds one request per stored daily job whose reasons include `employment:contract`,
    `employment:freelance` or `employment:part-time`, read through `AppStore` (app layer, not the agent).

- [ ] **Step 1:** Failing tests, offline against the fixtures through `offlineProviders`
  (`src/app/offline.ts`, URL → file index):
  - counts and sorted ids;
  - cross-query dedupe;
  - commitment dropped;
  - malformed body → `invalid_output`;
  - Remotive pm → `[]`;
  - HN thread older than 45 days → `[]` + note;
  - board item that is not a Posting → `invalid_output`.
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** `node --run verify` (contracts export updated:
  `node --run contracts:export`, then commit `contracts-out/`).
- [ ] **Step 5: Commit** `feat(freelance): Freelancer.com, Remotive, HN and board-contract sources`

---

### Task 5: gig-normalizer + rate-normalizer

**Files:**
- Create: `src/app/freelance/gig-normalizer.ts`, `src/app/freelance/rate.ts`
- Create: `evals/datasets/gig-normalizer.jsonl` (≥ 30), `evals/datasets/gig-rate.jsonl` (≥ 30)
- Modify: `src/app/evals.ts` (register both)
- Test: `tests/app/freelance/normalize.test.ts`

**Rules:**
- The normalizer maps each platform's `raw` to `Gig@1`.
  - Every field is copied or `null`; nothing inferred. `description` is HTML-stripped and whitespace-collapsed
    (reuse `src/app/text/norm.ts` helpers).
  - Freelancer: `kind` hourly → `contract`, fixed → `gig`. `budget` from `budget.minimum/maximum` + currency code.
    `location.worldwide = !raw.local`. `bids = bid_stats.bid_count ?? null`. `skills = jobs[].name`.
  - Hours come from text only: `/\b(\d{1,2})(?:\s?-\s?(\d{1,2}))?\s?(?:h|hrs|hours)\s?(?:\/|per|a)\s?(?:week|wk)\b/i`
    → min/max, `source: 'text'`. "part-time" alone → `{min:null,max:null,source:null}`.
  - HN: `title` = first line (≤ 120 chars), `kind: 'contract'`, `budget.type: 'unknown'` unless the text states pay
    (same hourly regex as the rate rules).
  - Boards: from `Posting@1`. `kind: 'contract'`; `budget.type: 'unknown'` (an annual salary is not a freelance
    budget); the annual comp is kept in the description-derived fields only for display.
- `rate.ts`, `export function rateOf(gig: Gig, fx: Fx, maxHoursPerWeek: number): RatedGig['rate']`, the exact table:
  - `hourly` with min/max → `stated`.
  - `fixed`:
    - with `hoursPerWeek.max` and `duration.weeks` → budget ÷ (hours × weeks), `fixed÷stated-hours`;
    - with a total-hours phrase in the description (`/~?\s?(\d{2,4})\s?(?:hours|hrs)\b(?!\s?(?:\/|per|a)\s?week)/i`)
      → budget ÷ hours, `fixed÷stated-hours`;
    - with `duration.weeks` only → budget ÷ (weeks × maxHoursPerWeek), `derived-from-duration`;
    - else `unknown` (`budgetUsd` still set).
  - `monthly` with stated hours/week → monthly ÷ (hours × 4.33), `monthly÷hours`; else `unknown`.
  - Annual (boards) → `unknown`. A full-time salary is not a freelance rate.
  - FX: the pack `fx.toINR` table (USD per unit = `toINR[c]/toINR.USD`). CAD/AUD absent from the table → use the
    platform's own `exchange_rate` when present, else `unknown`. `fxDate = fx.asOf`.
  - Round to 2 decimals, half-up.
- Eval cases cover every row, each currency, the Freelancer INR 750–1250 hourly case (≈ $7.84–13.06/h with the
  fixture fx), missing fields, and garbage numbers (negative, zero, min > max → `unknown`).

- [ ] **Step 1:** Failing unit tests + the two datasets. **Step 2:** FAIL. **Step 3:** implement. **Step 4:**
  `node --run verify` (both evals at 1.000).
- [ ] **Step 5: Commit** `feat(freelance): gig normalizer and rate method (stated, derived, unknown)`

---

### Task 6: gig-eligibility + gig-risk

**Files:**
- Create: `src/app/freelance/gig-eligibility.ts`, `src/app/freelance/gig-risk.ts`
- Create: `evals/datasets/gig-eligibility.jsonl` (≥ 40), `evals/datasets/gig-risk.jsonl` (≥ 30); register in `src/app/evals.ts`
- Test: `tests/app/freelance/evaluate.test.ts`

**gig-eligibility rules, in order; the first reject wins; reasons named exactly:**
1. `closed`: blank title or url.
2. `role:<p>` / `company:<n>`: v1 `filters.roleDeny` / `companyDeny` (reuse `compileSafePattern`, `hasTerm`).
3. `naming`: client name or description names a `naming.forbiddenTerms` term (strict matcher
   `forbiddenTermStrict`).
4. `location-outside-india`:
   - `location.countries` non-empty and none of india/apac/asia/south asia/worldwide, and not `worldwide`;
   - `location.text` matching `/\b(?:us|usa|u\.s\.|united states|canada|uk|eu|europe|emea|latam)\s*only\b/i`.
   - Nothing stated → note `location not stated - verify` and verdict `review` (continue).
5. `hours-over-cap`: `hoursPerWeek.min > maxHoursPerWeek`, or text `/\bfull[\s-]?time\b|\b(?:35|40)\+?\s?(?:h|hrs|hours)\b|\bdedicated\b/i`
   for kind `contract`. Unknown hours on a `contract` → `review` + note `hours not stated - verify`.
6. `overlap-outside-ist-window`: a required window in the text (`/\b(?:online|available|working)\b[^.]{0,30}\b(\d{1,2})(?::\d{2})?\s?(am|pm)?\s?[-–to]+\s?(\d{1,2})(?::\d{2})?\s?(am|pm)?\s?(EST|EDT|ET|PST|PDT|PT|CST|CET|CEST|GMT|UTC|BST)\b/i`)
   converted to IST shares less than 2 hours with `istWindow`. "async", "flexible" or "some overlap" in the same
   sentence voids it.
   - Fixed offsets: EST −5, EDT −4, ET −4, CST −6, PST −8, PDT −7, PT −7, CET +1, CEST +2, GMT/UTC 0, BST +1.
7. `exclusive`: `/\b(?:must not|cannot|can't|no) (?:work|hold|have) (?:other|any other|another) (?:jobs?|employment|clients?)\b|\bexclusiv(?:e|ity)\b/i`.
8. `budget-below-floor`: kind `gig`, rate `unknown`, `budgetUsd !== null && budgetUsd < fixedBudgetFloorUsd`.
9. `rate-below-floor:<maxUsdH>`: `maxUsdH < rateFloorUsdHour`. A `derived-from-duration` rate counts when
   `derivedRateCountsForFloor`.
   - Rate `unknown` → `review` + note `rate unknown - verify`.

**gig-risk flags (ids exact; flags never reject):**
- `payment-unverified`: Freelancer `raw.owner` payment flag false, where present.
- `off-platform`: `/\b(?:whats\s?app|telegram|skype|signal|gmail\.com|outside (?:the )?platform)\b/i`.
- `unusual-payment`: `/\b(?:crypto|usdt|bitcoin|gift ?cards?|western union)\b/i`.
- `upfront-fee`: `/\b(?:registration|joining|security) fee\b|\bpay (?:us|a fee) (?:first|upfront)\b/i`.
- `unpaid-test`: `/\b(?:unpaid|free) (?:test|trial|sample)\b/i`, or a test task estimated > 2 h.
- `thin-brief`: no client history (all client fields null or `reviews === 0`) and description < 300 chars.
- `duplicate-text`: the projector sets this one (same description, different client, same run; Task 9).
  The agent never computes it.

- [ ] **Step 1:** Failing tests + datasets. Include:
  - "online 9–5 EST" → `overlap-outside-ist-window`;
  - "async, some overlap with EST" → passes;
  - a $300 fixed gig with no hours → `budget-below-floor`;
  - a GBP 36/h hourly gig → its USD rate from `tests/fixtures/pack/fx.yaml`, computed by hand in the case comment,
    which decides pass vs `rate-below-floor:<value>`;
  - a 25 h/week contract → `hours-over-cap`.
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** `node --run verify`.
- [ ] **Step 5: Commit** `feat(freelance): gig eligibility (location, hours, IST overlap, exclusivity, floors) and risk flags`

---

### Task 7: gig-scorer + ranking

**Files:**
- Create: `src/app/freelance/gig-scorer.ts`, `src/app/freelance/rank.ts`
- Create: `evals/datasets/gig-scorer.jsonl` (≥ 30); register
- Test: `tests/app/freelance/score.test.ts`

**Rules:**
- `fit` = the v1 lexicon formula: call the scorer's pure scoring function from `src/app/agents/scorer-lexicon.ts`
  (export it if it is not exported, no behaviour change) on `title + description + skills.join(', ')`.
- `breakdown` adds:
  - `client`: +5 payment verified, +5 hireRate ≥ 0.5, +5 spend ≥ 10,000 USD, +5 reviews ≥ 5; 0 when unknown;
    cap 20, shown separately and **not** added to fit.
  - `fresh`: hours since `postedAt` (or since firstSeen).
  - `bids`.
- `list`:
  - `contracts` when kind `contract` and verdict `eligible`;
  - `gigs` when kind `gig` and `eligible`;
  - `review` when verdict `review`;
  - rejected gigs end at eligibility (the scorer returns `[]`, as v1).
- `rankGigs(rows)` (pure, used by the projector and the dashboard) orders within each list by:
  1. no `off-platform` / `unusual-payment` / `upfront-fee` flag first;
  2. `maxUsdH` desc (null last);
  3. fit desc;
  4. postedAt desc;
  5. gigKey asc.

  Rows with fit < `fitFloor` are excluded from `contracts` and `gigs` but kept in `review`.

- [ ] **Step 1:** Failing tests + dataset, including a rank test with ties broken by gigKey and a red-flag gig never
  first. **Steps 2–4** as before.
- [ ] **Step 5: Commit** `feat(freelance): gig scorer and deterministic ranking`

---

### Task 8: Writing: proposal, pitch, contract CV, gig QA

**Files:**
- Create: `src/app/freelance/writing/{phrases,proposal-planner,pitch-planner,gig-qa,gig-renderer}.ts`
- Modify: `src/app/guardrails.ts` (`G_GROUND` and `G_NAMING` accept `GigDocsPlan@1`; add `gigDocsProblems`)
- Create: `evals/datasets/gig-grounding.jsonl` (≥ 20 gigs from fixtures through the whole writing chain, expected
  `{pass:true}`); register
- Test: `tests/app/freelance/writing.test.ts`

**Types (add to `types.ts`):**

```ts
GigDocsPlan@1 { gigKey, scored: ScoredGig, platform,
  proposal: { hook: { text, quote }, evidence: { text, factIds }[], plan: string[], availability: string, question: string } | null,  // gigs
  pitch: { lines: { text, factIds }[] } | null,                                                                        // contracts
  resume: ResumePlan,                    // planResume(evidenceFor(syntheticPosting(gig)))
  covered: string[], missing: string[] }
GigRendered@1 { gigKey, files: RenderedFile[],   // export RenderedFile from src/app/types.ts (today it is module-private) text: { proposal: string|null, pitch: string|null, resume: string } }
GigQaReport@1 { gigKey, ok, checks: { id, ok, detail }[], files }
```

**Rules:**
- The hook quotes the client verbatim: the first sentence of the description (≤ 140 chars) that contains a matched
  skill term. `hook.text` = `phrases.hook[variant]` with `{quote}`; `hook.quote` must be a substring of
  `gig.description` (G-GROUND checks it). No such sentence → the hook omits the quote (variant "plain").
- Evidence lines: the top 2–3 facts from `resume.roles[].bullets` whose terms intersect the gig's covered terms,
  rendered verbatim with `phrases.evidenceLead[variant]` ("Relevant: " is banned; leads like "Recently, " or
  "At {employerDisplay}, "). `factIds` required.
- Plan steps: from a fixed step library keyed by the gig's top matched term group (`phrases.planSteps[group]`, 3
  steps each, plus a `default`). No gig-specific claims are invented.
- Availability: `"I can give this {maxHoursPerWeek} hours a week, mostly {istWindow} IST, with updates every {cadence}."`
  `cadence` comes from `answers.yaml` `updateCadence` (default "two days").
- Question: `phrases.question[variant]` with `{term}` = the first `missing` term if any ("Is {term} essential, or
  nice to have?"), else a scope question.
- `phrases.ts` holds ≥ 3 variants per slot. Variant = `parseInt(gigKey.slice(0, 8), 16) % n`.
- Pitch (contracts): 5 lines (hook, 2 evidence, availability, question), same sources.
- gig-qa checks (ids exact):
  - `gig.limits`: proposal text ≤ `platformRules[platform].maxChars`; hook ≤ `hookChars`.
    Over the limit **fails**; never truncate.
  - `gig.links`: no URL when `linksAllowed` false.
  - `gig.banned`: none of `/^Relevant work:/m`, `/I am writing to express/i`, `/to whom it may concern/i`, a line
    that is only a comma-separated term list.
  - `gig.repeat`: no two proposals of one run share their first 60 characters (checked in the projector, which
    flags them `repeat`).
  - `gig.ground`: `gigDocsProblems(plan, pack)` is `[]`.
  - `gig.naming`: strict forbidden-term scan of every rendered byte (PDF/DOCX text layer + `.txt`).
- Renderer: `proposal.txt`/`pitch.txt` (UTF-8, LF) + `resume.pdf`/`resume.docx` (existing renderer modules).
  Fixed metadata dates = gig firstSeen.

- [ ] **Step 1:** Failing tests:
  - a Freelancer fixture gig → proposal within 1500 chars;
  - the hook quote is a substring of the description;
  - every evidence line carries fact ids;
  - a missing term appears in the question;
  - variant stable for one gigKey and different across two gigKeys with different `% n`;
  - over-limit → `gig.limits` fails (not truncated);
  - a banned opening → `gig.banned` fails;
  - a forbidden term planted in a fixture fact's employer → output shows `employerDisplay`, scan 0 hits.
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** `node --run verify` (gig-grounding 1.000).
- [ ] **Step 5: Commit** `feat(freelance): grounded proposals, pitches and contract CVs with platform limits`

---

### Task 9: Wiring, run, projection, source health, notification

**Files:**
- Create: `src/app/freelance/{pipeline,run,project,health}.ts`
- Modify: `src/app/store/schema.ts` (append migrations), `src/app/store/app-store.ts` (gig methods),
  `src/app/allow-list.ts` (gig renderer = files capability), `src/exported-agents.ts`, `src/cli.ts`
  (`jobpilot run-freelance [--if-due] [--offline-fixtures <dir>] [--no-notify]`)
- Create: `tests/fixtures/freelance-e2e/index.json` (+ files)
- Test: `tests/app/freelance/e2e.test.ts`, `tests/app/freelance/project.test.ts`

**Wiring (`FREELANCE_PIPELINE = { id: 'jobpilot-freelance', version: '1.0.0' }`):**

```
GigRequest@1 ─► src-freelancer | src-remotive | src-hn | src-board-contracts ─► RawGig@1 ─► gig-normalizer ─► Gig@1
─► rate-normalizer ─► RatedGig@1 ─► gig-eligibility ─► GigVerdict@1 ─► gig-risk ─► RiskedGig@1 ─► gig-scorer
─► ScoredGig@1 ─► proposal-planner ─► GigDocsPlan@1 ─► gig-renderer ─► GigRendered@1 ─► gig-qa ─► GigQaReport@1
```
- Writing runs only for `contracts` / `gigs` rows with fit ≥ `fitFloor`, and for `review` rows with fit ≥
  `fitFloor` (the user decides).
- Teams: sourcing, understanding, evaluation, writing (same breaker rule as `dailyPipeline`).

**Run:** `runFreelance(o)` mirrors `runDaily` (`src/app/run.ts`):
- same lock (`withLock(home, 'run-freelance', …)`), pack load, kernel;
- run id `freelance-<date>-<half>` via `pickRunId`;
- seeds:
  - per enabled platform: freelancer one request per query; remotive one; hn two;
  - plus one `boards` request per stored daily contract job (Task 4), each with `runDate` and `half`.
- `--if-due` uses `due(FREELANCE_DUE, …)` (Task 3).
- `onLocked` / attempts are the same as `runCommand`. Factor the shared part of `runCommand` into
  `runWithDue(spec, run)` without behaviour change for daily.

**Tables (one additive migration, append to `APP_MIGRATIONS`):**
- `gigs` (`gig_key` PK, `dedupe_key`, `duplicate_of`, `platform`, `url`, `title`, `client` JSON, `kind`, `budget` JSON,
  `rate` JSON, `hours` JSON, `verdict`, `reasons` JSON, `notes` JSON, `flags` JSON, `fit`, `breakdown` JSON, `list`,
  `docs_state`, `docs_detail`, `posted_at`, `first_seen`, `last_seen`, `status` default `new`, `note`, `applied_at`,
  `notified_at`)
- `gig_docs` (`gig_key`, `kind` proposal|pitch|resume, `format` txt|pdf|docx, `path`, `sha256`)
- `gig_status_history`
- `gig_runs_summary` (same shape as `runs_summary`)
- `source_health` (`platform`, `week` YYYY-Www, `fetched`, `eligible`, `above_floor`, `shortlisted`, `applied`,
  `replied`, `won`, `failed_runs`, `probe_failures`; PK platform + week)
- `gig_snapshots` (applied copies, same rules as `job_snapshots`)
- `network_status` (`network_id` PK, `status` todo|applied|screening|passed|rejected, `updated_at`)

**Projection:**
- Upsert gigs by `gig_key`.
- `duplicate_of` = the earliest-first-seen gig with the same `dedupe_key` (v1 rule).
- `duplicate-text` flag: same normalised description, different client, same run.
- `repeat` QA flag (Task 8).
- `source_health` incremented per run; `failed_runs` per source failure.
- A source with 0 yield 4 weeks running, or `probe_failures` ≥ 3 in a row, → a run problem "source <id> looks dead".

**Notification** (once per newly shortlisted gig, `notified_at`, as v1):
`"<N> new gigs ≥$40/h · top: $<maxUsdH>/h <title ≤ 40> (<Platform>)"`. The top is the first `rankGigs` row of
`contracts ∪ gigs` with no red flag; none → `"No new gigs this <morning|evening>"`. Problems are appended as in v1.

- [ ] **Step 1:** Failing e2e: an offline fixture run (`--offline-fixtures tests/fixtures/freelance-e2e`) →
  - rows in all three lists;
  - documents on disk for shortlisted rows;
  - 0 forbidden-term hits in every file;
  - a second same-half run replays at $0 (all steps `replayed` except sources' fresh fetch rule, as daily);
  - the notification text exact;
  - `source_health` rows for the week.

  Projection unit tests: dedupe, duplicate-text, dead-source problem.
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** `node --run verify`.
- [ ] **Step 5: Commit** `feat(freelance): pipeline, run, projection, source health and notification`

---

### Task 10: Dashboard `/freelance`

**Files:**
- Create: `src/app/web/freelance.ts` (routes mounted by `src/app/web/server.ts`)
- Modify: the dashboard nav (add "Freelance"), `src/app/web/copy.ts` (copy-to-clipboard button reused)
- Test: `tests/app/web-freelance.test.ts`

**Routes:**
- `GET /freelance?tab=contracts|gigs|review|networks|sources` (default contracts).
  - A row shows: rate + method label ("$50/h stated", "$75/h derived from 2 weeks × 20 h"), hours, IST overlap
    note, fit + breakdown tooltip, risk flags (red for off-platform / unusual-payment / upfront-fee), client
    signals, age + bids, the source link (opens the original), and coverage "covered n/m, missing: …".
- `GET /freelance/:key` detail: the proposal or pitch in a `<pre>` with a copy button, files (`.txt`, PDF, DOCX),
  fact provenance on hover (reuse the v1 `data-fact` mechanism).
- `POST /freelance/:key/status`: new → shortlisted → applied (snapshot, as v1 `job_snapshots`) → replied →
  interviewing → won | lost | skipped. History is logged.
- `GET /freelance/networks`: one card per network with status, the pack files, the checklist, and "check before use"
  when `checkedByUser` is false. `POST /freelance/networks/:id/status`.
- `GET /freelance/sources`: the `source_health` table per platform (last 8 weeks), disabled sources and why
  (Upwork: key pending; Reddit: OAuth app needed; Gmail: not connected).
- Security: same as v1 (`src/app/web/security.ts`: 127.0.0.1, CSRF token on POST, no external assets).

- [ ] **Step 1:** Failing tests: each tab renders the fixture rows; red-flag styling; the method label text exact;
  status transitions + snapshot; CSRF refusal; no `http(s)://` asset references in the HTML except gig source links.
- [ ] **Steps 2–4.** **Step 5: Commit** `feat(web): freelance tab with contracts, gigs, review, networks and sources`

---

### Task 11: Schedule `com.jobpilot.freelance`

**Files:**
- Modify: `src/app/schedule.ts` (`FREELANCE_LABEL = 'com.jobpilot.freelance'`, `plistFreelance(o)` = `run-freelance --if-due`,
  same `StartCalendarInterval` `[{Minute:0},{Minute:30}]` + `RunAtLoad`, log `freelance.log`; install / uninstall /
  status cover 3 jobs), `src/cli.ts` (status prints today's freelance window state), `tests/app/schedule.test.ts`
- [ ] **Step 1:** Failing tests: plist keys exact (`plutil -lint`); install bootstraps 3 jobs in order daily, freelance,
  dashboard; status shows 3; the lock is shared, so a freelance start while daily runs prints
  `not due: a jobpilot run is running (pid N)`.
- [ ] **Steps 2–4.** **Step 5: Commit** `feat(schedule): freelance job twice daily with sleep catch-up`

---

### Task 12: `jobpilot sources probe`

**Files:**
- Create: `src/app/freelance/probe.ts`; modify `src/cli.ts`
- Test: `tests/app/freelance/probe.test.ts` (offline fixtures only; the live probe never runs in verify)

**Behaviour:** ports the 2026-10-12 scratch probe
(`…/scratchpad/platform-probe.ts`; the formula is in spec §4.6) onto the real agents for kept sources. It keeps
lightweight readers for the parked ones (RemoteOK `https://remoteok.com/api`, WWR category RSS, Working Nomads
`/api/exposed_jobs/`, Golang Projects RSS, Arbeitnow DE/UK).
- Output: the same table columns as §4.6, plus `--json`.
- `--record <dir>` saves raw responses as fixtures.
- Each probe failure increments `source_health.probe_failures` for the current week.
- A parked source whose relevant count is ≥ 5 for 2 consecutive monthly probes is reported as "promote: add an
  adapter". Promotion itself is a code change, never automatic.

- [ ] **Step 1:** Failing tests: score formula exact on synthetic rows; the hours rule excludes full-time; GitHub/Algora
  absent (dropped by spec); `--record` writes files. **Steps 2–4.**
- [ ] **Step 5: Commit** `feat(freelance): sources probe with the validation score`

---

### Task 13: Secrets + Gmail connect + `src-gig-mail` (channel C)

**Prerequisite (user action, the plan pauses here and asks):**
- The user creates a Google Cloud project with the Gmail API enabled and an OAuth client of type **Desktop app**, then
  gives the client id and secret to `jobpilot gmail connect`.
- The user creates Gmail filters that apply the label `jobpilot/gigs` to alerts from the 21 channel-C senders.
- The user forwards **one real alert email per sender** as fixtures. Saving the raw message as
  `.eml` is enough; the implementer redacts the user's own name, email and phone to the fixture pack's.

**Files:**
- Create: `src/app/secrets.ts`:
  - `getSecret(name)`, `setSecret(name, value)`, `deleteSecret(name)`, via
    `/usr/bin/security {find,add,delete}-generic-password -s jobpilot -a <name> [-w]`;
  - injectable runner for tests, like `schedule.ts`.
- Create: `src/app/freelance/mail/{oauth,gmail,parsers/index}.ts` and one `parsers/<sender>.ts` per sender **that
  has a real fixture**.
- Modify: `src/cli.ts` (`jobpilot gmail connect|status|disconnect`)
- Test: `tests/app/freelance/mail.test.ts`

**Behaviour:**
- OAuth installed-app flow with PKCE and a loopback redirect (`http://127.0.0.1:<random port>/cb`).
  - Scope `https://www.googleapis.com/auth/gmail.readonly` only.
  - The refresh token is stored with `setSecret('gmail.refresh')`.
  - Egress: `oauth2.googleapis.com`, `gmail.googleapis.com`, `accounts.google.com` (browser only).
- `src-gig-mail` (`io`, platform `gmail`):
  - lists messages `q=label:jobpilot/gigs newer_than:3d`, then fetches each `format=raw`;
  - never modifies;
  - sourceId = Gmail message id.
- Parser selection by `From` address **and** a layout fingerprint (a stable heading or footer string from the
  fixture).
  - Unknown sender or fingerprint → `ctx.skipped` note `unrecognised alert: <sender> "<redacted subject>"`, listed as a
    run problem. Never partially parsed.
  - Each parser emits one `RawGig` per job in the email, with the job's original URL.
- Senders without a fixture get **no parser** in this task. They are listed on `/freelance/sources` as "send one
  alert email to enable".

- [ ] **Step 1:** Failing tests:
  - secrets via a fake runner;
  - the OAuth URL has `gmail.readonly` only and PKCE S256;
  - the token is never written to disk or logs (grep the temp home);
  - each fixture parses to its expected `RawGig`s;
  - an altered fingerprint → skipped + problem;
  - no Gmail write endpoint (modify, trash, send) appears in `src/` (a test greps).
- [ ] **Steps 2–4.** **Step 5: Commit** `feat(freelance): read-only Gmail alert ingest with per-sender parsers`

---

### Task 14: Upwork and Reddit adapters (gated on user keys)

**Prerequisite (user action):**
- **Upwork:** an approved API key with "Read marketplace Job Postings – Public".
- **Reddit:** a personal "script" app (client id/secret).

Until then, this task is skipped and recorded as blocked in `.superpowers/sdd/progress.md`.

**Files:** `src/app/freelance/sources/{upwork,reddit}.ts`, `src/cli.ts` (`jobpilot upwork connect`, `jobpilot reddit connect`), tests with fixtures recorded from the user's first authorised call.
- Upwork: GraphQL `marketplaceJobPostingsSearch` at `https://api.upwork.com/graphql`, OAuth 2 tokens in the keychain.
  It reads budget, hourly range, client payment verification, hire rate, total spent, and country.
- Reddit: `https://oauth.reddit.com/r/{forhire,freelance_forhire,remotejs}/new?limit=100` with a bearer token. It
  keeps only `[Hiring]` titles or `Hiring` flair.
- [ ] Steps as Task 4 (fixtures, failing tests, implement, verify, commit
  `feat(freelance): Upwork and Reddit sources behind user keys`).

---

### Task 15: Live run, probe review, merge

- [ ] **Step 1:** `node --run jobpilot -- sources probe` (live). Compare with spec §4.6; record the table in
  `.superpowers/sdd/progress.md`.
- [ ] **Step 2:** `node --run jobpilot -- run-freelance --no-notify` against the real pack. Then check:
  - 0 forbidden-term hits across `out/` (strict matcher over every `.txt` and the PDF/DOCX text layers);
  - every shortlisted row has documents;
  - every rate shows its method.
- [ ] **Step 3:** Dispatch a whole-branch reviewer (opus) **with probe scripts against the real modules and the
  real corpus** (the v1 lesson: diff-only reviews miss the real bugs). Fix waves, then re-review the fix waves against
  the corpus.
- [ ] **Step 4:** `node --run jobpilot -- schedule install` (3 jobs), then `schedule status`.
- [ ] **Step 5:** Merge `freelance` → `main` (fast-forward if possible). Never push.
