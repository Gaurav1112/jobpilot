# Hosted mode (GitHub Actions, encrypted state)

All names, owners and numbers below are fictional examples. Replace `example-user` with your own GitHub login.

## What hosted mode is

Every morning a GitHub Actions job in a PRIVATE data repo downloads the encrypted state, runs the daily pipeline and the
freelance `am` window, compacts the database and uploads a new encrypted generation, whatever your computer is doing.

Three repos are involved:

| Repo | Visibility | Holds |
|---|---|---|
| `example-user/jobpilot` | public | the generic code (this repository) |
| `example-user/jobpilot-data` | private | the workflow, `hosted.yaml`, `code.lock`, the encrypted pack, the state pointer, the encrypted state releases, the budget ledger |
| `example-user/jobpilot-view` | public | the encrypted read-only snapshot site (a later phase) |

The first phase is a **shadow phase**: hosted runs happen every day, but your Mac keeps its own `~/.jobpilot` and its
launchd jobs, untouched. Nothing here changes the Mac setup, and no hosted command touches the default home. After a
week of runs the side-by-side report compares both.

The workflow never auto-submits an application. It prepares, like the local runs.

## One-time setup, in order

1. **Keys.** Create the state and pack keys in the keychain and print the recovery sheet once. Store the sheet offline.

   ```
   node --run jobpilot -- hosted keys new
   ```

2. **Data repo.** Create `example-user/jobpilot-data` as a PRIVATE repo. In Settings > Actions > General set the default
   workflow permissions to read, and turn off running workflows from fork pull requests. Check out the repo locally as
   `~/jobpilot-data`.

3. **Secrets.** Copy the keys (and the Gmail values, if you use the Gmail source) from the keychain into the repo's
   Actions secrets. Values go to `gh` on stdin; nothing is echoed.

   ```
   node --run jobpilot -- hosted secrets sync --repo example-user/jobpilot-data
   ```

4. **Pack.** Validate your pack, seal it with the pack key and write `pack/pack.jpst` into the data repo checkout.

   ```
   node --run jobpilot -- hosted pack push --pack ~/.jobpilot/pack --data ~/jobpilot-data
   ```

5. **Pin the code.** Write `code.lock`: the public commit hosted runs use. It must be an ancestor of `origin/main`.

   ```
   node --run jobpilot -- hosted bump --data ~/jobpilot-data
   ```

6. **Workflow.** Copy `examples/hosted/daily.yml` to `~/jobpilot-data/.github/workflows/daily.yml` and replace
   `example-user` in the `repository:` line. Do not loosen anything else: `hosted doctor` lints the file (only `schedule`
   and `workflow_dispatch` triggers, one concurrency group, pinned actions, secrets only in the wrapper step).

7. **Config.** Copy `examples/hosted/hosted.yaml` to `~/jobpilot-data/hosted.yaml` and set `owner`. Commit and push the
   data repo (workflow, `hosted.yaml`, `code.lock`, `pack/pack.jpst`).

8. **Seed.** Publish a copy of your home as generation 1. The source home is opened read-only and never written.

   ```
   node --run jobpilot -- hosted seed --from ~/.jobpilot --repo example-user/jobpilot-data --data ~/jobpilot-data
   ```

9. **Doctor.** Check the setup. It prints PASS, WARN and FAIL lines and exits 1 on a FAIL.

   ```
   node --run jobpilot -- hosted doctor --repo example-user/jobpilot-data --data ~/jobpilot-data
   ```

   Two things stay by hand and are printed as reminders: fork pull request workflows off, and no payment method on the
   account (or a $0 spending limit).

10. **First dispatch.** In the data repo's Actions tab run the `jobpilot daily` workflow with "Run workflow". Then
    check it with `hosted status` (below).

### The Gmail OAuth app must be in production status

If you use the Gmail source, the Google OAuth app behind it must be in **production** publishing status. A refresh token
issued while the app is in Testing status expires after 7 days, and the Gmail source would silently stop each week. A
revoked or expired token is reported as a named problem and an alert; the rest of the run carries on. To renew it, run
`jobpilot gmail connect` on a laptop, then set the `GMAIL_REFRESH` secret again from stdin.

## Daily operation

```
node --run jobpilot -- hosted status   --repo example-user/jobpilot-data
node --run jobpilot -- hosted verify   --repo example-user/jobpilot-data --all
node --run jobpilot -- hosted rollback --repo example-user/jobpilot-data --to 41
node --run jobpilot -- hosted pull     --repo example-user/jobpilot-data --to ~/jobpilot-pulled
JOBPILOT_HOME=~/jobpilot-pulled node --run jobpilot -- serve
```

- `status` shows the state generation, the last runs, the lease, the budget level, the size flag and the last ledger lines.
- `verify` downloads, decrypts and checks one generation (`--gen N`) or every retained one (`--all`).
- `rollback` points the state at an earlier retained generation. It is manual, never automatic, so corruption is never
  hidden, and it is refused while a run holds the lease. Below the current schema it needs `--with-code <sha>`.
- `pull` downloads and verifies the current state into a new folder (never the default home). Pointing `JOBPILOT_HOME`
  at it and running `serve` opens the dashboard on that copy. A weekly `pull` is also your off-GitHub backup.
- To move the pinned code later: `hosted bump --data ~/jobpilot-data`, then commit and push `code.lock`.

## The minutes budget

Free private-repo Actions give 2,000 runner-minutes a month. The planning month is 31 days: the daily job and
freelance take about 46 minutes (1,426 a month), the 10:37 catch-up check about 1 (31), a safety margin 100, which
leaves roughly 443 minutes for coverage. A hosted coverage fortnight therefore usually finishes only partially.

The governor runs at the start of every job and cuts work in this order. Each step down opens an alert issue, puts a
red Health line in the snapshot and writes a job summary line. It is never silent.

| Level | Trigger | What is cut | Announced as |
|---|---|---|---|
| L0 | normal | nothing | nothing |
| L1 | allowance A < 60 | coverage for the rest of the month (the period closes partial) | "Coverage paused until 1 Nov: Actions minutes budget" |
| L2 | used + days left x (p90 + 1) > 1,900 | the 10:37 catch-up trigger | "Catch-up check off: minutes budget" |
| L3 | used + days left x p90 > 1,900 | freelance (the job runs daily only) | "Freelance paused until 1 Nov: minutes budget" |
| L4 | used >= 1,900 | the hosted daily itself | "Hosted runs stopped until 1 Nov: minutes budget. The Mac fallback runs them." |

Here A = 2,000 - 100 - used - days left x (p90 + 1), and p90 is the 90th percentile of the last 14 daily-job ledger
entries (46 to start). GitHub itself stops Actions at 2,000 when no payment method is set; the governor stops at
1,900 so you hear about it first and the last 100 minutes stay for maintenance runs. GitHub's own usage page stays the
authority: the ledger is an estimate that errs high.

## When something fails

| Failure | Detected by | Effect | Recovery |
|---|---|---|---|
| 07:37 cron dropped or delayed | the 10:37 trigger's cheap check | the run starts up to 3 hours late | automatic |
| A run hits its deadline | the wrapper's deadline | SIGTERM, a stop between steps, upload of a resumable run | the next run resumes |
| Killed (job timeout, runner lost) | the next run sees an expired lease | no upload; the generation is unchanged | the next run takes over after the lease time |
| Download, checksum, decrypt or integrity failure | state download step | the run stops before any pipeline; red alert | `hosted verify --gen N`, then `hosted rollback --to N-1` |
| Wrong key | the file header | reported as "wrong key", not "corrupt" | fix the secret |
| Upload or verify failure | the upload step | the new release is deleted; the generation is unchanged; red | the next run redoes the work |
| Push rejected (state moved) | the commit step | the new release is deleted; red alert "another writer moved the state" | investigate; the lease should make this impossible |
| Disk preflight fails | the state step | stop before any pipeline | free space or raise the size thresholds in `hosted.yaml` |
| Asset over the hard size | the compaction step | committed; red alert; the next run refuses | shrink the state or raise the threshold |
| Source challenged from cloud IPs | the source's challenge detection | a named problem ending "(hosted runner)"; the report attributes it | add it to `skipSources` in `hosted.yaml`, or keep that source on the Mac |
| Gmail refresh revoked or expired | the token endpoint | the Gmail source is off with a named problem; the rest of freelance runs; alert | `jobpilot gmail connect` on a laptop, then set `GMAIL_REFRESH` again |
| Pack decrypt or validation fails | the pack step | stop before any pipeline | `hosted pack push` again |
| Laptop and Actions at once | the lease | the second one waits or exits "state is in use by ..." | automatic |

## What never leaves the encrypted state

The pack (your profile, contact details, answers, offers), the database, the generated documents and the notes live only
inside AES-256-GCM encrypted files: the state releases and `pack/pack.jpst`. The keys exist in your keychain and in the
Actions secrets, never in the repos.

- The public repo holds generic code and fictional examples only.
- The private data repo holds only ciphertext, the pointer (generation numbers, sizes, checksums), the budget ledger,
  run digests and alert text from fixed templates. No plaintext personal data.
- Actions logs go through a log gateway that prints fixed templates and masks known values. Workflows never run
  `set -x`, never upload artifacts, and expose secrets only to the one wrapper step. Each run audits the previous run's
  log, and a hit is a red alert.
- The state key and the GitHub token never reach a pipeline process; the Gmail values reach only the freelance one.
