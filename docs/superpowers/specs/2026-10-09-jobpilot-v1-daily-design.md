# jobpilot v1: the daily product (sub-projects 2, 3, 5, 6 + scheduler)

Status: approved by the user's instruction "build all, give me final product" (2026-10-09),
on top of the reviewed architecture spec `2026-10-08-jobpilot-architecture-design.md`.

## 1. What the user gets

Every morning at 07:00 IST, with no prompt and no click, the user's Mac:

1. fetches postings from the watchlist's ATS boards and from remote-job feeds;
2. normalises them, and drops any that are not remote-from-India, not full-time, below the
   comp floor, or excluded by role or company;
3. scores the rest with the deterministic lexicon formula;
4. for every job at or above the fit floor, builds a **job-specific resume and cover letter**
   from verified facts only, in the file format that job's ATS parses best;
5. shows all of it on a local dashboard (`http://127.0.0.1:4317`), ranked comp-first;
6. posts a macOS notification: "N new matches, top: score · company · title".

The user's only actions: open the dashboard, read, download the documents, apply on the
company site, and set a status. Applying stays manual in v1, and submission is never
automatic without a per-job approval token (sub-project 7, not in this build).

## 2. The determinism decision

**v1 makes no language-model call anywhere.** Every agent in the pipeline is `deterministic` or `io`.

- The same pack, the same postings and the same code produce the same rows and the same
  document text. Memoised step keys replay unchanged postings at $0 on the next day.
- **No hallucination by construction.** A resume bullet is the verbatim `claim` of a citeable
  fact. A skill appears only if it is in some citeable fact's `tech`. The summary is a fixed
  template whose slots are filled from facts and the pack. G-GROUND checks all three on every
  document and quarantines the job's documents on any miss.
- The LLM agents of the architecture (Claude and Jev scorers, LLM bullet rewriting, resume
  ingest) stay in the roadmap as optional add-ons. Each must pass the same G-GROUND gate.

## 3. User pack

Location `~/.jobpilot/pack/` (override with `JOBPILOT_HOME`). The engine repo holds no personal
data; tests use `tests/fixtures/pack/` (a fictional candidate).

| File | Class | Content |
|---|---|---|
| `contact.yaml` | P1 | name, email, phone, city, links. Read only by the renderer |
| `facts.yaml` | P0 | facts: `id, claim, tech[], employer, role, period (YYYY-MM..YYYY-MM or ..present), kind (experience, cert, education, project), status (verified, user-stated, derived-unverified, user-cannot-confirm, rejected)`. Only `verified` and `user-stated` are citeable |
| `roles.yaml` | P0 | employment history: `employer, title, location, start, end` (resume skeleton) |
| `eligibility.yaml` | P0 | residence `IN`; remote scopes accepted; onsite cities `[]`; employment types `[full-time]` |
| `lexicon.yaml` | P0 | strong, medium and gap groups, each `{key, synonyms[]}` |
| `targets.yaml` | P0 | title patterns, seniority words and points, `minFit: 60`, `maxYearsRequired: 14` |
| `filters.yaml` | P0 | role-title deny patterns, company deny list (services and staffing), employment-type deny words |
| `naming.yaml` | P0 | `employerDisplay` map (source employer string → display name) and `forbiddenTerms[]`; G-NAMING fails any output that contains a forbidden term |
| `offers.yaml` | P2 | `floor: {amount: 1200000, currency: INR, period: year, basis: base}`. Equity is never counted |
| `fx.yaml` | P0 | pinned rates to INR with an `asOf` date; the dashboard warns when `asOf` is more than 30 days old |
| `answers.yaml` | P1/P2 | screening answers (notice, work mode, relocation, CTC). Shown on job pages; never in a document |
| `watchlist.yaml` | P0 | `{company, ats: greenhouse, lever or ashby, slug, hiresInIndia: bool}` |
| `feeds.yaml` | P0 | enabled aggregator feeds |
| `policy.user.yaml` | — | tightening-only overrides (kernel `mergePolicy`) |

`jobpilot pack import` builds the pack once from:
- career-ops `profile/facts.yaml`, with employers rewritten through `naming.yaml` and ids
  re-prefixed so no id carries a forbidden term;
- the resume v5 experience text (roles, contact);
- the Desk `settings/answers`;
- the v2 discovery rules (lexicon, filters, targets, floor);
- the Desk-derived watchlist of 27 boards.

The import fails if the written pack contains any forbidden term. `jobpilot pack check`
validates every file against its schema, exits non-zero on error, and prints the pack hash.

## 4. Kernel extensions (from spec §16.1, rows 2 and 3)

1. **Pack capability.** `ctx.pack` is a deep-frozen read-only view. The supervisor takes `pack`
   and `packHash`, and the step key includes `packHash`, so editing the pack re-runs the
   affected steps the next day. A contract opts in with `capabilities.pack: true`; without it,
   `ctx.pack` is absent.
2. **Strict contract meta-schema.** Unknown keys in a contract spec are rejected.
3. **Spend recorded per attempt**, so a crash between attempts cannot lose cost.
4. **HTTP tool:** `getJson(url)` plus request headers (`accept`, a fixed honest
   `user-agent: jobpilot/0.1 (+local)`), a response size cap (`policy.maxResponseBytes`,
   default 16 MiB; raised from 5 MiB in Task 5 because large Greenhouse boards return up to 10.5 MB unpaged), and a per-host minimum interval (`policy.minHostIntervalMs`, default
   1000 ms, enforced by the broker across agents within a run).
5. **Egress host patterns: not needed in v1.** Every v1 source has one fixed API host, so
   contracts list bare hosts. Patterns move to sub-project 8 (source expansion).
6. **Evals forced offline:** the eval runner gets a fetch provider that throws.
7. **Tracker `keyOf`:** errors are documented and a throw quarantines the step.

## 5. Pipeline

```
DiscoveryRequest@1 ──► src-greenhouse | src-lever | src-ashby | src-<feed>   (io)
                     ──► RawPosting@1 ──► normalizer ──► Posting@1
                     ──► eligibility ──► Eligible@1 (rejections end as Rejected@1)
                     ──► scorer-lexicon ──► Scored@1 (below minFit: terminal BELOW_FLOOR)
                     ──► evidence-matcher ──► Evidence@1
                     ──► resume-planner ──► ResumePlan@1
                     ──► cover-writer ──► CoverPlan@1
                     ──► renderer ──► Rendered@1 (pdf + docx + html preview, sha256s)
                     ──► qa-gate ──► QaReport@1
```

Teams and agents (each has one skill, one output type and one contract):

| Team | Agent | Kind | Output |
|---|---|---|---|
| sourcing | `src-greenhouse`, `src-lever`, `src-ashby`, `src-himalayas`, `src-jobicy`; `src-careers-list` → `src-careers-job` (Playwright, read-only, for career sites without an API) | io | RawPosting@1 (`src-careers-list`: CareerLink@1) |
| understanding | `normalizer` | det | Posting@1 |
| evaluation | `eligibility`, `scorer-lexicon` | det | Eligible@1 / Rejected@1, Scored@1 |
| writing | `evidence-matcher`, `resume-planner`, `cover-writer`, `renderer`, `qa-gate` | det | as above |

**Career-page browsing (`src-careers-list`, `src-careers-job`, Task 5b).** The wiring is:

```
DiscoveryRequest@1 (ats careers) ──► src-careers-list ──► CareerLink@1 ──► src-careers-job ──► RawPosting@1
```

- `src-careers-list` emits one CareerLink per job link.
- `src-careers-job` renders one job page per step.
- CareerLink@1 is `{company, slug, listUrl, url, linkPattern, titleKey, refresh}`. It carries no run date, so an
  unchanged link replays from the store instead of being rendered again, and a removed link stops appearing.
  - `refresh = floor((dayNumber(runDate) + sha256(url) mod 7) / 7)` is a staggered weekly epoch: about a seventh of
    the links re-render each day, and no link is more than 7 days stale.
  - `titleKey` makes a retitled job re-render the next day. It comes from the title element inside the anchor
    (`h1`–`h6`, a class containing "title", or `itemprop=title`), or else the anchor's text, normalised: NFKC,
    lower-cased, with numbers (and a unit letter, as in "3d"), punctuation and relative-time or badge words
    ("posted", "ago", "new", "days", "featured", and so on, but not "remote") removed. Letters and combining
    marks are kept, so Devanagari and other scripts stay intact. So "Posted 3 days ago" does not cause a re-render.
  - Task 8: a re-rendered link re-emits a RawPosting with the same `sourceId`. The projector must treat it as a newer
    version of that posting (an upsert), not as a duplicate.
- A job that is gone fails its own step with the kernel code `gone`, which is non-retryable and never counts
  towards a breaker. It is still a failed step, counted as `gone` in the run report. Gone means any of:
  - the page answers 404 or 410;
  - a redirect lands on the listing's path (any query, such as `?page=2`) or the site root `/`. This is checked
    first, so it holds even when the listing path matches `linkPattern` (`/jobs/` and `^/jobs/`).

  Any other redirect outside `linkPattern` (a login wall, maintenance, a locale prefix) is `invalid_output`, which
  counts towards the breaker. Its message names the target and suggests widening `linkPattern`.

  The API sources use `gone` for "board not found" too.
- Both contracts are built from `careersHosts(watchlist)`.

Rules for the read-only browser:

- *Egress.* The contract's `egress` is the exact list of the watchlist's careers hosts. It governs every
  top-level navigation: the URL, each redirect hop (checked before it is requested), and `finalUrl`.
- *Denied boards.* The policy deny list applies by host and by brand, for http and browser alike:
  - by brand, under any suffix or subdomain: `linkedin`, `naukri`, `indeed`, `glassdoor`;
  - by host: `lnkd.in`, `indeedjobs.com`, `naukrigulf.com` and `licdn.com`.

  The boards' own careers pages (`careers.linkedin.com`, Indeed's careers site) are denied too, so these
  companies cannot be watched as employers.
- *Third-party subresources.* Scripts, styles and data calls (including XHR or fetch POSTs) that the page itself
  makes to other hosts are allowed, so that script-built listings render (Workday searches by POST). They carry
  nothing of the user's:
  - each page gets a fresh browser context with no cookies or storage;
  - requests carry the honest user-agent;
  - the agent can only name a URL;
  - nothing is typed;
  - images, fonts, media, WebSockets, pop-ups and denied hosts are blocked;
  - a non-GET navigation (any form submission) is refused and fails the step (G-READONLY).
- *Challenge stop.* A CAPTCHA or bot wall fails the step with `challenged`, never retried. The provider checks the
  raw document before the page may run, so no challenge script executes or re-requests the page. The broker checks
  the rendered page again. A page is a challenge when any of these holds:
  - **A**, status 403 or 429;
  - **B**, a vendor header: `cf-mitigated: challenge`, DataDome, `x-px-blocked`, or `x-amzn-waf-action`
    captcha or challenge;
  - **C**, a vendor interstitial marker:
    - Cloudflare: `_cf_chl_opt`, or the orchestrate path;
    - the `challenge-form`, `challenge-running` or `challenge-stage` elements;
    - DataDome: `captcha-delivery.com`;
    - PerimeterX: `px-captcha`;
    - Imperva: an incident ID, or the `_Incapsula_Resource?…incident_id=` iframe;
    - AWS: `gokuProps`;
    - Akamai: `/_sec/cp_challenge/` or `sec-if-cpt-container`;
  - **D**, the *whole* `<title>` or first `<h1>`, with any site suffix removed, is a wall phrase ("Just a moment",
    "Access denied", "Security check", and so on), on a short page (under 1,500 characters) with no JobPosting.
    "Security Check Officer" is a job, not a wall;
  - **E**, "captcha" in the visible text of a short page (under 2 KB) that has no JobPosting JSON-LD and no form
    with two or more inputs. A reCAPTCHA inside an apply form is not a challenge.
- *Settling.* Every page is sampled every 1 s and is settled only when 3 equal samples arrive with no document,
  xhr or fetch request in flight:
  - a listing samples its same-host job-link count, waits at least 5 s, and is capped at 45 s per settle;
  - a job page samples its main text length, waits at least 2 s, and is capped at 45 s.
- *Expanding a listing.* After it settles, the provider:
  1. clicks controls one at a time. A control qualifies only if it is a `<button type=button>`, a typeless
     `<button>` whose form owner is null, a `[role=button]`, or an `<a>` with no navigating href; it is never tied to a form (inside one, a `form`
     attribute, submit or reset), never inside a dialog or a cookie or consent banner, and its label matches one
     anchored rule (`load|show|view|see [N] more [jobs…] [(N)]`, `show|view|see all [jobs…] [(N)]`). Every click
     must add *visible* job links: a link with a box, not hidden by CSS, not aria-hidden. Collection still reads
     every job link in the DOM;
  2. scrolls to the bottom while that adds job links (infinite scroll).

  Clicks and scrolls are capped at 50 each and at 150 s of wall time. The agent follows next, "show all" and
  numbered (`page`, `start`, `offset`) links.
- *Loud failures.* Each of these fails the step:
  - a listing still loading at the cap;
  - zero job links;
  - a click that added no jobs;
  - the click, scroll or time cap reached;
  - a control matching the label rule (or a next or numbered pager button) that could not be clicked or followed;
  - an ItemList with fewer items than it announces;
  - more than 6 listing pages;
  - more than 5,000 job links.

  Per job, in that job's own step only: `gone` (described above), any other 4xx, a page still loading at its cap,
  a missing title, and unrendered template text. A click whose script submits a form fails as G-READONLY.
- *Budget arithmetic.* A job page costs at most 10 s (pacing) + 20 s (navigation) + 45 s (settle) = 75 s, and a
  `src-careers-job` step is given 90 s (75 s plus 15 s for the host pacer and starting a context). A listing page
  costs at most 10 + 20 + 45 + 200 s (the 150 s expansion budget plus one last 5 s click and a 45 s settle) = 275 s.
  A `src-careers-list` step reads at most 6 listing pages: 6 × 275 = 1,650 s, under the 30-minute step cap. The
  number of jobs per site is limited only by the 5,000-link cap.

**Fan-out typing.** One agent produces one type, so `eligibility` produces `EligibilityVerdict@1
{verdict: eligible, rejected or review, reasons[]}`. The wiring routes it onward, and the
scorer's `requires` predicate accepts only `eligible` and `review`. Rejected verdicts are
terminal and stored, so the dashboard can show why each job was dropped. The same holds for
`Scored@1`: `evidence-matcher` requires `score >= minFit`.

### 5.1 Normaliser

Per-source mapping:
- HTML to text (entities decoded, block tags become newlines);
- location strings;
- structured remote signals (Lever `workplaceType`, Ashby `isRemote` / `workplaceType`);
- employment type;
- compensation, from structured fields first (Ashby compensation, Lever `salaryRange`), else
  the career-ops comp parser over the text;
- the canonical job key `sha256(company|normTitle|normLocation)`.

### 5.2 Eligibility (deterministic, in order; the first failure ends it)

1. **Closed or missing.** No title or no URL.
2. **Role excluded.** The title matches a filters role-deny pattern.
3. **Company denied.** The company is on the deny list.
4. **Employment type.** The structured type or a text match is contract, intern or temporary.
5. **Remote-from-India.** The posting is eligible when it is:
   - structured remote, with India or APAC in scope or no country restriction, and the
     watchlist says `hiresInIndia`; or
   - a location string matching `remote (india)`-style patterns; or
   - from a company whose watchlist entry is all-remote.

   It is rejected on onsite or hybrid, or on remote restricted to non-India regions
   ("US only", "must be authorized to work in the US", "EU only").

   It goes to `review` when the remote scope is unclear. That matches the v2 rule "keep with
   note: remote scope unclear - verify".
6. **Comp.** A disclosed maximum, converted to INR with `fx.yaml`, is below the floor → reject
   `below-floor:<maxInr>`. This holds for a base figure and for an unknown basis alike: a
   total-type figure (CTC, total comp, OTE, a package, "compensation") is always at least the
   base inside it, so a total whose maximum is below the floor has a base below it too. Pay
   components (variable, bonus, equity alone, allowances) are never comp: the normalizer
   skips them. A kept posting with an unknown basis gets the note "pay basis unclear". An
   open range with no maximum ("from X") is never below the floor. Undisclosed comp passes
   with the note "pay not disclosed".
7. **Experience.** A requirement above `maxYearsRequired` is not a rejection. It is a −20
   applied in the scorer.

### 5.3 Scorer-lexicon (exactly the v2 §6 formula)

| Component | Points |
|---|---|
| Base | 30 |
| Title contains staff, lead, principal, SDE-3 or SDE III | +10 |
| Title contains senior (only when the previous row did not apply) | +8 |
| Title contains backend, platform, java or distributed | +10 |
| Each strong skill present in the JD | +4 |
| Each medium skill present in the JD | +1.5 |
| Each gap skill present in the JD | −4 |
| Required years above 14 | −20 |

Each skill counts once, through its synonyms. The score is rounded half-up to an integer and
clamped to 0–100. The output includes a breakdown table for the dashboard. The v2 worked
example (89) is a unit test.

### 5.4 Writing team (deterministic, grounded)

**evidence-matcher.** JD terms are the lexicon keys found in the JD. Each citeable fact is
ranked by:

```
3 × |fact.tech ∩ JD terms (via synonyms)| + 1 × |claim words ∩ JD terms| + recency (0..1 by period end)
```

It outputs the ranked fact ids per employer, plus covered and missing JD terms.

**resume-planner.**
- **Headline:** the posting's title, normalised into the user's target family, chosen from
  `targets.yaml` titles (never invented).
- **Summary:** a fixed template. `{years}+ years` is computed from `roles.yaml` dates. The
  top 4 covered JD terms come from the skills that are both in the facts and in the JD. The
  most recent display employer completes it.
- **Skills line:** covered terms first, then the remaining citeable facts' tech, deduplicated.
  A gap skill is never listed.
- **Experience:** every role in `roles.yaml`, newest first, with display employer names. For
  each role the top N facts of that employer: 4 for the latest two roles, 2 for the rest.
  Facts stay in rank order, each bullet is the verbatim claim, and the plan stores the
  `factId` on every bullet.
- **Certifications:** facts of kind `cert`.

**cover-writer.** A fixed four-paragraph template:
1. The role, the company and the source.
2. The two highest-ranked facts, verbatim, introduced by a fixed sentence.
3. The third fact plus the covered-term sentence.
4. Availability, notice and remote-from-India, from `answers.yaml`, then a close.

Every sentence is either a template literal or a verbatim fact claim. Each paragraph records
its fact ids.

**renderer.** Contact details (P1) are merged in only here.
- **PDF** via `pdfkit`: built-in Helvetica, a single column, literal `•` bullets, no
  header/footer contact, fixed document metadata so the output is reproducible.
- **DOCX** via `docx`: contact details in the body, no tables or text boxes.
- **HTML preview** for the dashboard.

Files go to `~/.jobpilot/out/<jobKey>/`. Each recommended format comes from the ATS profile
(spec §10): Greenhouse, Lever and Ashby get PDF; Workday, iCIMS and SmartRecruiters get DOCX.
Both formats are always rendered.

**qa-gate.**
- `pdftotext -layout` must contain the planned covered terms.
- Page counts: resume ≤ 2 pages, cover letter ≤ 1.
- No line may end in a hyphen.
- The text extracted from the DOCX (`document.xml`) must match the plan text.

### 5.5 Guardrails added

| Guardrail | Where | Rule |
|---|---|---|
| G-GROUND | out of resume-planner and cover-writer | Every bullet equals a citeable fact's claim, character for character. Every skill-line token is in the union of citeable facts' tech. Summary numbers equal computed values. Paragraph fact ids exist and are citeable |
| G-NAMING | out of every writing agent, and the renderer's text | No `forbiddenTerms` (case-insensitive, word-boundary) |
| G-NO-GAP-CLAIM | out of resume-planner | No gap-group skill appears in the skills line |

Any failure quarantines that job's documents. The job still shows on the dashboard with
"documents blocked: <reason>".

## 6. App store (catalogue)

These are SQLite tables beside the kernel's, in the same DB file `~/.jobpilot/jobpilot.db`.
After each run the projector writes from run outputs:

- `jobs` (job_key PK; company, title, url, ats, location, remote verdict, comp, score,
  breakdown JSON, eligibility verdict and reasons, first_seen, last_seen, status, note);
- `job_sources` (job_key, source, source_id);
- `job_docs` (job_key, kind, format, path, sha256, pages, qa_ok);
- `status_history` (append-only);
- `fact_overrides` (fact_id, status, at), written when the user verifies a fact on the dashboard.

Deduplication happens by `job_key` and also by `(source, source_id)`. Status and note are
user-owned and never overwritten by a run.

Statuses are `new, approved, applied, interview, offer, rejected, skipped`, with free
transitions by the user, each recorded.

`jobpilot migrate desk <dir>` imports the 96 Application Desk rows. Status, note and
applied_at are kept, and `source_id` comes from the doc id prefix. When the daily fetch
re-finds a posting, it attaches to the existing row.

## 7. Dashboard (Hono + htmx, local only, bound to 127.0.0.1)

**Jobs.** Columns:
- the comp band (≥ floor disclosed, undisclosed, review);
- score and title;
- company;
- a remote pill;
- a status pill;
- a documents state (ready, blocked, below floor).

Filters: status, band, minimum score and text. Sort is comp-first: disclosed comp above the
floor by max base descending, then score.

**Job detail.**
- the JD text and the eligibility reasons;
- the score breakdown table;
- covered and missing terms;
- a resume preview (HTML) with each bullet's fact id on hover;
- download PDF, download DOCX and the cover letter, with the recommended format marked;
- the screening answers;
- status buttons and a note field.

**Facts.** Every fact with its status. Verify and Reject buttons write `fact_overrides`, and
the next run picks them up through the pack hash.

**Runs.** The last 14 runs: counts by stage, quarantines with reasons, audit chain status,
and pack and policy hashes.

It is fully readable with JavaScript off. htmx is served from the package (vendored file), not
a CDN.

## 8. CLI and schedule

| Command | Does |
|---|---|
| `jobpilot pack import --career-ops <dir> --resume <file> --desk <dir>` | Builds the pack once |
| `jobpilot pack check` | Validates the pack |
| `jobpilot run [--offline-fixtures <dir>]` | Runs the daily pipeline, the projection and the notification |
| `jobpilot serve [--port 4317]` | Serves the dashboard |
| `jobpilot migrate desk <dir>` | Imports the Desk rows |
| `jobpilot schedule install` / `jobpilot schedule uninstall` | Writes `~/Library/LaunchAgents/com.jobpilot.daily.plist` (07:00 daily) and `com.jobpilot.dashboard.plist` (RunAtLoad, KeepAlive), then `launchctl bootstrap` / `bootout` |

Logs go to `~/.jobpilot/logs/`. The plist runs `node` with an absolute path, the repo
`src/bin.ts` and `--import tsx`, so Volta's pnpm/Node 20 problem cannot apply.

## 9. Testing and evals

- Unit tests for every agent and guardrail, the comp parser port, and the pack schemas.
- Source adapters are tested on recorded fixtures (`tests/fixtures/sources/*.json`) from real
  boards.
- An end-to-end test: fixture pack plus fixture postings → `jobpilot run --offline-fixtures`
  → expected job rows, documents produced, qa ok, grounding 1.0. Running it twice replays.

| Eval set | Gate |
|---|---|
| `eligibility`: ≥ 20 hand-labelled fixture postings | accuracy 1.0 |
| `scorer-lexicon`: worked examples | exact match |
| `grounding`: every generated plan in the e2e | 1.0 |
| `naming` | 0 violations |

A live smoke run (real network, the real pack) happens once at the end of the build. It must
produce rows and documents with no quarantine caused by a bug.

## 10. Out of this build

- LLM agents.
- Big boards (session-browse, Gmail ingest).
- Submit and approval tokens.
- Source expansion.
- MCP.
- Interview and negotiation.
- Plugin SDK.

These follow as later sub-projects.
