# jobpilot Sources Expansion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.
>
> **Plan style (same as the career-sites plan):** each task fixes files, interfaces, exact values and test cases; the
> implementer works test-first (failing test → run → minimal code → run → commit). The code blocks below are the
> intended code: types, constants, parsers and the tests that pin them. Where a block shows only the new part of an
> existing function, the rest of the function stays as it is on `main`.
>
> Approved by the user on 2026-10-15. Research it rests on (read before starting):
> `.superpowers/sdd/freehire-eval.md`, `.superpowers/sdd/hidden-contract-sources.md`,
> `.superpowers/sdd/companies-research.md`, the career-sites spec and plan (`docs/superpowers/specs/2026-10-13-…`,
> `docs/superpowers/plans/2026-10-13-career-sites.md`). Live notes for this plan (robots.txt files, response shapes,
> one polite request each on 2026-10-15) are in `$SCRATCH/sx/` (`$SCRATCH` = this session's
> scratchpad directory; if gone, re-record with one polite request each).

**Goal:** more places to find work, all deterministic and polite:
1. the freehire board catalogue (MIT, snapshot `96b53a2c`) as a filtered coverage seed, sent straight to the verifier;
2. a weekly freehire discovery agent (≤ 10 fixed queries) that feeds new boards to the verifier and unsupported-platform
   postings to the review lane only;
3. daily adapters for JazzHR, Zoho Recruit, Manatal and Freshteam (UKG Pro is detected but SKIPPED: its robots.txt
   disallows the only full job list);
4. three monitored freelance sources: Draft.dev (GitHub API), Prime Intellect bounties (GitHub search API), Fractional
   Jobs (its public page).

**Architecture:**
- **Coverage** (`jobpilot-coverage@1.0.0`) gains a fifth stage, `discover` (agent `src-freehire-discovery`, between
  `seed` and `locate`). The `verify` stage's input becomes: the detector's guesses, then the discovery's board guesses,
  then at most CATALOGUE_PER_WEEK catalogue guesses, deduped by `(platform, ref)` in that order, minus boards the
  registry already holds. Postings the discovery finds on platforms jobpilot cannot read go to a new additive table
  `freehire_leads`.
- **Daily** (`jobpilot-daily`) gains four platform adapters, each its own team, seeded from the registry like the Task 9
  platforms, and one store-fed source `src-freehire-leads` (no network) whose postings eligibility caps at `review`.
  With an empty registry and no leads, none of them is wired: the daily-identity golden stays byte-identical.
- **Freelance** (`jobpilot-freelance@1.0.0`) gains three sources, each its own team, on the `src-himalayas-gigs`
  pattern (run-scoped host state, robots.txt, 2 s spacing, refusals disable the host).
- **Build time only:** `scripts/freehire-catalogue.ts` regenerates the vendored seed deterministically from the pinned
  snapshot and a recorded evidence pass. Nothing at run time reads freehire's catalogue from the network.

**Tech stack:** TypeScript on Node 24 (ESM, strict), zod 4.6.5, better-sqlite3, vitest, commander, hono, yaml, all
already pinned. **No new dependencies** (the build script untars with Node's `zlib` and a 40-line ustar reader).

## Global Constraints

- **Worktree only.** After tonight's merge of `freelance-v2`, create the worktree `~/PersonalProject/jobpilot-sx` on a
  new branch `sources-x` from `main`. The live checkout `~/PersonalProject/jobpilot` stays on `main` (launchd runs it);
  never check out a branch there. `node_modules` is symlinked from the live checkout; never write into it.
- **The repo is PUBLIC on GitHub.** No personal data in `src/`, `tests/`, `assets/`, `scripts/`, `docs/` or commit
  messages: no user name, contact details, employer, offer, salary or rate floor, or city stated as the user's. Office
  cities come from the pack at run time (`eligibility.officeCities`), never from code. Tests use the fictional fixture
  pack (`tests/fixtures/pack`). Never push; the controller pushes `main` after a privacy scan.
- Run scripts with `node --run <script>`, never `pnpm <script>`. Node ≥ 24. ESM imports end in `.js`.
- **No language-model call anywhere; runs without Claude Code.** Every agent is `deterministic` or `io`. Every
  operation is a `jobpilot` CLI command, a `node --run` script or a launchd job. Nothing depends on Claude Code, its
  skills or `.superpowers/`. The kernel's `LlmProvider` stays unused.
- **No paid keys:** freehire's keyless API, GitHub's unauthenticated REST API, public pages. No token, no login, no
  session, no cookie.
- Every agent uses `defineContract` + `defineAgent`; description ≥ 10 characters without the word "and"; one skill,
  one output type. **One team per platform** (daily, coverage and freelance alike).
- **Politeness (binding for every new request):**
  - the broker's honest UA `jobpilot/0.1 (+local)`, never configurable;
  - ≥ 2000 ms between two requests to one host (`minIntervalMs: 2000` on every request plus the policy pacer);
  - robots.txt honoured before the first request to a host (once per host per run), except a documented public API
    (the freehire API, which invites bots and asks them to use it; GitHub's REST API), as Greenhouse is read;
  - a robots disallow, 401, 403, 429 or a challenge page disables that host **for the run**, with a named problem;
    nothing is retried around it, **Retry-After is never read**;
  - no proxies, no CAPTCHA solving, no UA spoofing, **no fingerprint masking, no Firecrawl, no headless browser** for
    any new source. freehire's Go adapters may be read as a REFERENCE (MIT; each derived file names the source file and
    commit `3957f7b` in its header); its `fingerprinthttp.go` and Firecrawl tiers are never ported. A platform that cannot
    be read politely is SKIPPED with the reason (UKG Pro, Task 1).
- **Determinism:** no `Date.now()`/`Math.random()` in agents; outputs sorted by a stable key; a relative or absent
  date → `postedAt: null`; HTML parsing is linear-time (forward `indexOf` scans, no backtracking regex on page bodies)
  with a size cap.
- **Caps are loud:** a page/job/request cap reached is `input_rejected` (or a named `ctx.skipped` note when the source
  keeps going) naming the source, the cap and the count; never a silent truncation.
- **Uncertain → review:** an unverified board → Proposed; a third-party posting on an unsupported platform → `review`
  band only; a gig whose rate, budget, hours or remote scope cannot be read → `review`.
- **Daily regression:** with an empty registry and no stored leads, the daily pipeline is byte-identical to `main`
  (`tests/app/daily-identity.test.ts` unchanged, golden not rewritten). Prove it in every task that touches the daily
  wiring.
- **Tests never touch the network:** the suite's net guard (`tests/support/net-guard.ts`) stays on; tests use recorded
  fixtures (`tests/fixtures/sx/…`) and stubbed `fetch`. The build script's tests use a fixture tarball and recorded
  API pages.
- `node --run verify` stays green after every task; existing evals stay at 1.000.
- Every commit message ends with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- Live data only through temp homes with a copy of `~/.jobpilot/pack`; `~/.jobpilot` is read-only (SELECT-only on its
  DB). The controller (not the implementer) edits the real pack.
- Put a timeout on every command that can hang (`timeout 600 node --run verify`, `curl --max-time 20`).

## Resolved decisions (2026-10-15, controller)

| # | Question | Decision |
|---|---|---|
| D1 | The India/remote evidence rule for the catalogue | A catalogue entry is kept iff freehire's **API**, queried once at build time per platform with location full-text (`q` over `location` only, never an enrichment facet), returns at least one row whose `(source, board)` is that entry AND whose **raw `location` text** passes jobpilot's own `namesIndia` or the fixed `WORLDWIDE_REMOTE` rule AND whose title passes the fixed `TECH_TITLE` rule. LLM-filled fields (`enrichment`, `countries`, `regions`, `work_mode`, `skills`, `category`, `reality`) are never read. Responses are cached by the script, their sha256 recorded in the committed manifest, and `--offline` replays them byte-identically. |
| D2 | "Real company name" | Not unnamed: `normalCompanyName(company)` differs from the board slug's and from the board host's first label, and the name contains no `/` and no host-like token (`x.y`). freehire's own count of unnamed entries per platform (eval §2) is the check. |
| D3 | Seed entries in the registry | `companyKey = fh-<first 16 hex of sha256("<platform> <ref>")>.freehire` (never a real domain, so the verifier's domain-label route can never match), `website: ''`, `source: 'freehire'` (catalogue) or `'freehire-discovery'`. A non-verified verdict for these two sources is projected as **Proposed** (its reasons kept, a 404 included), never `failed`, so the user can reject it. |
| D4 | How many catalogue entries a week | CATALOGUE_PER_WEEK = 300 new entries per coverage week, by evidence count (desc), then platform, then ref; an entry with any registry row (any status, same platform and ref) is skipped. The rest wait, with a loud line `catalogue: N entries left for later weeks`. |
| D5 | Size budget of the vendored seed | `assets/freehire/catalogue-seed.jsonl` target ≤ 1 MB, hard cap 2 MB (the script fails above it). |
| D6 | The ≤ 10 discovery queries | Nine fixed templates (Task 8), full-text over `title,location` only, `open_within_days=7`, one page of 100 each, office cities from the pack (≤ 2). More than 100 matches → a loud note, never a second page. |
| D7 | The review lane for unsupported-platform postings | The daily jobs list's `review` band: the store-fed `src-freehire-leads` emits them, eligibility caps every `ats: 'freehire'` posting at `review` with the reason `freehire-lead`. |
| D8 | UKG Pro | SKIPPED. robots.txt on `recruiting.ultipro.com` and `*.rec.pro.ukg.net` disallows `*/JobBoardView` (the `LoadSearchResults` list); the allowed board page embeds only featured jobs. Detected, never read: Proposed with the reason. |
| D9 | Prime Intellect's repo | `PrimeIntellect-ai/prime-environments` was renamed `PrimeIntellect-ai/community-environments` (GitHub 301, 2026-10-15); its issue list answers empty and its bounties are posted through Algora comments on issues across the org. The source reads the GitHub **search** API, one request per run, org-wide. |
| D10 | Fractional Jobs' "hrs" | The cards state weekly hours ("15 - 20 hrs"): read as hours per week (documented in the source header). A card without hours, pay or a location the rules can read → review. |

## File map

| Path | Responsibility |
|---|---|
| `src/app/coverage/types.ts` (modify) | `Platform` gains `jazzhr`, `zohorecruit`, `manatal`, `freshteam`, `ukg`; `CandidateSource` gains `freehire`, `freehire-discovery`; `FreehireQuery@1`, `FreehireFinding@1` |
| `src/app/types.ts` (modify) | `Ats` gains `jazzhr`, `zohorecruit`, `manatal`, `freshteam`, `freehire` |
| `src/app/coverage/signatures.ts`, `detector.ts` (modify) | host signatures of the five platforms |
| `src/app/agents/sources/platforms/skipped.ts` | `SKIPPED_PLATFORMS` (UKG and its reason) |
| `src/app/agents/sources/platforms/listing-pages.ts` | shared HTML-listing + JSON-LD-page adapter (JazzHR, Freshteam) with listing-level India/remote scope |
| `src/app/agents/sources/platforms/jazzhr.ts`, `freshteam.ts` | the two page adapters |
| `src/app/agents/sources/platforms/zohorecruit.ts` | feed adapter (embedded JSON) |
| `src/app/agents/sources/platforms/manatal.ts` | paged feed adapter |
| `src/app/agents/sources/platforms/feed-board.ts` (modify) | optional paging (`next`) for a feed |
| `src/app/coverage/freehire-api.ts` | the freehire API shapes, URL builder, `ignored_params` check, `utm` strip, row → board / lead |
| `src/app/coverage/freehire-boards.ts` | freehire board id → jobpilot ref, name rule D2, `companyKey` rule D3 |
| `scripts/freehire-catalogue.ts` | build-time regeneration of the seed |
| `assets/freehire/catalogue-seed.jsonl`, `manifest.json`, `NOTICE` | vendored seed, its provenance, the MIT notice |
| `src/app/coverage/catalogue.ts` | reads the vendored seed, picks this week's guesses |
| `src/app/coverage/discovery.ts` | `src-freehire-discovery` |
| `src/app/coverage/pipeline.ts`, `run.ts`, `project.ts` (modify) | the `discover` stage, verify inputs, D3 projection, leads projection |
| `src/app/store/schema.ts`, `app-store.ts` (modify) | migration: `freehire_leads`; registry board keys |
| `src/app/agents/sources/freehire-leads.ts` | `src-freehire-leads` (daily, no network) |
| `src/app/agents/eligibility.ts`, `normalizer.ts` (modify) | `freehire` mapper and the review cap; mappers for the four platforms |
| `src/app/pipeline.ts`, `daily-hosts.ts`, `allow-list.ts`, `exported-agents.ts` (modify) | daily wiring |
| `src/app/freelance/sources/draftdev.ts`, `prime-intellect.ts`, `fractional-jobs.ts` | the three gig sources |
| `src/app/freelance/sources/github.ts` | shared GitHub REST host state and request rules |
| `src/app/freelance/types.ts`, `pipeline.ts`, `gig-normalizer.ts`, `sources/index.ts`, `src/app/pack/freelance-schema.ts` (modify) | freelance wiring |
| `tests/fixtures/sx/…` | recorded fixtures (trimmed, scrubbed) |
| `evals/datasets/coverage-detector.jsonl` (+ pages), `evals/datasets/freehire-rows.jsonl`, `evals/datasets/gig-normalizer.jsonl` (append) | golden sets |

---

### Task 0: Worktree, baseline

- [ ] **Step 1:** after the controller confirms `freelance-v2` is merged to `main`:

```bash
cd ~/PersonalProject/jobpilot && git status --short && git log --oneline -1
git -C ~/PersonalProject/jobpilot worktree add ~/PersonalProject/jobpilot-sx -b sources-x main
ln -s ~/PersonalProject/jobpilot/node_modules ~/PersonalProject/jobpilot-sx/node_modules
cd ~/PersonalProject/jobpilot-sx && timeout 900 node --run verify 2>&1 | tail -20
```

Expected: verify green, evals 1.000, daily-identity passes. Record the test count in `.superpowers/sdd/progress.md`
(the live checkout's, which is git-ignored).

- [ ] **Step 2:** copy this plan's live notes into the worktree as fixtures only when a task asks for them (trimmed and
  scrubbed: no tracking ids, no personal names other than a public company's).

No commit.

---

### Task 1: Five platforms in the types, the signature table and the detector; UKG skipped

**Files:** modify `src/app/coverage/types.ts`, `src/app/types.ts`, `src/app/coverage/signatures.ts`,
`src/app/coverage/verifier.ts`, `src/app/web/views/companies.ts` (labels); create
`src/app/agents/sources/platforms/skipped.ts`; extend `evals/datasets/coverage-detector.jsonl` and its page directory;
re-export contracts. Tests: extend `tests/app/coverage/detector.test.ts`, `tests/app/coverage/platform-hosts.test.ts`,
`tests/app/coverage/verifier.test.ts`.

**Interfaces:**

```ts
// coverage/types.ts
export const Platform = z.enum([
  'workday', 'eightfold', 'oracle', 'icims', 'successfactors', 'smartrecruiters', 'workable', 'recruitee', 'teamtailor', 'personio',
  'bamboohr', 'breezy', 'pinpoint', 'rippling', 'gem', 'greenhouse', 'lever', 'ashby', 'jsonld-sitemap',
  // sources-x Task 1
  'jazzhr', 'zohorecruit', 'manatal', 'freshteam', 'ukg',
]);
export const CandidateSource = z.enum(['pick', 'remoteintech', 'yc', 'jobs', 'freehire', 'freehire-discovery']);

// types.ts (Ats): append 'jazzhr', 'zohorecruit', 'manatal', 'freshteam', 'freehire'
// ('freehire' is Task 9's store-fed review source; 'ukg' is never an Ats: it is never read)
```

```ts
// agents/sources/platforms/skipped.ts
/**
 * Platforms the detector recognises but jobpilot never reads, with the reason (sources-x D8). The verifier answers a
 * guess on one of them with Proposed and this reason, and fetches nothing. A platform leaves this list only with a
 * polite way to read its whole job list.
 */
export const SKIPPED_PLATFORMS: Readonly<Record<string, string>> = {
  ukg: 'ukg: not read: robots.txt disallows */JobBoardView, the only full job list (LoadSearchResults); the board page embeds featured jobs only',
};
export const skippedWhy = (platform: string): string | null => (Object.hasOwn(SKIPPED_PLATFORMS, platform) ? (SKIPPED_PLATFORMS[platform] as string) : null);
```

```ts
// verifier.ts, in verify(), before `platformClient(g.platform)`:
const skipped = skippedWhy(g.platform);
if (skipped !== null) return verdict('proposed', [skipped, `detected: ${g.platform} ${g.slug ?? '(no slug)'}`]);
```

**Signature rows** (append to `SIGNATURES` after `ashby`; table order is precedence for URL matching only):

| Platform | Hosts (suffix, tenantOnly) | Board → slug, boardUrl |
|---|---|---|
| jazzhr | `applytojob.com` (tenantOnly) | `labelBoard('applytojob.com', (l) => \`https://${l}.applytojob.com/apply\`)` |
| zohorecruit | `zohorecruit.com`, `zohorecruit.in`, `zohorecruit.eu`, `zohorecruit.com.au` (all tenantOnly) | `zohoBoard`: slug = the whole host `<label>.<suffix>` (the TLD is the data region and is part of the board), boardUrl `https://<host>/jobs/Careers` |
| manatal | `careers-page.com` | `manatalBoard`: `www.careers-page.com/<slug>[/…]` or `<slug>.careers-page.com` → slug, boardUrl `https://open.api.manatal.com/open/v3/career-page/<slug>/jobs/`; `open.api.manatal.com/open/v3/career-page/<slug>/jobs/` (an API URL on a page) → the same |
| freshteam | `freshteam.com` (tenantOnly) | `labelBoard('freshteam.com', (l) => \`https://${l}.freshteam.com/jobs\`)` |
| ukg | `rec.pro.ukg.net` (tenantOnly), `recruiting.ultipro.com`, `recruiting2.ultipro.com` | `ukgBoard`: path `/<tenant>/JobBoard/<guid>/…` → slug `<host>/<tenant>/<guid>`, boardUrl `https://<host>/<tenant>/JobBoard/<guid>/` |

```ts
// signatures.ts
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const ZOHO_SUFFIXES = ['zohorecruit.com', 'zohorecruit.in', 'zohorecruit.eu', 'zohorecruit.com.au'] as const;

function zohoBoard(u: URL): BoardMatch {
  for (const suffix of ZOHO_SUFFIXES) {
    if (u.hostname !== suffix && !u.hostname.endsWith(`.${suffix}`)) continue;
    const label = tenantLabel(u.hostname, suffix);
    if (label === null) return u.hostname === suffix || u.hostname === `www.${suffix}` ? null : 'slugless';
    return { slug: `${label}.${suffix}`, boardUrl: `https://${label}.${suffix}/jobs/Careers` };
  }
  return null;
}

function manatalBoard(u: URL): BoardMatch {
  const api = (slug: string) => ({ slug, boardUrl: `https://open.api.manatal.com/open/v3/career-page/${slug}/jobs/` });
  if (u.hostname === 'open.api.manatal.com') {
    const p = segs(u); // ['open','v3','career-page','<slug>','jobs']
    return p[0] === 'open' && p[2] === 'career-page' && boardSegment(p[3]) ? api((p[3] as string).toLowerCase()) : 'slugless';
  }
  if (u.hostname === 'www.careers-page.com' || u.hostname === 'careers-page.com') {
    const s = firstSeg(u, new Set(['static', 'api', 'login']));
    return s === null ? 'slugless' : api(s.toLowerCase());
  }
  const label = tenantLabel(u.hostname, 'careers-page.com');
  return label === null ? null : api(label);
}

function ukgBoard(u: URL): BoardMatch {
  const pro = tenantLabel(u.hostname, 'rec.pro.ukg.net') !== null;
  if (!pro && !onHost(u, 'recruiting.ultipro.com', 'recruiting2.ultipro.com')) return u.hostname.endsWith('.rec.pro.ukg.net') ? 'slugless' : null;
  const p = segs(u);
  const tenant = p[0];
  if (tenant === undefined || p[1]?.toLowerCase() !== 'jobboard' || !GUID.test(p[2] ?? '') || !/^[a-z0-9]{3,32}$/iu.test(tenant)) return 'slugless';
  const guid = (p[2] as string).toLowerCase();
  return { slug: `${u.hostname}/${tenant.toLowerCase()}/${guid}`, boardUrl: `https://${u.hostname}/${tenant.toLowerCase()}/JobBoard/${guid}/` };
}
```

`acme.zohorecruit.com.au` never ends with `.zohorecruit.com`, so the suffix order does not matter; the `.com.au` case
below pins it.

- [ ] **Step 1: Failing tests.**

```ts
// tests/app/coverage/detector.test.ts (append)
describe('sources-x platforms', () => {
  const m = (href: string) => matchUrl(new URL(href));
  it.each([
    ['https://baxterplanning.applytojob.com/apply/LuHTxCmJVv/Business-Development-Representative', 'jazzhr', 'baxterplanning', 'https://baxterplanning.applytojob.com/apply'],
    ['https://shurutech.zohorecruit.in/jobs/Careers/156977000027288115', 'zohorecruit', 'shurutech.zohorecruit.in', 'https://shurutech.zohorecruit.in/jobs/Careers'],
    ['https://acme.zohorecruit.com.au/jobs/Careers', 'zohorecruit', 'acme.zohorecruit.com.au', 'https://acme.zohorecruit.com.au/jobs/Careers'],
    ['https://www.careers-page.com/pradeepit/job/LRV7X8YR', 'manatal', 'pradeepit', 'https://open.api.manatal.com/open/v3/career-page/pradeepit/jobs/'],
    ['https://getinz-people.freshteam.com/jobs/-j3B-P8yuEdJ/net-lead', 'freshteam', 'getinz-people', 'https://getinz-people.freshteam.com/jobs'],
    ['https://recruiting.ultipro.com/EPR1000EPSUS/JobBoard/10653576-f6a1-4d69-8a9c-a0a96124abda/OpportunityDetail?opportunityId=1', 'ukg', 'recruiting.ultipro.com/epr1000epsus/10653576-f6a1-4d69-8a9c-a0a96124abda', 'https://recruiting.ultipro.com/epr1000epsus/JobBoard/10653576-f6a1-4d69-8a9c-a0a96124abda/'],
  ])('%s → %s', (href, platform, slug, boardUrl) => {
    expect(m(href)).toEqual({ platform, board: { slug, boardUrl } });
  });
  it('vendor sites and asset hosts are not boards', () => {
    expect(m('https://www.applytojob.com/')).toBeNull();
    expect(m('https://www.freshteam.com/pricing')).toBeNull();
    expect(m('https://www.zohorecruit.com/')).toBeNull();
    expect(m('https://cdn.freshteam.com/x.js')).toEqual({ platform: 'freshteam', board: 'slugless' });
    expect(m('https://recruiting.ultipro.com/robots.txt')).toEqual({ platform: 'ukg', board: 'slugless' });
  });
  it('platformForHost knows the new hosts on a dot boundary', () => {
    expect(platformForHost('acme.applytojob.com')).toBe('jazzhr');
    expect(platformForHost('notapplytojob.com')).toBeNull();
    expect(platformForHost('acme.zohorecruit.eu')).toBe('zohorecruit');
  });
});

// tests/app/coverage/verifier.test.ts (append)
it('a UKG guess is Proposed with the robots reason, nothing fetched', async () => {
  const { fetch, calls } = serve({});
  const v = await runVerifier(fetch, guess(cand('acme.com', 'Acme'), 'ukg', 'recruiting.ultipro.com/acme1/10653576-f6a1-4d69-8a9c-a0a96124abda'));
  expect(v.status).toBe('proposed');
  expect(v.reasons[0]).toMatch(/^ukg: not read: robots\.txt disallows \*\/JobBoardView/);
  expect(calls).toEqual([]);
});
```

  `runVerifier` is the file's existing helper that builds the agent on a fresh gate and runs one guess (add it if the
  file inlines that; keep it local to the test file).

- [ ] **Step 2: Golden set.** Record 8 careers pages (one polite GET each, trimmed to the anchors/scripts the
  detector reads) into `evals/datasets/coverage-detector/`: two JazzHR (`baxterplanning.applytojob.com/apply`, one
  company page linking to applytojob), two Zoho (`/jobs/Careers` of a `.in` and a `.com` tenant), one Manatal
  (`careers-page.com/<slug>`), two Freshteam, one UKG board page. Append 8 labelled cases to
  `coverage-detector.jsonl` (`expected: {platform, slug, boardUrl}`). The eval stays at 1.000.
- [ ] **Step 3: Run, expect FAIL.**
  `timeout 300 node --run test -- tests/app/coverage/detector.test.ts tests/app/coverage/verifier.test.ts tests/app/coverage/platform-hosts.test.ts`
- [ ] **Step 4: Implement** the enum values, rows, `skipped.ts`, the verifier line, `SOURCE_LABEL` entries
  (`freehire: 'freehire catalogue'`, `'freehire-discovery': 'freehire discovery'`) in `views/companies.ts`.
  `node --run contracts:export`; bump the minor version of every contract whose consumed or produced type carries
  `Ats`, `Platform` or `CandidateSource` (the Task 9 precedent: minor bumps because the enum grew).
- [ ] **Step 5: Verify.** `timeout 900 node --run verify`. Daily-identity unchanged (no new agent is wired yet).
- [ ] **Step 6: Commit** `feat(coverage): detect JazzHR, Zoho Recruit, Manatal, Freshteam and UKG Pro boards; UKG is skipped by its robots.txt`

---
### Task 2: Daily adapters: JazzHR and Freshteam (HTML listing, India/remote scope, JSON-LD job pages)

Both platforms publish a server-rendered listing that names every open job with its location, and a job page with a
schema.org `JobPosting` JSON-LD block (freehire `jazzhr.go`, `freshteam.go` at `3957f7b`, read as a reference; seen
live 2026-10-15). Neither has a documented public API, so the strict page rule of `pages.ts` applies, and both reuse
`readJobPages` (budget PAGE_MAX_FETCHES per company per IST day, rotation, keep-alive, `no-jobposting`, `detail-gone`).

**robots.txt seen live:** `<slug>.applytojob.com`: `User-agent: *` `Disallow: /cb` (so `/apply` and `/apply/<token>/…`
are allowed); `<slug>.freshteam.com`: `Allow: /jobs`, `Disallow: /` (job pages are under `/jobs/`, allowed).

**Files:** create `src/app/agents/sources/platforms/listing-pages.ts`, `jazzhr.ts`, `freshteam.ts`; modify
`client.ts` (two `PAGE_CLIENTS`), `normalizer.ts` (two mappers), `pipeline.ts`, `daily-hosts.ts` (nothing new: both use
`dailyPageHosts()`), `allow-list.ts`, `exported-agents.ts`, `shared.ts` (`PLATFORM_NOTE_PREFIXES` gains `'listing-cap '`).
Fixtures `tests/fixtures/sx/jazzhr/{listing.html,job-remote.html,job-pune.html,robots.txt}`,
`tests/fixtures/sx/freshteam/{listing.html,listing-page2.html,job.html,robots.txt}` (recorded, trimmed to the job
cards and the JSON-LD block, scrubbed). Test: `tests/app/sources-listing-pages.test.ts`.

**Interfaces:**

```ts
// listing-pages.ts
/** A job a listing names, with the listing's own location words (null: the card names none). */
export interface ScopedJob extends ListedJob {
  readonly location: string | null;
  /** The listing's structured remote flag (Freshteam `data-portal-remote-location`); null: none. */
  readonly remote: boolean | null;
}

/** A remote word in a card's location ("Remote", "Remote - India", "Work from home"), word-bounded. */
export const REMOTE_WORD = /\b(?:remote|work\s+from\s+home|wfh|anywhere)\b/iu;

/**
 * The listing-level scope (the platform has no server-side filter, so the scope is applied to the listing, before any
 * job page is asked): a job is kept when its card names India (`namesIndia`), one of the pack's office cities
 * (`namesOffice`), says remote (the flag, or REMOTE_WORD), or names no location at all (uncertain: its page decides).
 * The rest are counted in ONE named note `not-india <company>: N of M listed jobs outside India and not remote (not
 * fetched)`, never silently. Order kept.
 */
export function scopeListed(jobs: readonly ScopedJob[], officeCities: readonly string[], company: string, ctx: AgentContext): ScopedJob[] {
  const kept = jobs.filter((j) => j.location === null || j.remote === true || REMOTE_WORD.test(j.location) || namesIndia(j.location) || namesOffice(j.location, officeCities));
  const out = jobs.length - kept.length;
  if (out > 0) ctx.skipped([`not-india ${company}: ${out} of ${jobs.length} listed jobs outside India and not remote (not fetched)`]);
  return kept;
}

/** What a listing-pages platform supplies; everything else (requests, budget, state, refusals) is shared. */
export interface ListingPagesSpec {
  readonly platform: 'jazzhr' | 'freshteam';
  readonly label: string;
  readonly team: string;
  readonly egress: string;
  readonly parseRef: (ref: string) => string | null;
  readonly hostOf: (slug: string) => string;
  readonly boardOfUrl: (boardUrl: string) => string | null;
  /** The listing URL of page `n` (1-based). */
  readonly listingUrl: (slug: string, n: number) => string;
  /** Linear-time parse of one listing page: its jobs, and whether the page links a next page. */
  readonly parseListing: (html: string, slug: string) => { readonly jobs: ScopedJob[]; readonly next: boolean };
  /** Listing pages read at most (JazzHR 1: one page names every job; Freshteam LISTING_MAX_PAGES). */
  readonly maxListingPages: number;
}

/** Listing pages per company at most; a listing that still links a next page after it is `input_rejected` `listing-cap`. */
export const LISTING_MAX_PAGES = 5;
/** A listing page larger than this is refused (`input_rejected`), never parsed. */
export const LISTING_MAX_BYTES = 4 * 1024 * 1024;
export const LISTING_TIMEOUT_MS = 900_000;
/** robots.txt, the listing pages, and every job page with its redirects. */
export const LISTING_MAX_REQUESTS = 1 + LISTING_MAX_PAGES + PAGE_MAX_FETCHES * (1 + PAGE_MAX_HOPS);

export interface ListingPagesBoard {
  readonly spec: ListingPagesSpec;
  readonly contract: Contract<DiscoveryRequest, RawPosting>;
  /** Every listing page (robots.txt first, 2 s apart), as the board's jobs: the verifier's read and the adapter's. */
  fetchListing(http: HttpTool, hosts: PlatformHosts, slug: string, timeoutMs?: number): Promise<PageListing & { readonly jobs: readonly ScopedJob[] }>;
  make(o: SrcPageOptions): Agent<DiscoveryRequest, RawPosting>;
}
export function listingPagesBoard(spec: ListingPagesSpec): ListingPagesBoard;
```

`fetchListing` reads page 1, 2, … with `getListing` (`follow` = same host, `expected` = the body contains the card
marker), stops at the first page with no `next` or no new sourceId, and throws
`input_rejected` `listing-cap <label> <slug>: still more pages after <n>; nothing read, never truncated` when page
`maxListingPages` still says `next`. Jobs are deduped by sourceId, first seen wins, listing order kept.

`runCompany` (as `icims.ts`): `titlePackOf(ctx.pack, contract.id)`, `fetchListing`, `scopeListed` with
`pack.eligibility?.officeCities ?? []`, `prefilter`, then `readJobPages({…, board: \`${platform} ${slug}\`, source:
platform, follow: sameHost(host)})`; refusals through `refusal(e, company, ctx)`.

The contract (one per platform): id `src-<platform>`, version `1.0.0`, description e.g. `Reads one verified JazzHR
company's India or remote job pages from its listing, at most forty new or stale pages per day, under the strict page
robots rule`, skill `job-sourcing`, team `sourcing-<platform>`, kind `io`, `capabilities: { http: true, pack: true }`,
egress `registry:<platform>-hosts`, timeout LISTING_TIMEOUT_MS, retry `{ max: 1, on: ['overloaded', 'network'],
backoffMs: [8000] }`.

```ts
// jazzhr.ts  (reference: freehire internal/ingest/sources/jazzhr.go @ 3957f7b, MIT, Copyright (c) 2026 freehire contributors)
export const JAZZHR_EGRESS = 'registry:jazzhr-hosts';
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const TOKEN = /^[A-Za-z0-9]{6,16}$/u;
export const parseJazzhrRef = (ref: string): string | null => (LABEL.test(ref) && ref !== 'www' && ref !== 'app' ? ref : null);
export const jazzhrHost = (slug: string): string => `${slug}.applytojob.com`;
export const jazzhrListingUrl = (slug: string): string => `https://${slug}.applytojob.com/apply`;
export function jazzhrBoardOfUrl(boardUrl: string): string | null; // https://<slug>.applytojob.com/apply → slug

/**
 * The /apply listing: each `<li class="list-group-item">` holds one job: the first anchor whose path is
 * `/apply/<token>/<slug>` on the board's host (title = its text, entities decoded, collapsed) and the text after
 * `fa-map-marker` up to the closing `</li>` (location). Linear: forward `indexOf` from one card marker to the next.
 * One page names every job (`next: false`). sourceId = the token; url = fetchUrl = `https://<host>/apply/<token>/<slug>`.
 */
export function parseJazzhrListing(html: string, slug: string): { jobs: ScopedJob[]; next: boolean } {
  const host = jazzhrHost(slug);
  const jobs: ScopedJob[] = [];
  const CARD = 'class="list-group-item"';
  let at = html.indexOf(CARD);
  while (at >= 0) {
    const nextCard = html.indexOf(CARD, at + CARD.length);
    const card = html.slice(at, nextCard < 0 ? html.length : nextCard);
    const href = anchorHrefs(card).map((h) => decodeEntities(h)).find((h) => jobPath(h, host) !== null);
    const path = href === undefined ? null : jobPath(href, host);
    if (path !== null) {
      const title = anchorText(card, href as string);
      const mk = card.indexOf('fa-map-marker');
      const loc = mk < 0 ? null : collapse(htmlToText(card.slice(card.indexOf('</i>', mk) + 4, card.indexOf('</li>', mk))));
      const url = `https://${host}${path.path}`;
      jobs.push({ url, fetchUrl: url, sourceId: path.token, title, location: loc === '' ? null : loc, remote: null });
    }
    at = nextCard;
  }
  return { jobs, next: false };
}
/** `/apply/<token>/<slug>` on `host` (absolute or relative), else null. */
function jobPath(href: string, host: string): { token: string; path: string } | null;
/** The text of the first `<a …>` whose href is `href`, entities decoded, whitespace collapsed; null when blank. Forward scans only. */
export function anchorText(html: string, href: string): string | null;
```

```ts
// freshteam.ts  (reference: freehire internal/ingest/sources/freshteam.go @ 3957f7b, MIT)
export const FRESHTEAM_EGRESS = 'registry:freshteam-hosts';
const ID = /^[A-Za-z0-9_-]{12}$/u;
export const parseFreshteamRef = (ref: string): string | null => (LABEL.test(ref) && !['www', 'app', 'assets', 'cdn'].includes(ref) ? ref : null);
export const freshteamListingUrl = (slug: string, n: number): string => (n === 1 ? `https://${slug}.freshteam.com/jobs` : `https://${slug}.freshteam.com/jobs?page=${n}`);

/**
 * The /jobs listing: each `<a href="/jobs/<id12>/<slug>" … data-portal-location="…" data-portal-remote-location=…>`
 * is one job (title = the `<div class="job-title">` text after it; location = the attribute, entities decoded; remote =
 * the attribute `true`/`false`, else null). `next` = the page links `/jobs?page=<n+1>`. Linear scan over `<a ` tags.
 */
export function parseFreshteamListing(html: string, slug: string, n = 1): { jobs: ScopedJob[]; next: boolean };
```

Normalizer: `jazzhr: (raw, r) => jsonLdPosting(raw, r, 'jazzhr')`, `freshteam: (raw, r) => jsonLdPosting(raw, r,
'freshteam')` (the careers JSON-LD mapping: location from `jobLocation`, remote from `jobLocationType: TELECOMMUTE`;
Freshteam also writes `"remote": "true"` as a string, which the mapper reads as TELECOMMUTE only for this platform: a
two-line addition with its own test).

Verifier clients (`PAGE_CLIENTS`): `pageRead(platform, ref, http, opts, listingUrl, (hosts) => board.fetchListing(...),
sameHostAs(host))`: the listing, then one job page for `hiringOrganization.name`; `robots: true`, `host: null`.

Daily wiring (as Task 8's page adapters):
- `REGISTRY_PLATFORMS.jazzhr = { ref: jazzhrBoardOfUrl, hosts: (ref) => one(mapNull(parseJazzhrRef(ref), jazzhrHost)), egress: JAZZHR_EGRESS }`,
  the same for freshteam;
- `TEAM_ORDER` gains `'sourcing-jazzhr', 'sourcing-freshteam'` after the small platforms;
- `dailyAgents`: `...(has('jazzhr') ? [jazzhr.make(pages())] : [])`, same for freshteam;
- edges `DiscoveryRequest@1 → src-jazzhr | src-freshteam` only when wired;
- `HTTP_BUDGETS`: `perRequestMs: Math.floor(LISTING_TIMEOUT_MS / LISTING_MAX_REQUESTS)`;
- allow-list: `jazzhrEgress: ['src-jazzhr']`, `freshteamEgress: ['src-freshteam']` and their rows;
- `exported-agents.ts`: `{ platform: 'jazzhr', company: 'Example', ref: 'example' }`, `{ platform: 'freshteam', … }`.

- [ ] **Step 1: Failing tests** (`tests/app/sources-listing-pages.test.ts`, the `sources-small.test.ts` harness:
  stubbed fetch, a host pacer that records sleeps, `issueContext` with the egress set):

```ts
describe('JazzHR listing', () => {
  it('parses every card: token, title, location, absolute URL', () => {
    const l = parseJazzhrListing(fx('jazzhr/listing.html'), 'baxterplanning');
    expect(l.next).toBe(false);
    expect(l.jobs.map((j) => [j.sourceId, j.title, j.location])).toEqual([
      ['LuHTxCmJVv', 'Business Development Representative', 'Remote'],
      ['Mn2qS5X8cV', 'Director of Quality', 'Pune, India'],
    ]);
    expect(l.jobs[0]?.url).toBe('https://baxterplanning.applytojob.com/apply/LuHTxCmJVv/Business-Development-Representative');
  });
  it('ignores anchors to other hosts or other paths', () => {
    const html = '<li class="list-group-item"><a href="https://evil.example/apply/AAAAAAAA/x">x</a></li><li class="list-group-item"><a href="/apply/jobs">all</a></li>';
    expect(parseJazzhrListing(html, 'acme').jobs).toEqual([]);
  });
  it('is linear on a 2 MB adversarial page (no backtracking)', () => {
    const html = '<li class="list-group-item">' + '<a href="/apply/'.repeat(100_000);
    const t0 = performance.now();
    parseJazzhrListing(html, 'acme');
    expect(performance.now() - t0).toBeLessThan(500);
  });
});

describe('scopeListed', () => {
  const job = (id: string, location: string | null, remote: boolean | null = null): ScopedJob => ({ url: `https://a.example/${id}`, fetchUrl: `https://a.example/${id}`, sourceId: id, title: 'Engineer', location, remote });
  it('keeps India, office, remote and unknown; counts the rest in one note', () => {
    const skipped: string[] = [];
    const ctx = { skipped: (n: readonly string[]) => void skipped.push(...n) } as unknown as AgentContext;
    const kept = scopeListed([job('a', 'Pune, India'), job('b', 'Austin, TX'), job('c', 'Remote'), job('d', null), job('e', 'Barcelona'), job('f', 'Chennai', true)], [], 'Acme', ctx);
    expect(kept.map((j) => j.sourceId)).toEqual(['a', 'c', 'd', 'f']);
    expect(skipped).toEqual(['not-india Acme: 2 of 6 listed jobs outside India and not remote (not fetched)']);
  });
});

describe('src-jazzhr', () => {
  it('robots.txt first, then the listing, then only in-scope title-passing job pages, 2 s apart', async () => {
    const h = harness({ egress: JAZZHR_EGRESS, host: 'baxterplanning.applytojob.com' }, {
      'https://baxterplanning.applytojob.com/robots.txt': { status: 200, body: fx('jazzhr/robots.txt') },
      'https://baxterplanning.applytojob.com/apply': { status: 200, body: fx('jazzhr/listing.html') },
      'https://baxterplanning.applytojob.com/apply/LuHTxCmJVv/Business-Development-Representative': { status: 200, body: fx('jazzhr/job-remote.html') },
      'https://baxterplanning.applytojob.com/apply/Mn2qS5X8cV/Director-Of-Quality': { status: 200, body: fx('jazzhr/job-pune.html') },
    }, PACK_ALL_TITLES);
    const out = await jazzhr.make({ hosts: dailyPageHosts() }).run(req('jazzhr', 'baxterplanning'), h.ctx);
    expect(h.calls[0]).toBe('https://baxterplanning.applytojob.com/robots.txt');
    expect(h.calls[1]).toBe('https://baxterplanning.applytojob.com/apply');
    expect(out.map((p) => p.sourceId)).toEqual(['LuHTxCmJVv', 'Mn2qS5X8cV']);
    expect(Math.min(...h.slept.filter((s) => s > 0))).toBeGreaterThanOrEqual(2000 - 500);
    for (const p of out) expect(Posting.schema.safeParse(normalize(p)).success).toBe(true);
  });
  it('a robots disallow of /apply is a named skip, no listing request', async () => { /* robots: Disallow: /apply → skipped 'robots-disallow baxterplanning.applytojob.com: …', calls = [robots] */ });
  it('403 on the listing disables the host: challenged, never retried; a second company on that host is deferred', async () => {
    const hosts = dailyPageHosts();
    const h = harness({ egress: JAZZHR_EGRESS, host: 'acme.applytojob.com' }, {
      'https://acme.applytojob.com/robots.txt': { status: 200, body: fx('jazzhr/robots.txt') },
      'https://acme.applytojob.com/apply': { status: 403, body: 'Forbidden' },
    }, PACK_ALL_TITLES);
    const agent = jazzhr.make({ hosts });
    await expect(agent.run(req('jazzhr', 'acme'), h.ctx)).rejects.toMatchObject({ code: 'challenged' });
    expect(hosts.disabledWhy('acme.applytojob.com')).toBe('http-403');
    const before = h.calls.length;
    await expect(agent.run(req('jazzhr', 'acme', 'Acme Two'), h.ctx)).rejects.toMatchObject({ code: 'input_rejected', message: expect.stringContaining('host-disabled:http-403 on acme.applytojob.com') });
    expect(h.calls.length).toBe(before); // nothing asked again
  });
  it('a challenge page (cf-chl) on the listing is challenged', async () => { /* … */ });
  it('a listing over LISTING_MAX_BYTES is input_rejected, never parsed', async () => { /* … */ });
});

describe('src-freshteam', () => {
  it('reads page 2 when page 1 links it, stops at a page with no new id', async () => { /* listing.html links ?page=2; page2 repeats one id and adds one */ });
  it('a listing still linking a next page after LISTING_MAX_PAGES is input_rejected listing-cap', async () => {
    const page = (n: number) => `<a href="/jobs/${String(n).padStart(12, 'x')}/role-${n}" data-portal-location="Remote" data-portal-remote-location=true><div class="job-title">Engineer ${n}</div></a><a href="/jobs?page=${n + 1}">next</a>`;
    const routes: Record<string, Route> = { 'https://acme.freshteam.com/robots.txt': { status: 200, body: fx('freshteam/robots.txt') } };
    for (let n = 1; n <= LISTING_MAX_PAGES; n++) routes[freshteamListingUrl('acme', n)] = { status: 200, body: page(n) };
    const h = harness({ egress: FRESHTEAM_EGRESS, host: 'acme.freshteam.com' }, routes, PACK_ALL_TITLES);
    await expect(freshteam.make({ hosts: dailyPageHosts() }).run(req('freshteam', 'acme'), h.ctx)).rejects.toMatchObject({
      code: 'input_rejected',
      message: expect.stringMatching(/^listing-cap Freshteam acme: still more pages after 5; nothing read, never truncated/),
    });
    expect(h.calls.filter((u) => u.includes('/jobs/') && !u.includes('?page'))).toEqual([]); // no job page asked
  });
  it('maps "remote": "true" to a remote posting', () => { /* normalize(job.html raw).remote */ });
});

describe('verifier clients', () => {
  it('jazzhr: listing then one job page; hiringOrganization names the board', async () => { /* status verified for candidate "Baxter Planning" */ });
  it('freshteam: a board with 0 listed jobs is proposed, no job page fetched', async () => { /* … */ });
});

it('daily wiring: no jazzhr/freshteam agent without a registry board of theirs', () => {
  expect(dailyAgents(/* empty registry, as the existing pipeline test */).map((a) => a.contract.id)).not.toContain('src-jazzhr');
});
```

  Fill the `/* … */` bodies with the same harness and fixtures (each a real assertion on calls, notes and the thrown
  `KernelError` code); they are listed so none is forgotten.

- [ ] **Step 2: Run, expect FAIL.** `timeout 300 node --run test -- tests/app/sources-listing-pages.test.ts`
- [ ] **Step 3: Implement.** **Step 4:** `timeout 900 node --run verify`; daily-identity unchanged;
  `node --run contracts:export`.
- [ ] **Step 5: Commit** `feat(sources): JazzHR and Freshteam adapters with a listing-level India/remote scope`

---

### Task 3: Daily adapter: Zoho Recruit (one page, embedded JSON list)

**Reference:** freehire `zoho.go` @ `3957f7b` (MIT). A board is its careers host (`<label>.zohorecruit.<region TLD>`);
`GET https://<host>/jobs/Careers` embeds every opening as HTML-escaped JSON in `<input id="jobs" value="…">` (seen
live: 21 openings, 1.8 MB page). robots.txt (seen live) allows `/jobs`, `/jobs/`, `/jobs/*` and ends `Disallow: /`.
The embedded records have no description; the adapter does NOT fetch detail pages (freehire's description comes from a
JS-escaped blob; the Breezy/Rippling precedent: eligibility judges title, location, remote flag and job type). It is a
`feedBoard` with `documented: false` (the strict page rule).

**Files:** create `src/app/agents/sources/platforms/zohorecruit.ts`; modify `small.ts` (append to `SMALL_PLATFORMS`
and `SMALL_PLATFORM_NAMES`), `client.ts` (nothing: `FEED_CLIENTS` derives it), `normalizer.ts`, `pipeline.ts`
(`small('zohorecruit')`), `allow-list.ts`, `exported-agents.ts`. Fixture `tests/fixtures/sx/zohorecruit/careers.html`
(trimmed to the `<input id="jobs">` element plus 2 KB of surrounding markup, 4 openings: one remote, one in an Indian
city, one unpublished, one with no `id`), `robots.txt`. Test: extend `tests/app/sources-small.test.ts` with a
`zohorecruit` row (the table-driven tests then cover strict robots, refusals, caps and the verifier client) plus a
`zohorecruit` describe block.

```ts
// zohorecruit.ts
export const ZOHO_EGRESS = 'registry:zohorecruit-hosts';
const HOST = /^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.zohorecruit\.(?:com|in|eu|com\.au)$/u;
export const parseZohoRef = (ref: string): string | null => (HOST.test(ref) && !ref.startsWith('www.') ? ref : null);
export const zohoUrl = (host: string): string => `https://${host}/jobs/Careers`;
export function zohoBoardOfUrl(boardUrl: string): string | null {
  const u = plainHttps(boardUrl);
  return u === null || u.pathname.replace(/\/$/u, '') !== '/jobs/Careers' ? null : parseZohoRef(u.hostname);
}

const Opening = z.object({
  id: z.string().regex(/^\d{6,24}$/u, 'no id'),
  Posting_Title: z.string().refine((t) => t.trim() !== '', 'blank title'),
  City: z.string().nullish(),
  State: z.string().nullish(),
  Country: z.string().nullish(),
  Remote_Job: z.boolean().nullish(),
  Publish: z.boolean().nullish(),
  Job_Type: z.string().nullish(),
}).passthrough();

/**
 * The value of the first `<input …>` whose `id` is `jobs` (attribute order free, single or double quotes), entities
 * decoded; null when there is none. Linear: forward `indexOf('<input')`, then the tag's attributes read once.
 */
export function embeddedJobs(html: string): string | null;

export function parseZoho(body: string, host: string, req: { company: string; slug: string }): FeedPage {
  const what = `zohorecruit ${host}`;
  const raw = embeddedJobs(body);
  if (raw === null) throw feedProblem(what, 'no <input id="jobs"> list on the careers page');
  const json = jsonBody(raw, what);
  if (!Array.isArray(json)) throw feedProblem(what, 'response shape is not valid (root: expected a list of openings)');
  const postings: RawPosting[] = [];
  const malformed: string[] = [];
  json.forEach((e: unknown, i) => {
    const r = Opening.safeParse(e);
    if (!r.success) return void malformed.push(`entry ${i}: ${zodWhy(r.error)}`);
    const d = r.data;
    if (d.Publish === false) return; // not on the career site: not an open job (not malformed)
    const raw = { id: d.id, title: d.Posting_Title.trim(), url: `https://${host}/jobs/Careers/${d.id}`, city: textOf(d.City), state: textOf(d.State), country: textOf(d.Country), remote: d.Remote_Job ?? null, jobType: textOf(d.Job_Type) };
    postings.push({ source: 'zohorecruit', sourceId: d.id, company: req.company, slug: req.slug, raw });
  });
  return { postings, malformed, listed: json.length, names: [], total: null };
}

export const zohorecruit = feedBoard<string>({
  platform: 'zohorecruit', label: 'Zoho Recruit', team: 'sourcing-zohorecruit', egress: ZOHO_EGRESS, documented: false, fixedHost: null,
  parseRef: parseZohoRef, refOf: (h) => h, hostOf: (h) => h, urlOf: zohoUrl, boardOfUrl: zohoBoardOfUrl,
  // no company name in the list: the host's first label is compared (generic-label rules), as Personio's
  nameKey: (h) => h.split('.')[0] ?? null,
  parse: (body, host, req) => parseZoho(body, host, req),
});
```

Normalizer mapper `zohorecruit` (`smallPosting`): title; url; location = `[city, state, country]` joined; remote =
`raw.remote === true`; employment from `jobType` (`Full time` → full-time, `Contract`/`Temporary` → contract,
`Part time` → part-time, else null); description `''`; `postedAt: null`.

- [ ] **Step 1: Failing tests:**
  - the fixture parses to 2 postings (unpublished skipped silently, the id-less one a named malformed entry);
  - entities: `&#34;` and `&quot;` both decode; an `<input id='jobs' value='…'>` with single quotes parses;
  - a page without the input is `input_rejected` (`no <input id="jobs">`), and a 2xx under 32 KB with a challenge
    marker and no input is `challenged` (the `feedBoard` rule);
  - `embeddedJobs` is linear on `'<input '.repeat(200_000)` (< 500 ms);
  - mapping: the remote opening normalizes `remote: true`; the Bengaluru one is office-eligible with the fixture
    pack's office cities;
  - the verifier client compares the host label (`shurutech` ≈ "Shuru Technologies" → proposed "board name not
    available, please confirm"; candidate "Shurutech" → verified).
- [ ] **Steps 2–4** as Task 2. **Step 5: Commit** `feat(sources): Zoho Recruit adapter from the careers page's embedded list`

---

### Task 4: Daily adapter: Manatal (keyless paged JSON); paging for feed boards

**Reference:** freehire `manatal.go` @ `3957f7b` (MIT). `GET https://open.api.manatal.com/open/v3/career-page/<slug>/jobs/`
returns a DRF page `{count, next, previous, results}` with 10 jobs per page, each with `hash`, `position_name`,
`description` (HTML), `city`, `state`, `country`, `location_display`, `is_remote`, `contract_details`, `salary_min`,
`salary_max`, `currency_code` (seen live). robots.txt of `open.api.manatal.com` answers 404 (allows all); it is still
asked once per run (`documented: false`: the endpoint is the career page's own JSON, not a published developer API).
Public job URL: `https://www.careers-page.com/<slug>/job/<hash>`. Many Manatal tenants are recruitment agencies with
thousands of jobs (one seen: 2,010): a board over the cap is refused loudly from page 1's `count`, before page 2.

**Files:** modify `feed-board.ts` (optional paging), create `manatal.ts`; wiring as Task 3. Fixtures
`tests/fixtures/sx/manatal/{page1.json,page2.json,over-cap.json}`. Tests: extend `tests/app/sources-small.test.ts`.

```ts
// feed-board.ts: FeedSpec gains
/**
 * A paged feed (Manatal): the next page's URL from a parsed 2xx body (null: the last page), on the board's own host
 * only (another host is a page-level problem). Absent: one request, as the nine Task 9 feeds.
 */
readonly next?: (body: string, b: B) => string | null;
/** The platform's total from page 1, checked before page 2: over FEED_MAX_JOBS_PAGED the board is refused (`job-cap`). */
readonly totalOf?: (body: string) => number | null;

/** A paged feed's job cap: FEED_MAX_PAGES pages of the platform's page size (Manatal 10). */
export const FEED_MAX_JOBS_PAGED = 100;
```

`fetchFeed` with `next`: page 1 as today; if `totalOf(page 1) > FEED_MAX_JOBS_PAGED` → `input_rejected`
`job-cap <label> <ref>: the feed lists N jobs, over the cap of 100 (10 pages); nothing read, never truncated`; then
follow `next` (each request through `hostRequest`, the 2 s spacing) until null; a `next` after page FEED_MAX_PAGES is
the same `job-cap` refusal; a page's postings are concatenated, malformed notes prefixed `page <n> `; a `next` URL off
the board host or not `https` → `feedProblem`. The nine existing feeds are unchanged (no `next`: one request; their
tests stay green).

```ts
// manatal.ts
export const MANATAL_HOST = 'open.api.manatal.com';
export const MANATAL_EGRESS = 'registry:manatal-hosts';
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u;
export const parseManatalRef = (ref: string): string | null => (SLUG.test(ref) ? ref : null);
export const manatalUrl = (slug: string): string => `https://${MANATAL_HOST}/open/v3/career-page/${slug}/jobs/`;
export function manatalBoardOfUrl(boardUrl: string): string | null; // the list URL, any ?page= stripped

const Job = z.object({
  hash: z.string().regex(/^[A-Za-z0-9]{4,32}$/u, 'no hash'),
  position_name: z.string().refine((t) => t.trim() !== '', 'blank title'),
  description: z.string().nullish(),
  city: z.string().nullish(), state: z.string().nullish(), country: z.string().nullish(), location_display: z.string().nullish(),
  is_remote: z.boolean().nullish(),
  contract_details: z.string().nullish(),
}).passthrough();
const Page = z.object({ count: z.number().int().nonnegative(), next: z.string().nullable(), results: z.array(z.unknown()) }).passthrough();

export function parseManatal(body: string, slug: string, req: { company: string; slug: string }): FeedPage;
// raw: { hash, title, url: `https://www.careers-page.com/${slug}/job/${hash}`, description, location: location_display ?? join(city, state, country), remote: is_remote ?? null, contract: contract_details ?? null }
// salary fields are dropped (agency boards state them inconsistently; the scorer reads the description)
// names: [] (organization_name is a department, freehire's note): the slug is compared under the generic-label rules

export const manatal = feedBoard<string>({
  platform: 'manatal', label: 'Manatal', team: 'sourcing-manatal', egress: MANATAL_EGRESS, documented: false, fixedHost: MANATAL_HOST,
  parseRef: parseManatalRef, refOf: (s) => s, hostOf: () => MANATAL_HOST, urlOf: manatalUrl, boardOfUrl: manatalBoardOfUrl,
  parse: (body, slug, req) => parseManatal(body, slug, req),
  next: (body) => { const p = Page.safeParse(jsonBody(body, 'manatal')); return p.success ? p.data.next : null; },
  totalOf: (body) => { const p = Page.safeParse(jsonBody(body, 'manatal')); return p.success ? p.data.count : null; },
});
```

Normalizer mapper `manatal`: description from `htmlish(description)`; employment from `contract` (`full_time`,
`part_time`, `contract`/`temporary`/`freelance` → contract, `internship`); remote from the flag only.

The verifier client for a paged feed reads page 1 only (`complete: false` when `next` is non-null), so a verify costs
one request (plus robots.txt).

- [ ] **Step 1: Failing tests:**
  - page 1 + page 2 → 13 postings sorted by hash, 2 requests 2 s apart after robots.txt;
  - `over-cap.json` (`count: 2010`) → `job-cap` refusal, exactly one feed request made;
  - `next` pointing at `https://evil.example/…` → `input_rejected`, page 2 never asked;
  - a page whose `results` all fail → `input_rejected` (schema drift), one failing → a named note `manatal Acme page 2 entry 3: …`;
  - every Task 9 feed still makes exactly one feed request (the existing table test, unchanged).
- [ ] **Steps 2–4.** **Step 5: Commit** `feat(sources): Manatal adapter; feed boards may page, with a loud job cap`

---
### Task 5: The freehire API module and the board-id translation (pure, shared by the build script and the agent)

**Files:** create `src/app/coverage/freehire-api.ts`, `src/app/coverage/freehire-boards.ts`,
`evals/datasets/freehire-rows.jsonl` (≥ 40 recorded rows, hand-labelled `{board|lead|drop, why}`), register the eval
`freehire-rows` in `src/app/evals.ts` (a deterministic `classifyRow` case set, metric exact match, target 1.000).
Fixtures `tests/fixtures/sx/freehire/{search-ok.json,search-ignored.json,search-shape.json}` (trimmed from the
2026-10-15 recordings `qa.json`, `qb.json`, `qc.json`: 12 rows covering every source kind below). Test:
`tests/app/coverage/freehire-api.test.ts`.

**freehire-api.ts** (the API is documented at `https://freehire.me/docs/api` and `/openapi.yaml`; keyless; robots.txt
`Allow: /` and asks bots to use the JSON API; 600 requests/min per IP; terms of 2026-08-10: "no scraping beyond our
documented API, no attempting to bypass rate limits or authentication"; no attribution required, given anyway):

```ts
export const FREEHIRE_HOST = 'freehire.me';
export const FREEHIRE_API = `https://${FREEHIRE_HOST}/api/v1`;
/** The fields jobpilot reads. Everything else, notably the LLM-filled `enrichment`, `countries`, `regions`,
 *  `work_mode`, `skills`, `cities`, `collections` and `reality`, is NEVER read (passthrough drops it from raw). */
export const FreehireRow = z.object({
  source: z.string().min(1),
  external_id: z.string(),
  url: z.string().url(),
  title: z.string().min(1),
  company: z.string().nullable(),
  location: z.string().nullable(),
  posted_at: z.string().nullable(),
  created_at: z.string(),
  last_seen_at: z.string().nullish(),
  closed_at: z.string().nullish(),
});
export type FreehireRow = z.infer<typeof FreehireRow>;
const Page = z.object({
  data: z.array(z.unknown()),
  meta: z.object({ total: z.number().int().nonnegative(), limit: z.number().int(), offset: z.number().int(), ignored_params: z.array(z.string()).optional() }).passthrough(),
}).passthrough();

export type PageCheck = { readonly ok: true; readonly rows: FreehireRow[]; readonly malformed: string[]; readonly total: number } | { readonly ok: false; readonly why: string };

/**
 * A search page: JSON, the envelope above, and `meta.ignored_params` ABSENT OR EMPTY (freehire ignores an unknown
 * parameter instead of refusing it, so a renamed filter would silently widen the result: that is a shape change, never
 * data). One row failing `FreehireRow` is a named malformed entry; every row failing is a shape change.
 */
export function checkPage(body: string): PageCheck;

/** The URL without `utm_*` query parameters (freehire appends `utm_source=freehire.me`), otherwise unchanged. */
export function stripTracking(url: string): string;

/** jobpilot's platform for a freehire `source`, or null (a source jobpilot cannot read). UKG is null: it is skipped. */
export const FREEHIRE_PLATFORMS: Readonly<Record<string, Platform>> = {
  greenhouse: 'greenhouse', lever: 'lever', ashby: 'ashby', workday: 'workday', eightfold: 'eightfold', oracle: 'oracle',
  icims: 'icims', successfactors: 'successfactors', smartrecruiters: 'smartrecruiters', workable: 'workable',
  recruitee: 'recruitee', teamtailor: 'teamtailor', personio: 'personio', bamboohr: 'bamboohr', breezy: 'breezy',
  pinpoint: 'pinpoint', rippling: 'rippling', gem: 'gem', jazzhr: 'jazzhr', zohorecruit: 'zohorecruit', manatal: 'manatal',
  freshteam: 'freshteam',
};

/** freehire sources whose rows are re-syndicated listings with no employer link: never a lead (fixed list). */
export const LEAD_SOURCE_DENY = /^(?:whatjobs(?:-[a-z]{2})?|adzuna|powertofly)$/u;

/** A tech title (fixed word list, word-bounded). */
export const TECH_TITLE = /\b(?:engineer(?:ing)?|developer|programmer|architect|sre|devops|back[\s-]?end|full[\s-]?stack|platform|software|sde|swe|data|ml|machine learning|ai|security|infrastructure|cloud)\b/iu;
/** A location open to anyone (fixed words, word-bounded): "Worldwide", "Anywhere in the World", "Remote - Global". */
export const WORLDWIDE_REMOTE = /\b(?:anywhere|worldwide|world\s*wide|global(?:ly)?|international)\b/iu;

/**
 * jobpilot's own evidence that a row is India or worldwide-remote tech work, from the RAW `title` and `location` only:
 * `india` when `namesIndia(location)`, `worldwide` when WORLDWIDE_REMOTE matches and the location names no country
 * other than India (`countriesIn`), else null; null too when the title fails TECH_TITLE.
 */
export function evidenceOf(row: Pick<FreehireRow, 'title' | 'location'>): 'india' | 'worldwide' | null;

/**
 * `(platform, board)` of a row on a supported source: the `external_id` before its FIRST `:` (freehire's board id),
 * case kept (Oracle site numbers are case-sensitive); matching against catalogue boards compares lower-cased.
 */
export function boardOfRow(row: Pick<FreehireRow, 'source' | 'external_id'>): { readonly platform: Platform; readonly board: string } | null;
```

**freehire-boards.ts:**

```ts
/**
 * freehire's board id (catalogue `board:` field, or a row's external_id prefix) → jobpilot's ref for the platform, or
 * null when jobpilot cannot read that board shape (counted by the caller, never guessed):
 * - workday `host/site` → `host/<host's first label>/site`; `host/tenant/site` (myworkdaysite) unchanged;
 * - icims `slug` → `careers-<slug>.icims.com`; a dotted vanity host (the "careers-home" product) → null;
 * - personio `slug` → `<slug>.jobs.personio.de`;
 * - teamtailor `slug` → `<slug>.teamtailor.com`, a host unchanged;
 * - successfactors host, eightfold `host/domain`, oracle `host/siteNumber`, zohorecruit host: unchanged;
 * - lever, greenhouse: lower-cased; every other platform: unchanged.
 * The result must then pass `platformClient(platform).refOf(ref, null)` (Task 1-4 clients); otherwise null.
 */
export function refOfFreehireBoard(platform: Platform, board: string): string | null;

/**
 * D2, a real company name: not empty, no `/`, no host-like token (`\b[a-z0-9-]+\.[a-z]{2,}\b`), and
 * `normalCompanyName(company)` equals neither the normalised board slug nor the board host's first label
 * (`12jlkfsk` for board `12jlkfsk`, `egug.fa.us2.oraclecloud.com/CX` for an Oracle tenant: both unnamed).
 */
export function isRealCompanyName(company: string | null, board: string): company is string;

/** D3: the registry key of a freehire-sourced board, never a real domain. */
export const freehireCompanyKey = (platform: Platform, ref: string): string =>
  `fh-${createHash('sha256').update(`${platform} ${ref}`).digest('hex').slice(0, 16)}.freehire`;
```

- [ ] **Step 1: Failing tests:**

```ts
describe('checkPage', () => {
  it('reads rows and the total; never the enrichment', () => {
    const r = checkPage(fx('freehire/search-ok.json'));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.total).toBe(152);
    expect(r.rows[0]).not.toHaveProperty('enrichment');
    expect(r.rows[0]).not.toHaveProperty('countries');
  });
  it('a non-empty ignored_params is a shape change', () => {
    expect(checkPage(fx('freehire/search-ignored.json'))).toEqual({ ok: false, why: 'freehire ignored parameters: q_feilds' });
  });
  it('a body without data/meta, or not JSON, is a shape change', () => {
    expect(checkPage('{"jobs":[]}').ok).toBe(false);
    expect(checkPage('<html>').ok).toBe(false);
  });
});
it('stripTracking drops utm_* only', () => {
  expect(stripTracking('https://job-boards.greenhouse.io/twilio/jobs/8236865?utm_source=freehire.me')).toBe('https://job-boards.greenhouse.io/twilio/jobs/8236865');
  expect(stripTracking('https://a.example/j?id=4&utm_medium=api&utm_source=freehire.me')).toBe('https://a.example/j?id=4');
});
it.each([
  [{ title: 'Staff Software Engineer (L4)', location: 'Remote - India' }, 'india'],
  [{ title: 'Senior Software Engineer', location: 'Bengaluru, Karnataka, India' }, 'india'],
  [{ title: 'Senior Shopify Developer', location: 'Anywhere in the World' }, 'worldwide'],
  [{ title: 'Senior Software Engineer, Security Platform', location: 'Argentina, Remote' }, null], // freehire tagged it IN; jobpilot does not
  [{ title: 'Business Development Representative', location: 'Remote - India' }, null],
  [{ title: 'Senior Systems Engineer', location: 'In-Office' }, null],
  [{ title: 'Software Engineer', location: 'Indianapolis, IN' }, null],
])('evidenceOf(%o) = %s', (row, want) => expect(evidenceOf(row)).toBe(want));
it.each([
  [{ source: 'greenhouse', external_id: 'twilio:8236865' }, { platform: 'greenhouse', board: 'twilio' }],
  [{ source: 'workday', external_id: 'magnitudesoftware.wd1.myworkdayjobs.com/external:/job/India---Hyderabad/X_REQ1' }, { platform: 'workday', board: 'magnitudesoftware.wd1.myworkdayjobs.com/external' }],
  [{ source: 'oracle', external_id: 'fa-extu-saasfaprod1.fa.ocs.oraclecloud.com/CX_1:4080' }, { platform: 'oracle', board: 'fa-extu-saasfaprod1.fa.ocs.oraclecloud.com/CX_1' }],
  [{ source: 'remotedotcom', external_id: ':staff-engineer-backend-j1wocvrk' }, null],
  [{ source: 'ukg', external_id: 'recruiting.ultipro.com/epr1000epsus/1065…:4547' }, null],
])('boardOfRow(%o)', (row, want) => expect(boardOfRow(row)).toEqual(want));
it.each([
  ['workday', 'nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite', 'nvidia.wd5.myworkdayjobs.com/nvidia/NVIDIAExternalCareerSite'],
  ['icims', 'berrydunn', 'careers-berrydunn.icims.com'],
  ['icims', 'careers.docusign.com', null],
  ['personio', 'desotec', 'desotec.jobs.personio.de'],
  ['lever', 'Voltus', 'voltus'],
  ['jazzhr', 'baxterplanning', 'baxterplanning'],
  ['zohorecruit', '2basetechnologies.zohorecruit.in', '2basetechnologies.zohorecruit.in'],
])('refOfFreehireBoard(%s, %s) = %s', (p, b, want) => expect(refOfFreehireBoard(p as Platform, b)).toBe(want));
it.each([
  ['Twilio', 'twilio', true], ['tilthq', 'tilthq', false], ['12jlkfsk', '12jlkfsk', false],
  ['egug.fa.us2.oraclecloud.com/CX', 'egug.fa.us2.oraclecloud.com/CX', false], ['American Express', 'egug.fa.us2.oraclecloud.com/CX', true],
  [null, 'x', false], ['Getinz People', 'getinz-people', false],
])('isRealCompanyName(%s, %s) = %s', (c, b, want) => expect(isRealCompanyName(c, b)).toBe(want));
it('the company key is stable, never a domain label anyone has', () => {
  expect(freehireCompanyKey('greenhouse', 'twilio')).toMatch(/^fh-[0-9a-f]{16}\.freehire$/);
  expect(freehireCompanyKey('greenhouse', 'twilio')).toBe(freehireCompanyKey('greenhouse', 'twilio'));
});
```

  (`Getinz People` vs board `getinz-people`: the name is only the slug spelled out, so it is unnamed: the rule compares
  with spaces and dashes removed. Pin it.)
- [ ] **Steps 2–4** (eval `freehire-rows` 1.000). **Step 5: Commit** `feat(coverage): freehire API shapes and board-id translation, enrichment never read`

---

### Task 6: The vendored catalogue seed and its deterministic regeneration script

**What is vendored:** `assets/freehire/catalogue-seed.jsonl` (target ≤ 1 MB, hard cap 2 MB), `assets/freehire/manifest.json`,
`assets/freehire/NOTICE`. Nothing else from freehire is copied.

**Source:** the tarball of commit `96b53a2c7b1e545bbad0868e16ec85a2eba4f36a` of `github.com/strelov1/freehire`
(`https://codeload.github.com/strelov1/freehire/tar.gz/96b53a2c7b1e545bbad0868e16ec85a2eba4f36a`, 20.1 MB, recorded
2026-10-15). The gzip bytes are not pinned (GitHub does not promise stable archive bytes); the **content** is: the
script computes `sha256` over, for each kept platform file in name order, the line
`<name>.yml\n<sha256 of the file bytes>\n`, and refuses unless it equals

```
CATALOGUE_COMMIT = '96b53a2c7b1e545bbad0868e16ec85a2eba4f36a'
CATALOGUE_CONTENT_SHA256 = '384b6c4fbdd22e75e25bf6f0d8903c897e7be569359a9cf1da72b889cd13c084'
CATALOGUE_FILES = ashby bamboohr breezy eightfold freshteam gem greenhouse icims jazzhr lever manatal oracle personio
                  pinpoint recruitee rippling smartrecruiters successfactors teamtailor workable workday zohorecruit  (.yml, 3,821,507 bytes)
```

(computed 2026-10-15 from the recorded tarball; re-check once in Step 1 from a fresh download). `LICENSE` is read from
the same tarball and copied verbatim into NOTICE.

**Files:** create `scripts/freehire-catalogue.ts`, `scripts/ustar.ts` (a minimal reader: 512-byte headers, `ustar`
magic, regular files only, `prefix`+`name`, size in octal, no long-name extensions needed for these paths; refuses
anything else); add to `package.json` `"catalogue:freehire": "tsx scripts/freehire-catalogue.ts"`. Tests:
`tests/scripts/freehire-catalogue.test.ts` (add `tests/scripts/**` to the unit project's include if needed), fixtures
`tests/fixtures/sx/freehire/evidence/` (recorded API pages for two platforms) and an in-test tarball built with a
`ustarOf(files)` helper (no binary fixture).

**CLI:**

```
node --run catalogue:freehire -- --date 2026-10-16 --cache <dir> [--tarball <file>] [--offline] [--out assets/freehire]
```

- `--date` is required and is the only date in the outputs (no clock read);
- without `--tarball`, one GET of the codeload URL (honest UA, `--max-time`-style 120 s timeout), saved into `--cache`;
- `--offline`: no network at all; every API page must be in `--cache` (a missing one is an error naming the URL).

**Evidence pass (D1).** For each kept platform `p` in name order and each of the two fixed location queries
`EVIDENCE_QUERIES = ['india bengaluru bangalore', 'worldwide anywhere global international']` (unquoted: an OR of
tokens over `location` only):

```
GET https://freehire.me/api/v1/jobs/search?source=<p>&q=<query>&q_fields=location&sort=created_at&order=asc&limit=100&offset=<n>
```

- pages `n = 0, 100, …` while `n < total` and `n + 100 ≤ 10000` (freehire's window); a total over 10,000 is recorded in
  the manifest as `window-capped` with the total (loud, printed), never silent;
- `order=asc` so rows that arrive during the pass land after the pages already read;
- every response through `checkPage` (an `ok: false` page aborts the script naming the URL: a shape change is never
  half-applied);
- ≥ 2000 ms between requests, at most EVIDENCE_MAX_REQUESTS = 2000 (more aborts, loud), a 401/403/429 or a challenge
  aborts at once (never retried), a 5xx aborts;
- each body is saved as `<cache>/<sha256(url)>.json`, and `sha256(body)` is listed in the manifest in request order.

**Seed rule.** Parse each platform file with `yaml` (`[{company, board, …}]`; other keys ignored). For each entry:
1. `isRealCompanyName(company, board)` else counted `unnamed`;
2. `ref = refOfFreehireBoard(platform, board)` else counted `untranslatable`;
3. `evidence` = the number of evidence rows with `boardOfRow(row)` = `(platform, board.toLowerCase())` and
   `evidenceOf(row) !== null`; 0 → counted `no-evidence`;
4. kept: `{ platform, ref, boardUrl: platformClient(platform).boardUrl(ref), company, board, evidence, example }`,
   `example` = the newest evidence row's `{ title, location, url: stripTracking(url) }`;
5. duplicates by `(platform, ref)`: the higher evidence wins, ties by company name.

Output sorted by `(platform, ref)`, one JSON object per line, keys in the order above, `\n` line ends. Over 2 MB →
abort ("seed over the 2 MB budget: N bytes; tighten the rule, never truncate"). Manifest:

```json
{ "source": "github.com/strelov1/freehire", "commit": "96b53a2c…", "contentSha256": "384b6c4f…", "license": "MIT",
  "generatedOn": "2026-10-16", "rule": "sources-x D1/D2 (docs/superpowers/plans/2026-10-15-sources-expansion.md)",
  "queries": ["india bengaluru bangalore", "worldwide anywhere global international"],
  "requests": 0, "responses": ["<sha256>", "…"], "windowCapped": [{ "platform": "greenhouse", "query": "…", "total": 0 }],
  "platforms": { "greenhouse": { "entries": 0, "unnamed": 0, "untranslatable": 0, "noEvidence": 0, "kept": 0 } },
  "bytes": 0 }
```

NOTICE:

```
assets/freehire/catalogue-seed.jsonl is derived from the board catalogue of freehire
(https://github.com/strelov1/freehire), commit 96b53a2c7b1e545bbad0868e16ec85a2eba4f36a, sources/*.yml,
filtered by jobpilot's rule (see manifest.json). The source adapters for JazzHR, Zoho Recruit, Manatal and Freshteam
were written with freehire's adapters (commit 3957f7b) as a reference.

<the LICENSE text of that commit, verbatim: "MIT License\n\nCopyright (c) 2026 freehire contributors\n\nPermission is hereby granted, …">
```

- [ ] **Step 1: Failing tests** (all offline):
  - `ustar` reads the in-test archive's files; refuses a non-ustar header and a size field that runs past the end;
  - the content digest of the in-test files differs from CATALOGUE_CONTENT_SHA256 → the script refuses, naming both
    digests;
  - with `--content-sha256-override <hex>` (TEST ONLY: refused unless `NODE_ENV=test`) and the recorded evidence pages,
    the seed equals `tests/fixtures/sx/freehire/expected-seed.jsonl` byte for byte; a second run is byte-identical;
  - counts: an unnamed entry, a vanity iCIMS host, an entry without evidence and one with two evidence rows land in
    the manifest's counts;
  - `--offline` with a missing page aborts naming its URL, before writing anything;
  - a page with `ignored_params: ["q_fields"]` aborts naming the URL;
  - the 2 MB cap: a generated 2.1 MB seed aborts, nothing written.
- [ ] **Step 2: Run, expect FAIL.** **Step 3: Implement.** **Step 4:** `timeout 900 node --run verify`.
- [ ] **Step 5: Generate the real seed (live, polite, one time).**

```bash
cd ~/PersonalProject/jobpilot-sx
C=$SCRATCH/sx/fh-cache; mkdir -p $C
timeout 7200 node --run catalogue:freehire -- --date 2026-10-16 --cache $C 2>&1 | tail -40
ls -la assets/freehire && wc -l assets/freehire/catalogue-seed.jsonl
timeout 600 node --run catalogue:freehire -- --date 2026-10-16 --cache $C --offline && git diff --stat assets/freehire   # replay: no diff
```

  Report: requests made (expect several hundred; ≈ 2 s each), window-capped queries, kept per platform, bytes. If the
  seed is over 1 MB, report it and wait for the controller (the target), never trim by hand.
- [ ] **Step 6: Privacy check of the seed:** it holds company names, public board ids and public job titles only;
  grep it for the forbidden terms (`.superpowers/sdd/global-constraints.md`) and for email-like strings; 0 hits.
- [ ] **Step 7: Commit** `feat(coverage): vendored freehire catalogue seed (MIT, filtered to India and worldwide-remote tech evidence) with its regeneration script`

---

### Task 7: The catalogue seed in the weekly coverage run

**Files:** create `src/app/coverage/catalogue.ts`; modify `src/app/coverage/pipeline.ts` (verify inputs),
`src/app/coverage/run.ts` (options, recorded selection, summary line), `src/app/coverage/project.ts` (D3),
`src/app/store/app-store.ts` (`registryBoardKeys`), `src/cli.ts` (`run-coverage --no-freehire`,
`--catalogue-limit <n>`). Tests: `tests/app/coverage/catalogue.test.ts`, extend `tests/app/coverage/e2e.test.ts`.

```ts
// catalogue.ts
export const CATALOGUE_SEED = new URL('../../../assets/freehire/catalogue-seed.jsonl', import.meta.url);
export const CATALOGUE_SIGNATURE = 'freehire-catalogue:96b53a2c';
export const CATALOGUE_PER_WEEK = 300;

export const CatalogueEntry = z.object({
  platform: Platform, ref: z.string().min(1), boardUrl: z.string().url(), company: z.string().min(1), board: z.string().min(1),
  evidence: z.number().int().positive(), example: z.object({ title: z.string(), location: z.string().nullable(), url: z.string() }).strict(),
}).strict();
export type CatalogueEntry = z.infer<typeof CatalogueEntry>;

/** Every line parsed; a bad line is an error naming its number (the file is vendored: a bad line is a build bug). */
export function loadCatalogue(text: string): CatalogueEntry[];

/** `<platform> <ref lower-cased>`: the registry/verify dedupe key. */
export const boardKey = (platform: string, ref: string): string => `${platform} ${ref.toLowerCase()}`;

/**
 * This week's catalogue guesses (D4): entries whose boardKey is not in `known` (the registry's, any status, plus this
 * run's other verify inputs), by evidence desc, then platform, then ref; the first `limit`. `left` counts the rest.
 */
export function catalogueGuesses(entries: readonly CatalogueEntry[], known: ReadonlySet<string>, week: string, limit = CATALOGUE_PER_WEEK): { readonly guesses: PlatformGuess[]; readonly left: number };

/** The PlatformGuess of one freehire-sourced board (catalogue or discovery), D3. */
export function freehireGuess(o: { platform: Platform; ref: string; boardUrl: string; company: string; source: 'freehire' | 'freehire-discovery'; week: string; why: string; signature: string }): PlatformGuess {
  const candidate = { companyKey: freehireCompanyKey(o.platform, o.ref), name: o.company, website: '', careersUrl: null, source: o.source, runDate: o.week };
  return {
    site: { candidate, careersUrl: null, method: 'none', evidence: o.why },
    platform: o.platform, slug: o.ref, boardUrl: o.boardUrl, signature: o.signature, routedFrom: null,
    evidence: [`detected: ${o.platform} ${o.ref} (${o.signature})`],
  };
}
```

**Pipeline:** `CoverageStagesOptions` gains `freehireGuesses?: (taken: ReadonlySet<string>) => PlatformGuess[]`, and
the verify stage input is computed in `stagesOf` as

```ts
const fromDetector = guesses.filter((g) => g.platform !== null);
const fromFreehire = o.freehireGuesses?.(new Set(fromDetector.map((g) => boardKey(g.platform as string, g.slug ?? '')))) ?? [];
const verifyInputs = dedupeGuesses([...fromDetector, ...fromFreehire]); // first wins by boardKey; order kept
```

`o.freehireGuesses` (supplied by run.ts) returns the discovery's board guesses (Task 8) then the catalogue's, each
already filtered by the registry's `registryBoardKeys()` and the given set. **Resume safety:** run.ts records the
catalogue selection once per run as the event `coverage.catalogue` `{ keys: [...] , left }` before the verify stage
starts, and a resumed run reads the keys back instead of selecting again (the registry may have changed).

**Projection (D3):** in `projectCoverage`, before `keepLive`: a verdict whose candidate source is `freehire` or
`freehire-discovery` and whose status is `failed` becomes `proposed` with its reasons kept and `not verified: ` prefixed
to the first one. A live freehire-sourced company still goes through `keepLive` (a later failure is a failed week, as
for any company).

**run.ts / CLI:** `CoverageRunOptions` gains `freehire?: { readonly catalogue: string | null; readonly perWeek?: number; readonly discovery: boolean }`;
absent → neither (every existing test and caller unchanged). `jobpilot run-coverage` passes
`{ catalogue: fileURLToPath(CATALOGUE_SEED), discovery: true }` unless `--no-freehire`; `--catalogue-limit <n>` sets
`perWeek` (live checks). The summary and the weekly notification gain
`Catalogue: k checked (v verified, p proposed) · N left for later weeks`.

- [ ] **Step 1: Failing tests:**
  - `loadCatalogue` of a 3-line fixture; a bad line names line 2;
  - `catalogueGuesses`: evidence order, a registry key (any status, `rejected` included) skipped, the limit and `left`;
  - e2e (offline fixtures): a run with `freehire: { catalogue: <fixture seed of 3 boards>, discovery: false }` →
    one Greenhouse board verified (`company_name` matches), one Lever board proposed (slug ≠ name), one 404 board
    **proposed** with `not verified: board not found (404)…`, sources `freehire`; the Companies tab lists them under
    "freehire catalogue";
  - a second run the same week replays at $0 and selects nothing new; a run the next week skips all three (registry);
  - a detector guess and a catalogue entry for the same board: one verify step, the detector's candidate wins;
  - without the `freehire` option the e2e's step keys equal the recorded ones (existing assertions unchanged).
- [ ] **Steps 2–4.** **Step 5: Commit** `feat(coverage): the freehire catalogue seed goes straight to the verifier, 300 boards a week`

---

### Task 8: `src-freehire-discovery`, the weekly discovery stage, and the leads table

**Files:** create `src/app/coverage/discovery.ts`; modify `src/app/coverage/types.ts` (`FreehireQuery@1`,
`FreehireFinding@1`), `pipeline.ts` (stage `discover`), `run.ts` (seeds, leads projection, board guesses),
`src/app/store/schema.ts` (one migration), `src/app/store/app-store.ts` (leads methods), `src/exported-agents.ts`,
`src/app/allow-list.ts` (egress `freehire.me` only for `src-freehire-discovery`). Fixtures
`tests/fixtures/sx/freehire/discovery/` (one recorded page per query template, trimmed to ≤ 15 rows each). Test:
`tests/app/coverage/discovery.test.ts`.

**Agent header (terms recorded, as the contract's documentation):**

```ts
/**
 * `src-freehire-discovery` (sources-x D6): once a week, at most DISCOVERY_MAX_QUERIES fixed searches of freehire's
 * keyless public API (https://freehire.me/docs/api), one page of 100 rows each, never a second page.
 *
 * Terms (read 2026-10-15): robots.txt `User-agent: * Allow: /` and its comment invites bots to use the JSON API instead
 * of the pages; llms.txt "no key, no sign-up"; Terms of Service (2026-08-10): "no scraping beyond our documented API,
 * no attempting to bypass rate limits or authentication". Rate limit 600 requests/min per IP; this agent makes ≤ 10 a
 * week, ≥ 2 s apart, with the honest UA. No attribution is required; every lead links the original posting and the
 * dashboard names freehire as where it was found.
 *
 * Reads ONLY `source, external_id, url, title, company, location, posted_at, created_at, last_seen_at, closed_at`. The
 * LLM-filled fields (`enrichment`, `countries`, `regions`, `work_mode`, `skills`, `category`, `reality`) are never read,
 * and no query filters on them: queries are full-text over `title,location` plus `open_within_days` (freehire's own
 * first-seen date) and `source_exclude` (the provider, a fact).
 *
 * Fails closed: a non-2xx, a body that is not the documented envelope, a non-empty `meta.ignored_params`, every row
 * malformed, a timeout, a 5xx: the step returns NO findings and one named note `freehire-outage <queryId>: <why>`.
 * A 401, 403, 429 or a challenge also disables freehire.me for the rest of the run (`host-disabled`), never retried,
 * Retry-After never read. Nothing else in jobpilot depends on this agent.
 */
```

**Types:**

```ts
export const FreehireQuery = defineType('FreehireQuery', 1, z.object({ week: IsoDate, queryId: z.string().regex(/^q[0-9]{1,2}$/u), url: z.string().url() }).strict());
export const FreehireFinding = defineType('FreehireFinding', 1, z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('board'), platform: Platform, ref: z.string(), boardUrl: z.string(), company: z.string(), evidence: z.enum(['india', 'worldwide']), example: z.object({ title: z.string(), location: z.string().nullable(), url: z.string() }).strict(), queryId: z.string() }).strict(),
  z.object({ kind: z.literal('lead'), leadKey: z.string(), source: z.string(), url: z.string(), title: z.string(), company: z.string().nullable(), location: z.string().nullable(), postedAt: z.string().nullable(), evidence: z.enum(['india', 'worldwide']), queryId: z.string() }).strict(),
]));
```

**The query templates (D6)** (`discoveryQueries(week, officeCities)` in discovery.ts; the app layer seeds them; the
version of this list is the contract's version):

```ts
const COMMON = 'q_fields=title,location&open_within_days=7&sort=created_at&order=desc&limit=100&source_exclude=powertofly,adzuna';
export const DISCOVERY_MAX_QUERIES = 10;
/** `city` comes from the pack's office cities (at most two, pack order); never from code. */
export const DISCOVERY_TEMPLATES: readonly { readonly id: string; readonly q: (city?: string) => string; readonly perCity?: true }[] = [
  { id: 'q1', q: (c) => `"senior backend ${c}"`, perCity: true },     // q1 for office city 1
  { id: 'q2', q: (c) => `"senior backend ${c}"`, perCity: true },     // q2 for office city 2 (absent when the pack names one)
  { id: 'q3', q: () => '"senior backend india"' },
  { id: 'q4', q: () => '"senior engineer india"' },
  { id: 'q5', q: () => '"staff engineer india"' },
  { id: 'q6', q: () => '"remote india engineer"' },
  { id: 'q7', q: () => '"contract engineer remote"' },
  { id: 'q8', q: () => '"freelance developer"' },
  { id: 'q9', q: () => '"part-time engineer remote"' },
];
export function discoveryQueries(week: string, officeCities: readonly string[]): FreehireQuery[];
// url = `${FREEHIRE_API}/jobs/search?q=${encodeURIComponent(q)}&${COMMON}`; q1/q2 use officeCity(city).display lower-cased
```

**Agent (per query):** `GET url` (`getPage`, `minIntervalMs: 2000`), host state from the factory
(`makeSrcFreehireDiscovery()`: a fresh `{ disabled?: string }` per run, like `makeSrcHimalayasGigs`). Then
`checkPage`, then per row (skipping `closed_at` non-null):
- `evidenceOf(row)` null → dropped (counted);
- `boardOfRow(row)` non-null → if `isRealCompanyName` and `refOfFreehireBoard` succeed → a `board` finding (boardUrl =
  `platformClient(platform).boardUrl(ref)`), else counted `unnamed` / `untranslatable`;
- else, `LEAD_SOURCE_DENY` or a policy-denied URL host (`hostDenied(PRODUCT_POLICY_V1, host)`: LinkedIn, Indeed,
  Glassdoor, Naukri) → dropped (counted); else a `lead` with `leadKey = \`${source}:${external_id}\``, `url =
  stripTracking(url)`, `postedAt` = the date part of `posted_at` when it is an absolute ISO timestamp, else null;
- one note per query: `freehire <queryId>: N rows, b boards, l leads, d dropped (x not India/worldwide tech, y unnamed, z denied)`,
  and when `total > 100`: `freehire <queryId>: <total − 100> more matches not read (one page per query)`.

Contract: id `src-freehire-discovery`, version `1.0.0`, description `Finds new job boards and unreadable-platform
postings through at most ten weekly freehire searches`, skill `board-discovery`, team `coverage-freehire`, kind `io`,
consumes `FreehireQuery`, produces `FreehireFinding`, `capabilities: { http: true }`, egress `['freehire.me']`,
timeout 60 000 ms, `retry: { max: 0, on: [], backoffMs: [] }`.

**Stage:** `STAGES = ['seed', 'discover', 'locate', 'detect', 'verify']`. The discover stage runs only when
`o.discovery` is true (else an empty, unstored `StageResult`). Its findings: boards → `freehireGuess({…, source:
'freehire-discovery', signature: 'freehire-discovery:' + queryId, why: 'found through freehire: <title> (<location>)'})`
for the verify inputs (Task 7's `o.freehireGuesses`, discovery before catalogue); leads → `app.recordFreehireLeads(week,
leads, at)` once per run (event `coverage.leads`, so a resume does not count twice).

**Migration (additive, a literal):**

```sql
CREATE TABLE freehire_leads (
  lead_key TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  url TEXT NOT NULL,
  title TEXT NOT NULL,
  company TEXT,
  location TEXT,
  posted_at TEXT,
  evidence TEXT NOT NULL CHECK (evidence IN ('india', 'worldwide')),
  first_week TEXT NOT NULL,
  last_week TEXT NOT NULL,
  query_id TEXT NOT NULL
);
CREATE INDEX freehire_leads_by_week ON freehire_leads (last_week, lead_key);
```

`AppStore.recordFreehireLeads(week, leads, at)`: upsert by `lead_key` (first_week kept, everything else from the latest
finding); `freehireLeads(sinceWeek)`: rows with `last_week >= sinceWeek`, ordered by `lead_key`.

- [ ] **Step 1: Failing tests:**
  - `discoveryQueries('2026-10-18', ['Pune'])` → 8 queries (q1 for `pune`, no q2), each URL exactly as built, none with
    an enrichment parameter (assert the parameter names ⊆ `q, q_fields, open_within_days, sort, order, limit, source_exclude`);
    with three office cities → 9 (two city queries), never more than DISCOVERY_MAX_QUERIES;
  - a recorded page → the expected findings (a Greenhouse board for a real name, a lead from `remotedotcom`, the
    Argentina row dropped, a `whatjobs-in` row dropped, an unnamed `tilthq` board counted), utm stripped;
  - `ignored_params` non-empty → `[]` and `freehire-outage q3: freehire ignored parameters: …`;
  - 503 → `[]` + outage note, the step is `done` (not failed), the next query still asked;
  - 429 → `[]` + outage note, freehire.me disabled: the remaining queries make no request (notes say `host-disabled:http-429`);
  - a challenge page (Cloudflare) → the same as 429 with `challenge`;
  - requests ≥ 2000 ms apart (the pacer's record);
  - stage e2e: findings → one discovery board verified, one lead stored; a resume does not store the lead twice; the
    weekly line `Discovery: b boards (v verified) · l leads for review`.
- [ ] **Steps 2–4.** **Step 5: Commit** `feat(coverage): weekly freehire discovery stage; new boards to the verifier, other postings stored as leads`

---

### Task 9: `src-freehire-leads`: unreadable-platform postings in the daily review band only

**Files:** create `src/app/agents/sources/freehire-leads.ts`; modify `src/app/agents/normalizer.ts` (mapper `freehire`),
`src/app/agents/eligibility.ts` (the cap), `src/app/pipeline.ts` (wiring when leads exist), `src/app/run.ts` (reads
`app.freehireLeads(coverageWeek(now) − 7 days)` SELECT-only and hands them to `dailyAgents`), `src/exported-agents.ts`.
Test: `tests/app/freehire-leads.test.ts`; daily-identity stays as it is.

```ts
// freehire-leads.ts
export const LEADS_MAX_PER_DAY = 200;
export const srcFreehireLeadsContract = defineContract({
  id: 'src-freehire-leads', version: '1.0.0',
  description: 'Turns the stored freehire leads into raw postings for the review band, fetching nothing',
  skills: ['job-sourcing'], team: 'sourcing-freehire', kind: 'deterministic',
  consumes: DiscoveryRequest, produces: RawPosting, requires: [knownAts],
  dataClasses: { in: ['P0'], out: ['P0'] }, budget: { usdPerCall: 0, usdPerRun: 0 }, timeoutMs: 10_000,
});
/** The leads are injected by the app layer (the agent reads no store). Over LEADS_MAX_PER_DAY: the first 200 by leadKey and a named note. */
export function makeSrcFreehireLeads(leads: readonly StoredLead[]): Agent<DiscoveryRequest, RawPosting>;
// one RawPosting per lead: { source: 'freehire', sourceId: leadKey, company: lead.company ?? 'Unknown company', slug: 'leads', raw: { url, title, company, location, postedAt, via: lead.source } }
```

- `dailySeeds` adds `{ ats: 'freehire', slug: 'leads', company: 'freehire', runDate }` only when there are leads; the
  agent, its team (`sourcing-freehire`, after the platform teams in `TEAM_ORDER`) and its edge are wired only then.
- Normalizer `freehire`: title, company, url, location; remote = `REMOTE_WORD.test(location)`; description `''`
  (freehire's preview is truncated and not stored); `postedAt` as stored; `ats: 'freehire'`.
- Eligibility, after every existing rule: a posting with `ats === 'freehire'` that would be `eligible` is `review`
  with the reason `freehire-lead: found through freehire on a platform jobpilot cannot read; review only` (a rejected
  one stays rejected). The eligibility golden set gains 3 cases (eligible→review, rejected stays, review stays).
- The job page (`views/job.ts`) shows "Found through freehire (via <source>)" for such a job.

- [ ] **Step 1: Failing tests:** no leads → no agent, no seed, step keys identical to the empty-registry baseline
  (re-run `daily-identity.test.ts`, unchanged); 3 leads → 3 postings, all `review` (one would be eligible), sorted;
  250 leads → 200 + `freehire-leads: 50 more leads not read today (cap 200)`; a lead equal to a job read directly
  (same company, title, location) is linked as a duplicate by the existing dedupe, the direct one primary.
- [ ] **Steps 2–4** (evals 1.000). **Step 5: Commit** `feat(sources): stored freehire leads reach the daily review band, never eligible`

---
### Task 10: Freelance plumbing and the shared GitHub host rules; Draft.dev writer jobs

**Freelance plumbing (for Tasks 10–12):**
- `freelance/types.ts`: `Platform` gains `'draftdev'`, `'prime-intellect'`, `'fractional-jobs'` (the `gigs.platform`
  column has no CHECK: no migration).
- `pack/freelance-schema.ts`: `DEFAULT_PLATFORMS` entries `{ enabled: true, queries: [] }` for the three;
  `DEFAULT_RULES` `{ ...PLAIN_DEFAULTS, minIntervalMs: 2000 }` for the three.
- `freelance/pipeline.ts`: `TEAM_ORDER` gains `'sourcing-draftdev', 'sourcing-prime-intellect', 'sourcing-fractional-jobs'`
  (each source its own team, its own breaker); `PLATFORM_AGENT` and `FETCHING_PLATFORMS` gain them; `freelanceSeeds`
  adds one request each (`query: ''`) when on, after Himalayas and before `boards`; `freelanceAgents()` builds them
  per wiring with ONE shared `GithubHosts` for the two GitHub sources (one host, one request budget).
- `gig-normalizer.ts`: `Draft` gains `hours?: Gig['hoursPerWeek']` (a source's structured hours; absent: `hoursOf(text)`
  as today); `normalizeGig` dispatches the three new mappers.
- **Freelance regression:** a test runs the freelance e2e with the three platforms disabled in the fixture
  `freelance.yaml` and asserts its step keys equal a golden recorded from `main` before this task
  (`tests/fixtures/freelance-identity.json`, written once with `UPDATE_GOLDEN=1` on `main`'s code, then never). The
  daily-identity golden is untouched (no daily file changes in Tasks 10–12).

**Files:** create `src/app/freelance/sources/github.ts`, `src/app/freelance/sources/draftdev.ts`; the plumbing above.
Fixtures `tests/fixtures/sx/draftdev/{contents.json,readme.json,content-strategist.json,writer-role.json}` (GitHub
contents API answers, recorded 2026-10-15; `writer-role.json` a synthetic open role in the same format, marked so in the
fixture's `_note`). Tests: `tests/app/freelance/github.test.ts`, `tests/app/freelance/draftdev.test.ts`; append 4
cases to `evals/datasets/gig-normalizer.jsonl`.

**github.ts** (GitHub REST API, documented public, unauthenticated: 60 core requests/hour and 10 search requests/minute
per IP; robots.txt is not asked for the API host, as Greenhouse's API is read):

```ts
export const GITHUB_API_HOST = 'api.github.com';
/** Requests to api.github.com per freelance run, both GitHub sources together (2 runs/day → ≤ 24 of 60/hour). */
export const GITHUB_MAX_REQUESTS_PER_RUN = 12;
export interface GithubHosts { used: number; disabled?: string }
export const makeGithubHosts = (): GithubHosts => ({ used: 0 });

/**
 * One GET to api.github.com under the run's rules: a disabled host is never asked (`input_rejected`
 * `host-disabled:<why> on api.github.com`); over GITHUB_MAX_REQUESTS_PER_RUN → `input_rejected` `github-budget: …`
 * (loud, never a silent stop); `minIntervalMs: 2000`. 403 (GitHub's rate-limit answer is a 403) and 401 disable the
 * host (`challenged`), 429 disables it (`rate_limit`); Retry-After and the X-RateLimit headers are never read (the
 * broker does not expose them, and a refusal ends the run's reads anyway). 404 → `gone`; 5xx → `overloaded`; a body
 * that is not JSON → `invalid_output`.
 */
export async function githubJson(ctx: AgentContext, hosts: GithubHosts, path: string): Promise<unknown>;
```

**draftdev.ts:**

```ts
/**
 * `src-draftdev`: Draft.dev's public hiring repo `github.com/draftdev/jobs`, read through the GitHub contents API:
 * 1. `GET /repos/draftdev/jobs/contents/` (the root listing);
 * 2. `GET /repos/draftdev/jobs/contents/<name>` for `README.md` and each other root `*.md` (never `archive/`), at most
 *    DRAFTDEV_MAX_FILES (more: `input_rejected` `draftdev: N role files over the cap of 8`), base64 `content` decoded.
 * Gigs:
 * - README's `## Open Roles` bullets, `- **[<Title>](<url>) (<pay>)** - <text>`: one gig each, sourceId
 *   `readme:<title slug>`, url the bullet's link;
 * - each role file whose H1 is `# <Title> at [Draft.dev](…)` and does NOT end with `| CLOSED`: one gig, sourceId
 *   `file:<name>`, url the file's `html_url`; its first `> …` line is the summary (pay, hours, location); a closed file
 *   is counted in one note `draftdev: N closed roles skipped`.
 * raw: `{ title, url, summary, text (≤ 4000 chars of the markdown, links kept as text), file, sha, readmeRemoteGlobal }`.
 */
export const DRAFTDEV_MAX_FILES = 8;
export function makeSrcDraftdev(hosts: GithubHosts): Agent<GigRequest, RawGig>;
export function parseOpenRoles(readme: string): { title: string; url: string; pay: string | null; text: string }[];
export function parseRoleFile(md: string): { title: string; closed: boolean; summary: string | null } | null;
```

Contract: id `src-draftdev`, version `1.0.0`, description `Reads Draft.dev's open writer roles from its public GitHub
repo`, skill `gig-sourcing`, team `sourcing-draftdev`, kind `io`, consumes `GigRequest`, produces `RawGig`,
`capabilities: { http: true }`, egress `['api.github.com']`, `retry: { max: 1, on: ['overloaded', 'network', 'timeout'], backoffMs: [8000] }`.

**Mapping into the gig model (normalizer `draftdev`; uncertain → review):**

| Field | Rule |
|---|---|
| kind | a per-post/per-article pay (`/per\s+(?:blog\s+)?(?:post|article)/i`) → `gig`; else `contract` |
| budget | `$<n>[+] per (blog) post/article` → `{ type: 'fixed', min: n, max: null, currency: 'USD', from: 'description' }` (no hours → the rate is unknown → review); a yearly salary (`/year`, `/yr`, `per annum`) → unknown; else `payOf(text)` |
| hours | `<n>[+] hours/week` → `{ min: n, max: null, source: 'text' }`; "no monthly minimums" → null (unknown); else `hoursOf` |
| location | the summary's `Remote (Global)` / `(Worldwide)` / `(Anywhere)` → worldwide; a README bullet → worldwide only when the README says `remote, global team` (`readmeRemoteGlobal`), text `Remote, global team (README)`; else `placesOf(summary)`, nothing → not stated (review) |
| client | `Draft.dev` |
| postedAt | null (the API gives no posting date; first seen orders it) |

- [ ] **Step 1: Failing tests:**

```ts
it('reads the open writer role from the README and skips the closed strategist file', async () => {
  const h = gh({
    'https://api.github.com/repos/draftdev/jobs/contents/': fx('draftdev/contents.json'),
    'https://api.github.com/repos/draftdev/jobs/contents/README.md': fx('draftdev/readme.json'),
    'https://api.github.com/repos/draftdev/jobs/contents/content-strategist.md': fx('draftdev/content-strategist.json'),
  });
  const out = await makeSrcDraftdev(makeGithubHosts()).run({ platform: 'draftdev', query: '', runDate: '2026-10-15', half: 'am' }, h.ctx);
  expect(out.map((g) => g.sourceId)).toEqual(['readme:freelance-technical-writer']);
  expect(h.calls).toHaveLength(3);
  expect(h.skipped).toContain('draftdev: 1 closed roles skipped');
  const gig = normalizeGig(out[0] as RawGig);
  expect(gig).toMatchObject({ kind: 'gig', budget: { type: 'fixed', min: 300, max: null, currency: 'USD' }, location: { worldwide: true } });
});
it('the gig is review (no hours, so no rate), never eligible', () => { /* rate-normalizer + gig-eligibility on the gig above → verdict 'review' */ });
it('a 40+ hours/week role is rejected by the hours rule', () => { /* writer-role.json variant with "40+ hours/week, Remote (Global)" */ });
it('a 403 (GitHub rate limit) disables api.github.com for the run: the next GitHub source asks nothing', async () => { /* shared hosts; prime-intellect then fails host-disabled without a call */ });
it('the per-run budget is loud', async () => { /* hosts.used = 12 → input_rejected github-budget */ });
it('parseOpenRoles and parseRoleFile are linear on a 1 MB adversarial README', () => { /* < 500 ms */ });
```

- [ ] **Steps 2–4.** **Step 5: Commit** `feat(freelance): Draft.dev writer roles from its public GitHub repo; GitHub host rules shared`

---

### Task 11: Prime Intellect environment bounties (GitHub search API)

**Research correction (D9):** `PrimeIntellect-ai/prime-environments` now answers 301 to
`PrimeIntellect-ai/community-environments` (2026-10-15); its open-issue list answered empty, and the bounties are
created on GitHub issues across the org through Algora (`/bounty $N` comments; the Algora board lists them). One
search request per run covers the org without naming a repo that may move again:

```
GET https://api.github.com/search/issues?q=org%3APrimeIntellect-ai+is%3Aissue+is%3Aopen+bounty&sort=created&order=desc&per_page=50
```

(unauthenticated search: 10 requests/minute; this is 1 per run). On 2026-10-15 it found 3 issues, all closed: an
empty open list is the normal answer, recorded as the note `prime-intellect: 0 open bounty issues`, never a failure.

**Files:** create `src/app/freelance/sources/prime-intellect.ts`; normalizer mapper; fixtures
`tests/fixtures/sx/prime-intellect/{search-empty.json,search-two.json,search-incomplete.json}` (`search-two.json`
built from the recorded closed items' shape, opened and given a `bounty` label and an amount, marked synthetic in
`_note`). Test: `tests/app/freelance/prime-intellect.test.ts`; 4 gig-normalizer eval cases.

```ts
/**
 * `src-prime-intellect`: open GitHub issues in the PrimeIntellect-ai org that are environment bounties, through the
 * GitHub search API (one request per run, the shared GithubHosts budget).
 * An item is a bounty when a label name contains `bounty` (any case, e.g. "💎 Bounty") OR its title or body states an
 * amount next to the word bounty (BOUNTY_AMOUNT); anything else the text search matched is dropped, counted in one
 * note. `incomplete_results: true` → the note `prime-intellect: GitHub says the results are incomplete`; more than 50
 * matches → `prime-intellect: N more not read (one page)`. Pull requests (`pull_request` present) are never gigs.
 * raw: `{ number, repo, title, url: html_url, body (≤ 4000 chars), labels, created_at, amount }`; sourceId `<repo>#<number>`.
 */
export const PI_SEARCH_URL = 'https://api.github.com/search/issues?q=org%3APrimeIntellect-ai+is%3Aissue+is%3Aopen+bounty&sort=created&order=desc&per_page=50';
/** `$1,200 bounty`, `bounty: $800`, `$5k bounty` (an amount within 40 characters of the word, same sentence). Linear. */
export const BOUNTY_AMOUNT = /\$\s?(\d{1,3}(?:,\d{3})*|\d+)(k)?\b[^.\n$]{0,40}\bbount(?:y|ies)\b|\bbount(?:y|ies)\b[^.\n$]{0,40}\$\s?(\d{1,3}(?:,\d{3})*|\d+)(k)?\b/iu;
export function makeSrcPrimeIntellect(hosts: GithubHosts): Agent<GigRequest, RawGig>;
```

Contract: id `src-prime-intellect`, team `sourcing-prime-intellect`, egress `['api.github.com']`, otherwise as
`src-draftdev`; description `Reads open Prime Intellect environment bounties through the GitHub search API`.

**Mapping (normalizer `prime-intellect`; uncertain → review):** kind `bounty`; budget `{ type: 'fixed', min: amount,
max: amount, currency: 'USD', from: 'description' }` when BOUNTY_AMOUNT finds exactly one distinct amount, else
unknown; hours unknown (bounties state none; the rate is unknown → review unless the existing fixed-budget rules decide
otherwise, which the test pins as they are); location worldwide only when the issue text says `anyone`, `open access`,
`worldwide` or `anywhere` (the program's own words), else not stated (review); client `Prime Intellect`; postedAt the
issue's `created_at` date.

- [ ] **Step 1: Failing tests:** empty search → `[]` + the 0-open note, 1 request; two bounties (one labelled
  without an amount, one with `$1,200` in the title) → 2 gigs, budgets unknown and 1200; a PR item dropped; an
  unlabelled item without an amount dropped and counted; `incomplete_results` note; the amount regex on `$5k bounty` →
  5000 and on `bounty of 300 credits` → none; linear on 1 MB.
- [ ] **Steps 2–4.** **Step 5: Commit** `feat(freelance): Prime Intellect environment bounties through GitHub search, one request a run`

---

### Task 12: Fractional Jobs (its public page; robots-checked; linear parse; loud cap)

**Seen live (2026-10-15):** `https://www.fractionaljobs.io/robots.txt` names only a sitemap (no disallow);
`/terms` has no clause about automated access; the homepage (HTTP 200 to the honest UA, 418 KB) lists the newest roles
as Webflow cards (55): company, title, company site, weekly hours, pay, location, function, date and a job id; each role
has a page at `/jobs/<job-id>`. GoFractional (another board) answers 403 to the honest UA and is NOT read.

**Files:** create `src/app/freelance/sources/fractional-jobs.ts`; normalizer mapper; fixtures
`tests/fixtures/sx/fractional-jobs/{home.html,robots.txt}` (trimmed to 6 cards: Engineering remote with monthly pay,
Engineering "Remote (USA only)", Engineering hourly, Engineering "Unknown" pay, Finance, Hybrid London). Test:
`tests/app/freelance/fractional-jobs.test.ts`; 4 gig-normalizer eval cases.

```ts
/**
 * `src-fractional-jobs`: the roles on fractionaljobs.io's public homepage, ONE page request per run (plus robots.txt
 * once), the himalayas-gigs host rules: robots.txt read first and applied (a disallow of `/` is the named skip
 * `robots-disallow www.fractionaljobs.io`); ≥ 2000 ms apart; 401/403/challenge → `challenged`, 429 → `rate_limit`, both
 * disable the host for the run, never retried, Retry-After never read; 5xx → `overloaded`.
 * Caps (loud): a body over FJ_MAX_BYTES or more than FJ_MAX_CARDS cards → `input_rejected`, nothing read.
 * Parse (linear: `indexOf` from one `job-item w-dyn-item` marker to the next; inside a card, the `<h3>` texts, the
 * `job-item_more-info` `text-inline` values and the hidden `fs-cmsfilter-field="function"`, `date` and `job-id` divs,
 * each found by a forward search): `{ jobId, company, title, companySite, hours, pay, location, function, date }`.
 * Only FJ_FUNCTIONS are kept; the rest are counted in one note `fractional-jobs: N of M roles in other functions`.
 * A card without a job id or title is a named malformed entry; every card malformed is schema drift (`invalid_output`).
 * sourceId = jobId; url = `https://www.fractionaljobs.io/jobs/<jobId>`.
 */
export const FJ_HOST = 'www.fractionaljobs.io';
export const FJ_MAX_BYTES = 2 * 1024 * 1024;
export const FJ_MAX_CARDS = 200;
export const FJ_FUNCTIONS: readonly string[] = ['Engineering', 'Data', 'Product'];
export function parseFractionalCards(html: string): { cards: FjCard[]; malformed: string[] };
export function makeSrcFractionalJobs(): Agent<GigRequest, RawGig>;
```

Contract: id `src-fractional-jobs`, team `sourcing-fractional-jobs`, egress `['www.fractionaljobs.io']`, description
`Reads fractional roles from the Fractional Jobs public homepage, one page a run, robots-checked`, otherwise as the
other gig sources.

**Mapping (normalizer `fractional-jobs`; uncertain → review):**

| Card field | Gig field |
|---|---|
| `15 - 20 hrs`, `16 hrs` (D10: weekly) | `hours: { min: 15, max: 20, source: 'text' }`; anything else → `{ null, null, null }` (review) |
| `$8K - $9.5K / mo` | `budget: { type: 'monthly', min: 8000, max: 9500, currency: 'USD', from: 'platform' }` |
| `$150 - $200 / hr` | `{ type: 'hourly', min: 150, max: 200, … }`; one figure → min = max |
| `/ yr`, `Unknown`, anything else, or €/£ without a figure | unknown (review) |
| `Remote (Global)`, `Remote (Worldwide)`, `Remote (Anywhere)` | `location: { countries: [], worldwide: true, text }` |
| `Remote (USA only)`, `Hybrid (London only)`, `Onsite …` | `placesOf(text)` with `text` kept (the existing "ONLY" rule rejects) |
| bare `Remote` | `{ countries: [], worldwide: false, text: 'Remote' }` → `location not stated - verify` (review) |
| title, company | as on the card; kind `contract`; postedAt the card date (`October 12, 2026` → `2026-10-12`) |

`fjPay(s)` is its own small parser (the shared `payOf` needs a pay word beside a monthly figure; the card field IS the
pay): `^([$€£])\s?(\d+(?:\.\d+)?)(K)?(?:\s?-\s?[$€£]?\s?(\d+(?:\.\d+)?)(K)?)?\s?\/\s?(mo|hr)$` on the trimmed field.

- [ ] **Step 1: Failing tests:** the 6-card fixture → 4 Engineering cards read, the Finance card counted out, the
  Hybrid London card read and later rejected by eligibility; the remote monthly card → hours 15–20, monthly 8000–9500
  (its rate at 20 h/week passes through the existing rate normalizer as the test pins); bare "Remote" → review with
  `location not stated - verify`; "Unknown" pay → review; robots disallow → named skip, no page request; 403 →
  challenged and disabled; 201 cards → `input_rejected`; a 3 MB body → `input_rejected`; `parseFractionalCards` linear
  on `'job-item w-dyn-item'.repeat(100_000)` (< 500 ms).
- [ ] **Steps 2–4.** **Step 5: Commit** `feat(freelance): Fractional Jobs roles from its public homepage, robots-checked, one page a run`

---

### Task 13: Operator guide, probes, and the operator note for the pack

**Files:** modify `README.md` (Sources section), `docs/operations.md`, `src/cli.ts` help text, `src/app/coverage/probe.ts`
and `src/app/freelance/probe.ts` (`jobpilot sources probe`: new lines), `tests/app/cli-help.test.ts` (the guide's commands exist).

The guide covers, with expected output:
- `jobpilot run-coverage [--no-freehire] [--catalogue-limit N]`: the catalogue (300 boards a week until drained), the
  discovery stage (≤ 10 freehire searches a week), where leads appear (Jobs list, review band, "Found through freehire");
- `node --run catalogue:freehire -- --date <YYYY-MM-DD> --cache <dir> [--offline]`: when and how to regenerate the seed
  (never by hand), and that a replay with `--offline` must give no diff;
- the NOTICE file and the attribution rule (freehire, MIT);
- the four new platforms, and UKG's skip reason;
- the three freelance sources, their request budgets (GitHub: ≤ 12 per run, two runs a day), and how to turn one off in
  `freelance.yaml` (`platforms.<id>.enabled: false`);
- `coverage probe` gains `catalogue: k verified, p proposed, N left · discovery: boards b, leads l (last week)`;
  `sources probe` (the freelance source probe) lists the three sources like the others.

**Operator note (for the controller, NOT a code change; the pack is outside the repo):** once this branch is merged and
`schedule install` has run, add JazzHR's first real company to the user's pack:

```yaml
# ~/.jobpilot/pack/companies.yaml, appended under companies:
  - {name: Baxter Planning, website: 'https://www.baxterplanning.com', careersUrl: 'https://baxterplanning.applytojob.com/apply'}
```

then `jobpilot run-coverage` (or wait for Sunday) and check that the Companies tab shows it Verified on `jazzhr`
(board `baxterplanning`). Back up the pack file first; `jobpilot pack check` must pass.

- [ ] **Step 1: Failing test** (`cli-help.test.ts` finds every command and flag of the new guide sections in `--help`).
- [ ] **Steps 2–4.** **Step 5: Commit** `docs: operator guide for the freehire seed and discovery, the new platforms and gig sources`

---

### Task 14: Live polite check on a temp home

All live, polite, honest UA, on a TEMP home with a copy of the real pack; `~/.jobpilot` untouched (SELECT-only).

```bash
cd ~/PersonalProject/jobpilot-sx
T=$(mktemp -d "$SCRATCH/sx-live.XXXX")
cp -R ~/.jobpilot/pack "$T/pack"
# add the operator-note company to the TEMP pack only
printf "  - {name: Baxter Planning, website: 'https://www.baxterplanning.com', careersUrl: 'https://baxterplanning.applytojob.com/apply'}\n" >> "$T/pack/companies.yaml"
JOBPILOT_HOME="$T" timeout 900 node --run jobpilot -- pack check
JOBPILOT_HOME="$T" timeout 5400 node --run jobpilot -- run-coverage --no-notify --limit 20 --catalogue-limit 40 2>&1 | tail -60
JOBPILOT_HOME="$T" timeout 3600 node --run jobpilot -- run --no-notify 2>&1 | tail -40
JOBPILOT_HOME="$T" timeout 1800 node --run jobpilot -- run-freelance --no-notify 2>&1 | tail -40
JOBPILOT_HOME="$T" timeout 600 node --run jobpilot -- coverage probe --json > "$T/coverage-probe.json"
JOBPILOT_HOME="$T" timeout 600 node --run jobpilot -- sources probe --json > "$T/freelance-probe.json"
```

(`JOBPILOT_HOME` is the CLI's home override, `src/app/home.ts`; `$SCRATCH` is the session scratchpad. Check each
flag with `--help` first; `sources probe --json` and `coverage probe --json` exist on `main`.)

Report to the controller:
- coverage: the discovery stage's per-query notes (rows, boards, leads, dropped; any outage note), catalogue boards
  checked → verified / proposed, Baxter Planning's verdict (expect Verified on jazzhr), every host disabled and why;
- daily: postings per new platform adapter (JazzHR, and any verified Zoho/Manatal/Freshteam board), `not-india` and
  `title-prefilter` notes, leads in the review band (count; 5 sampled titles with their `via` source), 0 leads
  eligible;
- freelance: gigs per new source with their verdicts (Draft.dev writer role → review; Prime Intellect, expect 0 open;
  Fractional Jobs, cards read and lists);
- politeness audit from the run's request log: no host asked twice within 2 s, no request after a host was disabled,
  robots.txt asked before the first page of every page host, api.github.com ≤ 12 requests per freelance run,
  freehire.me ≤ 10 requests in the coverage run, 0 requests to any UKG list endpoint;
- hand-check 10 catalogue/discovery verified companies against their boards (target: 0 wrong-company verifications).

Then delete `$T`. No commit (fixes found here are new TDD steps in the task they belong to, then this check again).

---

### Task 15: Whole-branch review, merge

- [ ] A whole-branch reviewer (most capable model) reads `git diff main...sources-x` with this plan and checks, with
  probe scripts against the real modules (never the network) and a `.backup` copy of the real DB:
  - the migration rehearsal on the DB copy: `freehire_leads` added, every earlier table byte-identical (dump-and-hash),
    then delete the copy;
  - daily-identity unchanged (the golden file not rewritten: `git diff main...sources-x -- tests/fixtures/daily-identity.json` empty);
  - the freelance identity with the three platforms off;
  - politeness: every new request path goes through the broker with `minIntervalMs ≥ 2000`, robots.txt where the
    page rule applies, refusals disable the host, no Retry-After read, no port of `fingerprinthttp.go` or any Firecrawl
    path (grep `src/` and `scripts/` for `fingerprint`, `firecrawl`, `utls`, `ja3`: 0 hits outside comments citing the
    ban), no request to `*/JobBoardView`;
  - no enrichment field read: grep `src/app/coverage/freehire-*.ts discovery.ts` for `enrichment|work_mode|countries|regions|reality` outside the "never read" comment: 0;
  - determinism: the catalogue replay gives no diff; no `Date.now`/`Math.random` in new agents;
  - caps: every cap named in this plan has a test that hits it;
  - licence: NOTICE present, adapter headers cite freehire and `3957f7b`;
  - privacy: 0 forbidden-term hits in the diff and in `assets/freehire/*` (the terms in `.superpowers/sdd/global-constraints.md`),
    no office city in code, no contact value, no secret pattern.
- [ ] Fix waves (each a TDD step plus a commit), then a re-review of the fix commits.
- [ ] At a quiet time (no lock held, today's runs complete):

```bash
cp ~/.jobpilot/jobpilot.db ~/.jobpilot/jobpilot.db.pre-sources-x   # or the CLI backup command the operator guide names
git -C ~/PersonalProject/jobpilot merge --ff-only sources-x
cd ~/PersonalProject/jobpilot && timeout 900 node --run verify 2>&1 | tail -5
node --run jobpilot -- facts list > /dev/null        # migrates once
node --run jobpilot -- schedule install && node --run jobpilot -- schedule status
curl -s -o /dev/null -w "%{http_code}\n" --max-time 10 http://127.0.0.1:4317/companies   # expect 200 (and every tab)
git -C ~/PersonalProject/jobpilot worktree remove ~/PersonalProject/jobpilot-sx
```

- [ ] The controller applies Task 13's operator note to the real pack.
- [ ] Privacy-scan the new commits (forbidden terms, contact.yaml values, offer/floor, secret patterns); only then
  `git push origin main`.

---

## Self-review (plan author, 2026-10-15)

**Coverage of the approved scope:**

| Scope item | Task(s) |
|---|---|
| 1. catalogue seed: filtered derivative, NOTICE, supported platforms only, real names, India/remote evidence rule, straight to the verifier, unverified → Proposed, deterministic script, size budget | 5 (rules), 6 (script, seed ≤ 1 MB target / 2 MB cap, NOTICE), 7 (verifier path, D3 Proposed, 300/week) |
| 2. weekly discovery: ≤ 10 fixed queries, no LLM fields, `ignored_params` empty, boards → verifier, unsupported → review only, outage note, UA, pacing, terms in the header | 8 (agent, stage, leads), 9 (review band) |
| 3. JazzHR, Zoho Recruit, UKG, Manatal, Freshteam: client, detector, daily adapter, robots, fixtures, goldens, India/remote scope | 1 (detector + golden, UKG skipped), 2 (JazzHR, Freshteam: listing scope), 3 (Zoho), 4 (Manatal) |
| 4. Draft.dev (60/h), Prime Intellect (repo from research, corrected), Fractional Jobs (robots, linear, cap), gig-model rules with uncertain → review | 10, 11, 12 |
| 5. Baxter Planning in the pack, by the controller | 13 (operator note), 14 (temp-pack check), 15 (apply) |
| Final: live polite check, whole-branch review, merge | 14, 15 |

**India/remote scope per adapter:** JazzHR, Freshteam: listing-level scope before any job page (`scopeListed`, named
`not-india` note), title pre-filter, page budget. Zoho, Manatal: one list carries location and the remote flag for
every job and no detail page is asked, so there is nothing to scope before; eligibility judges each posting (the Task 9
feed precedent). There is no server-side facet on any of the four, so the Workday "scope-not-applied" check (a facet
total against the list) has no equivalent; the listing-level filter is its counterpart and is tested.

**Placeholders:** the remaining `/* … */` test bodies (Tasks 2 and 10) each sit under an `it` title that states the
exact assertion and reuse a harness shown in full in the same block; the two refusal/cap tests of Task 2 are written out
as the model for them. Fixtures are named with their recording source. No "TBD".

**Consistency checks done:** platform keys (`zohorecruit` everywhere, matching freehire's source name); teams
`sourcing-<platform>` (daily), `coverage-freehire`, `sourcing-<freelance platform>`; egress names
`registry:<platform>-hosts`; D3 key format used by Tasks 5, 7, 8; the catalogue digest matches the recorded snapshot;
the daily-identity rule restated in Tasks 2, 3, 4, 9.

**Risks:** Task 8 (a fifth coverage stage touches resume, retry and projection paths that took several fix rounds in
career-sites; keep the stage optional and its leads projection evented); Task 6 (a long live evidence pass, about
several hundred requests at 2 s; it is resumable through `--cache`).
