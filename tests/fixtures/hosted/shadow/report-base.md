# jobpilot side-by-side report: 2026-11-02 to 2026-11-08

Comparable days: 7 of 7. Code differs on: none.

## Per day and source (daily)

| Date | Source | Mac | Hosted | Both | Mac only | Hosted only | Recall | Problems (Mac / hosted) |
|---|---|---|---|---|---|---|---|---|
| 2026-11-02 | greenhouse | 10 | 10 | 10 | 0 | 0 | 1.000 | none / none |
| 2026-11-02 | himalayas | 6 | 4 | 4 | 2 | 0 | 0.667 | none / challenged |
| 2026-11-02 | lever | 2 | 0 | 0 | 2 | 0 | 0.000 | none / none |
| 2026-11-03 | greenhouse | 10 | 10 | 10 | 0 | 0 | 1.000 | none / none |
| 2026-11-03 | himalayas | 6 | 4 | 4 | 2 | 0 | 0.667 | none / challenged |
| 2026-11-03 | lever | 2 | 0 | 0 | 2 | 0 | 0.000 | none / none |
| 2026-11-04 | greenhouse | 10 | 10 | 10 | 0 | 0 | 1.000 | none / none |
| 2026-11-04 | himalayas | 6 | 4 | 4 | 2 | 0 | 0.667 | none / challenged |
| 2026-11-04 | lever | 2 | 0 | 0 | 2 | 0 | 0.000 | none / none |
| 2026-11-05 | greenhouse | 10 | 10 | 10 | 0 | 0 | 1.000 | none / none |
| 2026-11-05 | himalayas | 6 | 4 | 4 | 2 | 0 | 0.667 | none / challenged |
| 2026-11-05 | lever | 2 | 0 | 0 | 2 | 0 | 0.000 | none / none |
| 2026-11-06 | greenhouse | 10 | 10 | 10 | 0 | 0 | 1.000 | none / none |
| 2026-11-06 | himalayas | 6 | 4 | 4 | 2 | 0 | 0.667 | none / challenged |
| 2026-11-06 | lever | 2 | 0 | 0 | 2 | 0 | 0.000 | none / none |
| 2026-11-07 | greenhouse | 10 | 10 | 10 | 0 | 0 | 1.000 | none / none |
| 2026-11-07 | himalayas | 6 | 4 | 4 | 2 | 0 | 0.667 | none / challenged |
| 2026-11-07 | lever | 2 | 0 | 0 | 2 | 0 | 0.000 | none / none |
| 2026-11-08 | greenhouse | 10 | 10 | 10 | 0 | 0 | 1.000 | none / none |
| 2026-11-08 | himalayas | 6 | 4 | 3 | 3 | 1 | 0.500 | none / challenged |
| 2026-11-08 | lever | 2 | 0 | 0 | 2 | 0 | 0.000 | none / none |

## Recall per day

| Date | Eligible | To decide | Gigs (am) |
|---|---|---|---|
| 2026-11-02 | 1.000 (5 of 5) | 1.000 (5 of 5) | 1.000 (4 of 4) |
| 2026-11-03 | 1.000 (5 of 5) | 1.000 (5 of 5) | 1.000 (4 of 4) |
| 2026-11-04 | 1.000 (5 of 5) | 1.000 (5 of 5) | 1.000 (4 of 4) |
| 2026-11-05 | 1.000 (5 of 5) | 1.000 (5 of 5) | 1.000 (4 of 4) |
| 2026-11-06 | 1.000 (5 of 5) | 1.000 (5 of 5) | 1.000 (4 of 4) |
| 2026-11-07 | 1.000 (5 of 5) | 1.000 (5 of 5) | 1.000 (4 of 4) |
| 2026-11-08 | 0.800 (4 of 5) | 0.800 (4 of 5) | 1.000 (4 of 4) |

## Minutes

| Date | Billed minutes | Committed (IST) |
|---|---|---|
| 2026-11-02 | 44 | 08:30 |
| 2026-11-03 | 45 | 08:30 |
| 2026-11-04 | 46 | 10:20 |
| 2026-11-05 | 47 | 08:30 |
| 2026-11-06 | 48 | 08:30 |
| 2026-11-07 | 50 | 08:30 |
| 2026-11-08 | 52 | 08:30 |

## Criteria

| # | Criterion | Result | Numbers |
|---|---|---|---|
| C1 | Hosted daily+freelance committed state | PASS | 7 of 7 days; 6 of 7 by 10:00 IST |
| C2 | Eligible recall | PASS | ≥ 0.95 on 6 of 7 days; week 0.971 |
| C3 | Per-source volume (Mac mean ≥ 5/day) | FAIL | himalayas 0.667; failing sources held 20.0% of Mac eligible (limit 3.0%) |
| C4 | Gig recall (am) | PASS | week 1.000 |
| C5 | Projected minutes | PASS | 31 × (52 + 1) = 1,643 (limit 1,750) |
| C6 | Privacy | PASS | 0 log-audit hits, 0 non-template lines; snapshot leak scan not evaluated (H3) |
| C7 | State | PASS | 7 of 7 generations verified |
| C8 | Triage | NOT EVALUATED | needs H4 |

Overall: FAIL (C3). Proposed skipSources: himalayas
