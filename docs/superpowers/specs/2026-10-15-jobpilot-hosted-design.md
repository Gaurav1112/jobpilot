# jobpilot hosted mode: scheduled runs on GitHub Actions, an encrypted any-device dashboard

Status: designed 2026-10-15 from the user's decisions (below) and the hosting research
(`.superpowers/sdd/hosting-research.md`, local, git-ignored; every GitHub limit quoted here is cited there).

Builds on:
- the architecture, v1, freelance, career-sites and profiles specs;
- the UX upgrade spec (`2026-10-15-jobpilot-ux-upgrade-design.md`), whose content rules and 400 px rule the snapshot obeys;
- the retention build (`store compact` / `store restore`, `src/app/store/retention.ts`) and the dashboard perf build.

Code read for this design: `jobpilot-fv2` at 420b721 (schedule, due, store, secrets, Gmail mail, web, render, notify).

**What the user gets.** The daily and freelance runs happen every day whether or not a laptop is awake. The results
can be read and triaged from a phone, tablet, Windows or Mac browser, through a page that shows nothing until the
passphrase is typed. The Mac keeps running exactly as today until the numbers say the hosted runs are as good, and
stays as a fallback afterwards. Any laptop (macOS, Linux, Windows) can also run jobpilot locally on a schedule.

## 1. Decisions

### 1.1 The user's decisions (2026-10-15, binding)

| # | Decision |
|---|---|
| U-H1 | Runs happen on **GitHub Actions in a new PRIVATE repo `jobpilot-data`**. The public code repo is checked out at a **pinned commit**. Personal data never goes into the public repo, public logs or public artifacts. |
| U-H2 | **Stay free: at most 2,000 Actions minutes a month.** The daily run happens every day; freelance runs **once a day**; coverage runs **every two weeks**. The minutes are budgeted, and whatever is cut when the budget runs short is announced loudly. |
| U-H3 | The any-device dashboard is an **encrypted static snapshot on public GitHub Pages**. It is decrypted in the browser with WebCrypto AES-GCM under a key derived from a strong passphrase that exists only on the user's devices. Nothing readable appears before unlock. |
| U-H4 | Triage from any device uses a **fine-grained GitHub token that can reach only `jobpilot-data`**, stored on each device. Writes are **append-only triage events**, which the next run applies. Applying is idempotent, and the conflict rules are fixed. |
| U-H5 | Before the switch there is a **7-day side-by-side run**: Actions and the Mac both run, and a deterministic report compares the jobs and gigs each found, per source. The switch criteria are numeric. **The Mac stays as a fallback.** |
| U-H6 | **Cross-platform local mode:** `schedule install` supports launchd (macOS), systemd user timers (Linux) and Windows Task Scheduler. |

### 1.2 Decisions this spec makes (marked "spec" where they appear)

| # | Decision | Why |
|---|---|---|
| S1 | **Three repos.** Public `jobpilot` (code), private `jobpilot-data` (workflows, config, encrypted pack, state pointer), and a public `jobpilot-view` that holds only the Pages ciphertext and the generic shell. | Free-plan Pages needs a public repo. Even ciphertext of personal data stays out of the code repo (U-H1). |
| S2 | **All encryption uses `node:crypto` / WebCrypto.** AES-256-GCM everywhere, with a chunked STREAM layout for large files. No `age`, no new dependency. | It is the same code on runners, Mac, Linux and Windows. WebCrypto in the browser reads the same format. There is nothing extra to install on the runner. |
| S3 | **Snapshot KDF: PBKDF2-HMAC-SHA-256 with 1,000,000 iterations** (OWASP's 2023 floor is 600,000) and a passphrase of at least 6 words from the EFF large list (~77.5 bits). | Argon2 is not in WebCrypto: it would mean shipping a WASM build. With a 77-bit passphrase the iteration count is not what carries the security (§5). |
| S4 | **Triage goes through encrypted comments on an inbox issue in `jobpilot-data`.** The device token gets only `Issues: read and write`. | It costs 0 Actions minutes, appends naturally, and the token can't read code, releases, the pack or the state. Batches are AEAD-sealed, so a stolen token can't forge decisions (§3.8). |
| S5 | **Hosted retention keeps `daily: 1, freelance: 1, coverage: 1, rebuild: 1`.** | Research §1: `daily: 3` ships ~2.3–2.6 GB raw (~400 MB compressed), `daily: 1` ~1.4–1.7 GB (~250 MB). Rollback lives in the 7+ kept state generations, not in old runs inside the DB. The UI reads projections, not old envelopes. |
| S6 | **The state pointer is a git file on the `state` branch**, moved by fast-forward push only (compare-and-swap). The state itself is an encrypted release asset per generation. | A release asset can't be swapped atomically. A rejected non-fast-forward push is a free optimistic lock. |
| S7 | **Freelance runs in the same Actions job as the daily run**, after it. | It saves one state round trip (~8 min) a day, about 250 minutes a month (§4). |
| S8 | **A run lease** in the same git file guards Actions against a laptop, and the concurrency group guards Actions against Actions. | The Mac fallback and laptop-assisted runs share the state with Actions. |
| S9 | **The Actions log carries only allow-listed template lines.** Full pipeline output goes to `logs/` inside the encrypted state. | `::add-mask::` misses transformed values (research §2). An allow-list leaks nothing by construction. |
| S10 | **Hosted runs send the fixed UA `jobpilot/0.1 (+hosted)`**, local runs keep `jobpilot/0.1 (+local)`. Each is a constant picked by run environment and is never configurable. | The UA stays honest about where the request comes from. G-NO-EVASION still holds. |
| S11 | **A known home-network-only source is not tried from runners** (`hosted.yaml` `skipSources`). It is reported as the named note "home network only: not run on the hosted runner", not as a problem. | It saves minutes and doesn't hit a host that already said no. |
| S12 | **The snapshot is crawled from the real dashboard app** (in-process `app.request`, GET only, a new `readOnly` mode). It is not a second set of templates. | It keeps content parity with the local dashboard and inherits the UX copy rules for free. |

### 1.3 Constraints (binding, copied from the brief)

- Deterministic, no LLM, no paid keys.
- Honest UA, no evasion. A source blocked from cloud IPs just reports a named problem.
- **The DB is compacted inside every hosted run** with `store compact`. Hosted keeps 1 daily run (S5, research §1 numbers).
- **State integrity:**
  - a single concurrency group;
  - an atomic upload of the encrypted DB release asset with a checksum;
  - the previous version kept for rollback;
  - a run that fails before upload never replaces good state.
- **Secrets:**
  - the Gmail refresh token is an Actions secret;
  - the pack is encrypted in the data repo;
  - nothing is ever echoed;
  - `::add-mask::` is used where needed.
- **The snapshot** meets the UX spec's content rules and the 400 px rule. It contains nothing decryptable without the passphrase, and it has a size budget (§3.6).
- **The public repo** gets only generic code and an example workflow with all-fictional values.
- **The live Mac setup** (launchd, `~/.jobpilot`) keeps working unchanged until the switch.
- **Branch code never migrates `~/.jobpilot`.**
- Carried over from earlier specs: never auto-submits, robots.txt and terms honoured, `node --run` (never `pnpm <script>`), exact dependency versions, Node 24.

**Exemption, stated so it's not a silent conflict.** UX §3 requires "works without JS" and "127.0.0.1 only". Those still
bind the local dashboard. The encrypted Pages snapshot can't work without JS, because decryption is JS. It is a separate
read-and-triage surface with its own rules (§3.7). It obeys the UX content rules, the 400 px rule, the 44 px targets and
WCAG 2.2 AA.

## 2. Architecture

```
 PUBLIC  github.com/<owner>/jobpilot           code only; examples/hosted/*.yml (fictional values); no secrets,
         (pinned SHA, ancestor of main)         no state, no workflow that touches state
                 │ actions/checkout repository=<owner>/jobpilot ref=<code.lock SHA>
                 ▼
 PRIVATE github.com/<owner>/jobpilot-data
   main:   .github/workflows/{daily,coverage}.yml  hosted.yaml  code.lock  pack/pack.jpst
   state:  pointer.json (gen, sha256, lease)  ledger/<YYYY-MM>.jsonl  shadow/{hosted,mac}/…   (orphan branch)
   releases: state-g000124 → state-g000124.jpst (encrypted DB + out/ + logs/), keep 7 + 4 weekly
             archive-g000124 → compaction segment (encrypted), keep 30 days
   issues:   "Decisions inbox 2026-11" (label triage-inbox): encrypted triage batches, one per comment
             "jobpilot alert: …" (label jobpilot-alert): loud notices, template text only
   secrets:  STATE_KEY PACK_KEY SNAPSHOT_KEYS GMAIL_CLIENT_ID GMAIL_CLIENT_SECRET GMAIL_REFRESH VIEW_DEPLOY_TOKEN

 ┌──────────────── one Actions job (ubuntu-latest, concurrency group jobpilot-state) ────────────────┐
 │ 0 cheap check: pointer says today done? → exit (1 billed min)                                      │
 │ 1 lease (CAS commit) → 2 download state G, sha256, decrypt, decompress, quick_check, audit tail    │
 │ 3 decrypt pack, add-mask → 4 triage apply (issue comments) → 5 run --if-due → 6 run-freelance      │
 │ 7 store compact --apply --include-incomplete → 8 shadow digest → 9 snapshot build (ciphertext)     │
 │ 10 bundle+encrypt G+1 → upload release → verify → CAS pointer G→G+1 (releases lease)               │
 │ 11 deploy snapshot → 12 prune generations → 13 ledger append (always)                              │
 └────────────────────────────────────────────────────────────────────────────────────────────────────┘
                 │ force-push orphan commit (VIEW_DEPLOY_TOKEN: Contents RW on jobpilot-view only)
                 ▼
 PUBLIC  <owner>.github.io/jobpilot-view/      index.html shell.js app.css keyinfo.json k.bin m.bin c/<rand>.bin
                 ▲ fetch ciphertext                               │ POST encrypted batch (device token: Issues RW,
                 │                                                ▼  jobpilot-data only)
         phone / tablet / Windows / Mac browser ── passphrase → PBKDF2 → keys (non-extractable, IndexedDB)

 LAPTOPS  local mode: jobpilot schedule install (launchd | systemd --user | schtasks), own home, unchanged
          Mac fallback after the switch: jobpilot hosted standby (pull G under lease, run, push G+1) in
          ~/.jobpilot-hosted — never ~/.jobpilot
```

## 3. Components

### 3.1 Data repo layout (`jobpilot-data`, private)

| Path / ref | Written by | Content |
|---|---|---|
| `main:.github/workflows/daily.yml`, `coverage.yml` | user | copied from `examples/hosted/` in the public repo, then edited (owner names) |
| `main:hosted.yaml` | user | config (below) |
| `main:code.lock` | user (`jobpilot hosted bump`) | one 40-hex SHA of the public repo; it must be an ancestor of the public `main` |
| `main:pack/pack.jpst` | user (`jobpilot hosted pack push`) | the hosted pack (a deterministic tar), encrypted with `PACK_KEY`. It may differ from the Mac pack only by `retention.yaml` (S5) |
| `state:pointer.json` | runs, `hosted` CLI | `{gen, tag, asset, sha256, bytes, schema:{kernel,app}, codeSha, packHash, lastDone:{daily,freelance,coverage}, lease:{holder,until}\|null, budget:{month,level}}` |
| `state:ledger/<YYYY-MM>.jsonl` | runs (an `always()` step) | one line per job: `{runId, workflow, startedAt, billedMinutes, outcome}` |
| `state:shadow/hosted/<date>-<pipeline>.json`, `shadow/mac/…`, `shadow/report-<date>.{md,json}` | runs, the user | side-by-side digests and reports (§3.10), kept for the shadow period only |
| releases `state-gNNNNNN` | runs | one asset, `state-gNNNNNN.jpst` |
| releases `archive-gNNNNNN` | runs | the compaction segment and its manifest, encrypted; deleted after 30 days |
| issues labelled `triage-inbox` | devices (comments), runs (open and close) | §3.8 |
| issues labelled `jobpilot-alert` | runs | template text only, no personal values |

`hosted.yaml` (the example ships with these fictional values):

```yaml
version: 1
owner: example-user                 # GitHub owner of the three repos
view: { repo: jobpilot-view, url: https://example-user.github.io/jobpilot-view/ }
budget: { monthlyMinutes: 2000, safetyMinutes: 100, cycleStartDay: 1, dailyEstimateMinutes: 46 }
freelance: { windows: [am] }        # once a day (U-H2)
coverage: { everyWeeks: 2, anchor: 2026-11-01, maxSliceMinutes: 330, endBy: "07:00" }
state: { keepGenerations: 7, keepWeekly: 4, archiveDays: 30, warnCompressedMB: 600, hardCompressedMB: 1500 }
snapshot: { budgetMB: 40, staleHours: 26 }
skipSources: []                     # home-network-only sources (S11), filled from the shadow report
```

Repo settings, which the user sets and `jobpilot hosted doctor` checks through the API:
- visibility is private;
- Actions "Fork pull request workflows" is off;
- the default `GITHUB_TOKEN` is read-only (each workflow raises its own permissions);
- there is no payment method or the spending limit is $0, so overage is impossible and the budget governor is the only cut.

### 3.2 Workflow files

`daily.yml` (sketch; the example in the public repo is the source of truth):

```yaml
on:
  schedule:
    - cron: '37 7 * * *'    # 07:37 IST: daily owed from 07:00, freelance "am" from 07:30
      timezone: Asia/Kolkata
    - cron: '37 10 * * *'   # catch-up: a dropped or delayed 07:37 trigger (cheap check exits in ~1 min)
      timezone: Asia/Kolkata
  workflow_dispatch: {}
concurrency: { group: jobpilot-state, cancel-in-progress: false }
permissions: { contents: write, issues: write, actions: read }
jobs:
  run:
    runs-on: ubuntu-latest
    timeout-minutes: 150
    env: { TZ: Asia/Kolkata, JOBPILOT_RUN_ENV: hosted }
    steps:
      - uses: actions/checkout@<sha>        # data repo, main
      - uses: actions/checkout@<sha>        # public code at code.lock, path: code
      - uses: actions/setup-node@<sha>      # Node 24, pnpm store cache
      - uses: actions/cache@<sha>           # ~/.cache/ms-playwright, key = playwright version
      - run: node --run jobpilot -- hosted run daily        # the wrapper does everything below
        working-directory: code
        env: { STATE_KEY: ..., PACK_KEY: ..., SNAPSHOT_KEYS: ..., GMAIL_*: ..., VIEW_DEPLOY_TOKEN: ..., GH_TOKEN: ${{ github.token }} }
```

| Rule | Value |
|---|---|
| Triggers | `schedule` and `workflow_dispatch` only. Never `pull_request`, `pull_request_target`, `push` or `issue_comment` (an issue comment never starts a run). |
| Concurrency | one group, `jobpilot-state`, for every workflow; `cancel-in-progress: false`. The design doesn't depend on a pending-queue option: schedules don't overlap (coverage ends by 07:00, daily starts 07:37), and the lease (§3.3) catches anything else. |
| Cron times | off the hour (`:37`, `:23`), with `timezone: Asia/Kolkata`. If the timezone key is unavailable, the UTC equivalents are `7 2 * * *`, `7 5 * * *` and `53 19 * * 6,0`. |
| Actions | pinned by 40-hex SHA. Only `actions/checkout`, `actions/setup-node` and `actions/cache`; the `gh` CLI already on the runner does the rest. |
| Secrets | passed only as `env:` of the one wrapper step, never interpolated into `run:` text, never given to the install step. |
| Shell | no `set -x`; no `upload-artifact`; no `actions/cache` of anything from the home. |
| Code checkout | the wrapper fetches public `main` and refuses unless `git merge-base --is-ancestor <code.lock> origin/main` (a commit reachable only through a fork's network is refused). |
| Install | `pnpm install --frozen-lockfile` from the pinned lockfile, then `npx playwright install chromium` with the cache. |

`coverage.yml`:
- cron `'23 1 * * 0,1'` (IST, Sunday and Monday 01:23), with `timeout-minutes: 350`;
- the same group and the same wrapper (`hosted run coverage`);
- the wrapper runs coverage only when the fortnight period is owed (§3.5) and the governor allows a slice (§4).

No other workflow. Rollback, pull and push are local `jobpilot hosted …` commands that use the user's own `gh` login.

### 3.3 State store

**Bundle format `JPST1`** (state and pack alike):

| Part | Value |
|---|---|
| Header | the line `JPST1\n`, then one canonical-JSON line `{"v":1,"codec":"zstd","level":3,"chunk":4194304,"keyId":"<8 hex>","nonce":"<16 hex>"}\n` |
| Body | the payload, compressed (`node:zlib` zstd level 3; the codec field allows gzip), split into 4 MiB chunks. Each chunk is AES-256-GCM with nonce = 8-byte random file prefix ‖ 4-byte big-endian chunk counter, AAD = sha256(header) ‖ counter ‖ final-flag byte. This is the STREAM construction: reordering, truncation and extension all fail. |
| Payload | a deterministic ustar written in Node (names sorted, mtime 0, uid/gid 0, mode 0600). It holds `jobpilot.db` after `PRAGMA wal_checkpoint(TRUNCATE)`, `out/**`, `logs/**` (the last 14 days) and the home's `*-attempts.json` and `coverage-start.json`. It excludes `pack/`, `archive/`, `secrets/`, lock files and `*.tmp`. |
| Keys | `STATE_KEY` and `PACK_KEY`: 32 random bytes each, base64. `keyId` = the first 4 bytes of sha256(key), so a wrong key fails with "wrong key", not "corrupt". |

**Pointer and lease** (`state:pointer.json`). Every change is one commit pushed without force. A rejected push means
someone else moved first.

| Operation | Precondition (read at the commit's parent) | New pointer |
|---|---|---|
| acquire lease | `lease` is null, or `lease.until` < now | `lease = {holder: "actions:<runId>" \| "laptop:<deviceId>", until: now + job timeout}` |
| commit generation | the lease is ours and `gen` = G | `gen = G+1`, new `sha256/bytes/schema/codeSha/packHash/lastDone`, `lease = null` |
| release lease (failure) | the lease is ours | `lease = null`; `gen` unchanged |
| rollback (local CLI) | no live lease | `gen = K` (an existing generation); `lastDone` taken from K's record |

**Generation lifecycle in one run:**

1. Download asset G and check its sha256 against the pointer. Decrypt (the GCM tags check every chunk), decompress and
   untar into `$RUNNER_TEMP/home`. Check `PRAGMA quick_check` = ok. Check the audit chain from its stored checkpoint
   (`/runs`' incremental check). Any failure stops the run before any pipeline: the lease is released, an alert opens,
   and **G stays**.
2. Preflight: free disk ≥ 3 × the DB size + 2 GB on the work volume (`/mnt` when it has more room than `/`), or stop.
3. After the pipelines, compaction and the snapshot: checkpoint, bundle, encrypt, and compute sha256 while streaming.
4. Create release `state-g<G+1>` and upload the asset. Check the size reported by the API and the asset's sha256
   `digest` where the API returns one; otherwise download it again and hash it.
5. Commit the pointer G→G+1 (CAS). A rejected push deletes the new release, opens an alert and exits red. The pointer
   still says G.
6. Prune:
   - keep the 7 newest generations, plus the newest generation of each of the last 4 IST weeks (at most 11, ≈ 3 GB);
   - delete `archive-*` releases older than 30 days.

**When the pointer moves.** It moves only when step 3 is reached with a passing `quick_check`, and the wrapper did not
kill the pipeline on its deadline. The pipeline's exit code does not decide it. Exit 0 (clean), 1 (completed with step
failures) and 2 (could not run, attempt recorded) all leave a consistent DB, and the attempt bookkeeping must persist so
the `--if-due` cap of 3 works.

"A run that fails before upload" means a wrapper failure: download, decrypt, integrity, disk, a deadline kill, upload or
CAS. **It never moves the pointer.**

**Deadline.** The wrapper's deadline is the job timeout minus 15 min. At the deadline it sends SIGTERM. H1 adds a
between-steps stop on SIGTERM to `run` and `run-freelance`; `run-coverage` already pauses between steps. A pipeline
that hasn't exited 60 s after SIGTERM is killed, and nothing is uploaded.

**Compaction in every run** (constraint). After the pipelines the wrapper runs
`store compact --apply --include-incomplete`. Resumable runs (a paused coverage period) stay pinned by R3, and stale
incomplete runs are archived. The segment is uploaded encrypted as `archive-g<G+1>` so `store restore` stays possible
for 30 days. VACUUM's own free-disk check stands.

**Size watch.** Research §1: events, queue and the remaining step rows are never pruned, and they grow ~70–100 MB raw
per daily run (~10–15 MB compressed).

| Level | Threshold | Action |
|---|---|---|
| warn | asset > 600 MB compressed | a Health line and an alert issue |
| hard | asset > 1,500 MB compressed (the release-asset limit is 2 GiB) | the run still commits, opens a red alert, and the next run refuses to start until the user acts |

The fix for long-term growth is outside this spec (open question Q2).

**Seed (H1).** `jobpilot hosted seed --from <home>`:
1. Opens the source DB **read-only** and copies it with the SQLite online backup API into a temp home.
2. Copies `out/`.
3. Migrates and compacts **the copy**.
4. Bundles it as generation 1 and pushes it with the user's `gh` login.

A test asserts the source DB's bytes, mtime and `user_version` are unchanged. Every `hosted` command that writes a home
refuses when the home resolves to the default `~/.jobpilot`.

### 3.4 Secrets

| Name | Where | What | Notes |
|---|---|---|---|
| `STATE_KEY` | Actions secret; the laptop's OS keychain | 32 bytes, base64 | losing it loses the state: `hosted keys new` prints a one-time recovery sheet |
| `PACK_KEY` | Actions secret; the laptop keychain | 32 bytes, base64 | the pack (124 KB) is over the 48 KB secret limit, so it is a file encrypted with this key |
| `SNAPSHOT_KEYS` | Actions secret | 64 bytes, base64, plus the epoch id: the PBKDF2 output (§3.7) | **the passphrase itself is never stored anywhere but in the user's head and devices** |
| `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH` | Actions secrets | the existing Gmail OAuth items (`gmail.client_id`, `gmail.client_secret`, `gmail.refresh`) | the OAuth app must be in **production** status (unverified is fine for personal use): Testing-status refresh tokens expire after 7 days |
| `VIEW_DEPLOY_TOKEN` | Actions secret | fine-grained PAT: `jobpilot-view` only, Contents read and write, 1-year expiry | used only by the deploy step |
| device token | each device, encrypted under the device's snapshot key in IndexedDB | fine-grained PAT: `jobpilot-data` only, **Issues read and write**, nothing else, 90-day expiry | §3.8 |
| `GITHUB_TOKEN` | per job | `contents: write` (releases, `state` branch), `issues: write`, `actions: read` (the job's own billed time, the previous run's log audit) | everything else none |

**Secrets backends.** The `Secrets` interface (`src/app/secrets.ts`) gets more backends, chosen by platform:

| Platform | Backend |
|---|---|
| macOS | the Keychain, unchanged |
| Linux | libsecret through `secret-tool`. The value goes on stdin; with no libsecret, refuse with a message (never a plaintext file). |
| Windows | a DPAPI-protected file `secrets\<name>.dpapi`, through PowerShell `ProtectedData.Protect`, value on stdin |
| hosted | `envSecrets()`: it reads `JOBPILOT_SECRET_<NAME>` (with `.` written as `_`, upper case); `set` and `delete` throw "hosted mode stores no secrets" |

Values never go into argv, as today.

**Echo and masking.**
- Secrets are masked by Actions automatically.
- Before any pipeline output exists, the wrapper emits `::add-mask::` for every pack-derived value of 3 or more
  characters: identity, contact, links, compensation (each number in plain, en-IN-grouped, international-grouped and
  "N LPA" forms), employer and school names from facts, `naming.forbiddenTerms`, and office cities.
- Masking is the second line. The first is S9: the log gateway (§3.5).

### 3.5 Run wrapper (`jobpilot hosted run daily|coverage`)

One process drives §2's steps 0–13. It owns the home, the lease, the log gateway and the budget governor.

**Log gateway.**
- Child pipelines write stdout and stderr to `logs/hosted-<runId>.log` inside the home, which ships encrypted.
- The Actions log and `$GITHUB_STEP_SUMMARY` get only lines from a fixed template table. Each template has typed slots:
  integers, durations, generation numbers, platform ids from the source catalogue, and problem codes.
- Example: `daily: done in 41 min · 1,204 postings · 37 to decide · 3 problems (2 challenge, 1 timeout)`.
- No company, board, title, person or URL slot exists.
- A test feeds every template the worst strings and asserts nothing outside the slots' alphabets passes.

**Log audit.** Each run downloads the previous run's log (`actions: read`) and scans it for the masked values and their
base64 and URL-encoded forms. A hit opens a red alert.

**Hosted variations.** All are selected by `JOBPILOT_RUN_ENV=hosted`; nothing changes on the Mac.

| Item | Hosted |
|---|---|
| Freelance due windows | `hosted.yaml` `freelance.windows: [am]` → run id `freelance-<date>-am` |
| Coverage period | `everyWeeks: 2` from `anchor`. `coverageWeek()` generalises to `coveragePeriod(now, everyWeeks, anchor)`; with `everyWeeks: 1` it is byte-for-byte today's function, and a test proves it. |
| Notifier | collects lines for the snapshot banner. "Loud" kinds open or update an alert issue: gave up, budget cut, Gmail sign-in refused, state failure, leak hit. |
| UA | `jobpilot/0.1 (+hosted)` (S10) |
| `skipSources` | not requested. The note reads "home network only: not run on the hosted runner". |
| Challenge pages | as today, G-CHALLENGE marks the source blocked. The problem text adds "(hosted runner)" so the shadow report can attribute it. |

**Budget governor.** It runs at step 0, from the ledger; the formulas are in §4. It decides: skip (already done),
run all, run without freelance, or refuse (level L4). On a level change it opens an alert issue.

### 3.6 Snapshot builder (`jobpilot snapshot build --home <dir> --out <dir>`)

**Route crawl (S12).**
- The builder starts the dashboard app in-process with `readOnly: true`. That is a new server option: every non-GET
  answers 405, and no best-effort write happens (the audit checkpoint, visit cookies).
- It requests a fixed route list with `app.request`.
- Views gain a `mode: 'snapshot'` flag. In that mode each status, note or follow-up form renders as a button with
  `data-triage` attributes (kind, target, base) instead of a CSRF form. Nothing else differs.

**Content scope.** The route names are the UX spec's; before UX Phase B lands, the current routes are crawled instead.

| Page | Included |
|---|---|
| Today, Jobs (To decide · Shortlist · Applied), Freelance (Contract roles · Gigs · Networks), Applications, Run health | yes |
| Item pages | everything in To decide (eligible or check-first, first seen in the last 7 days, as one predicate: UX U9), Shortlist, Applied in the last 60 days, and their gig and contract equivalents |
| Documents (resume PDF/DOCX, cover letter PDF/DOCX/txt, screening answers) | items in Shortlist and Ready to send, plus the top 50 Strong and Good items in To decide |
| Profile, Facts, System, Companies, setup | **no** (laptop only) |

**Encryption layout.**
- A random 256-bit DEK per build, and random 128-bit chunk names per build. Nothing links builds or reveals a job key.
- Each chunk is gzip'd, padded to a bucket (16 KB for items, 256 KB for the index, 64 KB for documents), then
  AES-256-GCM with a random 96-bit nonce and AAD `chunk|<buildId>|<name>`.
- The encrypted manifest maps route → chunk name. It also holds the build time, the budget line and the owner/repo
  names the device needs for triage, so none of those are in plaintext.

**Size budget.**

| Item | Limit |
|---|---|
| First paint: shell + `keyinfo.json` + `k.bin` + `m.bin` + the index chunk | ≤ 700 KB |
| Index chunk (lists, before padding) | ≤ 512 KB gzip |
| Item chunk | ≤ 64 KB |
| Document chunk | ≤ 400 KB |
| Whole build | ≤ 40 MB (the Pages site limit is 1 GB) |

**Over budget, degrade in this order:**
1. drop documents from the lowest-ranked To decide items;
2. cap To decide at 300 rows (rank order), with the rest summarised as "N more on the laptop dashboard";
3. drop Applied older than 30 days.

Each step is a banner line inside the snapshot. If it is still over, the build fails: the state still commits (§3.3),
and the snapshot stays at the previous build.

**Leak scan (`snapshot verify`), before any deploy.**
- It scans every output byte for the masked values (§3.4) and for every job key, company name and job title in the DB
  (the top 2,000 by rank), in plaintext, gzip-inflated, base64 and URL-encoded forms.
- It asserts every file is either one of the shell files, byte-equal to the pinned code's, or begins with the
  ciphertext magic.
- Any hit stops the deploy and opens a red alert.

### 3.7 Encrypted Pages site (`jobpilot-view`, public)

**Public files.**
- `index.html`, `shell.js` and `app.css` (generic, from the code repo, byte-equal to the pinned commit), `.nojekyll`.
- `keyinfo.json`: `{v:1, kdf:"PBKDF2-SHA-256", iter:1000000, salt:<16 bytes b64>, epoch:"<8 hex>"}`.
- `k.bin` (the wrapped DEK), `m.bin` (the manifest) and `c/<32 hex>.bin`.

**Deploy.** A single orphan commit, force-pushed to `gh-pages`, so the public repo carries no history. Old ciphertext
can still exist in caches: see §5, passphrase rotation.

**Keys.**
- `PBKDF2(passphrase, salt, 1,000,000, SHA-256)` → 64 bytes: bytes 0–31 are the view KEK and bytes 32–63 the triage key.
- Both are imported as **non-extractable** AES-GCM keys.
- The DEK is wrapped as AES-GCM(KEK, nonce, AAD `dek|<epoch>|<buildId>`).
- `jobpilot hosted passphrase new` makes a 6-word EFF passphrase and a salt locally. It pipes the 64-byte output to
  `gh secret set SNAPSHOT_KEYS` on stdin, and prints the passphrase once.
- `passphrase set` accepts the user's own passphrase only if it has 6 or more list words, or 30 or more characters.

**Unlock.**

| Item | Rule |
|---|---|
| Before unlock | the page shows only a lock form: a passphrase field, "Remember on this device" and the generic product name. No counts, dates, names or build time. |
| Meta tags | `<meta name="robots" content="noindex,nofollow">`, `<meta name="referrer" content="no-referrer">` |
| CSP (meta) | `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self' https://api.github.com; frame-src blob:; base-uri 'none'; form-action 'none'` |
| Target time | unlock ≤ 3 s on a 2019-era phone |
| Remember | "Remember on this device" stores the two non-extractable keys in IndexedDB. "Forget this device" deletes them, and they are forgotten after 30 days unused. A wrong passphrase shows "That passphrase didn't open this snapshot", with no detail. |

**Rendering.**
- Decrypted HTML goes through `DOMParser`; `<script>` elements and `on*` attributes are stripped before insertion.
  This is defence in depth: the content is already escaped server-side, and the CSP blocks inline scripts anyway.
- Clicks on same-origin `/…` links are routed to manifest chunks. An unmapped route shows "Not in this snapshot: open
  it on your laptop dashboard".
- Document routes become `blob:` downloads.
- Fixed-name files are fetched with `cache: 'no-store'`. A missing chunk (replaced build) shows "A newer snapshot is
  ready" plus Reload.

**Health line, inside the ciphertext.** "Updated 08:21 IST, 15 Oct · Actions minutes 1,212 of 2,000 used in Oct · <budget level>".
It turns amber when the device's clock is more than 26 h past the build.

**UX rules.**
- The app's own CSS and copy are used, so the copy-rules lint and the 400 px matrix (no horizontal scroll, 44 px targets
  under `pointer:coarse`, first row < 260 px, header plus one sticky bar ≤ 25 % of 860 px) run against the decrypted
  snapshot pages in tests (§7).
- Pending decisions show a "Pending: applies at the next run (07:37 IST)" pill.

**Shell integrity.**
- Each run fetches the live `index.html` and `shell.js` from Pages after the deploy and compares their sha256 with the
  pinned code's.
- A mismatch (defacement with a stolen deploy token) opens a red alert telling the user not to unlock.

### 3.8 Triage events: format and applier

**Device side.**
- After unlock, the device holds the API owner and repo from the manifest. Settings › "Decisions from this device"
  takes a token, which is stored AES-GCM-encrypted under the view KEK.
- The device keeps an outbox in IndexedDB, with `deviceId` (8 random hex) and a monotonic `seq`.
- "Send N decisions" posts one comment to the open issue labelled `triage-inbox`.

**Comment body:**

```
jobpilot-triage v1 <epoch> <deviceId> <batchSeq>
<base64url( nonce(12) ‖ AES-GCM(triageKey, gzip(batch JSON), AAD = first line) )>
```

**Batch JSON** (strict Zod; ≤ 200 events; ≤ 60,000 characters per comment, split otherwise):

| Field | Value |
|---|---|
| `v`, `deviceId`, `batchSeq`, `buildId` | the snapshot build the decisions were made on |
| `events[].id` | `<deviceId>-<seq>` (globally unique; the idempotency key) |
| `events[].at` | device ISO time (orders events only; never trusted as a fact) |
| `events[].kind` | `status` · `note` · `followup` |
| `events[].target` | `{type: job\|gig\|network, key}` (job and gig keys `^[0-9a-f]{16}$`) |
| `events[].base` | what the device saw: `{status}`, `{noteSha256}` or `{followup}` |
| `events[].to` | a `JOB_STATUSES`, `GIG_STATUSES` or `NETWORK_STATUSES` member; note text ≤ 4,000 characters; a follow-up date `YYYY-MM-DD` or null |
| `events[].docsSha256` | only for `to: applied`: the hash of the resume and cover files the device downloaded |
| `events[].undoOf` | optional: the event id this reverts (UX: Undo) |

Not allowed from devices: facts verify/reject, company approvals, keep-a-copy, setup. Those stay on the laptop dashboard.

**Applier (`jobpilot triage apply`).** It runs under the run lock at step 4, before any pipeline.

1. **Fetch.** Comments on every `triage-inbox` issue (open, and those closed in the last 35 days).
2. **Accept a batch only if:**
   - its author is the repo owner;
   - it was never edited (`created_at == updated_at`; an edited comment is rejected as `edited`);
   - the header parses, and the epoch is current or the previous one;
   - AEAD verifies;
   - the schema passes.

   A failing batch is rejected whole (`invalid-batch`) and recorded once.
3. **Dedupe.** The new table `triage_events(id PK, batch, outcome, reason, applied_run, applied_at)` (app migration)
   holds every event ever seen. A seen id is skipped.
4. **Order.** New events are sorted by `(at, deviceId, seq)`, which is deterministic.
5. **Decide each event independently**, in its own transaction, with a `triage.applied` audit event in the hash chain:

| Outcome | Rule |
|---|---|
| `noop` | the current value already equals `to` |
| `applied` | current = `base` → apply through the same `AppStore` methods the dashboard uses (`setStatus(…, 'user')`, `setGigStatus`, network status, `setNote`, follow-up) |
| `conflict` | current ≠ `base` and ≠ `to`: **first applied wins; a decision made on a stale view is never applied silently**. The snapshot lists it as "Not applied: changed on another device", with the note text kept so it can be entered again. |
| `applied-no-copy` | `to: applied` whose `docsSha256` ≠ the job's current documents. The status is set, but no "documents you sent" copy is made (they would not be what was sent); the item says so. |
| `unknown` | no such job, gig or network |
| `expired` | `at` is more than 30 days before the run |
| `invalid` | a per-event schema or vocabulary failure |

6. **Feedback.** Outcomes from the last 14 days ride in the next snapshot. The device clears its outbox entry when it
   sees an outcome.
7. **Housekeeping.**
   - On the first run of a month, open "Decisions inbox YYYY-MM".
   - Close an inbox once all its batches have outcomes and it is more than 35 days old.
   - Never delete or edit a comment.

**Properties (tested).**
- Any duplication, reordering or interleaving of the same set of batches gives the same final DB.
- A rollback (§3.3) followed by the next run re-applies every event since that generation, because the dedupe table
  rolls back with the DB and the comments stay.
- Triage never touches pipeline inputs, so the daily-identity golden is unchanged.

### 3.9 Cross-platform scheduler (`jobpilot schedule install|uninstall|status|run-now [--platform auto|launchd|systemd|windows]`)

There is one scheduling model on every platform:
- start at load/login and every :00 and :30;
- `--if-due` decides (`due.ts`, unchanged);
- the dashboard is kept alive on 127.0.0.1:4317.

| | launchd (macOS) | systemd user (Linux) | Task Scheduler (Windows) |
|---|---|---|---|
| Units | `com.jobpilot.{daily,freelance,coverage,dashboard}.plist`, **byte-identical to today** (golden test) | `jobpilot-{daily,freelance,coverage}.service` + `.timer`; `jobpilot-dashboard.service` | tasks `\jobpilot\daily`, `\freelance`, `\coverage`, `\dashboard` from generated XML (`schtasks /Create /XML`) |
| Schedule | `StartCalendarInterval` :00, :30; `RunAtLoad` | `OnCalendar=*-*-* *:00,30:00`, `Persistent=true`, `OnStartupSec=2min` | a logon trigger + a time trigger repeating `PT30M` indefinitely; `StartWhenAvailable=true` |
| Overlap | the shared run lock | `Type=oneshot` (systemd never starts a second instance) + the lock | `MultipleInstancesPolicy=IgnoreNew` + the lock |
| Dashboard | `KeepAlive` | `Restart=always`, `RestartSec=30` | logon trigger, restart on failure every 1 min, 999 times |
| Limits | `ExitTimeOut 120` | `TimeoutStopSec=120` | `ExecutionTimeLimit=PT8H` (coverage slices are 90 min) |
| Environment | `JOBPILOT_HOME`, `PATH`, `TZ=Asia/Kolkata`, `LANG` | the same, through `Environment=` | the same, set by a generated `<home>\bin\run-<job>.cmd` launcher that the task's `Exec` runs (`WorkingDirectory` = repo) |
| Runs while logged out | no (GUI domain) | only with linger. `install` prints `loginctl enable-linger <user>` and never runs sudo. | no ("Run only when user is logged on", so no password is stored) |
| Status / run-now | `launchctl print` / `kickstart` (today) | `systemctl --user show -p ActiveState,Result` / `start` | `schtasks /Query /TN … /V /FO CSV` / `schtasks /Run` |

**Shared rules.**
- The Node binary must be absolute and ≥ 24 (today's check).
- Every command goes through the injected `Runner`.
- On Windows, file-mode tightening and `checkHome` mode warnings are skipped (ACLs are out of scope).
- Paths use `path.win32` there, and pack YAML is read with CRLF normalised.
- Notifier:
  - macOS: `osascript` (today);
  - Linux: `notify-send` through `execFile` when it is on PATH, otherwise log only;
  - Windows: log and dashboard banner only (no toast in this build).

### 3.10 Side-by-side comparator

**Digest** (`jobpilot shadow digest --run <runId> [--home]`). It opens the DB read-only, as-is, and never migrates.

- **Fields:** `{date, env: hosted|local, pipeline, runId, codeSha, packHash, sources: {<sourceId>: {postings: [keys], problems: [codes]}}, eligible: [keys], toDecide: [keys], gigs: {<sourceId>: [keys]}, billedMinutes?}`.
- **Format:** canonical JSON with sorted keys and arrays.
- **Hosted:** written at step 8 to `state:shadow/hosted/`.
- **Mac:** the user runs the digest once at the end of the week, read-only, for the 7 dates, and pushes it to
  `shadow/mac/`. No launchd change. The Mac must not be compacted during the shadow week (noted in the H2 checklist).

**Report** (`jobpilot shadow compare --mac <dir> --hosted <dir>`). It is a pure function of the two directories,
byte-identical for the same inputs, with no clock.

- **Per day and source:** Mac, hosted, both, Mac only, hosted only, recall = both ÷ Mac.
- **Then:** eligible, to-decide and gig recall, durations and billed minutes.
- **Then:** every criterion below as PASS or FAIL with the numbers.
- **Comparability:** a day whose `packHash` differs is "not comparable" and doesn't count. A `codeSha` difference is
  listed. The hosted freelance `am` run is compared with the Mac's `am` run.

**Switch criteria** (all must pass over 7 consecutive comparable days):

| # | Criterion | Threshold |
|---|---|---|
| C1 | Hosted daily+freelance committed state | 7 of 7 days, and by 10:00 IST on ≥ 6 of 7 |
| C2 | Eligible recall `|E_mac ∩ E_hosted| ÷ |E_mac|` | ≥ 0.95 on ≥ 6 of 7 days and ≥ 0.97 over the week |
| C3 | Per source with a Mac mean ≥ 5 postings/day | hosted mean ÷ Mac mean ≥ 0.90. Sources that fail go into `skipSources`, and the switch is allowed only if they together held ≤ 3 % of the Mac's eligible items that week. |
| C4 | Gig recall (am window) | ≥ 0.95 over the week |
| C5 | Projected minutes: 31 × (p90 of the daily job's billed minutes + 1 probe) | ≤ 1,750 (leaves ≥ 150 for coverage + 100 safety) |
| C6 | Privacy | 0 leak-scan hits on every build, 0 log-audit hits, 0 non-template lines |
| C7 | State | all 7 generations pass `hosted verify` (sha256, decrypt, quick_check, audit verify) |
| C8 | Triage (needs H4) | ≥ 10 events from ≥ 2 devices with correct outcomes; a resent batch applied once; a forced conflict reported |

If C2 or C3 fails, the hosted mode is not switched on: the Mac stays primary and nothing is lost.

## 4. Minutes budget

The basis is research §7 (Linux 2-core, private repo, each job billed rounded up), with S7 (freelance in the daily job)
applied. The planning month is **31 days** (the worst case). All figures are minutes.

| Workload | Per run | Runs/month | Minutes/month |
|---|---|---|---|
| Daily + freelance job: daily 36 (research avg; max 94) + freelance 2 + overhead 8 (checkout and Node 1, Chromium from cache 1, state pull and verify 1.5, compaction 1.5, snapshot 1, bundle and upload 2) | 46 | 31 | 1,426 |
| Catch-up trigger at 10:37 (cheap check, exits) | 1 | 31 | 31 |
| Triage | 0 (issue comments, no workflow) | | 0 |
| Pages build in `jobpilot-view` | public repo: free | | 0 |
| Safety margin | | | 100 |
| **Coverage allowance** (whatever is left) | | | **≈ 443** (≈ 220 per fortnight) |
| **Total** | | | **2,000** |

**What this means.**
- A full coverage pass took ~7 h on the Mac. At the planning figures a hosted fortnight gets ~220 runner-minutes, so
  **hosted coverage will usually finish partially**.
- The run is resumable and is closed partial at the period's end, as today ("Coverage last period did not finish: N of
  M candidates finished").
- This is the main tension with U-H2 (§10): **daily every day + freelance daily + coverage fortnightly fits 2,000 only
  if coverage accepts ~half a pass per fortnight**, or a laptop does coverage (H6).

**Ledger.**
- Each job appends `ceil(billed)`, where billed is the job's `started_at` to the wrapper's end (from the API, which
  `actions: read` allows), + 1 minute for teardown.
- The month runs from `cycleStartDay` (default 1, UTC).
- It is an estimate of GitHub's meter that errs high. GitHub's own usage page stays the authority (Q3).

**Governor**, evaluated at step 0 of every job:

```
U  = minutes used this month (ledger)            d  = p90 of the last 14 daily-job ledger entries (start: 46)
Rd = days left in the month, today included       M  = 2,000   S = 100
reserve  = Rd × (d + 1)
coverage slice allowed when  A = M − S − U − reserve ≥ 60;  slice = min(A − 10, 330, minutes until 07:00 IST − 20)
```

**Cut ladder.** Each step down opens an alert issue, puts a red Health line in the snapshot and writes a job summary
line. It is never silent.

| Level | Trigger | What is cut | Announced as |
|---|---|---|---|
| L0 | normal | nothing | — |
| L1 | A < 60 | coverage for the rest of the month (the period closes partial) | "Coverage paused until 1 Nov: Actions minutes budget" |
| L2 | U + Rd × (d + 1) > M − S | the 10:37 catch-up trigger (a dropped 07:37 cron then waits for the Mac standby) | "Catch-up check off: minutes budget" |
| L3 | U + Rd × d > M − S | freelance (the job runs daily only) | "Freelance paused until 1 Nov: minutes budget" |
| L4 | U ≥ M − S | the hosted daily; the Mac standby (§8 H5) runs it locally with 0 minutes | "Hosted runs stopped until 1 Nov: minutes budget. The Mac fallback runs them." |

With no payment method, GitHub itself stops Actions at 2,000. The governor stops at 1,900, so the user hears about it
first, and the last 100 minutes stay for `hosted` maintenance runs.

**Shadow week cost.** ~7 × 47 ≈ 330 minutes, and no hosted coverage runs during the shadow week.

## 5. Security and threat model

**Assets:**
- personal data: the pack, DB, documents and notes;
- credentials: the Gmail refresh token, `STATE_KEY`, `PACK_KEY`, `SNAPSHOT_KEYS`, both PATs;
- the passphrase.

| Threat | Exposure | Controls | Residual risk |
|---|---|---|---|
| **Device token stolen** (Issues RW on `jobpilot-data`) | read and write issues and comments | Batches are AEAD-sealed with the triage key, so the thief reads only ciphertext and can't forge or alter events. Alert issues hold template text only. The token can't read contents, releases or secrets, or start workflows. 90-day expiry; revoke in GitHub settings. | Comment spam: the applier reads at most 50 batches a run and reports the rest. Deleting comments (DoS on pending decisions) shows up as decisions never acknowledged on the device. |
| **Device stolen while unlocked or remembered** | everything the snapshot shows; the token | keys are non-extractable; "Forget this device"; 30-day auto-forget | the same as losing an unlocked laptop |
| **Passphrase brute force** (offline, against the public `k.bin`) | all snapshots of that epoch | PBKDF2 at 1,000,000 iterations. At ~9,000 guesses/s per high-end GPU, a 6-word passphrase (2^77.5) takes ~10^19 GPU-seconds on average. The tool refuses passphrases under 6 words or 30 characters. | A weak user-chosen passphrase. Rotation (`passphrase new`) re-encrypts from then on. **Ciphertext already harvested stays readable with the old passphrase**: rotate when it might be known, and treat old builds as exposed then. |
| **Size and traffic analysis** | build size, chunk counts | per-build random names; bucket padding; no plaintext counts or dates | the rough volume of activity |
| **Log leaks** | the Actions log (private, owner-only) | S9 log gateway; `::add-mask::`; no `set -x`; no artifacts; secrets only in one step's env; the next run's log audit | none known; a hit is a red alert |
| **Fork PRs / untrusted code** | secrets in a workflow run | no PR or comment triggers in `jobpilot-data`; fork PR workflows off; the public repo has no secrets and its example workflow is outside `.github/workflows`; the code SHA must be an ancestor of public `main` (fork-network commits refused) | — |
| **Supply chain** (a compromised npm dependency on the pinned lockfile) | secrets in the wrapper step's env | exact versions + frozen lockfile from the pinned commit; secrets absent during install; actions pinned by SHA | accepted: a malicious dependency in the wrapper step could read its env |
| **`VIEW_DEPLOY_TOKEN` stolen** | deface the shell to phish the passphrase | the token reaches `jobpilot-view` only; the shell-integrity check after each deploy (§3.7); "Remember on this device" means the passphrase is rarely typed | up to one day between defacement and detection |
| **Data repo made public by mistake** | issues, ledger, digests (no plaintext personal data), and the encrypted pack and state | the wrapper refuses to run when `github.event.repository.private` is false; `hosted doctor` checks it | — |
| **State tampering** (anyone with Contents write) | releases, pointer | AEAD on every chunk (forgery fails); sha256 in the pointer; the pointer is moved only by CAS; generations kept | deletion: the laptop's `hosted pull` is the off-GitHub copy (H5 checklist: once a week) |
| **GitHub account takeover** | everything | the account's 2FA (outside this design) | total |
| **Gmail token misuse** | read-only mail of one label | the `gmail.readonly` scope; the path allow-list (`GMAIL_READ_PATH`); the label check; a revoked token is a named problem and an alert | — |

## 6. Failure modes

| Failure | Detected by | Effect | Recovery |
|---|---|---|---|
| 07:37 cron dropped or delayed | the 10:37 trigger's cheap check | the run starts up to 3 h late | automatic; with L2 active, the Mac standby at 11:00 IST |
| A run hits its deadline | the wrapper's deadline | SIGTERM, a between-steps stop, upload (a resumable run) | the next run resumes |
| Killed (job timeout, runner lost) | the next run sees an expired lease | **no upload; G unchanged** | the next run takes over the lease after `until` |
| Download, sha256, decrypt or `quick_check` failure | step 2 | the run stops before any pipeline; red alert | `hosted verify --gen G`; `hosted rollback --to G-1` (manual, never automatic, so corruption is never hidden) |
| Wrong key (`keyId` mismatch) | the header | "wrong key", not "corrupt" | fix the secret |
| Upload or verify failure | step 4 | the new release is deleted; G unchanged; red | the next run redoes the work (source steps refetch) |
| CAS push rejected | step 5 | release G+1 deleted; red alert "another writer moved the state" | investigate; the lease should make this impossible |
| Disk preflight fails | step 2 | stop before any pipeline | raise `state.warn`, open question Q2 |
| Asset > 1,500 MB compressed | step 3 | committed; red alert; the next run refuses | Q2 (event and queue growth) |
| Pinned code newer than the state schema | open | migrates under the lock, as on the Mac; the pointer records the new schema | rollback below that schema also needs `code.lock` set back; `hosted rollback` says so and refuses without `--with-code <sha>` |
| Source challenged from cloud IPs | G-CHALLENGE | a named problem "(hosted runner)"; the shadow report attributes it | `skipSources` (S11), or keep that source in local mode |
| Gmail refresh revoked or expired | the token endpoint refuses | the Gmail source is off with its named problem; the rest of freelance runs; alert | `jobpilot gmail connect` on a laptop, then `gh secret set GMAIL_REFRESH` from stdin |
| Pack decrypt or validation fails | step 3 | stop before any pipeline | `hosted pack push` again |
| Triage batch invalid or edited | the applier | that batch is rejected and recorded once; others apply | the device resends from its outbox |
| Snapshot over budget | the builder | degrade (§3.6); over again → no deploy | lists shrink, or the budget is raised |
| Leak-scan hit | `snapshot verify` | no deploy; red alert | a bug fix; the old snapshot stays |
| Pages deploy fails or is defaced | deploy step / integrity check | state still advances; devices show "Updated N h ago" | the next run; rotate `VIEW_DEPLOY_TOKEN` |
| Device token expired | API 401 | "Your GitHub token for decisions expired: create a new one", and the outbox is kept | paste a new token |
| Budget level change | governor | the §4 ladder | automatic at the month start |
| GitHub Actions down or blocked by billing | Mac standby: pointer `lastDone.daily` < today at 11:00 IST | standby pulls G under the lease, runs, pushes G+1 | automatic once H5 is live |
| Laptop and Actions at once | the lease | the second one waits or exits "state is in use by <holder> until <time>" | automatic |

## 7. Testing (all offline; the vitest net guard stays on)

- **GitHub and Google.** Every interaction goes through injected clients: `GitHubClient` (releases, git push CAS,
  issues, jobs) and the existing `FormPost`/HTTP fakes. There are no real calls; loopback-only browser tests are allowed
  as today.

| Area | Tests |
|---|---|
| Crypto | Known-answer vectors for JPST1 (fixed key and nonce → fixed bytes). Tamper, reorder, truncate, extend and wrong key each fail with their own message. WebCrypto (Node's `crypto.subtle`, same API as browsers) decrypts what `node:crypto` encrypted: snapshot chunks, the wrapped DEK and triage batches. PBKDF2 parameters asserted. |
| State store | A fake GitHub with races: two writers, exactly one CAS wins. Fault injection at each step 1–13 → the pointer equals G unless step 5 succeeded. Pruning keeps 7 + 4 weekly. Rollback refuses under a live lease and across a schema boundary without `--with-code`. |
| Seed and never-migrate | `hosted seed` on a behind-schema fixture home: the source bytes, mtime and `user_version` are unchanged. Every writing `hosted` command refuses the default home. |
| Wrapper | Exit codes 0, 1, 2 → upload; a deadline kill → no upload. The `--if-due` attempts file survives across generations. `everyWeeks: 1` gives `coveragePeriod` = `coverageWeek` on every date in 2026–2027. The hosted UA constant is selected by environment only (the G-NO-EVASION test is extended). |
| Log gateway | Every template fed adversarial strings (names, URLs, control characters): output stays in the slot alphabets. The log audit finds planted canaries in raw, base64 and URL-encoded forms. |
| Governor | Table-driven: day of month × usage × p90 → the expected level and slice. Each level change produces exactly one alert. |
| Snapshot | Golden manifest of routes for a fixture home. The degrade order. The leak scan catches planted canaries in every encoding. Every non-shell file starts with the magic. Real-browser project: unlock from `file://` / loopback; copy-rules lint and the 400 px / 1440 px matrix on decrypted pages; 0 targets under 44 px with `hasTouch`; no plaintext text nodes before unlock (DOM dump = the lock form only); CSP violations = 0. |
| Triage | Property test: random duplication, reordering and interleaving of batches → the same final DB. Each outcome row of §3.8 has a case. An edited comment, a foreign author, a bad tag and an old epoch are rejected. Rollback-then-reapply. Daily-identity golden unchanged. |
| Scheduler | launchd plists **byte-identical** to today's golden. Golden systemd units and timers, and golden Task Scheduler XML. Install, status and run-now command lines through a fake `Runner`. Win32 path handling through `path.win32`. CRLF pack files. |
| Secrets backends | `secret-tool` and PowerShell DPAPI through fake runners: the value is on stdin only, never in argv. `envSecrets` is read-only. |
| Comparator | Golden report from fixture digests; byte-identical across two runs; each criterion has a PASS and a FAIL fixture; the "not comparable" path. |
| Workflow lint | It parses `examples/hosted/*.yml` and asserts: only the allowed triggers; one concurrency group; `cancel-in-progress: false`; every `uses:` pinned by 40-hex SHA; `timeout-minutes` set; cron minute ≠ 0; minimal `permissions`; no `set -x`, `upload-artifact` or `${{ secrets.` inside `run:`. |
| Public-repo privacy | A forbidden-term scan of `examples/`, the docs and this spec. Emails only `@example.com`/`.org`, owner `example-user`, no number matching the pack's compensation values. |

Before merging each phase: `node --run verify` (typecheck, tests, contracts, evals, perf).

## 8. Rollout phases

Ordered by return: H1 alone gets the runs off a sleeping Mac. **Each phase is useful if the next never happens.**

| Phase | Delivers | Useful on its own because | Done when |
|---|---|---|---|
| **H1 Hosted runs (shadow)** | JPST1 crypto; the state store (pointer, lease, generations, verify, rollback); `hosted seed/pull/push/run/status/doctor/keys/pack`; `envSecrets`; the run wrapper with log gateway, masking, compaction, ledger and governor; `daily.yml` (daily + freelance am); the SIGTERM stop; S10 UA; hosted digests; the example workflows and `docs/hosted.md` in the public repo | Runs happen every morning whatever the Mac is doing. Any laptop can `hosted pull` into its own home and run `serve` on it. The Mac is untouched. | 3 consecutive green days; `hosted verify` passes on each generation |
| **H2 Side-by-side report** | `shadow digest`/`compare`; the 7-day report; the C1–C7 evaluation; the first `skipSources` | Measured evidence about hosted yield and minutes, without any switch | the report exists for 7 comparable days (pass or fail) |
| **H3 Encrypted snapshot** | `readOnly` server mode and `mode: 'snapshot'` views; the builder, leak scan and size budget; the shell (unlock, router, documents); `passphrase new/set`; the deploy and integrity check | Read the day's matches and documents on a phone or tablet | unlock works on iOS Safari, Android Chrome, Windows and macOS; C6 holds for 7 builds |
| **H4 Triage from any device** | device token settings; outbox; encrypted batches; the inbox issue; `triage apply`; outcomes in the snapshot | Shortlist, Not for me, Mark applied and notes from any device, applied next morning | C8 passes |
| **H5 Switch + Mac fallback + hosted coverage** | `coverage.yml` with the fortnight period and governor slices; `hosted standby` (scheduled locally at 11:00 IST, home `~/.jobpilot-hosted`); the switch checklist | The Mac can sleep; the hosted mode is primary; the Mac covers outages and L4 | the user flips after C1–C8 pass. Checklist: unload the `~/.jobpilot` launchd jobs (the home stays as an archive, untouched); install standby; weekly `hosted pull` as the off-GitHub copy. |
| **H6 Cross-platform local mode + laptop-assisted coverage** | systemd and Task Scheduler adapters; libsecret and DPAPI backends; Linux and Windows notifiers; `hosted run coverage --local` (a laptop runs the coverage slice against hosted state under the lease, 0 Actions minutes) | jobpilot runs on Linux and Windows laptops; coverage can finish fully without spending minutes | golden tests; a manual smoke checklist on one Linux and one Windows machine |

H3 can be built while H2's 7 days run. H6's scheduler half can come earlier if a non-Mac laptop is needed sooner.

## 9. Open questions (minimal)

| # | Question | Default if unanswered |
|---|---|---|
| Q1 | The public view repo's name and URL show that jobpilot is in use. Is a neutral name wanted? | `jobpilot-view` |
| Q2 | Events, queue and step rows grow ~70–100 MB raw per daily run and are never pruned. Should a later build segment the event chain (an archive with a verified checkpoint)? | Out of scope. The §3.3 size alerts decide when it is needed. |
| Q3 | Should the ledger be reconciled with GitHub's billing usage API? That needs a third token with the user-level "Plan: read" permission. | No: the ledger errs high, and the governor stops at 1,900. |

## 10. Conflicts with the user's choices (stated, not resolved silently)

1. **Budget versus coverage (U-H2).** At the research's figures, daily every day + freelance daily already uses ~1,460
   of the 2,000 minutes. That leaves ~220 per fortnight for coverage, about half of a ~7-hour pass. The spec keeps all
   three schedules. Coverage gets only the leftover and closes partial, loudly, and H6 offers a laptop-assisted coverage
   slice at 0 minutes. If the shadow week measures the daily job above ~55 billed minutes (C5), even that leftover
   disappears.
2. **"Works without JS" (UX §3) versus an encrypted static page (U-H3).** This can't be satisfied: decryption needs
   JS. The exemption applies to the hosted snapshot only (§1.3).
3. **Freelance once a day (U-H2) versus the Mac's two windows.** Hosted runs only the `am` window, which loses the
   19:30 refresh. The comparator compares `am` with `am`.
4. **"Public Pages" (U-H3) and "no personal data in the public repo" (U-H1).** Both hold only with a third, public
   `jobpilot-view` repo that carries nothing but ciphertext and the generic shell (S1).
