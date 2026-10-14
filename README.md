# jobpilot

A local job-search pipeline that runs by itself every morning. It fetches remote jobs open to
candidates in India, filters and scores them with fixed rules, and builds a resume and cover
letter for each job worth a look. Everything is shown on a dashboard on your own machine.

There is no language model anywhere in it. Given the same inputs it produces the same outputs.

## What it does

1. Reads the public job boards and company career pages you listed (never LinkedIn).
2. Drops jobs you cannot take (location, pay floor, seniority) and scores the rest.
3. For each kept job, picks facts from your pack and writes a resume and cover letter.
4. Saves the results and posts one macOS notification.
5. Serves the results at http://127.0.0.1:4317.

## One-time setup

Needs macOS, Node 24 or newer, and `pdftotext` (`brew install poppler`).

```sh
pnpm install
```

Build your pack once. The pack is your facts, contact details, answers and watchlist; it lives
in `~/.jobpilot/pack/` (set `JOBPILOT_HOME` to use another folder). Nothing personal is ever
stored in this repo.

```sh
node --run jobpilot -- pack import \
  --career-ops ~/career-ops \
  --resume-text ~/resume-experience.txt \
  --desk ~/desk-export \
  --forbid "Example Client Ltd" \
  --name "Your Name" --email you@example.com --phone "+91 00000 00000" --city "Pune" \
  --link https://www.linkedin.com/in/your-profile \
  --as-of 2026-10 \
  --available-from "1 November 2026" --notice-period "30 days" \
  --floor-inr 1234567
```


What the flags mean:

| Flag | Meaning |
|---|---|
| `--career-ops <dir>` | Your career-ops repo; its `profile/facts.yaml` supplies the facts |
| `--resume-text <file>` | Your experience as text, one header per role: `Title \| Employer \| City, Country \| Mon YYYY - Mon YYYY` |
| `--desk <dir>` | Your Application Desk export (`settings/answers.json`, `jobs/*.json`) |
| `--forbid <term>` | A name that must never appear anywhere, such as your current client. Repeat it for more. At least one is required, and the import writes nothing if the term shows up in the input |
| `--employer-display raw=display` | Show an employer under a different name |
| `--name --email --phone --city --link` | Contact details printed on documents (`--link` repeats) |
| `--as-of YYYY-MM` | The month your experience is counted to. Daily runs use the current month |
| `--available-from`, `--notice-period` | Standard application answers |
| `--floor-inr <amount>` | Minimum base salary per year in INR. Equity, bonus and total comp never count |
| `--education-text`, `--claimable-title`, `--extra-watchlist`, `--fx-file` | Optional extras |
| `--allow-unplaced` | Go ahead even when citeable facts sit under an employer that no resume role names (normally an error) |
| `--dry-run` | Check every input and print the summary without writing anything |
| `--force` | Replace an existing pack (the old one is moved to `pack.bak-<time>`) |

Then:

```sh
node --run jobpilot -- pack check          # validates the pack as today's run would load it
node --run jobpilot -- migrate desk ~/desk-export   # brings in your earlier application history
node --run jobpilot -- schedule install    # starts the daily run and the dashboard
```

`schedule install` writes two launchd jobs to `~/Library/LaunchAgents/`:

- `com.jobpilot.daily` runs `jobpilot run` at 07:00 India time. If your Mac is set to another
  time zone, the install converts 07:00 IST to your Mac's local clock and prints it, together
  with the next run time. (launchd uses the Mac's clock; if you travel or change zone, run
  `schedule install` again.) The Mac must be awake or it runs when it wakes.
- `com.jobpilot.dashboard` serves the dashboard all the time and restarts if it stops.

It refuses to install with a Node older than 24. To remove everything: `schedule uninstall`.
To test the daily job without waiting for 07:00: `schedule run-now`.

## The daily flow

At 07:00 the run fetches sources, filters, scores, builds documents and posts a notification
that says how many new jobs are worth a look. Open the dashboard and work from the top.
Running again the same day replays the stored results; add `--refresh` to fetch again.

## Opening the dashboard

Go to http://127.0.0.1:4317. It listens on this machine only. Pages: today's jobs, each job
with its documents and notes, Facts, and Runs (what each run did and what went wrong).

## Verifying facts

Resume lines come only from facts in your pack, and only verified facts are used. Review them:

```sh
node --run jobpilot -- facts list
node --run jobpilot -- facts verify <id>
node --run jobpilot -- facts reject <id>
```

These are overrides stored in the app database; your pack files are never edited. The next
run picks them up.

## Applying

Applying is manual. Open the job, download the resume and cover letter, apply on the
employer's own site, then mark the job applied on the dashboard. The documents you actually
sent are kept as they were, even if you rebuild documents later. jobpilot never submits an
application for you.

## Gmail alerts (freelance)

The freelance run can read the job-alert emails platforms send you. It reads **one label**,
`jobpilot/gigs`, with the `gmail.readonly` scope. It never changes, moves, deletes, sends or
marks mail read.

Connect once:

1. In Google Cloud, enable the Gmail API, then create an OAuth client of type **Desktop app**.
   Download its JSON and save it as `~/.jobpilot/secrets/google-oauth-client.json`
   (`chmod 600`).
2. In Gmail, add filters that apply the label `jobpilot/gigs` to each platform's alerts.
3. Run `node --run jobpilot -- gmail connect`. Your browser opens Google's consent page. Allow
   read-only access; the tab then says "You can close this tab". The client and the refresh
   token go into the macOS Keychain (service `jobpilot`), and nothing is printed or written
   anywhere else. Then it asks whether to delete the JSON (the default is to keep it).
   The browser is opened with `open <url>`, so for a moment that URL is visible to `ps` on this
   Mac. It carries the client id, the `state` and the PKCE `code_challenge`, never the client
   secret or a token. The challenge is useless without the verifier, which stays in memory, and
   the state is used once.

`gmail status` shows whether Gmail is connected (never the token), and `gmail disconnect`
deletes the Keychain items. Until you connect, the Sources tab shows Gmail as "not connected -
run jobpilot gmail connect", and the run carries on without it. If the Keychain cannot be read,
the run warns "Keychain could not be read (security exit N); Gmail skipped" and the other
sources still run.

Each run looks the label up by its exact name. If there is no label named `jobpilot/gigs`, the
run warns "label jobpilot/gigs not found in Gmail - create it and a filter" rather than
reporting zero alerts.

### Alert parsers: one per sender, built from a real sample

A parser is chosen by the sender's address and a layout fingerprint (a stable heading or
footer from the sample email). An email nothing recognises is set aside whole and never half
read. The run lists one problem per sender domain: `N unrecognised alerts from <domain> - save
one as .eml in ~/.jobpilot/secrets/alert-samples/`. A run in which nothing could be parsed does
not count against Gmail's source health, so Gmail never "looks dead" just because it has no
parser yet.

This build has **no parsers yet**. To add one: drop the .eml in
`~/.jobpilot/secrets/alert-samples/`; a parser is built and tested from it, with the user's own
details redacted. In practice:

1. In Gmail, open one alert and use "Download message" to get the `.eml`.
2. Copy it into the fixtures as `tests/fixtures/freelance/gmail/<sender>.eml`, with your own
   name, email and phone replaced by the fixture pack's (Asha Rao). Run the forbidden-terms
   test on it.
3. Write `src/app/freelance/mail/parsers/<sender>.ts` (the `AlertParser` shape in
   `parsers/index.ts`: the exact sender, the fingerprint, and a `parse` that throws on anything
   it does not recognise). Then add it to `ALERT_PARSERS`. A `From` address can be spoofed, so
   every parser **must refuse a job whose URL host is not the platform's own domain**. It
   **should also check** that the message's `Authentication-Results` header shows a DKIM pass
   for that domain (once the real sample shows the header).
4. Add a test where the sample parses to its expected jobs and an altered fingerprint is set
   aside, then run `node --run verify`.

## Running jobpilot on your own

Everything is a command, and no assistant, account or API key is needed: there is no AI in it,
and the same inputs give the same outputs. (Claude Code was only the tool the project was built
with. The kernel has an unused `LlmProvider` slot where an optional, local-model-friendly step
could plug in later.) The full guide, with the real output of each command, is in
[docs/operations.md](docs/operations.md). The short version:

```sh
node --run jobpilot -- --help                      # every command; each takes --help too
node --run jobpilot -- pack check                  # validate your pack
node --run jobpilot -- run                         # the daily run (add --if-due to run only when owed)
node --run jobpilot -- run-freelance --if-due      # the freelance run
node --run jobpilot -- run-coverage --if-due       # the weekly career-site coverage run
node --run jobpilot -- coverage probe              # what the coverage adds: companies, new jobs, requests, problems
node --run jobpilot -- sources probe               # live measurement of the freelance sources
node --run jobpilot -- schedule install            # daily 07:00 IST, freelance 07:30 and 19:30, coverage Sunday 06:00, dashboard
node --run jobpilot -- schedule status
node --run jobpilot -- serve                       # the dashboard on http://127.0.0.1:4317
node --run jobpilot -- networks pack arc           # application pack for one freelance network
node --run jobpilot -- gmail status
node --run jobpilot -- audit verify --db ~/.jobpilot/jobpilot.db
```

- **Coverage** is sliced (at most 90 minutes) and yields to the daily and freelance runs; the next
  start continues the same run.
- **Companies tab** on the dashboard: approve, reject, undo, add a company, or resolve one now.
- **Backups:** `sqlite3 ~/.jobpilot/jobpilot.db ".backup 'backup.db'"`. Migrations are one-way;
  to roll back, restore the backup taken before upgrading (guide, section 9).
- **Logs:** `~/.jobpilot/logs/`.

## Guarantees

- **No language model.** Every step is plain code with fixed rules.
- **Every resume line is a verified fact.** A line that cannot be traced to a verified fact in
  your pack is not written.
- **The client is never named.** Anything on your forbidden list is checked on import, on
  every run, and in every document.
- **Read-only browsing.** Public pages only; it never logs in, posts or submits anything, and
  never touches LinkedIn.
- **No evasion.** An honest user agent (`jobpilot/0.1 (+local)`), the sites' own rules and
  polite pacing. If a site refuses, jobpilot skips it.

## Troubleshooting

- **Logs:** `~/.jobpilot/logs/daily.log` and `dashboard.log` (readable only by you).
  `tail -f ~/.jobpilot/logs/daily.log`.
- **Is it installed and healthy?** `node --run jobpilot -- schedule status` shows each job's
  state, last exit code, plist path and log path. "not loaded" means run `schedule install`.
- **Documents look wrong or are missing:** `node --run jobpilot -- docs rebuild` re-renders
  the latest run's documents from stored plans. Nothing is fetched.
- **Sources look stale:** `node --run jobpilot -- run --refresh` fetches everything again.
- **Dashboard will not open:** check `dashboard.log`; port 4317 may be in use (`serve --port <n>`
  for a manual run).
- **Exit codes of `run`:** `0` clean. `1` some step failed or was held back (the summary lists
  the problems; the rest of the run is still saved). `2` the run could not start at all, for
  example a missing or invalid pack or another run in progress.
- **Wrong Node:** the launchd job uses the Node binary that was running when you ran
  `schedule install`. If you upgrade Node, run `schedule install` again.

## Development

```sh
node --run test        # unit and end-to-end tests
node --run typecheck
node --run verify      # typecheck, tests, contract drift check, evals
```

Use `node --run`, not `pnpm <script>`. Tests use the fictional fixture pack in
`tests/fixtures/pack/`.
