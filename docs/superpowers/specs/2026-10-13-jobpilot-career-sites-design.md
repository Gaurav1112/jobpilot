# jobpilot career sites: deterministic coverage of company-run career websites

Status: designed with the user 2026-10-13 (brainstorm; sections 1-3 approved). Builds on the architecture spec
(`2026-10-08-jobpilot-architecture-design.md`, roadmap sub-project 12 "Coverage"), v1
(`2026-10-09-jobpilot-v1-daily-design.md`) and the freelance build (`2026-10-12-jobpilot-freelance-design.md`).
Research with live verification: `.superpowers/sdd/careersites-research-2026-10-13.md` (local, git-ignored).

## 1. What the user gets

Many employers publish jobs on their own career site rather than (or in front of) a known ATS board. Example: an
Okta posting at `okta.com/company/careers/…` is a Drupal page with schema.org `JobPosting` JSON-LD, backed by the
Greenhouse board `okta`. Big employers commonly run Workday, Eightfold, Oracle Recruiting Cloud, iCIMS or
SuccessFactors behind their careers pages.

After this build:

1. A **weekly coverage run** discovers companies, finds their careers site, detects the platform behind it, verifies
   the board, and records each company in a **company registry**.
2. The **daily run** reads jobs from every verified company through **one deterministic adapter per platform**, and
   they flow through the existing normalizer, eligibility (remote open to India, or onsite/hybrid in the user's
   `eligibility.officeCities`), scorer, documents and dashboard.
3. A **Companies** dashboard tab shows verified, proposed and failing companies; the user approves or rejects
   proposals and can add any company.

No LLM anywhere; no scraping against robots.txt or terms; no evasion.

## 2. Decisions (user, 2026-10-13)

- D1 **Companies:** auto-discover from verified lists **plus** the user's picks (`pack/companies.yaml`).
- D2 **Onboarding:** a discovered company is added **automatically only if every deterministic check passes**
  (careers URL found, platform detected, board company name matches, board returns ≥ 1 job, response shape valid);
  anything else goes to **Proposed** for a one-click OK.
- D3 **SmartRecruiters:** its robots.txt disallows all bots except LinkedInBot on the API, so jobpilot reads only the
  `jobs.smartrecruiters.com` job pages and their JSON-LD. The API is not used.
- D4 **Approach A:** a separate weekly `jobpilot-coverage@1` pipeline fills the registry; the daily pipeline gains
  per-platform adapters that read it. Discovery never runs in the 07:00 daily run.

## 3. Coverage pipeline `jobpilot-coverage@1` (weekly)

Owed from Sunday 06:00 IST; the same catch-up schedule design as daily and freelance (`run-coverage --if-due`, own
attempts file `coverage-attempts.json`, cap 3 failures, one "gave up" notice). Shares the single process lock.

| Agent | Skill | Output |
|---|---|---|
| `company-seed` | build candidates from sources (below), dedupe by registrable website domain | `CompanyCandidate@1` |
| `careers-locator` | find the careers URL by fixed probes, first match wins | `CareersSite@1` |
| `platform-detector` | identify the platform from link and script signatures; route front-ends to their back-end ATS | `PlatformGuess@1` |
| `board-verifier` | fetch the board once; check name, ≥ 1 job, response shape | `CompanyVerdict@1` (verified / proposed / failed, with reasons) |

**Seed sources (all verified live 2026-10-13):** remoteintech/remote-jobs (≈ 884 companies with a careers URL),
yc-oss `hiring.json` (≈ 1,495 hiring companies), every company already present in the user's jobs table, and
`pack/companies.yaml` (the user's picks, highest priority). Wikidata is used only to look up an official website
for a named company.

**Careers-locator probe order:** the listed careers URL → homepage links whose text or href matches
`careers|jobs|join us|work with us` → `/careers`, `/jobs`, `/company/careers`, `/about/careers` → `careers.<domain>`,
`jobs.<domain>` → sitemap entries matching `/careers|/jobs`. robots.txt is honoured; 2 s per host; honest UA.

**Platform signatures (deterministic):** `myworkdayjobs.com` / `/wday/cxs/`; Eightfold `/api/apply/v2/`; Oracle
`hcmRestApi…recruitingCE`; iCIMS `icims.com`; SuccessFactors `successfactors.com`; SmartRecruiters
`jobs.smartrecruiters.com`; Workable `apply.workable.com`; Recruitee `recruitee.com`; Teamtailor `teamtailor`;
Personio `jobs.personio`; BambooHR `bamboohr.com/careers`; Breezy `breezy.hr`; Pinpoint `pinpointhq.com`; Rippling
`ats.rippling.com`; Gem `jobs.gem.com`; Greenhouse `greenhouse.io` / `gh_jid=`; Lever `jobs.lever.co`; Ashby
`jobs.ashbyhq.com`; Phenom `phenompeople` / `cdn.phenompeople` (a front-end: route to the ATS its apply links
target); generic: schema.org `JobPosting` JSON-LD on job pages, or a sitemap of job URLs.

**Name verification:** normalise both names (case-fold, Unicode NFKC, strip legal suffixes `inc|ltd|llc|pvt|
private limited|gmbh|corp|corporation|co|plc|sa|ag|bv`, strip punctuation); verified only on equality, or when the
board's company name equals the candidate's registrable domain label. Anything else → Proposed with the reason
("board name '…' ≈ '…', please confirm").

**Registry table** `companies` (additive migration): `company_key` (domain), `name`, `website`, `careers_url`,
`platform`, `platform_slug` (tenant/site/id), `status` (verified | proposed | rejected | failing), `reasons` JSON,
`source` (seed list), `jobs_seen`, `last_verified`, `failing_since`, `user_override` (approved | rejected | null).
A verified company that fails verification 3 weeks running becomes `failing` (shown, never silently removed). User
overrides always win.

## 4. Daily adapters

Each adapter is one `io` agent consuming `DiscoveryRequest@1` (`ats` gains the platform values) and producing
`RawPosting@1`, with its own recorded fixtures and golden eval. The daily seeds add one request per verified
registry company (plus the existing watchlist). The normalizer gains one mapper per platform.

| Priority | Platform | Endpoint | Notes |
|---|---|---|---|
| 1 | Workday | `POST /wday/cxs/<tenant>/<site>/jobs`, limit 20, offset paging | relative dates ("Posted Today") → `postedAt: null`, ordered by firstSeen; full paging with a loud cap |
| 1 | Eightfold | `/api/apply/v2/jobs` | robots.txt allows the API |
| 1 | Oracle Recruiting Cloud | `…/hcmRestApi/resources/latest/recruitingCEJobRequisitions` | robots unreadable (403): minimal rate |
| 2 | iCIMS | sitemap → job page JSON-LD | |
| 2 | SuccessFactors | `sitemal.xml` catalogue | large: streamed with a size cap; no posted dates |
| 2 | SmartRecruiters | job pages + JSON-LD only (D3) | |
| 3 | Workable, Recruitee, Teamtailor, Personio, BambooHR, Breezy, Pinpoint, Rippling, Gem | public JSON / XML / RSS feeds (Teamtailor needs `Accept: application/rss+xml`) | |
| 3 | Generic | sitemap + JobPosting JSON-LD on job pages | in-house sites |
| — | Taleo, Avature | — | deferred (positional / capped responses; brittle) |

**Politeness:** honest UA `jobpilot/0.1 (+local)`; ≥ 2 s per host; a per-company daily request budget; robots
disallow, 403, 429 or a challenge page → that host is disabled for the week with a named problem; never retried
around, never bypassed.

**Dedupe:** a job seen on both a company page and its ATS (Okta) is merged by ATS job id (`gh_jid`, Workday job
req id, …), then by `dedupeKey(company, title, location)`. The user never sees one job twice.

## 5. Dashboard: Companies tab

- **Verified:** company, platform, careers URL, open jobs, jobs passing the user's rules, last verified.
- **Proposed:** what was found, why it is not verified, Approve / Reject (CSRF-protected POST, logged).
- **Failing:** verified companies whose board stopped answering, with the error and since-week.
- **Add company:** name or website → resolved on the next coverage run, or immediately via "resolve now" (takes the
  run lock).
- Each company links to its jobs in the existing lists; rejected jobs show the reason ("onsite – Pune",
  "role: product manager").

## 6. Error handling

- A failing company board is `failed` with a named problem; all others continue. Each platform's adapters are their
  own team, so one dead tenant cannot open a breaker for another platform.
- Paged sources never truncate silently: a cap throws loudly.
- A response missing expected fields is `invalid_output`, never partially parsed; 3 weeks → Failing.
- Coverage only writes the registry: a coverage failure never blocks or slows the daily run, which reads whatever
  registry exists.

## 7. Testing and measurement

- Per adapter: recorded fixtures from the verified companies (NVIDIA, Salesforce, Mastercard on Workday; Microsoft
  on Eightfold; JPMorgan on Oracle; Atlassian on iCIMS; HCLTech on SuccessFactors; one company per small platform);
  paging, cap, drift and empty-board tests.
- Golden sets: `platform-detector` ≥ 40 labelled careers pages (incl. Okta: Drupal over Greenhouse; Mastercard:
  Phenom over Workday); name matcher ≥ 40 pairs incl. look-alikes. Gate exactMatch 1.000.
- e2e offline: a coverage run from fixtures fills the registry; a daily run then yields jobs from the new adapters,
  with zero duplicates against existing Greenhouse jobs.
- Daily regression: with an empty registry the daily pipeline is byte-identical to main (step keys, rows, document
  hashes).
- `jobpilot coverage probe`: companies discovered / resolved / verified / proposed / failing by platform, and the
  number of **new jobs not on any existing source**, and how many pass the user's rules. This number decides whether
  each platform adapter earns its place.

## 8. Out of scope

Taleo and Avature adapters; LinkedIn, Indeed and Naukri (alert emails only, a separate sub-project); any login,
session browsing or CAPTCHA handling; submitting applications.

## 9. Build order (for the plan)

1. Types, registry migration, `pack/companies.yaml`, name matcher (+ golden set).
2. Coverage agents: seed, locator, detector (+ golden set), verifier; `run-coverage` + weekly schedule.
3. Daily adapters, priority 1 (Workday, Eightfold, Oracle), with normalizer mappers and dedupe.
4. Priority 2 (iCIMS, SuccessFactors, SmartRecruiters pages, generic JSON-LD/sitemap).
5. Priority 3 small platforms.
6. Companies tab; `coverage probe`.
7. Live coverage run on a temp home, probe review, final review, merge (worktree only; the live checkout stays on
   main).
