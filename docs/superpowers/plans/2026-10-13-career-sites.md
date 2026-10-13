# jobpilot Career Sites Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.
>
> **Plan style (same as the v1 and freelance plans):** each task fixes files, interfaces, exact values and test
> cases; the implementer writes the code test-first (failing test → run → minimal code → run → commit). The spec is
> binding: `docs/superpowers/specs/2026-10-13-jobpilot-career-sites-design.md`.

**Goal:** deterministic coverage of company-run career websites. A weekly coverage run discovers companies, locates
their careers site, detects the platform, verifies the board and fills a company registry; the daily run reads every
verified company through one adapter per platform.

**Architecture:** a new wiring `jobpilot-coverage@1.0.0` (run ids `coverage-<IST date>`) writes the `companies`
registry. The daily wiring gains per-platform source agents, seeded from the registry plus the watchlist, whose
`RawPosting@1` outputs flow through the existing normalizer → eligibility → scorer → writing → projector. Hosts are
resolved per run through symbolic egress sets, exactly like `pack:careers-hosts` in `src/app/agents/sources/careers.ts`.

**Tech stack:** TypeScript on Node 24 (ESM, strict), zod 4.6.5, better-sqlite3, vitest, commander, hono, all already
pinned. **No new dependencies.**

## Global Constraints

- **Work only in the git worktree `~/PersonalProject/jobpilot-career` (branch `career-sites`).** The live checkout
  `~/PersonalProject/jobpilot` stays on `main` (launchd runs it); never check out a branch there. `node_modules` is
  symlinked from the live checkout; never write into it.
- **The repo is PUBLIC on GitHub.** No personal data in `src/`, `tests/`, `docs/` or commit messages: no user name,
  contact details, employer, offer, salary floor or city stated as the user's. Tests use the fictional fixture pack
  (`tests/fixtures/pack`, "Asha Rao", Pune). Never push; the controller pushes `main` after a privacy scan.
- Run scripts with `node --run <script>`, never `pnpm <script>`. Node ≥ 24. ESM imports end in `.js`.
- **No language-model call anywhere.** Every agent is `deterministic` or `io` (fetchers and file writers).
- Every agent uses `defineContract` + `defineAgent`; description ≥ 10 characters with no word "and"; one skill,
  one output type.
- **Politeness:**
  - honest UA `jobpilot/0.1 (+local)`;
  - ≥ 2000 ms between requests to one host;
  - robots.txt honoured for every host before the first request (cache per run);
  - a per-company daily request budget (default 40);
  - a robots disallow, 401/403/429, or a challenge page (Cloudflare "Just a moment", `cf-chl`) → that host is
    disabled for the run with a named problem, and never retried around.
  - No proxies, no CAPTCHA solving, no UA spoofing, no login or session.
- **SmartRecruiters:** never call `api.smartrecruiters.com` (robots disallows it; spec D3). Read only
  `jobs.smartrecruiters.com` job pages and their JSON-LD.
- **Determinism:**
  - no `Date.now()` or `Math.random()` in agents;
  - output sorted by a stable key;
  - paged sources never truncate silently: a cap throws `invalid_output` naming the source and count;
  - a relative or absent posted date → `postedAt: null` (never computed from the clock).
- **Uncertain → Proposed / review, never a guess:**
  - a company is auto-verified only when every check passes (spec D2);
  - name matching is exact after the fixed normalisation (spec §3).
- **Daily regression:** with an empty registry the daily pipeline is byte-identical to `main` (step keys, rows,
  document hashes). Prove it in every task that touches the daily wiring.
- `node --run verify` stays green after every task; existing evals stay at 1.000.
- **The product must run without Claude Code, ever (user, 2026-10-13).**
  - jobpilot makes **no AI call at runtime**, and every agent is deterministic code.
  - Every operation is a `jobpilot` CLI command or a launchd job: setup, runs, schedule, connect, add company,
    backups, rollback.
  - Nothing may depend on Claude Code, its skills, subagents, `.superpowers/` files or this session.
  - The kernel's vendor-neutral `LlmProvider` stays unused, so any LLM (local or other vendor) could be added later
    as an optional extra, never a dependency.
- Every commit message ends with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- Live data only through temp homes with a copy of `~/.jobpilot/pack`; `~/.jobpilot` is read-only (SELECT-only on
  its DB).
- Research with endpoints, request bodies and live responses: `.superpowers/sdd/careersites-research-2026-10-13.md`.
  Raw responses: `/private/tmp/claude-501/-Users-racit/f3efd04a-30cd-4e5b-bc92-82bcfcaace4e/scratchpad/cr/` (if
  gone, re-record with one polite request each).

## File map

| Path | Responsibility |
|---|---|
| `src/app/coverage/types.ts` | `CompanyCandidate@1`, `CareersSite@1`, `PlatformGuess@1`, `CompanyVerdict@1`, `Platform` enum |
| `src/app/coverage/names.ts` | `normalCompanyName`, `sameCompany` |
| `src/app/coverage/seed.ts`, `locator.ts`, `detector.ts`, `verifier.ts` | the four coverage agents |
| `src/app/coverage/pipeline.ts`, `run.ts`, `project.ts` | coverage wiring, run, registry projection |
| `src/app/pack/companies-schema.ts` | `pack/companies.yaml` (user picks) |
| `src/app/store/schema.ts` (modify) | additive migration: `companies` table |
| `src/app/agents/sources/platforms/<platform>.ts` | one daily adapter per platform |
| `src/app/agents/normalizer.ts` (modify) | one mapper per platform |
| `src/app/pipeline.ts` (modify) | daily wiring adds the platform adapters and registry seeds |
| `src/app/web/companies.ts` | the Companies tab |
| `src/app/coverage/probe.ts` | `jobpilot coverage probe` |
| `src/app/due.ts`, `src/app/schedule.ts` (modify) | weekly `COVERAGE_DUE`, `com.jobpilot.coverage` |
| `evals/datasets/coverage-*.jsonl` | golden sets |

---

### Task 0: Types, registry, company picks, name matcher

**Files:** create `src/app/coverage/types.ts`, `src/app/coverage/names.ts`, `src/app/pack/companies-schema.ts`,
`tests/fixtures/pack/companies.yaml`, and `evals/datasets/coverage-names.jsonl` (≥ 40 cases). Modify
`src/app/store/schema.ts` (append one migration), `src/app/store/app-store.ts` (registry methods),
`src/app/pack/load.ts` (load companies.yaml; absent → empty; daily mode lenient, like the freelance files after
fix C1), `src/app/evals.ts`. Test: `tests/app/coverage/names.test.ts`, `tests/app/coverage/registry.test.ts`.

**Interfaces:**

```ts
// types.ts
Platform = z.enum(['workday','eightfold','oracle','icims','successfactors','smartrecruiters','workable','recruitee',
  'teamtailor','personio','bamboohr','breezy','pinpoint','rippling','gem','greenhouse','lever','ashby','jsonld-sitemap'])
CompanyCandidate@1 { companyKey: string /* registrable domain, lowercase */, name: string, website: string,
  careersUrl: string | null, source: 'pick'|'remoteintech'|'yc'|'jobs', runDate: IsoDate }
CareersSite@1      { candidate: CompanyCandidate, careersUrl: string | null, method: 'listed'|'homepage-link'|'path'|'subdomain'|'sitemap'|'none', evidence: string | null }
PlatformGuess@1    { site: CareersSite, platform: Platform | null, slug: string | null /* tenant/site/id */,
  boardUrl: string | null, signature: string | null, routedFrom: string | null /* e.g. 'phenom', 'drupal-jsonld' */ }
CompanyVerdict@1   { guess: PlatformGuess, status: 'verified'|'proposed'|'failed', reasons: string[],
  boardName: string | null, jobsSeen: number | null }

// names.ts
export function normalCompanyName(s: string): string
// NFKC, case-fold, & -> and, strip punctuation, collapse spaces, then strip trailing legal suffixes
// (inc|ltd|llc|pvt|private limited|limited|gmbh|corp|corporation|co|plc|sa|ag|bv|technologies?)
export function sameCompany(a: string, b: string, domainLabel?: string): boolean
// true iff normalCompanyName(a) === normalCompanyName(b), or normalCompanyName(b) === domainLabel
```

- **`companies` table:** `company_key` PK, `name`, `website`, `careers_url`, `platform`, `platform_slug`,
  `board_url`, `status` (verified|proposed|rejected|failing|failed), `reasons` JSON, `source`, `jobs_seen`,
  `last_verified`, `failing_since`, `fail_weeks`, `user_override` (approved|rejected|null), `updated_at`.
- **App-store methods:** `upsertCompanyVerdict(v, at)` (respects `user_override`), `verifiedCompanies()`,
  `setCompanyOverride(key, override, at)`, `listCompanies(filter)`.
- **`pack/companies.yaml`:** `{ companies: [{ name, website, careersUrl? }] }`, all optional except `name`, default
  `{companies: []}`. The fixture file lists 3 fictional-safe public companies (e.g. a Workday user, an Eightfold user,
  an Okta-like Greenhouse-backed site).

- [ ] **Step 1: Failing tests.**
  - names: `Okta, Inc.` = `okta`; `Microsoft Corporation` = `microsoft`; `Pure Storage Inc` = `purestorage`
    (domain label); `Meta` ≠ `Metaverse Labs`; `HCL Technologies` = `hcl`; `Tata Consultancy Services` ≠ `TCS`
    (no alias guessing → proposed);
  - the golden set covers ≥ 40 pairs including Unicode, ampersands and look-alikes;
  - registry: a migration on a v8 DB adds `companies`, all prior tables byte-identical (dump-and-hash test);
    `user_override: rejected` survives a later verified verdict; `verifiedCompanies()` excludes rejected and failed.
- [ ] **Step 2: Run, expect FAIL.** **Step 3: Implement.** **Step 4: `node --run verify`.**
- [ ] **Step 5: Commit** `feat(coverage): company types, registry table, picks file, name matcher`

---

### Task 1: Weekly schedule and the coverage run skeleton

**Files:** modify `src/app/due.ts` (`COVERAGE_DUE`), `src/app/schedule.ts` (`com.jobpilot.coverage`, plist
`run-coverage --if-due`, `[{Minute:0},{Minute:30}]` + RunAtLoad, `coverage.log`; install order daily, freelance,
coverage, dashboard), `src/cli.ts` (`jobpilot run-coverage [--if-due] [--offline-fixtures <dir>] [--no-notify]`;
`schedule status` prints the coverage week state). Create `src/app/coverage/run.ts` (lock, run id, empty pipeline).
Tests: extend `tests/app/due.test.ts` and `tests/app/schedule.test.ts`.

**Interfaces:**
- `DueSpec` gains `weekday?: 0..6` (0 = Sunday, IST). `COVERAGE_DUE = { pipeline: 'coverage', windows: [{ fromIst:
  '06:00', id: '' }], weekday: 0, attemptsFile: 'coverage-attempts.json', runPrefix: 'coverage-' }`.
- A weekly spec is owed on its weekday from `fromIst` and **stays owed on the following days** until a run for that
  ISO week completes, so a Mac asleep on Sunday catches up on Monday. The run id is `coverage-<IST date of the run>`;
  "completed this ISO week" is the test.

- [ ] **Step 1: Failing tests.**
  - Saturday 23:59 IST → not due;
  - Sunday 05:59 → not due; Sunday 06:00 → due;
  - Tuesday with no run this ISO week → due;
  - after `coverage-<Monday>` completed → not due until next Sunday 06:00;
  - the cap of 3 failures is per ISO week;
  - daily and freelance due behaviour unchanged (existing tests);
  - plists byte-identical for daily, freelance and dashboard; the coverage plist passes `plutil -lint`.
- [ ] **Steps 2–4.** **Step 5: Commit** `feat(coverage): weekly due window with catch-up, schedule job, run-coverage CLI`

---

### Task 2: `company-seed`

**Files:** create `src/app/coverage/seed.ts`; fixtures `tests/fixtures/coverage/seed/{remoteintech.tar.gz or a
trimmed set of company .md files, yc-hiring.json}`. Test: `tests/app/coverage/seed.test.ts`.

**Behaviour:**
- **Inputs:** one `CoverageRequest@1 { runDate, source }` per source. Add `CoverageRequest` to types.ts:
  `{ runDate: IsoDate, source: 'picks'|'remoteintech'|'yc'|'jobs', items?: unknown }`.
- **`picks`:** the controller seeds the request with `items` = `pack.companies` (app layer reads the pack).
- **`jobs`:** the app layer seeds `items` = the distinct `(company, best-known URL host)` pairs from the `jobs` table,
  SELECT-only.
- **`remoteintech`:** fetch the GitHub repo's company files deterministically:
  - one request to `https://api.github.com/repos/remoteintech/remote-jobs/contents/company-profiles` (the list),
    then raw files via `https://raw.githubusercontent.com/remoteintech/remote-jobs/main/company-profiles/<file>`,
    paced;
  - or, if the research shows a single archive endpoint is simpler, `https://codeload.github.com/remoteintech/remote-jobs/tar.gz/refs/heads/main`;
  - choose ONE, document it, cap the size at 20 MB;
  - parse each profile's company name and website / careers link with fixed markdown rules.
- **`yc`:** `https://yc-oss.github.io/api/companies/hiring.json` (verify the exact path from the research): `name`,
  `website`, `status === 'Active'`, `isHiring`.
- **Output:** `CompanyCandidate` per company, `companyKey` = the registrable domain of `website`. Use the public
  suffix rule: a small built-in list for common multi-part suffixes (`co.in`, `co.uk`, `com.au`, …), document it.
  Dedupe across sources: `pick` > `remoteintech` > `yc` > `jobs` for the name and careersUrl. Sorted by companyKey.
- A malformed profile is `ctx.skipped` with a note, never fatal unless all fail (`checkParsed` pattern).

- [ ] **Step 1: Failing tests:** fixture-based counts; dedupe precedence; registrable-domain cases (`www.okta.com` →
  `okta.com`, `careers.foo.co.in` → `foo.co.in`); malformed → skipped; size cap → `invalid_output`.
- [ ] **Steps 2–4.** **Step 5: Commit** `feat(coverage): company seed from picks, remote-company and YC lists, seen jobs`

---

### Task 3: `careers-locator`

**Files:** create `src/app/coverage/locator.ts`, `src/app/coverage/robots.ts` (robots.txt fetch + RFC 9309 matcher,
cached per run in step memo), fixtures `tests/fixtures/coverage/locator/`. Test: `tests/app/coverage/locator.test.ts`.

**Behaviour (exact probe order, first hit wins, each probe a single GET honouring robots):**
1. `candidate.careersUrl` if present and it answers 2xx → method `listed`.
2. The homepage (`website`) HTML: the first `<a href>` whose text or href matches
   `/\b(careers?|jobs|join (?:us|our team)|work with us|open positions)\b/i`, resolved absolute, same registrable
   domain OR a known platform host (Task 4 signatures) → `homepage-link`.
3. `/careers`, `/jobs`, `/company/careers`, `/about/careers` on the website host → `path`.
4. `https://careers.<domain>`, `https://jobs.<domain>` → `subdomain`.
5. `/sitemap.xml`, or the sitemap named in robots.txt: the first `<loc>` whose path matches `/careers|/jobs` →
   `sitemap`.
6. None → `method: 'none'`, `careersUrl: null`.

Rules: follow redirects only within the same registrable domain or to a known platform host; a challenge page or a
4xx on the homepage → `none` with the evidence reason (never retried).

- [ ] **Step 1: Failing tests** with recorded HTML for 6 real-shaped sites:
  - an Okta-like Drupal page;
  - a homepage linking to myworkdayjobs;
  - a `/careers` path site;
  - a `careers.` subdomain site;
  - a sitemap-only site;
  - a challenge page.

  Robots matcher unit tests: allow/disallow precedence, wildcards, `$`.
- [ ] **Steps 2–4.** **Step 5: Commit** `feat(coverage): careers locator with fixed probes and robots.txt`

---

### Task 4: `platform-detector` + golden set

**Files:** create `src/app/coverage/detector.ts`, `src/app/coverage/signatures.ts` (the table below as data),
`evals/datasets/coverage-detector.jsonl` (≥ 40 recorded careers pages, each labelled). Register the eval. Test:
`tests/app/coverage/detector.test.ts`.

**Signatures (from spec §3; match on the careers page HTML: hrefs, script srcs, iframe srcs, form actions, inline
JSON):**

| Platform | Signature → slug extraction |
|---|---|
| workday | `https://<tenant>.wd<N>.myworkdayjobs.com/<site>` or `/wday/cxs/<tenant>/<site>/` → slug `<tenant>/<site>`, boardUrl the CXS jobs URL |
| eightfold | `<host>/careers?…` with `eightfold` script, or `/api/apply/v2/jobs` → slug host+domain param |
| oracle | `…/hcmUI/CandidateExperience/…/sites/<siteNumber>` or `hcmRestApi…recruitingCE` → slug `<host>/<siteNumber>` |
| icims | `careers-<co>.icims.com` → slug host |
| successfactors | `career<N>.successfactors.com/career?company=<id>` or `jobs.sap.com`-style → slug company id + host |
| smartrecruiters | `jobs.smartrecruiters.com/<Company>` or `careers.smartrecruiters.com/<Company>` → slug company |
| workable | `apply.workable.com/<slug>` |
| recruitee | `<slug>.recruitee.com` |
| teamtailor | `<slug>.teamtailor.com` or a teamtailor script |
| personio | `<slug>.jobs.personio.(de|com)` |
| bamboohr | `<slug>.bamboohr.com/careers` |
| breezy | `<slug>.breezy.hr` |
| pinpoint | `<slug>.pinpointhq.com` |
| rippling | `ats.rippling.com/<slug>` |
| gem | `jobs.gem.com/<slug>` |
| greenhouse | `boards.greenhouse.io/<slug>`, `job-boards.greenhouse.io/<slug>`, `greenhouse.io/embed/job_board?for=<slug>`, `gh_jid=` with a Greenhouse script |
| lever | `jobs.lever.co/<slug>` |
| ashby | `jobs.ashbyhq.com/<slug>` |
| jsonld-sitemap | a JobPosting JSON-LD on a careers-domain job page, or a sitemap listing job URLs, and no platform above |

- **Precedence:** a back-end ATS signature always beats a front-end.
- **Phenom:** recognise `phenompeople` and route to the ATS of its apply links (`routedFrom: 'phenom'`).
- **Okta-like:** a careers page with JobPosting JSON-LD AND a `gh_jid=` or Greenhouse apply link → `greenhouse`
  (`routedFrom: 'jsonld'`).
- **Several distinct back-ends** found → `platform: null` with all of them in the evidence (→ Proposed).

- [ ] **Step 1: Failing tests + golden set.** Record the 40 pages by one polite GET each, trimmed to the relevant
  HTML. Include Okta (Drupal → Greenhouse), Mastercard (Phenom → Workday), Microsoft (Eightfold), JPMorgan (Oracle),
  Atlassian (iCIMS), HCLTech (SuccessFactors), and one per small platform. Hand labels.
- [ ] **Steps 2–4** (eval 1.000). **Step 5: Commit** `feat(coverage): platform detector with signature table and golden set`

---

### Task 5: `board-verifier`, registry projection, coverage wiring, live coverage run

**Files:** create `src/app/coverage/verifier.ts`, `src/app/coverage/pipeline.ts`, `src/app/coverage/project.ts`;
modify `src/app/coverage/run.ts`, `src/exported-agents.ts`, `src/app/allow-list.ts`. Fixtures
`tests/fixtures/coverage/e2e/`. Test: `tests/app/coverage/e2e.test.ts`.

**Wiring:**
`CoverageRequest@1 → company-seed → CompanyCandidate@1 → careers-locator → CareersSite@1 → platform-detector →
PlatformGuess@1 → board-verifier → CompanyVerdict@1`. Teams: one per agent (the freelance lesson: never one breaker
across unrelated work). Egress:
- seed: `api.github.com`, `raw.githubusercontent.com` (or codeload), `yc-oss.github.io`;
- locator, detector, verifier: the symbolic set `coverage:candidate-hosts`, resolved per run from the candidates
  (like `pack:careers-hosts`), plus the known platform hosts.

**Verifier:**
- fetch the board once through the platform's read endpoint: the same request shape the daily adapter uses, so
  share a `platformClient(platform)` module under `src/app/agents/sources/platforms/client.ts`, created here with
  the read functions Tasks 6–8 fill in. Until a platform's adapter exists, verification for it → `proposed` with
  reason `adapter not built yet`;
- `verified` iff all of:
  - the board answers 2xx;
  - the response shape is valid (zod);
  - jobs ≥ 1;
  - `sameCompany(boardName, candidate.name, domainLabel)`.
- Otherwise `proposed` (shape OK but the name differs or 0 jobs), or `failed` (an error), with reasons.

**Projection:** `upsertCompanyVerdict`:
- verified → `last_verified = now`, `fail_weeks = 0`;
- failed on a previously verified company → `fail_weeks + 1`, and 3 → `failing`;
- user overrides respected.

**Notification:** a weekly line, `"Coverage: N verified (+k new) · p proposed · f failing"`.

- [ ] **Step 1: Failing e2e** from fixtures:
  - a pick plus a seed yields 1 verified, 1 proposed (name mismatch) and 1 failed (404);
  - user-rejected stays rejected;
  - 3 failing weeks → `failing`;
  - a same-week rerun replays at $0.
- [ ] **Step 2–4.**
- [ ] **Step 5: Live check** (required): a temp home with a copy of the real pack, `run-coverage --no-notify` live and
  polite. Report:
  - candidates by source;
  - locator method counts;
  - platform counts;
  - verified / proposed / failed;
  - 10 sampled verified companies with platform.
  Then hand-check 20 verified companies' name matches, with a target of 0 wrong-company verifications.
- [ ] **Step 6: Commit** `feat(coverage): board verifier, registry projection, coverage pipeline`

---

### Task 6: Daily adapter: Workday

**Files:** create `src/app/agents/sources/platforms/workday.ts`; modify `src/app/agents/normalizer.ts` (mapper),
`src/app/pipeline.ts` (wiring + `dailySeeds` adds one request per verified registry company of this platform), and
`src/app/types.ts` (`Ats` gains the platform values; `knownAts` updated). Fixtures
`tests/fixtures/sources/workday-<tenant>.json` (NVIDIA, Salesforce, Mastercard). Test: `tests/app/sources-workday.test.ts`.

**Behaviour (from the research):**
- `POST https://<host>/wday/cxs/<tenant>/<site>/jobs` with body
  `{"appliedFacets":{},"limit":20,"offset":<n>,"searchText":""}`;
- page by `offset` until `jobPostings` is empty or `offset >= total`; cap 100 pages → loud failure;
- per job: `title`, `externalPath` (→ URL `https://<host>/<site><externalPath>`), `locationsText`, `postedOn`
  (relative → `postedAt: null`), `bulletFields` (job req id → used for dedupe);
- `sourceId` = the job req id if present, else externalPath;
- detail fetch (`GET /wday/cxs/<tenant>/<site><externalPath>`) only for jobs whose title passes the cheap title
  pre-filter (pack roleDeny / titles), to stay within the per-company budget; the description, `remoteType` and
  `timeType` come from the detail.

**Daily regression:** with no registry companies, the pipeline is byte-identical to main (assert with the existing
e2e plus a step-key comparison).

**Teams (spec §6):** each platform's adapter is its own team in the daily wiring, so one dead tenant can never open a
breaker for another platform or for the existing ATS sources. Tasks 7–9 follow the same rule.

- [ ] **Step 1: Failing tests:** paging, cap, the relative date → null, URL construction, budget stop (named skip, not
  silent), mapping into Posting fields (location → India/Bengaluru recognition works with the existing eligibility).
- [ ] **Steps 2–4.** **Step 5: Commit** `feat(sources): Workday adapter for verified registry companies`

---

### Task 7: Daily adapters: Eightfold, Oracle Recruiting Cloud

**Files:**
- create `src/app/agents/sources/platforms/eightfold.ts` and `oracle.ts`;
- modify `src/app/agents/normalizer.ts` (one mapper each), `src/app/pipeline.ts` (wiring; `dailySeeds` adds one
  request per verified registry company of each platform), `src/app/types.ts` (`Ats` values);
- fixtures `tests/fixtures/sources/eightfold-{microsoft,netflix}.json`, `oracle-jpmorgan.json`;
- test `tests/app/sources-enterprise.test.ts`.

**Behaviour:**
- Use the endpoints, params and paging exactly as recorded in `.superpowers/sdd/careersites-research-2026-10-13.md`:
  - Eightfold `GET /api/apply/v2/jobs?domain=<d>&start=<n>&num=<k>`, or the newer API recorded for Microsoft;
  - Oracle `GET …/hcmRestApi/resources/latest/recruitingCEJobRequisitions?onlyData=true&expand=…&finder=findReqs;siteNumber=<s>,limit=<k>,offset=<n>`.
- Page until empty, with a loud cap (100 pages Eightfold, 10 pages Oracle).
- sourceId = the platform's job/requisition id. URL built from the recorded pattern. A relative or absent date →
  `postedAt: null`.
- Detail fetch only for title-prefiltered jobs, within the per-company budget (40 requests); a budget stop is a
  named skip, never silent.
- **Oracle:** robots.txt is unreadable (403), so treat it as "unknown", at 5000 ms between requests and at most 10
  pages per company per day, documented in the adapter header.
- With no registry companies the daily pipeline is byte-identical to main.

- [ ] Tests as Task 6 per adapter. **Commit** `feat(sources): Eightfold and Oracle Recruiting Cloud adapters`

---

### Task 8: Daily adapters: iCIMS, SuccessFactors, SmartRecruiters pages, generic JSON-LD/sitemap

One file each.
- **Shared:** a pure parser `jsonLdJobPostings(html)` (reuse the JSON-LD extraction in `careers.ts`; factor it out
  without behaviour change, proven by the careers tests) and `sitemapJobUrls(xml, pattern)`.
- **iCIMS:** sitemap → job pages → JSON-LD.
- **SuccessFactors:**
  - stream `sitemal.xml` with a 50 MB cap (loud on overflow);
  - parse job URLs and titles;
  - fetch detail only for title-prefiltered jobs;
  - `postedAt: null`.
- **SmartRecruiters:** `jobs.smartrecruiters.com/<Company>` listing → job pages → JSON-LD. **Never**
  `api.smartrecruiters.com`; a test greps `src/` for that host.
- **Generic `jsonld-sitemap`:** careers-domain sitemap → job URLs (pattern from the detector evidence) → JSON-LD. No
  browser (plain HTTP).

- [ ] Tests per adapter with recorded fixtures; the api.smartrecruiters.com grep test. **Commit**
  `feat(sources): iCIMS, SuccessFactors, SmartRecruiters pages and generic JSON-LD adapters`

---

### Task 9: Daily adapters: small platforms

Workable, Recruitee, Teamtailor (`Accept: application/rss+xml`), Personio (`/xml`), BambooHR (`/careers/list`),
Breezy (`/json`), Pinpoint (`/postings.json`), Rippling, Gem. One file each, sharing a tiny `feedBoard(platform)`
helper only where shapes truly coincide. Endpoints exactly as recorded in the research doc.

- [ ] Tests per adapter with fixtures. **Commit** `feat(sources): adapters for nine small ATS platforms`

---

### Task 10: Cross-source dedupe

**Files:** modify `src/app/project.ts` (daily projector) and `src/app/text/norm.ts` if a key helper is needed. Test:
`tests/app/dedupe-sources.test.ts`.

**Rule (spec §4):** a posting from a platform adapter whose ATS job id equals an existing posting's id is the same job:
- `gh_jid` from a company page = the Greenhouse job id;
- a Workday req id on a company page = the Workday posting.

The rule links them via `duplicate_of`, keeping the earliest first-seen as primary, as the v1 rule does. Otherwise
fall back to `dedupeKey(company, title, location)`. **The user never sees one job twice**, and statuses, documents
and announcements belong to the primary.

- [ ] Tests: the Okta-like pair (company page + Greenhouse) → one visible row; the same title in two cities → two
  rows; announce once. **Commit** `feat(project): merge one job seen through a company page and its ATS`

---

### Task 11: Companies tab

**Files:** create `src/app/web/companies.ts` (+ views); modify the nav and `server.ts`. Test:
`tests/app/web-companies.test.ts` (+ a browser check at 400 px).

Per spec §5:
- **Lists:** Verified, Proposed (Approve/Reject POST with CSRF, logged), Failing.
- **Add company:** a form that writes the pick to the registry as a `pick` candidate pending the next coverage run.
  It never edits the pack file. "Resolve now" takes the run lock and runs the four coverage agents for that one
  company.
- **Links:** each company links to its jobs in the existing lists, and rejected jobs show their reason.
- **Security:** the same rules as the other tabs (127.0.0.1, CSRF, no external assets except company careers links
  with `rel="noopener noreferrer"`).

- [ ] Tests: each list renders; approve/reject transitions and overrides; CSRF refusal; XSS-safe company names;
  resolve-now under the lock. **Commit** `feat(web): Companies tab with proposals, failing boards and add company`

---

### Task 12: `jobpilot coverage probe`

**Files:** create `src/app/coverage/probe.ts`; modify `src/cli.ts`. Test: `tests/app/coverage/probe.test.ts`
(offline only; fetch stubbed to throw).

Output (spec §7):
- companies by status and platform;
- **new jobs found by the platform adapters that are not on any existing source**, and how many pass the user's
  rules (eligible or review with fit ≥ the daily minFit);
- per platform: requests used against the budget, and problems.

`--json`. It takes the run lock.

- [ ] Tests on fixtures. **Commit** `feat(coverage): coverage probe with the new-jobs gain`

---

### Task 12b: Operator guide: running jobpilot without Claude Code

**Files:** modify `README.md` (a new top-level section "Running jobpilot on your own"), `src/cli.ts` (help text where
it is thin). Create `docs/operations.md`. Test: `tests/app/cli-help.test.ts`.

**The guide covers every operation as a CLI command, with expected output:**
- install (Node 24 + `pnpm install`);
- create a pack (`pack import` / the fixture pack as a template);
- `pack check`;
- `schedule install|status|run-now|uninstall`;
- the three runs (`run`, `run-freelance`, `run-coverage`), each with `--if-due` explained;
- `serve` and the dashboard tabs;
- `gmail connect|status|disconnect`;
- `networks pack`;
- `sources probe` / `coverage probe`;
- adding companies (the pack file and the dashboard);
- backups (the DB `.backup`) and the rollback recipe for a migration;
- logs;
- upgrading (migrations are one-way: back up first, migrate once, then `schedule install`).

It also states plainly:
- no AI and no API key is needed;
- Claude Code was only the build tool;
- where an optional LLM could be plugged in later (`LlmProvider`, unused).

**Tests:** every command named in the guide exists in `jobpilot --help` (the test parses the guide's commands and
runs `--help` for each); no command in the guide refers to Claude, skills or `.superpowers`.

- [ ] **Commit** `docs: operator guide for running jobpilot on its own`

---

### Task 13: Live run, final review, merge

- [ ] On a temp home with a copy of the real pack: `run-coverage` live, then `run --no-notify` live (daily with the
  new registry), then `coverage probe`. Record the gain numbers.
- [ ] A whole-branch reviewer (most capable model) with probe scripts against the real modules and a `.backup` copy
  of the real DB:
  - the migration rehearsal (daily tables byte-identical), then delete the copy;
  - daily regression byte-identity with an empty registry;
  - politeness audit: no host above its rate, robots honoured, no `api.smartrecruiters.com`;
  - a 0 forbidden-term scan of all outputs;
  - triage of the carried minors.
- [ ] Fix waves, re-review. Then, at a quiet time (no lock, today's runs complete):
  - back up the real DB (`.backup`);
  - `git -C ~/PersonalProject/jobpilot merge --ff-only career-sites`;
  - migrate once (`facts list`);
  - `schedule install` (4 jobs);
  - verify all dashboard routes return 200;
  - remove the worktree.
- [ ] Privacy-scan the new commits (forbidden terms, contact.yaml values, offer/floor, secret patterns); only then
  `git push origin main`.
