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
  --floor-inr 1200000
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
