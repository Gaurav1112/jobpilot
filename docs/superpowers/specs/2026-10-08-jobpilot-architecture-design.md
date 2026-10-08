# jobpilot: architecture design

**Status:** draft rev 3, awaiting review · **Date:** 2026-10-08 · **Owner:** the maintainer

jobpilot is a local-first, multi-agent **product** that helps its user land the
best job available to them. The author is the first user; anyone they share it with
runs their own copy. For its first user it discovers the best-paying,
best-fitting **full-time remote roles open to India-based candidates**, scores them
with two independent scorers, generates an evidence-grounded resume and cover
letter for each shortlisted job, presents everything in a local dashboard, and
submits an application **only after a per-job human approval**.

The design goal is reliability through determinism. Every agent is a
specialist with a published contract. A deterministic supervisor routes typed
messages between agents. Every request and response passes deterministic
guardrails. An LLM may be used only inside a leaf agent, for one bounded
judgement, and its output is accepted only after schema and postcondition
checks.

---

## 0. Product architecture

### 0.1 Two planes

| | Public plane (shared) | Private plane (per user, local) |
|---|---|---|
| Data | Job postings, company facts (ATS, remotePolicy, stage), source manifests, disclosed-comp statistics (all P0) | Profile, fact store, user pack, scores, documents, approvals, offers, Gmail, outcomes (P1–P3) |
| Agents | Discovery, normalizer, deduper, source-scout, source health | Prefilter, scorers, ranker, tailoring, QA, approval, submit, tracker, interview, negotiation |
| Runs | On each user's machine; optionally publishes to and pulls from the shared catalogue | Only on the user's machine |
| Determinism | Catalogue snapshots are content-addressed; a run pins the snapshot it used | Same as before: memoised steps, pinned policy |

The boundary between the planes **is** the data-class rule from §8.3: only P0
may cross. The taint labels of §5.5 enforce it, so there is no separate
mechanism to get wrong.

### 0.2 Shared catalogue

A signed, versioned, append-only store of P0 records: `JobPosting@1`,
`Company@1`, `SourceManifest@1`, `CompStat@1`. In v1 it is a file bundle that
can be exported and imported (`jobpilot catalogue export|import`), so sharing
works with no server. A hosted catalogue is a later deployment choice (open
question Q3). Every record carries `contributor`, `signature` and
`contentHash`. Imports are validated by the same guardrails as fetched data,
so the catalogue is never trusted more than the open web.

### 0.3 User pack: everything personal is configuration

```
user-pack/
  profile/facts.yaml        fact store with provenance (only verified/user-stated is citeable)
  eligibility.yaml          residence country, work authorisation, acceptable remote scopes,
                            onsite cities (empty for the user), employment types (FTE)
  lexicon.yaml              STRONG / MEDIUM / GAP skill groups with synonyms (e.g. Java…)
  filters.yaml              role, company and stage deny lists (e.g. services firms, staffing)
  targets.yaml              titles, seniority, minimum fit
  naming-rules.yaml         employer/client naming (e.g. a display name for the employer, never "[client]")
  offers.yaml   (P2)        current offers: base, bonus, equity, vesting → floor + leverage
  answers.yaml              screening-question answer bank
  policy.user.yaml          user policy overrides (see below)
  secrets (OS keychain)     Anthropic key, Jev key, Gmail OAuth token
```

**Two-tier policy.** `policy.product.vN` is immutable and holds the safety
floor: LinkedIn and ToS-banned hosts denied, approval token required for any
submit, grounding required for any claim, P1 never sent to an LLM, the daily
submit cap's maximum. `policy.user.yaml` may **tighten but never loosen** it
(for example, a lower submit cap, more deny-listed companies, a higher
fit floor). The policy engine computes `effective = product ∧ user`, and
boot fails if a user override tries to relax a product rule.

Every guardrail that mentioned the user now reads its values from the user pack:
G-EMPLOYER becomes **G-NAMING** (the user's naming rules), and the comp floor
and "Δ vs best offer" come from `offers.yaml` and are omitted when it is empty.

### 0.4 Source expansion: coverage without a fixed platform list

| Tier | Method | Adapter |
|---|---|---|
| T1 | Public ATS APIs (Greenhouse, Lever, Ashby, Workable, SmartRecruiters, Recruitee, …) | One code adapter per ATS vendor |
| T2 | `schema.org/JobPosting` JSON-LD, sitemaps, RSS/Atom | One generic adapter for all sites |
| T3 | Sites with neither | A declarative `SourceManifest@1` written by `source-scout` |
| T4 | Login walls, ToS bans, CAPTCHA | Refused by the source policy registry |

**Source lifecycle** (a state machine of its own, like a job's):

```
PROPOSED → PROBED → (T1 | T2 detected → ACTIVE)
                  → T3: SYNTHESISED → EVALUATED → APPROVED → ACTIVE
ACTIVE → DEGRADED (health drop) → QUARANTINED → re-synthesise → EVALUATED → …
PROBED → REFUSED (T4: robots.txt disallow, ToS ban, auth wall)
```

- **Proposal.** `company-finder` (search for companies hiring in the user's
  eligible scopes), user input ("add this careers page"), or the catalogue.
- **Probe (deterministic).** Fetches robots.txt and the careers page, then
  fingerprints the ATS (e.g. `boards.greenhouse.io` links, `jobs.lever.co`
  iframes, `myworkdayjobs.com` hosts) and looks for JobPosting JSON-LD. An ATS
  fingerprint means the existing T1 adapter is reused and only a watchlist
  entry is created.
- **Synthesis (LLM, build time only).** `source-scout` writes a manifest:
  list-page URL pattern, pagination rule, detail-page URL pattern, field
  mappings (CSS/JSON paths) to `RawPosting@1`. It never runs at fetch time.
- **Evaluation.** The manifest is executed on recorded pages (≥ 5 list pages,
  ≥ 20 detail pages). Gates: required fields present ≥ 0.98, title/company
  exact on hand-checked samples, no P1 captured. A failing manifest never
  becomes active.
- **Approval.** By the user for their own machine; by the catalogue
  maintainer for publishing to the shared catalogue.
- **Health.** Each run records yield and per-field null rates for every
  source. A drop beyond the threshold (yield −60 % vs the 14-day median, or a
  required field's null rate > 5 %) moves the source to DEGRADED, then
  QUARANTINED, and queues a re-synthesis. A broken source is loud.

Plugin authors can also ship a code adapter through the SDK (§0.6); it goes
through the same evaluation and approval.

### 0.5 New agent families

| Family | Agents | Notes |
|---|---|---|
| Onboarding | `resume-ingest` (llm), `fact-verifier` (human), `pack-builder` (llm → proposal) | Resume → candidate facts with status `extracted` and source spans; the user verifies each one before it can be cited; `pack-builder` proposes lexicon, targets and filters from verified facts, and the user edits and approves |
| Interview | `interview-prep` (llm) | Per approved job: likely questions from the JD, answers grounded in facts (G-GROUND), company research from catalogue facts only |
| Negotiation | `comp-intel` (deterministic), `negotiation-coach` (llm) | `comp-intel` builds market bands from disclosed comp in the catalogue (`CompStat@1`: role, level, scope, currency, n). The coach drafts a negotiation plan using the user's offers as leverage; numbers must come from `offers.yaml` or `CompStat` (G-GROUND-NUM); it drafts and never sends |
| Sources | `source-probe` (deterministic), `source-scout` (llm, build time), `source-health` (deterministic) | §0.4 |
| Interface | `mcp-gateway` | Exposes read tools (`top_jobs`, `explain_job`, `why_rejected`, `run_status`, `eval_report`) and proposal tools (`propose_source`, `propose_fact`). **No approve or submit tool exists**: approval stays in the dashboard. Tool schemas are the contracts' JSON Schemas |

### 0.6 Agent plugin SDK

A plugin is an npm package exporting `{ contract, run }`, plus fixtures and
an eval dataset. `jobpilot plugin add <pkg>`:

1. validates the contract against the meta-schema;
2. runs the wiring compile (types, guarantees ⊆ requirements);
3. checks the plugin asks only for capabilities its `kind` allows (an `io`
   agent cannot request `submit`; only the core submitter is `effect`);
4. runs the plugin's evals and the containment scan;
5. registers it in the user's registry, disabled until the user enables it.

Plugins run in a **worker thread with no ambient authority**: the capability
broker passes in the only tools it may use, and egress is limited to the
hosts its contract lists.

### 0.7 Distribution

One command install (`npx jobpilot init`), which creates the user pack,
stores secrets in the OS keychain, runs onboarding, and installs the daily
schedule (`launchd` on macOS, systemd timer on Linux, Task Scheduler on
Windows). A desktop wrapper is a later option.

---

## 1. Decisions made so far

| # | Decision | Source |
|---|---|---|
| D1 | New repository, from scratch (`~/PersonalProject/jobpilot`). Proven pure functions from `career-ops` (fact store, INR comp parser) are **ported with their tests**, not imported. | User |
| D2 | End action: **auto-submit with per-job approval**. Approval is a signed, single-use token bound to the exact document hashes. | User |
| D3 | Scoring: **dual scorer**. Claude and Jev (TypeSafe AI) sit behind one `Scorer` contract. The scores are fused and disagreement is flagged. The resume is PII-redacted before it goes to Jev. | User |
| D4 | Sources: direct ATS boards, remote aggregators and India-specific feeds (Japan boards dropped by D9). India is covered by Adzuna India, a watchlist of India-remote employers' ATS boards, and a Gmail job-alert ingest. **There is no scraping of Naukri, Wellfound or Instahyre** (their ToS and anti-bot measures). | User ("all that works best") + research |
| D5 | Ranking: **comp-first with a fit floor**. | User |
| D6 | The user's pack holds their current offer (base + RSU) as the best offer; the comp floor is its annualised total comp (A1). Superseded in framing by D17. | User |
| D7 | The current LLM-managed daily discovery is non-deterministic. **This is the problem the design exists to fix**, so routing and state never depend on an LLM. | User |
| D8 | LinkedIn is never scraped and never a submit target. | Standing rule (job-os, linkedin-ops) |
| D9 | **Remote from India only.** No onsite, no hybrid, no Japan. Eligible = remote roles open to India (Remote-India, APAC, or global-remote that hires in India incl. via EOR), **full-time only**. | User, 2026-10-08 |
| D10 | **New local dashboard** (Hono + htmx). The 93 rows from the Application Desk artifact are migrated once; the Desk is retired. | User |
| D11 | The existing Daily Job Discovery's scoring formula and hard filters are kept **as deterministic code** (`scorer-lexicon`, prefilter rules), not as prompt text. | Analysis of handoff doc |
| D13 | **A product, not a personal tool.** Used by the author and anyone they share it with. The engine contains no user-specific data; every personal rule lives in a per-user *user pack* (§0.3). | User |
| D14 | **Deployment: local app per user + optional shared public catalogue.** Personal data (P1–P3) never leaves a user's machine; only public postings and source manifests are shared. | User |
| D15 | Scope adds **guided onboarding, interview prep, offer negotiation, an MCP interface and an agent plugin SDK**. | User |
| D16 | **Coverage must grow without a fixed platform list:** tiered sources plus a source lifecycle with LLM-synthesised manifests that are evaluated and approved before they run (§0.4). | User |
| D17 | A user's current offer is **private user data** used as negotiation leverage and as an optional comp floor, never a product constant. | User correction |
| D18 | **TypeScript on Node 24** (strict, pnpm workspaces). One codebase ships four surfaces: engine, CLI, local dashboard, MCP server. Chosen over Python (rewrite of career-ops/CareerFill code, harder install for non-developers, its guardrail libraries are LLM-based and unneeded) and Go (community Playwright, loses CareerFill's ATS drivers). | User |
| D12 | **Evals are first-class.** Every agent has a golden set, metrics and a release gate; outcomes feed back as labels. | User: "no scope of scoring and evals" |

### Assumptions to confirm (defaults used in this spec)

| # | Assumption | Default |
|---|---|---|
| A1 | The user's RSU grant vests over 4 years | The pack's floor = base + RSU / 4 (**total comp**) |
| A2 | Roles with undisclosed comp | Kept, put in a separate "comp unknown" band, and ranked by fit |
| A3 | Target roles | Senior/Staff/Lead Backend, Platform, or AI/LLM Engineer (Go, Java, TypeScript) |
| A4 | Global-remote roles with no country stated | Eligible only when the company is on the watchlist with `hiresInIndia: true`, else `needs-review` |
| A5 | Daily submit cap | 10 submissions/day, 3 per company per 30 days |
| A6 | Schedule | One daily run at 07:00 IST via macOS `launchd`, plus manual `jobpilot run` |
| A7 | Jev API | A key is available; data retention terms must be read before enabling it (the provider is disabled until confirmed) |
| A8 | LinkedIn job-alert *emails* | Excluded from Gmail ingest unless the user opts in (parsing your own mailbox is not scraping, but it stays off by default) |
| Q1 | Who pays for LLM calls for other users | Each user brings their own Anthropic (and optionally Jev) key |
| Q2 | Who approves T3 manifests for the shared catalogue | The maintainer; users approve for their own machine |
| Q3 | Where the shared catalogue lives later | v1: export/import file bundle, no server |
| Q4 | Market comp data beyond disclosed comp in postings | v1: disclosed comp only (Ashby, Adzuna, prose); no scraping of salary sites |

### 1.1 What the existing Daily Job Discovery taught us

The current system (one LLM session per day, Firecrawl search, Artifact DB "Application Desk", 93 rows) has good rules but non-deterministic execution:

| Step | Why it is non-deterministic | jobpilot replacement |
|---|---|---|
| Discovery via `firecrawl_search` `qdr:d` | Search-engine ranking changes by the hour | Direct ATS board APIs for a watchlist; search only proposes *companies* (`company-finder`) |
| §4 score formula applied by the LLM | All 93 stored scores are integers although `+1.5`/medium skill must give `.5` values; rounding is unspecified and counting is by eye | `scorer-lexicon`: pure function, word-boundary regex, synonym groups, explicit rounding (half-up to integer after summing) |
| §3 hard filters judged from title + snippet | Same posting can be judged differently | Named prefilter rules over normalised fields |
| Soft caps ("~10 searches", "cap ~15") | Interpreted per run | Contract budgets |
| Fresh LLM session is the orchestrator | Every run re-interprets the runbook | Deterministic supervisor |
| Dedupe on raw `(company, title)` | "Sr. Staff SDE" vs "Senior Staff Software Development Engineer" | Normalised dedupe key |
| No evals | Nobody knows if a score of 89 means anything | §15 |

Data findings (2026-10-08): only 10 of 93 rows were remote-India; 23 of 28 approved rows were onsite (20 moved to `skipped`, notes kept). **GitLab postings say "Bangalore, India" but GitLab is all-remote** — text-only location classification is wrong for such companies, so the watchlist carries `remotePolicy`. The 93 URLs yield 26 ATS slugs (16 Greenhouse, 6 Lever, 4 Ashby) that seed the watchlist.

---

## 2. Principles

1. **LLM inside the box, never on the wire.** The supervisor, routing table,
   retries, dedupe, policy and state transitions are plain code. LLM calls
   happen only inside a leaf agent's `run()`.
2. **Contracts are code.** Each agent exports a Zod v4 contract. JSON Schema
   is generated from it. The supervisor routes only by declared message types.
3. **Fail closed, never repair.** Invalid output is rejected and quarantined,
   never coerced into shape.
4. **Memoised and replayable.** `stepKey = sha256(agentId@major + canonicalJSON(input) + policyHash)`.
   A completed step is never re-executed for the same key. A re-run on the
   same day therefore yields byte-identical results.
5. **Least privilege.** Agents receive no raw `fetch`, filesystem or browser
   access. They receive a capability-scoped `ctx` holding only the tools
   their contract grants.
6. **No single point of failure.** Sources are bulkheaded, scorers are
   redundant, each agent has its own circuit breaker, and supervisor state
   lives in SQLite, so a crash resumes instead of restarting.
7. **Grounded or rejected.** No architecture stops a model from writing a false
   sentence. This one guarantees an unsupported sentence never leaves the system:
   every claim cites a verified fact, a deterministic checker verifies it, and
   failure is a rejection, not a warning.
8. **Irreversible actions need a human.** Submit requires a valid approval
   token. No other agent can cause an external side effect.
9. **Everything is auditable.** An append-only, hash-chained event log
   records every step, verdict, cost and policy version.

---

## 3. Technology stack

| Layer | Choice | Why (research 2026-10-08) |
|---|---|---|
| Runtime | Node 24, TypeScript, pnpm | Same ecosystem as job-os, CareerFill and career-ops |
| Orchestration | **Hand-rolled supervisor + SQLite event log** | LangGraph and Mastra checkpoints are not durable execution (Mastra has an open crash-recovery bug, #25187; a LangGraph checkpointer CVE appeared in 2026). Temporal, Inngest and Restate each need a server, which is too heavy for one user. A fixed transition table is maximally deterministic. |
| Contracts | **Zod v4** + `z.toJSONSchema()` | Native JSON Schema export, used by the Anthropic and MCP SDKs. Schemas are MCP-shaped (object-rooted). Metadata borrows A2A Agent Card fields (`skills`, `inputModes`, `outputModes`). |
| Guardrails | Own deterministic pipeline, using a **tripwire pattern** | The mature guardrail libraries are Python-only. Our checks are deterministic anyway. |
| LLM | `@anthropic-ai/sdk`, temperature 0, structured output | Claude-only data boundary except for Jev scoring |
| Second scorer | Jev API (TypeSafe AI) | Typed, explainable match scores (D3) |
| Storage | `better-sqlite3`, WAL mode | Single file, transactional, synchronous, so ordering is deterministic |
| Browser | Playwright (Chromium) | Rendering, submit drivers |
| Documents | `docx` + Playwright print-to-PDF, with a `pdftotext` probe | Follows the resume v5 ATS rules |
| Email | Gmail API, `gmail.readonly` OAuth scope | Job-alert ingest (D4) |
| Dashboard | **Hono + htmx**, server-rendered JSX, bound to 127.0.0.1 | About 47 KB versus 643 KB for Next.js; same process; reads SQLite directly |
| Tests | vitest + Playwright test, recorded HTTP fixtures | Same as the existing projects |

---

## 4. System topology

```
                    ┌──────────────────────── SUPERVISOR (deterministic) ────────────────────────┐
 launchd 07:00 ───▶ │ Contract Registry ─ Routing Table ─ Step Executor ─ Policy Engine ─ Event Log│
                    └───────▲───────────────────────┬───────────────────────────────▲────────────┘
                            │ Envelope<T>            │ Envelope<T>                   │ verdicts
        ┌───────────────────┴──────┐   ┌─────────────▼──────────────┐   ┌────────────┴─────────┐
        │ DISCOVERY (no LLM)       │   │ PROCESSING                 │   │ GUARDRAIL PIPELINE   │
        │ greenhouse lever ashby   │   │ normalize → dedupe →       │   │ in: schema,size,     │
        │ workable smartrecruiters │   │ prefilter → score(lexicon) │   │  inject,egress,budget│
        │ recruitee himalayas      │   │  score(claude) score(jev)  │   │ out: schema,post,    │
        │ remotive remoteok hn     │   │ → fuse → rank → tailor-cv  │   │  pii,ground,ats-text │
        │ adzuna-in gmail-alerts   │   │ → cover-letter → render    │   └──────────────────────┘
        │ company-finder (weekly)  │   │ → qa-gate                  │
        └──────────────────────────┘   └─────────────┬──────────────┘
                                                     ▼
                         DASHBOARD (Hono+htmx) ── human Approve ──▶ ApprovalToken (HMAC)
                                                     ▼
                                  SUBMIT agent (Playwright drivers) ──▶ tracker
```

---

## 5. The contract model

### 5.1 Message types (the shared vocabulary)

Agents never reference each other. They declare which **message types** they
consume and produce. Types are versioned (`JobPosting@1`).

| Type | Produced by | Key fields |
|---|---|---|
| `DiscoveryRequest@1` | supervisor | `sourceId`, `runDate`, `query` (keywords, locations), `cursor?` |
| `RawPosting@1` | discovery agents | `sourceId`, `sourceUrl`, `fetchedAt`, `raw` (verbatim payload), `rawHash` |
| `JobPosting@1` | normalizer | `jobId` (content hash), `company`, `title`, `descriptionText` (sanitised), `location`, `remoteClass` (`remote-india`, `remote-global`, `remote-apac`, `onsite-jp`, `onsite-in`, `hybrid`, `ineligible`), `comp` (`{min,max,currency,period,inrAnnualMin,inrAnnualMax,fxDate,disclosure:'source'|'prose'|'none'}`), `seniority`, `applyUrl`, `ats` (`greenhouse`, `lever`, `ashby`, `workday`, `workable`, `smartrecruiters`, `icims`, `taleo`, `other`), `postedAt` |
| `DedupedJob@1` | deduper | `JobPosting` + `provenance[]` (all sources that listed it) |
| `PrefilterVerdict@1` | prefilter | `jobId`, `pass`, `reasons[]` (rule IDs) |
| `ScoreResult@1` | scorer-claude, scorer-jev | `jobId`, `provider`, `fit` (0–10), `dimensions` (`skills`, `seniority`, `domain`, `stack`), `evidence[]` (JD quote ↔ factId), `gaps[]`, `modelId`, `promptHash` |
| `FusedScore@1` | fuser | `jobId`, `fit`, `providers[]`, `disagreement`, `singleScorer` |
| `RankedJob@1` | ranker | `jobId`, `band` (`above-floor`, `comp-unknown`, `below-floor`), `rank`, `deltaVsBaselineInr`, `rankingVersion` |
| `JobRequirements@1` | jd-analyst | `jobId`, `requirements[]` (`{text, kind:'must'|'nice', jdSpan:{start,end}, terms[]}`), `responsibilities[]` |
| `EvidenceMap@1` | evidence-matcher | `jobId`, `matches[]` (`{requirementId, factIds[], strength}`), `unmatched[]` |
| `ResumePlan@1` | resume-strategist | `jobId`, `headline`, `summaryAngle`, `sectionOrder[]`, `bulletSlots[]` (`{role, factIds[], targetTerms[]}`) |
| `Bullet@1` | bullet-writer | `slotId`, `text`, `factIds[]`, `terms[]` |
| `CritiqueReport@1` | recruiter-critic | `findings[]` (`{slotId?, issue, severity}`) |
| `TailoredResume@1` | writing-lead (assembled) | `jobId`, `sections[]` → `bullets[]` (`{text, factIds[], jdTerms[]}`), `keywordPlan` |
| `CoverLetter@1` | cover-letter | `jobId`, `paragraphs[]` (`{text, factIds[]}`) |
| `RenderedArtifact@1` | renderer | `jobId`, `kind` (`resume`, `cover`), `format` (`pdf`, `docx`), `path`, `sha256`, `pages`, `textLayerProbe` |
| `QaVerdict@1` | qa-gate | `jobId`, `pass`, `checks[]` |
| `ApprovalToken@1` | dashboard (human) | `jobId`, `resumeSha256`, `coverSha256`, `answersSha256`, `expiresAt`, `nonce`, `hmac` |
| `SubmissionResult@1` | submitter | `jobId`, `status` (`submitted`, `needs-human`, `failed`), `confirmation` (screenshot path, confirmation text), `driver`, `atsHost` |

### 5.2 Agent contract (one per agent)

```ts
export const ScorerClaudeContract = defineContract({
  id: 'scorer-claude',
  version: '1.0.0',                    // semver; major is part of stepKey
  description: 'Scores job fit 0-10 against the verified fact store',
  skills: ['job-fit-scoring'],         // A2A-style metadata
  consumes: 'DedupedJob@1',
  produces: 'ScoreResult@1',
  kind: 'llm',                         // 'deterministic' | 'llm' | 'io' | 'human' | 'effect'
  preconditions: ['job.prefilter.pass === true', 'facts.verifiedCount > 0'],
  postconditions: ['fit in [0,10]', 'every evidence.factId exists', 'evidence.length >= 3'],
  capabilities: { llm: { model: 'claude-sonnet-5-5', maxTokens: 1500 } },
  egress: ['api.anthropic.com'],
  dataClasses: { in: ['P0', 'P2'], out: ['P0'] },   // see §8.3
  budget: { usdPerCall: 0.02, usdPerRun: 1.50 },
  timeoutMs: 45_000,
  retry: { max: 2, on: ['rate_limit', 'overloaded', 'timeout'], backoffMs: [2000, 8000] },
  breaker: { consecutiveFailures: 5 },
  guardrails: { in: ['G-SCHEMA', 'G-INJECT', 'G-PII-EGRESS'], out: ['G-SCHEMA', 'G-POST', 'G-GROUND-SCORE'] },
});
```

### 5.3 How contracts are shared and passed on (no single point of failure)

1. **Registration.** At boot, every agent module exports its contract. The
   **Contract Registry** loads all of them, validates each with a meta-schema,
   computes `contractHash = sha256(JSON Schema of in/out + policy fields)`,
   and stores a snapshot in the `contracts` table.
2. **Wiring compile.** `pipeline.v1.ts` declares edges by type
   (`DedupedJob@1 → [scorer-claude, scorer-jev]`). The registry checks at boot
   that every edge connects a producer of type T to a consumer of exactly
   T@major, and that **the producer's postconditions imply the consumer's
   preconditions** (§5.5). It also checks that every consumed type has at least one producer,
   and that the graph is acyclic apart from declared retry loops. **A wiring
   error stops boot.** Nothing runs half-wired.
3. **Envelope carries the contract.** Every message travels in an
   `Envelope<T>` that names its producer and the producer's `contractHash`.
   The receiving step verifies the hash against the registry. If a producer
   changed its output without bumping its version, the hash mismatch
   quarantines the message.
4. **Redundancy by declaration.** When several agents produce the same type
   (12 discovery agents produce `RawPosting@1`; three scorers produce
   `ScoreResult@1`), the supervisor treats them as interchangeable providers.
   If one fails or its breaker opens, the run continues with the rest, and the
   gap is recorded (`source_health`, `FusedScore.singleScorer`).
5. **Contract drift check.** A vitest snapshot of every generated JSON Schema
   lives in `contracts-out/`. CI fails if a schema changed but the contract
   version did not.

### 5.4 Envelope

```ts
type Envelope<T> = {
  envelopeId: string;        // sha256(stepKey + ':' + index), deterministic
  runId: string; stepKey: string;
  type: string; typeVersion: number;
  producer: { agentId: string; version: string; contractHash: string };
  parents: string[];         // envelopeIds this was derived from (lineage)
  payload: T;
  guardrails: { id: string; verdict: 'pass' | 'warn' | 'trip'; detail?: string }[];
  cost: { usd: number; inputTokens: number; outputTokens: number };
  policyVersion: string;
};
```

### 5.5 Handoff protocol: what one agent passes to the next

An agent never hands over a bare payload. The envelope carries four things the
next agent inherits, and the supervisor enforces all four deterministically:

1. **Guarantees (postconditions as named predicates).** Each contract lists
   the predicates it guarantees, e.g. `remote.eligible`, `comp.normalised`,
   `text.sanitised`, `claims.grounded`. A consumer lists the predicates it
   requires. At boot the registry checks `consumer.requires ⊆ producer.guarantees
   ∪ supervisor.guarantees` for every edge, so a consumer can never be wired
   behind a producer that does not promise what it needs. At run time the
   predicates are re-evaluated on the actual payload (G-POST on the producer,
   preconditions on the consumer), so a promise is checked twice.
2. **Data-class labels (taint).** Every field carries its class (P0–P3). The
   output of an agent inherits the highest class of its inputs unless the
   agent is a declared *redactor* (only `pii-redactor` and the renderer may
   lower a class). The broker refuses any egress call whose payload class is
   not allowed for that host. Personal data cannot leak by forgetting.
3. **Obligations.** Policy obligations that travel downstream and must be
   discharged by a named later agent, e.g. `must-cite-facts` (discharged by
   G-GROUND in qa-gate), `needs-human-approval` (discharged only by an
   ApprovalToken), `attribution-required` (Remotive, RemoteOK; discharged by
   the dashboard showing the source). A job cannot reach a terminal success
   state with an undischarged obligation.
4. **Policy and contract pins.** `policyHash`, the producer's `contractHash`
   and the `rankingVersion` are pinned on the envelope. A consumer running
   under a different policy hash rejects the envelope (G-LINEAGE), so one run
   never mixes two policies.

```ts
type Handoff = {
  guarantees: Predicate[];              // e.g. ['remote.eligible','text.sanitised']
  labels: Record<string, 'P0'|'P1'|'P2'|'P3'>;   // per JSON path
  obligations: { id: string; dischargedBy: string; discharged: boolean }[];
  pins: { policyHash: string; contractHash: string; rankingVersion: string };
};
```

---

## 6. The supervisor

### 6.1 Step execution algorithm (identical for every agent)

```
execute(agentId, inputEnvelope):
  1  contract  = registry.get(agentId)                       // fail if unknown
  2  verify inputEnvelope.producer.contractHash              // G-LINEAGE
  3  check contract.preconditions(input)                     // deterministic predicates
  4  run input guardrails in declared order                  // first trip → quarantine
  5  stepKey = sha256(agentId@major, canonical(input), policyHash)
  6  if steps[stepKey].status == done → return stored envelopes   // replay
  7  policy.check(budget, rate, breaker, egress, sideEffects)       // may defer or deny
  8  ctx = capabilityBroker.issue(contract)                  // only the granted tools
  9  out = await agent.run(input, ctx) with AbortSignal.timeout(contract.timeoutMs)
 10  parse out with contract.produces schema                 // no coercion
 11  check postconditions + output guardrails
 12  in ONE SQLite transaction: write envelopes, step=done, events (hash-chained), cost ledger
 13  route: for each edge in routingTable[produces] → enqueue(consumer, envelope)
```

Errors are classified as `retryable` (rate limit, timeout, 5xx), `invalid`
(schema or postcondition failure, which is never retried with the same input)
or `policy` (denied). Retry jitter is seeded from `stepKey`, so retry timing
is deterministic as well.

### 6.2 Run lifecycle

`run.start(date)` takes an FX snapshot, freezes the policy and ranking
versions, then fans out `DiscoveryRequest`s with **bulkhead concurrency**
(max 4 sources in flight, max 2 requests per host). Downstream stages are
work queues drained in a **total order** (`ORDER BY stage, jobId`), so
processing order never depends on network timing. `run.finish` writes a run
report (counts per stage, trips, cost, source health).

### 6.3 Job state machine

```
DISCOVERED → NORMALIZED → DEDUPED ─┬→ PREFILTER_REJECTED (terminal)
                                   └→ PREFILTERED → SCORED → RANKED ─┬→ PARKED (below cutoff)
                                                                     └→ SHORTLISTED (top N/day)
SHORTLISTED → TAILORED → RENDERED → QA_PASSED → AWAITING_APPROVAL
AWAITING_APPROVAL ─┬→ APPROVED → SUBMITTING ─┬→ SUBMITTED → TRACKING
                   │                         ├→ NEEDS_HUMAN (captcha / account wall)
                   │                         └→ SUBMIT_FAILED
                   ├→ DECLINED (user)
                   └→ EXPIRED (token TTL or posting closed)
any state ── guardrail trip ──▶ QUARANTINED (visible in dashboard, manual release)
QA failed ──▶ TAILORED (one regeneration with failure feedback) ──▶ QUARANTINED on second fail
```

Transitions are a static table. A transition not in the table throws.

### 6.4 Resilience

| Mechanism | Behaviour |
|---|---|
| Crash resume | `jobpilot run --resume <runId>` skips `done` steps and re-queues `running` steps whose lease expired |
| Circuit breaker | Per agent, per run: N consecutive failures open the breaker; consumers proceed with the remaining providers |
| Scorer fallback | Three providers of `ScoreResult@1`. Any one down → fuse the rest and show a badge. Claude and Jev both down → `scorer-lexicon` alone (`lexiconOnly=true`), so ranking never stops |
| Source isolation | A failing source never blocks the others; `source_health` shows the last success and error class |
| Dead letter | `QUARANTINED` jobs keep the failing envelope and the guardrail detail |
| Budget | A hard daily USD cap. Reaching it stops new LLM steps but lets deterministic steps finish |

---

## 7. The agents: specialist teams

### 7.1 Specialisation rule

**One agent = one skill, one output type, one knowledge base, one eval set.** If an
agent's description needs "and", it is split. The same agents serve every user;
only the user pack they read differs. An agent specific to one person is a design
bug.

Small, bounded LLM tasks are also the main defence against hallucination:
"rewrite this one bullet from facts F12 and F31 to include *event-driven*" leaves
the model almost nothing to invent.

### 7.2 Hierarchical supervision

Agents are grouped into **seven teams**, each run by a **team lead**. A lead is a
deterministic sub-supervisor. Its *skill* is a static playbook: a fixed sub-graph
of its specialists, a team contract, and a team breaker. The top supervisor routes
between teams; each lead runs its specialists through the same 13-step executor
(§6.1). A team's contract states what the whole team guarantees, e.g. the writing
team guarantees `claims.grounded` and `ats.parseable` on everything it emits.

```
                                SUPERVISOR
   ┌─────────┬──────────────┬────────────┬───────────┬──────────┬─────────┬──────────┐
 sourcing  understanding  evaluation    writing      ops        career    platform
   lead       lead          lead         lead        lead        lead     (services)
```

### 7.3 Roster

Kinds: **det** deterministic code · **llm** one bounded model call · **io**
external read · **human** · **effect** external side effect. v1 = in the first
releases (sub-projects 1–6); later = sub-projects 7–11.

#### Team A: Sourcing (lead `sourcing-lead`: today's source plan, quotas, bulkheads)

| Agent | Kind | Expertise (its knowledge base) | Output | When |
|---|---|---|---|---|
| src-greenhouse | io | Greenhouse board API, `content=true`, board tokens | RawPosting | v1 |
| src-lever | io | Lever postings API, EU host, commitment fields | RawPosting | v1 |
| src-ashby | io | Ashby posting API, `includeCompensation` | RawPosting | v1 |
| src-workable · src-smartrecruiters · src-recruitee | io | Each vendor's public posting endpoint | RawPosting | v1 |
| src-jsonld | io | schema.org `JobPosting`, sitemaps, RSS (T2, any site) | RawPosting | v1 |
| src-himalayas · src-remotive · src-remoteok | io | Each aggregator's API, attribution terms | RawPosting | v1 |
| src-hn | io | HN "Who is hiring" comment-header grammar | RawPosting | v1 |
| src-adzuna | io | Adzuna query building, 250/day quota | RawPosting | v1 |
| src-gmail-alerts | io | Alert-email templates per sender (Naukri, Instahyre, Wellfound…) | RawPosting | later |
| src-manifest-runner | io | Executes approved T3 manifests | RawPosting | later |
| company-finder | io | Finding companies that hire in the user's eligible scopes | WatchlistProposal | later |
| source-probe | det | robots.txt, ATS fingerprints, JSON-LD detection | SourceProbe | later |
| source-scout | llm | Writing declarative manifests (build time only) | SourceManifest | later |
| source-health | det | Yield and field-completeness baselines | SourceHealth | v1 |

#### Team B: Understanding (lead `understanding-lead`)

| Agent | Kind | Expertise | Output | When |
|---|---|---|---|---|
| jd-sanitizer | det | Hidden text, zero-width characters, injection markers | SanitisedText | v1 |
| jd-parser | det | Title normalisation, seniority ladders, years required, employment type | ParsedJob | v1 |
| jd-analyst | llm | Separating must-have from nice-to-have; **every requirement quotes a JD span** | JobRequirements | v1 |
| remote-classifier | det | Remote scopes, company `remotePolicy`, location strings | RemoteScope | v1 |
| comp-normalizer | det | Lakh/crore/LPA, ranges, periods, pinned FX, disclosure source | Compensation | v1 |
| company-profiler | det | Stage, size, services/staffing lists, catalogue company facts | CompanyProfile | v1 |
| deduper | det | Cross-source identity, provenance merge | DedupedJob | v1 |

#### Team C: Evaluation, a judge panel (lead `evaluation-lead`)

| Agent | Kind | Expertise | Output | When |
|---|---|---|---|---|
| eligibility-judge | det | Product filters + the user's eligibility and filters (named rules) | EligibilityVerdict | v1 |
| scorer-lexicon | det | The user's lexicon formula | ScoreResult | v1 |
| scorer-claude | llm | Semantic fit of JobRequirements against fact summaries | ScoreResult | v1 |
| scorer-jev | io | Jev match API (redacted) | ScoreResult | v1 |
| score-fuser | det | Eval-calibrated weights, disagreement | FusedScore | v1 |
| ranker | det | ranking version, bands, total order | RankedJob | v1 |

#### Team D: Application writing (lead `writing-lead`; team guarantees `claims.grounded`, `ats.parseable`)

| Agent | Kind | Expertise | Output | When |
|---|---|---|---|---|
| evidence-matcher | llm | Mapping each requirement to the user's verified facts; deterministic candidate retrieval, model only ranks and must cite | EvidenceMap | v1 |
| resume-strategist | llm | Narrative plan: headline, summary angle, section order, which roles to expand | ResumePlan | v1 |
| bullet-writer | llm | Rewriting **one bullet per call** from 1–3 cited facts with target terms | Bullet | v1 |
| keyword-planner | det | Must-have term coverage; tells bullet-writer what is still missing | KeywordPlan | v1 |
| recruiter-critic | llm | Reading the draft as a recruiter; typed findings; one revision round | CritiqueReport | v1 |
| fact-checker | det | Per-claim grounding verdicts (G-GROUND, G-NAMING, G-PII-OUT) | FactCheckReport | v1 |
| cover-letter-writer | llm | Three or four paragraphs, each citing facts and requirements | CoverLetter | v1 |
| screening-answerer | det + llm | Answer bank lookup; model only for free-text questions, grounded | ScreeningAnswers | v1 |
| ats-formatter | det | Per-ATS file rules (DOCX for Workday/Taleo, text-layer PDF elsewhere), the v5 template rules | RenderedArtifact | v1 |
| qa-gate | det | Text-layer probe, pages, hyphen breaks; the team's final check | QaVerdict | v1 |

#### Team E: Application ops (lead `ops-lead`)

| Agent | Kind | Expertise | Output | When |
|---|---|---|---|---|
| approval-desk | human | Presents the diff, mints the token | ApprovalToken | v1 |
| form-mapper | det | Widget classification by accessible name (ported from CareerFill) | FormPlan | v1 |
| driver-greenhouse · driver-lever · driver-ashby | effect | Each ATS's form flow | SubmissionResult | v1 |
| assist-workday · assist-icims | effect | Prefill, then hand over to the user | SubmissionResult | later |
| confirmation-verifier | det | Confirmation page text and confirmation emails | Confirmation | v1 |
| tracker | det | Application state and history | — | v1 |
| follow-up-planner | llm | Drafting day-7 and day-14 follow-ups (never sends) | FollowUpDraft | later |

#### Team F: Career (lead `career-lead`)

| Agent | Kind | Expertise | Output | When |
|---|---|---|---|---|
| company-researcher | llm | Company brief from catalogue facts and cited public pages | CompanyBrief | later |
| interview-prep | llm | Likely questions and fact-grounded answers per job | InterviewPack | later |
| comp-intel | det | Market bands from disclosed comp (n ≥ 5) | CompBands | later |
| negotiation-coach | llm | Negotiation plan using the user's offers as leverage; every number cited | NegotiationPlan | later |

#### Team G: Platform services

| Agent | Kind | Expertise | Output | When |
|---|---|---|---|---|
| resume-ingest | llm | Extracting candidate facts with source spans | CandidateFacts | v1 |
| fact-verifier | human | User confirms or edits each fact | VerifiedFacts | v1 |
| pack-builder | llm | Proposing lexicon, targets and filters from verified facts | PackProposal | v1 |
| eval-runner · online-eval | det | Golden sets, gates, outcome labels | EvalReport | v1 / later |
| mcp-gateway | io | Read and propose tools for Claude | — | later |

**Totals:** 7 teams, about 60 specialists. 15 make an LLM call, each with
one bounded task. Only the 3 v1 drivers (plus 2 later assistants) have an
external side effect, and all of them require an ApprovalToken.

### 7.4 One job's path through the specialists

```
sourcing-lead → src-greenhouse → RawPosting
understanding-lead → jd-sanitizer → jd-parser → jd-analyst → remote-classifier
                   → comp-normalizer → company-profiler → deduper → DedupedJob + JobRequirements
evaluation-lead → eligibility-judge → scorer-lexicon (≥60?) → scorer-claude ∥ scorer-jev
                → score-fuser → ranker → RankedJob (shortlisted)
writing-lead → evidence-matcher → resume-strategist → bullet-writer ×N ⇄ keyword-planner
             → recruiter-critic → bullet-writer (one revision) → fact-checker
             → cover-letter-writer → screening-answerer → ats-formatter → qa-gate
ops-lead → approval-desk (you) → form-mapper → driver-greenhouse → confirmation-verifier → tracker
```

About 25 specialists touch one shortlisted job. Each hands the next a typed
envelope carrying its guarantees, labels, obligations and pins (§5.5).

## 8. Guardrails and governance

### 8.1 Guardrail catalogue

Every guardrail is a pure function `(envelope, contract, policy) → {verdict, detail}`.

| ID | Where | Check |
|---|---|---|
| G-SCHEMA | in + out | Zod parse with the contract schema; unknown keys rejected (`strict`) |
| G-LINEAGE | in | The producer's `contractHash` matches the registry |
| G-SIZE | in | Payload and string-length limits (JD ≤ 60 KB) |
| G-INJECT | in (any agent reading external text) | Strips zero-width characters, HTML comments, hidden-CSS text and `<script>`; normalises Unicode (NFKC); flags imperative patterns ("ignore previous", "you are", "system:"). Flagged JDs are still processed, but always fenced and marked |
| G-EGRESS | io | Every URL host must appear in the contract's `egress` list (enforced in the broker's `http` tool) |
| G-PII-EGRESS | before any third-party call | Data-class check (§8.3); P1 fields replaced by placeholders |
| G-BUDGET / G-RATE | before the call | Per-call, per-agent and per-run USD and token caps; per-host request rate |
| G-POST | out | Contract postconditions |
| G-GROUND | out (tailor, cover) | Every bullet has ≥ 1 `factId`; each fact exists and has status `verified` or `user-stated`; every number, employer, date and skill token in the text appears in the cited facts; unknown skill tokens fail |
| G-GROUND-SCORE | out (scorers) | The evidence quotes are substrings of the JD; the factIds exist |
| G-NAMING | out | The user's naming rules (e.g. the employer under its display name; "[client]" never appears) |
| G-GROUND-NUM | out (negotiation, interview) | Every number cites `offers.yaml`, a fact, or a `CompStat` record with n ≥ 5 |
| G-POLICY-MONOTONIC | boot | User policy may only tighten product policy |
| G-PLUGIN-CAPS | plugin add | A plugin's requested capabilities fit its kind; egress hosts declared |
| G-SOURCE-POLICY | probe | robots.txt allows; host not on the T4 refusal list |
| G-PII-OUT | out | No phone number or home address in LLM text; the email address only in the contact header |
| G-ATS-TEXT | qa | `pdftotext -raw` keyword probe finds all planned JD terms; no line ends in a hyphen; page count ≤ 2; DOCX has no tables, text boxes or header contact |
| G-DISAGREE | fuser | Provider disagreement > 2 points → `needs-review` badge, no auto-shortlist |
| G-APPROVAL | submit | HMAC valid, unexpired (72 h), nonce unused, the artifact hashes on disk match the token |
| G-DENY-DOMAIN | submit | Apply host not on the deny list (`linkedin.com`, `naukri.com` etc.) |
| G-SUBMIT-CAP | submit | ≤ 10/day, ≤ 3 per company per 30 days, never the same jobId twice |
| G-CONTAINMENT | CI | Submit-capable patterns (`click` on submit buttons, `form.submit`, apply POSTs) exist only under `src/agents/submit/` |

### 8.2 Policy as code

`policy/policy.v1.ts` is a typed object. It is hashed at boot, and every event
records the hash. The policy holds: comp baseline and floor, ranking weights
version, budgets, rate limits, egress allowlists, deny domains, submit caps,
data-class permissions, the approval TTL and the shortlist size. Changing
policy means a new version file. Old runs keep replaying under their own
policy.

### 8.3 Data classification

| Class | Contents | Allowed to reach |
|---|---|---|
| P0 | Public job data, skills, project descriptions | Claude, Jev, local |
| P1 | Phone, personal email, address, date of birth | Local renderer, and the target ATS during an approved submit. **Never an LLM or Jev.** |
| P2 | Offer details (e.g. a current offer), current salary | Local ranker and negotiation coach (the coach sees offers only as placeholders the renderer fills locally) |
| P3 | Gmail message bodies | Local parser; only the extracted JD text (P0) moves on |

### 8.4 Audit

Each `events` row stores `prevHash` and `hash = sha256(prevHash + row)`.
`jobpilot audit verify` walks the chain. The dashboard shows each job's full
lineage: sources → scores → documents → approval → submission.

---

## 9. Ranking formula (`ranking.v1`)

```
eligible   = prefilter.pass && lexicon.score >= 60 && fused.fit >= 7.0 && !needsReview
compTC     = annualMax ?? annualMin                  // total comp in the user's currency, pinned FX
floor      = userPack.offers.bestTotalComp ?? userPack.targets.compFloor   // the user's floor
band       = compTC == null ? 'comp-unknown' : floor == null || compTC >= floor ? 'above-floor' : 'below-floor'
order      = band ASC (above-floor, comp-unknown, below-floor),
             compTC DESC NULLS LAST, fused.fit DESC, postedAt DESC, jobId ASC   // total order
shortlist  = first 8 per day from above-floor + top 4 comp-unknown with fit >= 8
deltaVsBestOffer = floor ? compTC - floor : null   // shown only if the user has an offer
```

---

## 10. Resume and cover letter per platform

Research finding: most ATSs license the same few parsers (Textkernel,
Daxtra, RChilli), so a different *layout* for each ATS is mostly a myth. What
really differs is the file format, the handling of headers and footers, and
the screening questions. Therefore:

- **Content** is tailored per job: JD terms placed in fact-grounded bullets.
- **Format** is chosen per ATS profile (`ats-profiles.v1.ts`):

| ATS | File | Notes |
|---|---|---|
| Workday, Taleo | DOCX | Contact details in the body, never a Word header |
| iCIMS, SmartRecruiters | DOCX | Textkernel parser |
| Greenhouse, Lever, Ashby, Workable | PDF (text layer) | Single column, Arial, literal `•` bullets |
| Unknown | PDF + DOCX both kept | |

- **Screening answers** come from a deterministic answer bank (notice period,
  visa, location, expected comp), filled in per driver. Free-text questions
  are generated by the LLM, grounded in facts, and shown at approval.

---

## 11. Data model (SQLite)

`runs` · `steps(stepKey PK, runId, agentId, contractVersion, status, attempts, leaseUntil, error)` ·
`envelopes(envelopeId PK, stepKey, type, payload JSON, guardrails JSON)` ·
`events(seq PK, runId, kind, data JSON, policyHash, prevHash, hash)` ·
`jobs(jobId PK, state, band, rank, updatedAt)` · `contracts(agentId, version, hash, schema JSON)` ·
`artifacts(sha256 PK, jobId, kind, format, path)` · `approvals(nonce PK, jobId, hashes, expiresAt, usedAt)` ·
`submissions` · `fx_rates(date, ccy, rate)` · `cost_ledger` · `outcomes(jobId, label, at)`

Public plane (separate SQLite file, exportable): `catalogue_postings` · `companies(slug, ats, remotePolicy, hiresIn[], stage)` · `source_manifests(id, version, tier, status, signature)` · `source_health(sourceId, runId, yield, nullRates)` · `comp_stats` · `catalogue_snapshots(hash, createdAt)`

---

## 12. Dashboard

Hono + htmx on `127.0.0.1:4317`.

- **Today:** run summary, source health, spend, quarantine count.
- **Jobs:** table sorted by rank, with chips for band, Δ vs best offer (when the user has one), fit,
  disagreement, ATS and sources. Filters for remote class and band.
- **Job detail:** JD (sanitised), both scores with evidence, the tailored
  resume diff against master, the cover letter, screening answers, lineage.
  Actions: **Approve**, **Decline**, **Regenerate**.
- **Applications:** submitted, needs-human and follow-ups due.
- **Evals:** per-agent scorecards (§15), trend per release, calibration curve.
- **Contracts:** the live registry, the wiring graph and each agent's
  breaker state.
- **Audit:** chain verification and the event stream.

---

Migration: the 93 Application Desk rows are imported once (status, notes,
applied dates kept) and re-scored by `scorer-lexicon` so old and new scores
can be compared side by side.

## 13. Repository layout

```
jobpilot/
  src/
    kernel/        registry.ts supervisor.ts executor.ts envelope.ts memo.ts breaker.ts
                   broker.ts clock.ts canonical.ts errors.ts state-machine.ts
    contracts/     types/*.ts (message types) define-contract.ts
    guardrails/    one file per guardrail ID + pipeline.ts
    policy/        policy.v1.ts ranking.v1.ts ats-profiles.v1.ts pipeline.v1.ts
    agents/        discovery/* normalize/ dedupe/ prefilter/ score/{claude,jev,fuser}/
                   rank/ tailor/{resume,cover}/ render/ qa/ submit/{drivers/*} track/
    providers/     anthropic.ts jev.ts gmail.ts http.ts browser.ts
    facts/         ported from career-ops (schema, store) + profile/facts.yaml
    store/         db.ts migrations/ repos/
    evals/         runner.ts metrics.ts gates.ts judges/ datasets/<agent>/*.jsonl
    dashboard/     app.tsx views/*
    cli.ts
  contracts-out/   generated JSON Schemas (snapshot-tested)
  config/          watchlist.yaml answers.yaml
  tests/           unit/ contract/ guardrails/ replay/ fixtures/http/ e2e/
```

---

## 14. Testing strategy

| Layer | What it proves |
|---|---|
| Unit | Pure functions: comp parsing, remote classification, dedupe keys, ranking total order |
| Guardrail | Each guardrail has a passing case and a tripping case, including real injection samples hidden in JDs |
| Contract | JSON Schema snapshots; each wiring edge type-checks; drift without a version bump fails |
| Replay | Running the recorded fixtures twice gives byte-identical `jobs` and `envelopes` tables (**the determinism test**) |
| Chaos | Kill the process mid-run, then resume: no step runs twice. Fail one scorer: the run completes with `singleScorer` |
| Driver e2e | Submit drivers run against locally served copies of Greenhouse, Lever and Ashby forms; **never against a live employer in tests** |
| Containment | G-CONTAINMENT scan in CI |

---

## 15. Evals and agent scoring

Every agent is scored, not only every job. An eval is a dataset, a metric and a
threshold. A release that drops any metric below its gate does not ship.

### 15.1 Offline evals (golden sets, run in CI and on demand: `jobpilot eval`)

| Agent | Golden set | Metric | Gate |
|---|---|---|---|
| normalizer · remote classifier | 93 migrated rows labelled by hand + GitLab/all-remote cases + 50 tricky strings ("Remote, Bangalore", "India; Berlin") | accuracy per class; **false-eligible rate** | acc ≥ 0.97, false-eligible ≤ 0.01 |
| normalizer · comp parser | INR notations (lakh/crore/LPA/`₹18,00,000`), USD/EUR ranges, "competitive" | exact match | 1.00 |
| prefilter | 200 postings with expected rule IDs | precision / recall per rule | recall of `F-REMOTE-INDIA`, `F-FTE` = 1.00; precision ≥ 0.95 |
| deduper | known duplicate pairs + near-misses | pairwise F1 | ≥ 0.98 |
| scorer-lexicon | the 93 rows' JDs, expected score computed by hand from §4 | exact score match | 1.00 (it is code: any miss is a bug) |
| scorer-claude, scorer-jev | 60 jobs you rate 1–10 yourself | Spearman ρ vs your rating; MAE | ρ ≥ 0.6, MAE ≤ 1.5 |
| score-fuser | same 60 | ρ of the fused score | ≥ best single provider |
| evidence-matcher · bullet-writer · resume-strategist · recruiter-critic | 20 JDs; bullet-writer also 200 single-slot cases | evidence precision; **grounding rate** per bullet (claims passing G-GROUND), keyword coverage, judge rubric | grounding = 1.00 after QA; first-pass grounding tracked |
| cover-letter | 20 JDs | grounding rate, length, judge rubric | grounding = 1.00 after QA |
| renderer / qa-gate | rendered files | `pdftotext` probe pass, pages ≤ 2, 0 hyphen-EOL | 1.00 |
| submit drivers | local form copies | fields correct, no submit without token | 1.00 |

LLM-as-judge is used **only** for subjective quality (resume readability, cover
letter tone). The judge returns a typed rubric (`relevance`, `specificity`,
`tone`, 1–5 each), runs at temperature 0, and is itself checked against your
ratings on 20 samples before it is trusted. A judge never gates grounding;
grounding is always the deterministic check.

### 15.2 Online evals (from real outcomes)

Every action you take is a label. **Approve / Decline / Skip** label fit;
**response / interview / offer** label outcome. Weekly, `eval-online` computes:

- precision@k of the shortlist (share of shortlisted jobs you approved);
- calibration: approval rate per fused-score band (a score of 8 should be approved more often than a 7);
- scorer agreement with your decisions, per provider, which **re-fits the fuser weights** (a new `ranking` version, never a silent change);
- funnel by source and ATS: discovered → eligible → shortlisted → approved → submitted → response.

### 15.3 Agent scorecards (runtime health, per run)

Per agent: success rate, guardrail trip rate by ID, p95 latency, cost per
item, breaker opens, and, for LLM agents, first-pass grounding rate and QA
regeneration rate. Shown on the dashboard's Evals page. A rising trip rate
on one agent after a prompt or model change is the earliest signal of a
regression.

### 15.4 Eval-gated changes

Prompts, models, lexicons and ranking weights are versioned artifacts.
Changing any of them runs the affected agents' offline evals and the replay
test; the change is recorded with its eval report in `events`.

---

## 16. Roadmap (each sub-project gets its own spec → plan → build)

| # | Sub-project | Delivers | Depends on |
|---|---|---|---|
| 1 | **Kernel** | Contracts, handoff protocol, registry + wiring compile, executor, memo, guardrail framework, two-tier policy, event log, state machine, eval runner, plugin loader skeleton. Replay test. | — |
| 2 | **User pack + onboarding** | Pack schema, keychain secrets, resume-ingest, fact verification UI, pack-builder. The user's pack migrated from career-ops facts + the old handoff rules | 1 |
| 3 | **Discovery T1 + T2** | ATS adapters, generic JSON-LD adapter, aggregators, normalizer, deduper, watchlist (26 seeded slugs), catalogue export/import | 1 |
| 4 | **Scoring + ranking + dashboard** | prefilter, scorer-lexicon, scorer-claude, scorer-jev, fuser, ranker, Hono dashboard, Desk migration, golden sets | 2, 3 |
| 5 | **Documents** | tailor, cover letter, renderer, QA gate | 2, 4 |
| 6 | **Approval + submit** | token, Greenhouse / Lever / Ashby drivers, tracker | 5 |
| 7 | **Source expansion** | source-probe, source-scout, manifests, source health, lifecycle | 3 |
| 8 | **MCP gateway** | read and proposal tools | 4 |
| 9 | **Interview + negotiation** | interview-prep, comp-intel, negotiation-coach | 4, 5 |
| 10 | **Plugin SDK + distribution** | SDK, sandboxed plugins, `npx jobpilot init`, schedulers | 1–4 |
| 11 | **Coverage + online evals** | Gmail alerts, company-finder, assisted Workday, weekly online evals | 3, 4 |

## 17. Out of scope (v1)

Onsite, hybrid and Japan roles and contractor roles **for the user's pack** (other users configure their own eligibility); a hosted SaaS; scraping LinkedIn, Naukri, Wellfound or Instahyre; mass auto-apply without
approval; shared multi-user servers holding personal data.
