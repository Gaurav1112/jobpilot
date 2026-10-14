# jobpilot freelance: a separate, deterministic pipeline for contracts and gigs

Status: designed with the user 2026-10-12 (brainstorm, sections 1–5 each approved). Builds on the
architecture spec `2026-10-08-jobpilot-architecture-design.md` and the v1 build
`2026-10-09-jobpilot-v1-daily-design.md`. This **reverses Rev 2's "no contractor" scope** for a
separate track only: the full-time pipeline (`jobpilot-daily`) is not changed by this build.

## 1. What the user gets

Twice a day (from 07:30 and 19:30 IST, catching up after sleep), with no prompt:

1. jobpilot reads **40 platforms** through four deterministic channels (§4): public APIs and feeds,
   official keyed APIs, and the user's own alert emails. It never scrapes or crawls a marketplace;
2. it normalises every gig, dedupes it across sources, converts its pay to USD/h with a stated
   method, and drops gigs that are not open to India, need more than 20 h/week, need working hours
   that do not fit IST evenings, or forbid other employment;
3. it flags scam and risk signals, scores fit with the v1 lexicon, and ranks two lists, **Contracts**
   and **Gigs**, comp-first above **$40/h** with fit ≥ 45;
4. for each shortlisted gig it builds the screening documents (gig proposal, contract pitch + CV,
   network application pack or bounty note) **from verified facts only**, within the platform's
   limits;
5. the dashboard's `/freelance` tab shows all of it; a macOS notification says
   `N new gigs, K at ≥$40/h · top: $65/h Go API contract (Freelancer)` (`, K at ≥$40/h` counts only gigs with a
   known hourly rate at or above the floor and is left out when there are none; final review, 2026-10-13).

The user's only actions: read, copy the proposal, open the gig at its source URL, paste, submit
there, and set a status. **Nothing is ever submitted by jobpilot** (Upwork's terms forbid
automated proposals, and bids cost Connects).

Design context: freelance work runs **alongside** a full-time job, at most
20 h/week; both long contracts and short fixed-price gigs; every free platform that helps.
Before the first gig the user should check the employment contract's moonlighting and IP
clauses (a checklist item on the Networks page, not a gate). The naming rule
applies to every document: employer = the pack's display name.

## 2. The determinism decision (same as v1)

- **No language-model call anywhere in this build.** Every agent is `deterministic` or `io`.
  Same pack + same inputs + same code = same rows, same order, same document bytes. Same-day
  replay is memoised and costs $0.
- **A missing value stays missing.** No hours → `review`. No rate → `unknown`. No location →
  `review`. No evidence for a requirement → listed as *missing*. Nothing is estimated silently.
- **Every gig keeps its source URL**, and the dashboard links to it, so nothing shown exists only
  inside jobpilot.
- The later "human writing" sub-project may replace the planners (§7) with an LLM writer **behind
  the same contracts**; the fact-check (G-GROUND, qa-gate) stays deterministic.

## 3. Pipeline and agents

A separate wiring `jobpilot-freelance@1.0.0`, run as `freelance-<IST date>-<am|pm>` in the same
`JOBPILOT_HOME`, same DB (its own tables, §8), same lock (never overlaps the daily run). It
imports shared code (kernel, shared lexicon, evidence-matcher, renderer, qa-gate, naming guard,
PDF/DOCX), never copies it. Rule from Rev 4: one agent = one skill, one output type, one
knowledge base, one eval set.

| Team | Agent | Skill | Output contract |
|---|---|---|---|
| Sourcing | `src-<platform>` (one per channel A/B source, §4) | read one platform | `RawGig` |
| | `src-gig-mail` with one parser per sender (§4 channel C) | parse the user's alert emails | `RawGig` |
| Understanding | `gig-normalizer` | one schema (§5.1) | `Gig` |
| | `gig-deduper` | same gig across sources | `GigGroup` |
| | `rate-normalizer` | pay → USD/h with method (§5.3) | `Rate` |
| Evaluation | `gig-eligibility` | hard rules (§5.2) | `GigVerdict` |
| | `gig-risk` | red flags (§5.4) | `RiskReport` |
| | `gig-scorer` | fit + client quality + freshness (§5.5) | `GigScore` |
| | `gig-ranker` | two lists + review (§5.5) | `Ranking` |
| Writing | `evidence-matcher` (reused) | requirements → verified facts | `EvidenceMap` |
| | `proposal-planner` | gig proposal (§7) | `ProposalPlan` |
| | `pitch-planner` + `contract-cv-planner` | contract pitch + 1-page CV | `PitchPlan`, `ResumePlan` |
| | `network-pack-planner` | per-network CV + profile + vetting prep | `NetworkPackPlan` |
| | `bounty-planner` | bounty claim note | `BountyPlan` |
| | `renderer` + `qa-gate` (reused, extended) | PDF / DOCX / plain text, checks | `QaReport` |
| Ops | `source-health` | weekly yield per source (§4.5) | `SourceHealth` |

Every contract is Zod v4, exported to `contracts-out/` and checked by `contracts check`, as in v1.

## 4. Sources: 40 platforms, four channels

"Verified" = a documented public endpoint confirmed during the brainstorm (2026-10-12).
"Probe" = the build's first task must confirm it with a live probe; **a source that fails its
probe moves to channel C (email) or is dropped, and is never replaced by scraping**.

### 4.1 Channel A: public API or feed, no account (17)

| # | Platform | Endpoint | State |
|---|---|---|---|
| 1 | Freelancer.com | `https://www.freelancer.com/api/projects/0.1/projects/active` (skill/job ids, sort by time) | verified |
| 2 | Remotive | `https://remotive.com/api/remote-jobs` (`job_type` contract / freelance / part_time; attribution per its legal notice) | verified |
| 3 | RemoteOK | `https://remoteok.com/api` (attribution and link back required) | verified |
| 4 | We Work Remotely | category RSS: programming, back-end, full-stack, devops | verified |
| 5 | Working Nomads | `https://www.workingnomads.com/api/exposed_jobs/` | verified |
| 6 | Arbeitnow (EU, UK) | `https://www.arbeitnow.com/api/job-board-api`, `https://www.arbeitnow.co.uk/api/job-board-api` | verified |
| 7 | Himalayas | v1 source; contractor / part-time types | in v1 |
| 8 | Jobicy | v1 source; contract / part-time types | in v1 |
| 9 | HN "Freelancer? Seeking Freelancer?" (monthly) | `https://hn.algolia.com/api/v1` (find the thread, read its comments) | verified |
| 10 | HN "Who is hiring" contract / part-time comments | same | verified |
| 11–13 | Greenhouse, Lever, Ashby | v1 watchlist boards, contract / part-time roles | in v1 |
| 14 | Company careers pages | JSON-LD `employmentType` CONTRACTOR / PART_TIME | in v1 |
| 15 | GitHub paid bounties | GitHub search API, open issues labelled bounty / 💎 Bounty (free token) | probe |
| 16 | Algora bounties | public bounty listings | probe |
| 17 | Golang Projects | RSS | probe |

Sources 7, 8 and 11–14 already fetch in the daily run. The freelance run reads the daily run's
stored source outputs for them (read-only, through the kernel store) instead of fetching twice;
when the daily run has not run today, it fetches them itself with the same agents.

### 4.2 Channel B: official API with a key (2)

| 18 | Upwork | GraphQL `marketplaceJobPostingsSearch`, scope "Read marketplace Job Postings – Public"; needs Upwork's approval of the user's key | verified, approval pending |
|---|---|---|---|
| 19 | Reddit r/forhire, r/freelance_forhire, r/remotejs | Reddit API, personal "script" app (OAuth), `[Hiring]` posts only | probe |

Until a key exists, the source is **disabled and says so** in `pack check` and on the dashboard;
Upwork alert emails (channel C) fill in.

### 4.3 Channel C: the user's own alert emails (21)

The user creates Gmail filters that label alerts `jobpilot/gigs`. jobpilot reads **only that label**,
with the Gmail API `gmail.readonly` scope (OAuth token in the macOS keychain, as v1 secrets).

| Vetted networks | Marketplaces | Boards with contract filters |
|---|---|---|
| 20 Toptal · 21 Arc.dev · 22 Contra · 23 Braintrust · 24 Gun.io · 25 Lemon.io · 26 Turing · 27 Flexiple | 28 Upwork (until the API) · 29 Guru · 30 PeoplePerHour · 31 Truelancer · 32 Workana · 33 Freelancermap · 34 Malt · 35 Hubstaff Talent | 36 Wellfound · 37 LinkedIn alerts · 38 Indeed alerts · 39 Naukri / Foundit alerts · 40 Dice |

- One parser per sender, matched by sender address **and** a layout fingerprint. Each parser has
  recorded fixtures and a golden eval.
- An email whose layout is not recognised is **quarantined**, listed under problems with sender
  and redacted subject, and never partially parsed. No generic regex fallback.
- LinkedIn, Indeed and Naukri are read only from emails they send the user, never crawled
  (Rev 5 line, unchanged). Mail is never sent, moved, deleted or marked read.

### 4.4 Pacing and limits

Per-host pacing at or above each platform's documented limit, kept in `platform-rules.yaml`
(Freelancer, Reddit, GitHub, Upwork, Gmail each have their own). No proxies, no CAPTCHA
solving, no spoofing (G-NO-EVASION holds). A 403/429/challenge disables that source for the day
with a named problem.

### 4.5 Source health ("best probability" by measurement)

`source-health` records per source per week: fetched → eligible → ≥ floor → shortlisted, and the
user's outcomes (applied, replied, won). The ranker's freshness term and the dashboard's Sources
page use it. A source with zero yield for 4 weeks, or failing its probe 3 days running, is
flagged in problems ("source X looks dead"), **never silently removed**.

### 4.6 Live validation (2026-10-12): every channel A/B source probed and scored

A probe read every channel A/B endpoint once (polite, sequential, raw responses kept as fixture
candidates) and applied this spec's rules with the user's real lexicon: freelance kind, ≥ 2
strong/medium skills, hours rule (§5.2), India-open (§5.2), pay ≥ $40/h (§5.3). The v1 boards were
measured from the daily catalogue.
Score = access (ok 30, partial 22, key 20, email 10, failed 0) + volume min(30, 30·log(1+relevant)/log(51))
+ India 20·(open + ½ unknown)/relevant + pay 20·(≥$40 + ¼ unknown)/relevant.

| Source | Score | Skill-matched | Relevant (hours ok) | Pass all rules | Review | Verdict |
|---|---|---|---|---|---|---|
| Freelancer.com | 85 | 149 | 147 | 0 | 123 | **keep**: main automated feed; fixed-price needs a budget floor (below) |
| Himalayas (contract types) | 79 | 64 | 49 (15 B2B full-time excluded) | 0 | 49 | **keep**, review-only: no pay stated, recruiter reposts |
| Remotive | 75 | 1 | 1 | 0 | 1 | keep (cheap; public API returns a small delayed subset) |
| HN "Who is hiring" contract/part-time | 48 | 5 | 2 | 0 | 1 | keep (monthly, 2 requests) |
| Arbeitnow DE/UK | 49 | 5 | 5 | 0 | 0 | **park**: onsite/hybrid DE/UK; nothing open to India |
| Greenhouse/Lever/Ashby/careers/Jobicy contract roles | 30–40 | 1 | 1 | 0 | 0 | keep (free: already fetched by the daily run) |
| RemoteOK, We Work Remotely, Working Nomads, Golang Projects | 30 | 0 | 0 | 0 | 0 | **park**: work, but zero relevant contract gigs |
| HN "Freelancer? Seeking freelancer?" | 30 | 0 | 0 | 0 | 0 | keep (monthly; October had 18 comments, all SEEKING WORK) |
| GitHub bounty labels | 30 | 23 | 0 | 0 | 0 | **drop**: top results are spam/test repos (59/100 from one repo), no Algora bot verification in 8/8 sampled; amounts live in bot comments |
| Algora own listing | — | | | | | **drop**: no public JSON (HTML only; scraping is out) |
| Reddit | — | | | | | **blocked**: public JSON 403s; needs the user's OAuth script app |
| Upwork API | — | | | | | **key needed** (approval) |
| Channel C (21 email sources) | — | | | | | **unmeasured** until the Gmail label exists |

Findings that change the build:
- **Freelancer.com's `hourly_project_info.commitment` is a default** (all 77 hourly projects say
  40 h/week), so it is ignored; hours come from the text only, else `unknown` → review.
- **v1 eligibility keeps only its first reject reason**, so a contract-rejected posting carries no
  location verdict; the freelance pipeline must evaluate location itself, never reuse that verdict.
- **"Contract type: B2B" with an annual salary is full-time employment by contract** (e.g. DualEntry,
  $100K–175K, all countries). It fails this pipeline's ≤ 20 h rule. It also means the *full-time*
  pipeline currently rejects such roles as `employment:contract` (decision for the user, §13).
- Fixed-price budgets on Freelancer.com: median $392, 61/166 ≥ $500, 19 ≥ $1,000.
- With today's data, the free automatable sources yield **no gig that passes every rule**; the
  value is concentrated in vetted networks and Upwork (channels B/C). Build order is changed
  accordingly (§12).

## 5. Understanding and evaluation (all deterministic code)

### 5.1 `Gig` schema

`gigKey, sources[] (platform, id, url), title, client {name|null, country|null,
paymentVerified|null, hireRate|null, spendUsd|null, reviews|null, since|null}, kind
(contract|gig|bounty|network-alert), budget {type: hourly|fixed|monthly|unknown, min|null,
max|null, currency|null}, hoursPerWeek {min|null, max|null}, duration {weeks|null, text|null},
timezone {required|null, overlapText|null}, location {countries[], worldwide: bool, text|null},
skills[], description, postedAt|null, bids|null, firstSeen, lastSeen`. Every field is either
copied from the source or `null`; the normalizer never infers a value it was not given.

### 5.2 `gig-eligibility`

Reasons are named, as in v1 eligibility. Reject when:

- **location**: restricted to countries or timezones excluding India. India, worldwide, APAC, or
  anywhere passes. Nothing stated → `review`.
- **hours**: stated over 20 h/week, or "full-time", "40 hours", "dedicated" describing this role.
  Not stated → `review`.
- **overlap**: a window required OF YOU that shares under 2 hours with IST 18:00–00:00 → reject (e.g. "must be
  online 9am-5pm PST" = 22:30–06:30 IST shares 1.5 h). The client's own hours, a rare short sync, "some overlap" and
  "async" never reject. (Corrected 2026-10-12: the earlier example "9–5 EST" shares 4.5 h and passes.)
- **exclusivity**: "must not work other jobs", "exclusive", contract-to-hire with exclusivity.
- **role, company, naming**: v1 `roleDeny`, `companyDeny`; a gig from the user's current
  employer or its client (naming forbidden terms, strict matcher) is rejected.

### 5.3 `rate-normalizer`

| Posting says | Method label | Result |
|---|---|---|
| $50/h, or $40–60/h | `stated` | hourly min/max as given |
| fixed $3,000 and "~60 hours" | `fixed÷stated-hours` | 50 |
| fixed $3,000 and "2 weeks" | `derived-from-duration` (weeks × 20 h cap) | 75, labelled derived |
| fixed with no scope | `unknown` | no rate → review |
| monthly $4,000 part-time 20 h | `monthly÷(hours×4.33)` | 46 |
| ₹ / € / £ | pack FX table (v1), FX date shown | converted |

Decision (2026-10-12): a **derived** rate counts against the $40 floor and is always shown with
its label. `targets.freelance.derivedRateCountsForFloor: true` in the pack, changeable.

### 5.4 `gig-risk`

Fixed rules, each with a named flag: payment unverified (where exposed); asks to move off-platform
or pay outside it; crypto, gift-card or upfront-fee payment; unpaid test task over ~2 h; new client
with no history **and** a brief under 300 characters; posting copied across many clients
(duplicate text, different client). Flags never hide a gig; they warn and lower its rank, and a
flagged gig is never the notification's "top".

### 5.5 `gig-scorer` and `gig-ranker`

- **Fit**: the v1 lexicon formula over skills × evidence (explainable breakdown).
- **Client quality** (only where exposed): payment verified, hire rate, spend, reviews.
- **Freshness / competition**: hours since posting, bid count, source-health yield.
- Lists: **Contracts** (hourly, ≥ 4 weeks), **Gigs** (fixed or < 4 weeks), **Bounties**,
  **Review** (unknown rate / hours / location). Each sorted comp-first above $40/h with fit ≥ 45 (user decision
  2026-10-12: gig titles never earn the full-time title points, so on live data a floor of 60 kept 1 of 51 eligible
  gigs and 45 keeps 13; the daily pipeline's 60 is unchanged);
  ties by postedAt then gigKey. Pure function of stored inputs.

## 6. Pack additions (per user, no personal data in the engine)

`pack/freelance.yaml`: `rateFloorUsdHour: 40`, `maxHoursPerWeek: 20`, `istWindow: "18:00-00:00"`,
`derivedRateCountsForFloor: true`, `kinds: [contract, gig, bounty]`, `platforms: {<id>: {enabled,
query: {skills, categories}}}`. `pack/platform-rules.yaml`: per platform the character limits,
visible-hook length (Upwork ~2 lines), attachments allowed, links allowed, forced questions, pacing.
`pack/networks/<network>.yaml`: that network's screening stages for the vetting checklist (curated
by the user; jobpilot ships starting files marked "check before use"). `pack/answers.yaml` gains
`hourlyRate`, `weeklyAvailability`, `istWindow`, `startDate`.

## 7. Documents (no hallucination by construction)

**Grounding contract, from v1, on every document type:** each claim sentence carries its `factId`s;
G-GROUND / qa-gate fails any sentence without a fact, and any number, employer, skill or year that
does not match the pack verbatim. A requirement without evidence is listed as **missing** ("covered
6/8, missing: Kubernetes, Terraform"), never written around. The naming guard (strict matcher) runs
on every rendered byte of PDF, DOCX and plain text.

| Document | For | Shape |
|---|---|---|
| Gig proposal (plain text) | Freelancer, Upwork, Guru, PPH, Truelancer, Workana | hook that quotes the client's own phrase verbatim → 2–3 evidence lines "did X → result" → 3-step plan from a fixed step library per gig category → availability (≤ 20 h, IST window) → one question about their requirement |
| Contract pitch + CV | board contracts, HN, Wellfound, Arc gigs | 5-line pitch + 1-page contract CV (outcomes first, gig keywords in Skills) |
| Network application pack | Toptal, Arc, Turing, Lemon, Gun.io, Braintrust, Contra, Flexiple | network-tuned CV + headline + summary + vetting-prep checklist |
| Bounty note | GitHub, Algora | approach + files the issue text names + the user's own time estimate field (never invented) |

- **Platform limits from `platform-rules.yaml`** are enforced by qa-gate: over the limit **fails**,
  never silently truncated; the visible hook must fit the platform's preview length.
- Forced screening questions are answered from `answers.yaml`; a missing answer stays blank and
  is flagged.
- **Human wording within determinism**: several hand-written phrasings per template slot, picked by
  a hash of the gigKey (varied across gigs, stable for one gig, replay byte-identical). qa-gate fails
  banned robotic patterns ("Relevant work:", "I am writing to express", bare keyword lists, the
  same opening on two documents of one run).
- **Applied** snapshots the documents exactly as sent (immutable copy, as v1).

## 8. App store, dashboard, CLI, schedule

- **Tables** (app migrations, additive): `gigs`, `gig_sources`, `gig_docs`, `gig_status_history`,
  `gig_runs_summary`, `source_health`, `network_status`. The full-time tables are not touched.
- **Dashboard** `/freelance` (Hono + htmx, 127.0.0.1): tabs Contracts, Gigs, Bounties, Review,
  Networks, Sources. A row shows rate + method label, hours, IST overlap, fit with breakdown, risk
  flags, client signals, age and bids, source link, keyword coverage; documents with copy button,
  `.txt`, PDF, DOCX; fact provenance on hover. Status: new → shortlisted → applied (snapshot) →
  replied → interviewing → won | lost | skipped; every transition logged and kept as an eval label.
- **CLI**: `jobpilot run-freelance [--if-due] [--offline-fixtures]`, `jobpilot sources probe
  [<id>]` (live, never in verify), `jobpilot gmail connect` (OAuth, read-only label),
  `jobpilot upwork connect` (when approved).
- **Schedule**: launchd `com.jobpilot.freelance`, `run-freelance --if-due` at load and every :00 /
  :30, using the catch-up design of 2026-10-12 (`app/due.ts`, generalised per pipeline): owed from
  07:30 and from 19:30 IST, its own attempts file `freelance-attempts.json`, cap 3 failures per
  half-day an hour apart, one "gave up" notice, quiet when offline or when the lock is held.

## 9. Failure handling

- A source that is down is `failed` with a named problem; the others continue.
- Unrecognised email layout → quarantined, named (sender, redacted subject), never parsed.
- 403 / 429 / challenge → that source is off for the day, named; never retried by evasion.
- Upwork without approval, Gmail without consent, GitHub/Reddit without token → the source is
  disabled and says why in `pack check` and on the Sources page.
- Probe failures in 3 consecutive runs (about 1.5 days at twice a day) → "source X looks dead" in problems.

## 10. Testing and evals

- Per agent: unit tests + golden eval ≥ 30 hand-labelled cases, gate exactMatch = 1.000
  (gig-eligibility, rate-normalizer, gig-risk, gig-deduper, every source parser, every email
  parser). User actions (applied, skipped, won) become new labels.
- Per source: recorded fixtures for offline tests; `sources probe` for live checks.
- e2e: offline fixture run of the whole freelance pipeline → rows + documents, **0 forbidden-term
  hits**, every claim sentence grounded, every document within its platform limits.
- Full-time regression: `node --run verify` stays green with its current evals unchanged.
- Before merge: a live first run against the real sources, reviewed with probe scripts.

## 11. Out of this build

Auto-submit of any kind; LLM writing (the next sub-project, "human writing", behind the same
contracts); paid platforms, Connects purchase, paid APIs; Fiverr (seller-listing model, nothing to
read); session-browse of any marketplace.

## 12. Build order (for the plan), re-ordered by the §4.6 validation

1. **Network application packs first** (Toptal, Arc, Braintrust, Contra, Turing, Lemon, Gun.io,
   Flexiple): network-tuned CV + profile + vetting checklist. Highest value, no source code needed.
2. Kernel/app: generalise `due.ts` per pipeline; `jobpilot-freelance` wiring; tables.
3. Freelancer.com source (with the fixed-budget floor), Himalayas + v1-board contract reuse,
   Remotive, HN; normalizer, deduper, rate-normalizer (with evals).
4. Eligibility (location evaluated afresh, hours from text), risk, scorer, ranker (with evals).
5. Writing: platform rules, proposal/pitch/CV planners, renderer/qa-gate extensions.
6. Dashboard `/freelance`, CLI, schedule.
7. Channel C: Gmail connect + per-sender parsers (fixtures from the user's real alert emails).
8. Channel B: Upwork when approved; Reddit when the user creates the script app.
9. Parked sources (§4.6) re-probed monthly by `sources probe`; promoted only when they yield.
10. Live run, probe review, merge.

## 13. Decisions from the validation (user, 2026-10-12)

- **D1: fixed-price budget floor $500.** A fixed-price gig with no stated hours and a budget under
  $500 (USD after FX) is rejected as `budget-below-floor`; at or above it, it is eligible as a gig (judged by
  deliverable; the rate stays labelled `unknown`). Amended 2026-10-12 in Task 6 review: requiring hours would mean
  no fixed-price gig could ever pass. A preset bracket (D1b) or a hedged budget ("budget is flexible") goes to review. `freelance.yaml: fixedBudgetFloorUsd: 500`.
- **D1b (user, 2026-10-12): platform preset brackets are not budgets.** A fixed budget exactly matching a platform
  preset bracket (`platform-rules.yaml: freelancer.presetBrackets`, derived from recordings: same bracket for at least 3
  distinct clients) goes to review with the note `preset bracket - bids may exceed it`, never `budget-below-floor`.
  Found on 2026-10-12: 33 of 91 floor rejects sat at Freelancer's stock ₹12,500–37,500 cap.
  (User decision, 2026-10-13: a preset bracket at or above `fixedBudgetFloorUsd` stays eligible but carries the same
  note and is labelled a preset everywhere: the rate label "preset tier $750–1,500 (client picked a range; bids may
  exceed it)" and the notification's top "preset tier $X–Y".)
- **Role filter on gigs → review (controller, 2026-10-12):** `filters.roleDeny` was written for job titles and misfires
  on gig titles (about 6 of 35 wrong), so for gigs a match is `review` with the pattern named, never a reject.
- **D2: the full-time pipeline accepts full-time B2B contractor roles, labelled.** A posting whose
  only reject would be `employment:contract`, and which states full-time hours or an annual salary
  ("Contract type: B2B", "full-time contractor"), is judged by the normal full-time rules (comp floor,
  fit, remote-India) and carries the badge "B2B contractor: no PF/benefits". Short-term, part-time,
  hourly and contract-to-hire stay rejected. This is a change to `jobpilot-daily` eligibility, built
  as its own first task (plan Task 0) with new golden cases; the existing eligibility eval (n=192)
  must stay at 1.000 apart from the cases this decision deliberately flips, each listed in the
  task.

## 14. freelance-boost (2026-10-14, user-approved scope)

Research: `.superpowers/sdd/freelance-research.md`; report: `.superpowers/sdd/freelance-boost-report.md`.

- **Parsing fixes.** Hours ranges accept "–", "—" and "to" ("10–39 hours per week" is 10–39, not 39). Boards gigs read
  pay from the posting text with the same PAY rule (labelled `budget.from: description`; an annual salary is still no
  budget). "Upto $X/hr" / "up to $X per hour" is a stated ceiling (`budget.bound: ceiling`, rate method
  `stated-ceiling`): below the floor it rejects, at or above it is review `ceiling-only`; it never passes alone. A
  ceiling repeating the top of the one stated range yields to the range; "ranges from $A–$B" is a closed range.
- **D3 (user, 2026-10-14), the one rule change.** A Freelancer.com hourly contract whose stated rate after FX reaches
  `rateFloorUsdHour` and whose text states no per-week hours (and no full-time wording tied to it) goes to Contracts
  with the note "hours not stated; you set them". Kept as they were (user): presets under the budget floor stay in
  review; boards postings with no pay stay in review.
- **Source 7b, `src-himalayas-gigs`.** Himalayas' public JSON API, one search per freelance keyword,
  `employment_type=Contractor,Part Time&country=India`, page 1 only (its robots.txt body disallows `/jobs*&page=`),
  structured hourly/monthly pay labelled `from: platform`, link back to the Himalayas page, its own team.
- **Ranking.** Default freelance keywords are backend/AI terms (no `react`, `python`); a Freelancer gig whose skill
  tags are all off-stack loses 10 fit points (`stack:off`); lists sort by `maxUsdH × fit` after the red-flag rule.
- **Networks.** A catalogue of 13 networks (India eligibility, rates, hours, link, recommended order; Lemon.io not open
  to India) joined to `pack/networks/` by id; one-click "Mark applied", logged as `network.status`.
