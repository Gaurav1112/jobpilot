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
| sourcing | `src-greenhouse`, `src-lever`, `src-ashby`, `src-himalayas`, `src-jobicy`, `src-careers` (Playwright, read-only, for career sites without an API) | io | RawPosting@1 |
| understanding | `normalizer` | det | Posting@1 |
| evaluation | `eligibility`, `scorer-lexicon` | det | Eligible@1 / Rejected@1, Scored@1 |
| writing | `evidence-matcher`, `resume-planner`, `cover-writer`, `renderer`, `qa-gate` | det | as above |

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
6. **Comp.** Disclosed maximum base, converted to INR with `fx.yaml`, is below the floor →
   reject. Undisclosed comp passes with the note "pay not disclosed".
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
