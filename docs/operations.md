# Operating jobpilot on your own

Everything jobpilot does is a command in this folder's CLI. You never need an assistant, an
account or a key to run it.

- **No AI and no API key is needed.** Every step is plain code with fixed rules. The same inputs
  give the same outputs.
- Claude Code was only the tool the project was built with. Nothing at run time depends on it.
- The kernel has an `LlmProvider` slot that nothing uses. If you ever want a model for some
  step, it plugs in there, and a local model works as well as a hosted one. Today it is unused.

Every command below is written as `node --run jobpilot -- <command>`. Use `node --run`, not
`pnpm <script>`. The output shown was produced by real runs on a scratch home built from the
fictional fixture pack (Asha Rao); `~/.jobpilot` stands for that home, and long output is
trimmed with `...`. Your own numbers will differ.

`JOBPILOT_HOME` moves the home folder (default `~/.jobpilot`). It holds `pack/` (your facts and
settings), `jobpilot.db` (everything jobpilot has stored), `out/` (documents), `logs/` and
`jobpilot.lock`.

## 1. Install

You need macOS, Node 24 or newer and `pdftotext` (`brew install poppler`).

```sh
pnpm install
node --run jobpilot -- --help
```

The second command lists every command. Any command accepts `--help`, which prints what it does,
its options and its exit codes.

## 2. Create your pack

The pack is your facts, contact details, answers and watchlist, in `~/.jobpilot/pack/`. Nothing
personal is ever stored in the repo.

Two ways to start:

1. Build it once from your own files with `pack import` (every flag is explained in the README,
   section "One-time setup"):

   ```sh
   node --run jobpilot -- pack import --career-ops ~/career-ops --resume-text ~/resume-experience.txt \
     --desk ~/desk-export --forbid "Example Client Ltd" --name "Your Name" --email you@example.com \
     --phone "+91 00000 00000" --city "Pune" --as-of 2026-10 --available-from "1 November 2026" \
     --notice-period "30 days" --floor-inr 1200000 --dry-run
   ```

   `--dry-run` checks every input and prints the summary without writing anything. Drop it to
   write the pack. `--forbid` is required: a name that must never appear anywhere.

2. Copy the fixture pack as a template and edit the YAML files by hand:

   ```sh
   mkdir -p ~/.jobpilot && cp -r tests/fixtures/pack ~/.jobpilot/pack
   chmod 700 ~/.jobpilot
   ```

   Then replace the fictional person with yourself (`contact.yaml`, `facts.yaml`,
   `experience.yaml`, `answers.yaml`), list what must never be named in `naming.yaml`, and set
   your pay floor in `targets.yaml`.

### Check it

```sh
node --run jobpilot -- pack check
```

```
pack ok: ~/.jobpilot/pack
pack hash 900420850a1aaf46edd002e793fcee1d80cd16e2edb08e0fa37f76a3e7d2c820
full pack hash 55a2636155f823877511bb9b51f2e7f880b97bb0f92e6cbcf45a407b17a7fee2
experience as of 2026-10; 15 facts; watchlist 4 entries (1 careers); feeds himalayas
pipeline jobpilot-daily@1.0.0: 15 agents; policy 0831f5e6a08b
```

It loads the pack exactly as today's run would and refuses on any problem, naming the file. Run
it after every edit. A home folder readable by other users makes every command warn
(`JOBPILOT_HOME ... is readable by other users; run chmod 700 ...`); do what it says.

## 3. The runs

There are three runs. Each has an `--if-due` mode, which is what the schedule uses: it runs only
when that run is owed and otherwise prints why and exits 0. Without `--if-due` the command
always runs.

| Run | Command | Owed |
|---|---|---|
| Daily | `run` | every day from 07:00 IST, once a day completes |
| Freelance | `run-freelance` | twice a day, from 07:30 and 19:30 IST |
| Coverage | `run-coverage` | weekly, from Sunday 06:00 IST through Saturday |

A failed attempt is retried no sooner than an hour later and at most three times in its window.

Exit codes of all three: `0` clean; `1` some step failed or was held back (the summary lists the
problems and the rest of the run is still saved); `2` the run could not start (a missing or
invalid pack, another jobpilot process running).

### Daily run

```sh
node --run jobpilot -- run
```

```
run daily-2026-10-14 for 2026-10-14 (experience as of 2026-10): completed
agent             done  replayed  failed  gone  rejected  skipped  quarantined
cover-writer         3         0       0     0         0        0            0
eligibility          7         0       0     0         0        0            0
...
total               69         0       0     0         0        0            0
jobs: 7 written (7 new, 0 stale skipped); docs ready 3, blocked 0, missing 0, below-floor 2, none 2
notification: 3 new matches · top: 94 Example Lever Co — Staff Platform Engineer
pack 900420850a1a, full pack 55a2636155f8, policy 0831f5e6a08b
```

Useful options: `--refresh` fetches every source again even if today's run already did;
`--no-notify` posts no macOS notification; `--offline-fixtures <dir>` answers every request from
recorded files in `<dir>/index.json` and fetches nothing (the repo's `tests/fixtures/e2e` is
one such folder, handy for trying jobpilot without touching the network).

```sh
node --run jobpilot -- run --if-due
```

```
not due: today's run completed
```

If a run stops half-way, `node --run jobpilot -- resume <runId> --db ~/.jobpilot/jobpilot.db` continues it:
finished steps are replayed, not redone.

### Freelance run

```sh
node --run jobpilot -- run-freelance --if-due
```

Reads gig boards and, if connected, your Gmail alerts (section 8) and projects them into the
Freelance tab. Nothing is ever submitted. `sources probe` measures how well each freelance source
is doing; it asks the network, is polite and sequential, and never part of the tests.

```sh
node --run jobpilot -- sources probe
```

### Coverage run (career sites)

```sh
node --run jobpilot -- run-coverage
```

The coverage run is how jobpilot learns which companies it can read directly. It seeds
companies (your picks in `pack/companies.yaml`, lists, and employers of jobs it already saw),
finds each careers page, detects the hiring platform, verifies the company's job board, and
fills the companies registry. The daily run then reads the verified boards.

```
run coverage-2026-10-14 for 2026-10-14 (coverage week 2026-10-11): completed
company picks: 1
candidates: 6 after the merge (pick 1, remoteintech 2, yc 2, jobs 1); 1 dropped as duplicates; ...
located: listed 3, homepage-link 1, none 2
platforms: ashby 1, greenhouse 2, workday 1
verdicts: verified 2, proposed 1, failed 1
...
registry: verified 2, proposed 1, failing 0, failed 1, rejected 0
notification: Coverage: 2 verified (+2 new) · 1 proposed · 0 failing
```

It is long, so it works in **slices of at most 90 minutes** and **yields** to the other runs:
before each step it checks whether the daily or freelance run is owed (now or within five
minutes) and, if so, pauses. A paused slice prints one line and the next start continues the same
run where it stopped:

```
run coverage-2026-10-14 for 2026-10-14 (coverage week 2026-10-11): paused in seed (slice limit); the next run-coverage continues it
```

```
run coverage-2026-10-14 for 2026-10-14 (coverage week 2026-10-11), resumed: completed
```

(That pause came from `--slice-minutes 0.0001`, a checking option; a real pause says
`yielded to daily` or `yielded to freelance` where this says `slice limit`.) Because the
schedule starts it every half hour, a paused run finishes by itself over the next starts. Once a
coverage week's run is complete:

```sh
node --run jobpilot -- run-coverage --if-due
```

```
not due: this coverage week's run completed
```

Only one jobpilot process runs at a time (`~/.jobpilot/jobpilot.lock`). A command that finds the
lock held refuses and names the holder; wait for it to finish. A lock left by a process that is
gone is taken over automatically.

### Coverage probe: what the coverage adds

```sh
node --run jobpilot -- coverage probe
```

```
Coverage probe, 2026-10-14 (reads the DB only; nothing was requested)
Window: first seen 2026-10-08 to 2026-10-14 IST (last 7 days)

Companies by status and platform
  platform    verified  proposed  failing  rejected  failed
  ----------  --------  --------  -------  --------  ------
  workday            1         0        0         0       0
  greenhouse         1         1        0         0       0
  ashby              0         0        0         0       1
  total              2         1        0         0       1
  deferred this week (coverage week of 2026-10-11): 0

New jobs only the platform adapters found (no copy on an existing source), passing = eligible or review with fit >= 60
  none
  Note: "new" counts every job the adapters found in the window, including ones you have since skipped or rejected and ones no longer listed.

Requests today and problems per platform (latest daily run daily-2026-10-14-2)
  workday: 0/1 boards (up to 405 requests per board)
  greenhouse: 1/1 boards
  ...
```

It reads the database only and makes no request. It takes the run lock, so it refuses while a run
is writing. It reports the companies by status and platform, the **new jobs** found only through
the platform adapters (no copy on a watchlist board, a feed or a company page) and how many pass
your rules (eligible, or review with a fit at or above your `minFit`), and per platform today's
requests against the budget and the latest daily run's problems and skips with their reasons
(`robots-disallow`, `host-disabled`, `listing-cap`, `scope-not-applied`, ...). `--days N`
(1 to 90, default 7) sets the window by first seen; `--json` prints a stable, versioned shape for
other tools. This number decides whether a platform earns its place.

## 4. The schedule (macOS launchd)

```sh
node --run jobpilot -- schedule install
node --run jobpilot -- schedule status
node --run jobpilot -- schedule run-now
node --run jobpilot -- schedule uninstall
```

`install` writes four launchd jobs to `~/Library/LaunchAgents/` and loads them; repeating it is
safe. Each run job is started at login and every half hour and uses `--if-due`, so a Mac that was
asleep at 07:00 runs soon after it wakes.

| Job | What | When |
|---|---|---|
| `com.jobpilot.daily` | `run --if-due` | from 07:00 IST |
| `com.jobpilot.freelance` | `run-freelance --if-due` | from 07:30 and 19:30 IST |
| `com.jobpilot.coverage` | `run-coverage --if-due` | weekly, from Sunday 06:00 IST through Saturday; sliced, and yields to the daily and freelance runs |
| `com.jobpilot.dashboard` | `serve` | always on, restarts if it stops |

```
com.jobpilot.daily: loaded, state not running, last exit code 0
  plist ~/Library/LaunchAgents/com.jobpilot.daily.plist
  log   ~/.jobpilot/logs/daily.log
...
com.jobpilot.dashboard: loaded, state running, last exit code none yet
  plist ~/Library/LaunchAgents/com.jobpilot.dashboard.plist
  log   ~/.jobpilot/logs/dashboard.log
today's daily run: today's run completed
freelance run, am window: owed: the am window's run has not run
coverage run, week of 2026-10-11: this coverage week's run completed
```

`schedule run-now` starts the daily job through launchd (a manual test of the scheduled command);
add `--freelance` or `--coverage` for the others. It runs only if that run is owed. If your Mac
is set to another time zone, `install` converts the IST times to your clock and prints them; run
`install` again after changing zone or Node versions (the jobs use the Node that was running at
install).

## 5. The dashboard

```sh
node --run jobpilot -- serve
```

```
jobpilot dashboard on http://127.0.0.1:4317/ (Ctrl-C to stop)
```

(`--port <n>` picks another port; the output above was on a scratch port.) It listens on this
machine only. With the schedule installed it is already running. Tabs:

- **Jobs**: today's jobs, comp-first, each with its documents, notes and status (mark a job
  applied here; jobpilot never applies for you).
- **Freelance**: gigs, their proposals and source health.
- **Companies**: see below.
- **Your facts**: every fact and its status; verify or reject here.
- **Runs**: what each run did and what went wrong.

### The Companies tab

The companies whose own career sites jobpilot reads. The tab shows counts (Verified, Proposed,
Failing, Rejected, your picks not yet verified, Deferred this week) and the lists:

- **Proposed**: found, but a check did not pass, so nothing is read until you decide. The
  reasons say what did not match (for example `board name 'Betacorp Holdings' ≈ 'Beta Labs',
  please confirm`).
- **Verified**: read by the daily run.
- Failing, Rejected and deferred lists.

Buttons:

- **Approve**: read this company daily (a proposed or rejected company that has a board becomes
  verified from the next daily run).
- **Reject**: stop reading it; coverage never brings it back.
- **Undo approve / Undo reject**: clears your choice, so the status goes back to what coverage
  last decided (undoing a reject puts it back in Proposed).
- **Resolve now**: runs the locate, detect and verify steps for that one company immediately,
  instead of waiting for the weekly run. It takes the run lock without waiting and yields to an
  owed daily or freelance run; if it cannot, it says so and the weekly run asks again.
- **Add a company**: a website (https, a real company domain, not a job board) and an optional
  name. It is added as a proposed pick and resolves on the next coverage run, or at once with
  Resolve now. A limited number of added companies can wait at once, and a company already in
  the list is refused with a message.

You can also add companies as picks in `~/.jobpilot/pack/companies.yaml`:

```yaml
companies:
  - {name: Alpha Robotics, website: 'https://alpha.test', careersUrl: 'https://alpha.test/careers'}
```

Run `pack check`, then `run-coverage`. Your choices (approve, reject, picks) are stored in the
database and survive coverage runs. To watch a Greenhouse, Lever or Ashby board directly, or a
careers page, list it in `pack/watchlist.yaml`.

## 6. Facts and applying

```sh
node --run jobpilot -- facts list
node --run jobpilot -- facts verify <id>
node --run jobpilot -- facts reject <id>
```

```
f-nw-01  verified                        experience  Led the design of an event-driven order pipeline on Kafka handling 40M events a day.
f-nw-04  user-stated                     experience  Mentored four engineers and ran the weekly design review for the platform group.
f-nw-05  derived-unverified              experience  Reduced AWS spend by roughly 30 percent through right-sizing and spot capacity.
```

These are overrides stored in the database; the pack files are never edited. Only verified facts
are used in documents. Applying is manual: download the documents from the job page, apply on
the employer's own site, then mark the job applied.

```sh
node --run jobpilot -- docs rebuild
```

```
run rebuild-2026-10-14 for 2026-10-14 (experience as of 2026-10), rebuilt from daily-2026-10-14-2: completed
agent     done  replayed  failed  gone  rejected  skipped  quarantined
qa-gate      3         3       0     0         0        0            0
renderer     3         0       0     0         0        0            0
total        6         3       0     0         0        0            0
```

`docs rebuild` re-renders the latest run's documents from stored plans; nothing is fetched.

If you move from an earlier tool, `node --run jobpilot -- migrate desk <dir>` imports its
application history once.

## 7. Networks (freelance applications)

```sh
node --run jobpilot -- networks list
node --run jobpilot -- networks pack arc
```

```
arc  Arc  not checked by you  4 stages
braintrust  Braintrust  not checked by you  4 stages
...
arc: wrote out/networks/arc/ (resume 1 page; headline 23/120, summary 110/1000; 3 missing keywords)
```

`networks pack` writes a resume, a profile text and a checklist per network, only from verified
facts. Nothing is submitted.

## 8. Gmail alerts

```sh
node --run jobpilot -- gmail connect
node --run jobpilot -- gmail status
node --run jobpilot -- gmail disconnect
```

```
connected: no (run jobpilot gmail connect)
label: jobpilot/gigs (messages from the last 3 days, read-only)
client in the Keychain: no
client JSON on disk: none
alert parsers: none yet - send one alert email per sender to enable
```

jobpilot reads one label, `jobpilot/gigs`, with the read-only scope. `connect` opens your browser
once and keeps the client and refresh token in the macOS Keychain; `disconnect` deletes them. The
README describes the one-time Google setup.

## 9. Backups and rolling back a migration

Everything jobpilot stores is in one SQLite file, `~/.jobpilot/jobpilot.db`. Back it up with
SQLite's own `.backup`, which gives a consistent copy even while jobpilot is open:

```sh
sqlite3 ~/.jobpilot/jobpilot.db ".backup '$HOME/jobpilot-backup-$(date +%F).db'"
chmod 600 "$HOME/jobpilot-backup-$(date +%F).db"
sqlite3 "$HOME/jobpilot-backup-$(date +%F).db" "PRAGMA integrity_check;"
```

```
ok
```

(`.backup` creates a file readable by others, so the `chmod` matters.) Also back up the pack
folder, which holds your facts: `cp -r ~/.jobpilot/pack ~/jobpilot-pack-backup`.

To check that the event history has not been altered:

```sh
node --run jobpilot -- audit verify --db ~/.jobpilot/jobpilot.db
```

```
audit chain intact: 187 events
head ef9e83ab0fa34117a1e79a7c465724e1040130371e2a847e31bb1c63ba274dfd (187 events)
```

### Migrations are one-way

Opening the database with a newer jobpilot upgrades its tables in place, and a newer database
is refused by an older jobpilot (`app schema version N is newer than this jobpilot`). There is no
down-migration. To roll back, restore the backup you took before upgrading:

```sh
node --run jobpilot -- schedule uninstall
cp ~/jobpilot-backup-2026-10-14.db ~/.jobpilot/jobpilot.db
rm -f ~/.jobpilot/jobpilot.db-wal ~/.jobpilot/jobpilot.db-shm
chmod 600 ~/.jobpilot/jobpilot.db
git checkout <the older version>
```

Then reinstall the schedule from that version. Anything stored after the backup (new jobs,
status changes) is lost, which is why the backup comes first.

## 10. Logs and troubleshooting

Logs are in `~/.jobpilot/logs/` (`daily.log`, `freelance.log`, `coverage.log`, `dashboard.log`),
readable only by you:

```sh
tail -f ~/.jobpilot/logs/daily.log
```

- `schedule status` shows whether each job is loaded and its last exit code. "not loaded" means
  run `schedule install`.
- A command that says another jobpilot process holds the lock: wait, or, if nothing is running,
  delete the `jobpilot.lock` file it names.
- `quarantined` lists steps a guardrail held back; `release <stepKey>` lets the next run execute
  one again. Both take `--db <path>` (default `jobpilot.db` in the current folder), so pass
  `--db ~/.jobpilot/jobpilot.db`.

  ```
  no quarantined steps
  ```

- Sources look stale: `run --refresh`. Documents look wrong: `docs rebuild`.
- Dashboard will not open: read `dashboard.log`; port 4317 may be in use.

## 11. Upgrading

Migrations are one-way, so the order matters:

1. Back up the database (section 9).
2. Update the code (`git pull`, then `pnpm install`).
3. Check: `node --run verify` (optional, for the repo), then `node --run jobpilot -- pack check`.
4. Open the database once with the new version so it migrates: any command does it, for example
   `node --run jobpilot -- coverage probe`.
5. Run `node --run jobpilot -- schedule install` so launchd points at the new code and Node.
