# jobpilot: architecture design

**Status:** draft, awaiting review · **Date:** 2026-10-08 · **Owner:** the maintainer

jobpilot is a local-first, multi-agent system. It discovers the best-paying,
best-fitting jobs (with priority on remote roles inside India), scores them
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

## 1. Decisions made so far

| # | Decision | Source |
|---|---|---|
| D1 | New repository, from scratch (`~/PersonalProject/jobpilot`). Proven pure functions from `career-ops` (fact store, INR comp parser) are **ported with their tests**, not imported. | User |
| D2 | End action: **auto-submit with per-job approval**. Approval is a signed, single-use token bound to the exact document hashes. | User |
| D3 | Scoring: **dual scorer**. Claude and Jev (TypeSafe AI) sit behind one `Scorer` contract. The scores are fused and disagreement is flagged. The resume is PII-redacted before it goes to Jev. | User |
| D4 | Sources: direct ATS boards, remote aggregators, Japan boards and India. India is covered by Adzuna India, a watchlist of India-remote employers' ATS boards, and a Gmail job-alert ingest. **There is no scraping of Naukri, Wellfound or Instahyre** (their ToS and anti-bot measures). | User ("all that works best") + research |
| D5 | Ranking: **comp-first with a fit floor**. | User |
| D6 | Comp baseline = **the user's current offer (base + RSU)**. The floor is the offer's annualised total comp (see A1). | User |
| D7 | The current LLM-managed daily discovery is non-deterministic. **This is the problem the design exists to fix**, so routing and state never depend on an LLM. | User |
| D8 | LinkedIn is never scraped and never a submit target. | Standing rule (job-os, linkedin-ops) |

### Assumptions to confirm (defaults used in this spec)

| # | Assumption | Default |
|---|---|---|
| A1 | The RSU grant vests over 4 years | Floor = base + RSU / 4 (**total comp**) |
| A2 | Roles with undisclosed comp | Kept, put in a separate "comp unknown" band, and ranked by fit |
| A3 | Target roles | Senior/Staff/Lead Backend, Platform, or AI/LLM Engineer (Go, Java, TypeScript) |
| A4 | Japan | Japan-based roles with visa sponsorship are eligible, as are remote-from-India roles |
| A5 | Daily submit cap | 10 submissions/day, 3 per company per 30 days |
| A6 | Schedule | One daily run at 07:00 IST via macOS `launchd`, plus manual `jobpilot run` |
| A7 | Jev API | A key is available; data retention terms must be read before enabling it (the provider is disabled until confirmed) |
| A8 | LinkedIn job-alert *emails* | Excluded from Gmail ingest unless the user opts in (parsing your own mailbox is not scraping, but it stays off by default) |

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
7. **Irreversible actions need a human.** Submit requires a valid approval
   token. No other agent can cause an external side effect.
8. **Everything is auditable.** An append-only, hash-chained event log
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
| Browser | Playwright (Chromium) | Japan boards (JSON-LD pages), rendering, submit drivers |
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
        │ workable smartrecruiters │   │ prefilter → score(claude)  │   │  inject,egress,budget│
        │ recruitee himalayas      │   │            score(jev)      │   │ out: schema,post,    │
        │ remotive remoteok hn     │   │ → fuse → rank → tailor-cv  │   │  pii,ground,ats-text │
        │ adzuna-in tokyodev       │   │ → cover-letter → render    │   └──────────────────────┘
        │ japandev gmail-alerts    │   │ → qa-gate                  │
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
| `TailoredResume@1` | resume-tailor | `jobId`, `sections[]` → `bullets[]` (`{text, factIds[], jdTerms[]}`), `keywordPlan` |
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
   T@major. It also checks that every consumed type has at least one producer,
   and that the graph is acyclic apart from declared retry loops. **A wiring
   error stops boot.** Nothing runs half-wired.
3. **Envelope carries the contract.** Every message travels in an
   `Envelope<T>` that names its producer and the producer's `contractHash`.
   The receiving step verifies the hash against the registry. If a producer
   changed its output without bumping its version, the hash mismatch
   quarantines the message.
4. **Redundancy by declaration.** When several agents produce the same type
   (14 discovery agents produce `RawPosting@1`; two scorers produce
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
| Scorer fallback | Jev down → Claude alone (`singleScorer=true`, shown as a badge); Claude down → Jev alone; both down → stage halts, jobs stay `PREFILTERED` |
| Source isolation | A failing source never blocks the others; `source_health` shows the last success and error class |
| Dead letter | `QUARANTINED` jobs keep the failing envelope and the guardrail detail |
| Budget | A hard daily USD cap. Reaching it stops new LLM steps but lets deterministic steps finish |

---

## 7. The agents

| Agent | Kind | Consumes → Produces | Notes |
|---|---|---|---|
| `src-greenhouse` | io | DiscoveryRequest → RawPosting | `boards-api.greenhouse.io/v1/boards/{token}/jobs?content=true`, per watchlist company |
| `src-lever` | io | same | `api.lever.co/v0/postings/{slug}?mode=json` (+ EU host) |
| `src-ashby` | io | same | `api.ashbyhq.com/posting-api/job-board/{name}?includeCompensation=true` |
| `src-workable`, `src-smartrecruiters`, `src-recruitee` | io | same | Public posting endpoints |
| `src-himalayas`, `src-remotive`, `src-remoteok` | io | same | Attribution is stored and shown; Remotive's 24 h delay is noted |
| `src-hn` | io | same | Algolia "Who is hiring" thread comments; header line parsed deterministically |
| `src-adzuna-in` | io | same | Free key, 250 calls/day; queries tuned for remote, India and senior roles |
| `src-tokyodev`, `src-japandev` | io (Playwright) | same | Parses `JobPosting` JSON-LD; robots.txt checked; ≤1 req/2 s |
| `src-gmail-alerts` | io | same | `gmail.readonly`; sender allowlist (Naukri, Instahyre, Wellfound, Cutshort, Hirist); parses the job cards in the email |
| `normalizer` | deterministic | RawPosting → JobPosting | Comp parser ported from career-ops (lakh/crore, LPA, `₹18,00,000`), FX at the run's pinned rate, remote classifier, ATS detection from apply-URL host, HTML → text through the sanitiser |
| `deduper` | deterministic | JobPosting → DedupedJob | Key = `slug(company) + normTitle + remoteClass`; merges provenance; prefers the ATS-direct URL |
| `prefilter` | deterministic | DedupedJob → PrefilterVerdict | Rule IDs: location eligibility, seniority, stack overlap ≥ 2, deny keywords, disclosed comp ≥ floor × 0.85 |
| `scorer-claude` | llm | DedupedJob → ScoreResult | The prompt holds the JD (fenced as data) and verified fact *summaries*; no contact PII |
| `scorer-jev` | io | DedupedJob → ScoreResult | The resume is sent with P1 fields redacted; Jev output mapped to `ScoreResult@1` by a deterministic adapter |
| `score-fuser` | deterministic | ScoreResult×n → FusedScore | Mean of available providers; `disagreement = |a−b| > 2` → `needs-review` |
| `ranker` | deterministic | FusedScore → RankedJob | See §9 |
| `resume-tailor` | llm | RankedJob → TailoredResume | Picks facts, rewrites bullets using JD terms; every bullet cites `factIds` |
| `cover-letter` | llm | RankedJob → CoverLetter | Three or four paragraphs, every claim cites `factIds` |
| `renderer` | deterministic | Tailored* → RenderedArtifact | Template follows the v5 ATS rules; format chosen per ATS (§10) |
| `qa-gate` | deterministic | RenderedArtifact → QaVerdict | Runs G-ATS-TEXT, G-GROUND, G-PII-OUT, G-EMPLOYER |
| `approval` | human | QaVerdict → ApprovalToken | Dashboard button; shows a diff against the master resume |
| `submitter` | effect | ApprovalToken → SubmissionResult | Playwright drivers for Greenhouse, Lever and Ashby first; Workday, iCIMS and Taleo are "assisted" (prefill, then hand over) |
| `tracker` | deterministic | SubmissionResult → (state) | Status log; follow-up reminders at day 7 and day 14 |

---

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
| G-EMPLOYER | out | The employer is written under its display name; the string "[client]" never appears; client described generically |
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
| P2 | Offer details (the user's current offer), current salary | Local ranker only |
| P3 | Gmail message bodies | Local parser; only the extracted JD text (P0) moves on |

### 8.4 Audit

Each `events` row stores `prevHash` and `hash = sha256(prevHash + row)`.
`jobpilot audit verify` walks the chain. The dashboard shows each job's full
lineage: sources → scores → documents → approval → submission.

---

## 9. Ranking formula (`ranking.v1`)

```
eligible   = fused.fit >= 7.0 && !needsReview && prefilter.pass
compTC     = inrAnnualMax ?? inrAnnualMin            // total comp, INR/yr, pinned FX
band       = compTC == null ? 'comp-unknown' : compTC >= floor ? 'above-floor' : 'below-floor'
order      = band ASC (above-floor, comp-unknown, below-floor),
             compTC DESC NULLS LAST, fused.fit DESC, postedAt DESC, jobId ASC   // total order
shortlist  = first 8 per day from above-floor + top 4 comp-unknown with fit >= 8
deltaVsOffer = compTC - floor
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
`submissions` · `fx_rates(date, ccy, inr)` · `cost_ledger` · `source_health` · `watchlist(company, ats, slug)`

---

## 12. Dashboard

Hono + htmx on `127.0.0.1:4317`.

- **Today:** run summary, source health, spend, quarantine count.
- **Jobs:** table sorted by rank, with chips for band, Δ vs the offer, fit,
  disagreement, ATS and sources. Filters for remote class and band.
- **Job detail:** JD (sanitised), both scores with evidence, the tailored
  resume diff against master, the cover letter, screening answers, lineage.
  Actions: **Approve**, **Decline**, **Regenerate**.
- **Applications:** submitted, needs-human and follow-ups due.
- **Contracts:** the live registry, the wiring graph and each agent's
  breaker state.
- **Audit:** chain verification and the event stream.

---

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

## 15. Build phases (each gets its own plan)

1. **Kernel:** contracts, registry, wiring compile, executor, memo, guardrail
   framework, policy, event log, state machine. Two stub agents end to end
   and the replay test.
2. **Discovery:** ATS boards, aggregators and Adzuna-IN, plus normalizer,
   deduper and prefilter. All deterministic.
3. **Scoring:** scorer-claude, scorer-jev, fuser and ranker.
4. **Dashboard:** read-only views (jobs, detail, health, quarantine, contracts).
5. **Documents:** fact store port, tailor, cover letter, renderer and QA gate.
6. **Approval and submit:** token, Greenhouse, Lever and Ashby drivers, tracker.
7. **Coverage:** Gmail alerts, TokyoDev, Japan Dev, assisted Workday.

## 16. Out of scope (v1)

Scraping LinkedIn, Naukri, Wellfound or Instahyre; mass auto-apply without
approval; multi-user support; cloud hosting.
