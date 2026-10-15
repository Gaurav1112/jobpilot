# jobpilot dashboard UX upgrade

Status: designed with the user on 2026-10-15.

**How it was designed:**
- An 11-expert panel reviewed the dashboard: UX research, information architecture, interaction design, visual design, design system, accessibility, mobile, content, dashboard/data visualisation, frontend engineering, and a recruiter/job-search coach.
- A lead combined their findings, and a completeness critic checked the result.
- The user then chose between visual options in mockups.

This spec is the source of truth. Section D holds the panel's detailed design. Where D conflicts with sections 1–2, sections 1–2 win.

Builds on: the architecture, v1, freelance, career-sites and profiles specs. The profiles spec (`2026-10-14-jobpilot-profiles-design.md`) is coordinated in §5.

## 1. Decisions (user, 2026-10-15)

| # | Decision |
|---|---|
| U1 | **Today is the home page at `/`.** The Jobs list moves to `/jobs`. Old URLs (`/?status=…`) redirect with a 302 to `/jobs?…`. |
| U2 | **Today uses the Cockpit layout.** On desktop, "Decide today" fills the main column, with Follow-ups, Freelance highlights and Health in a side rail. Below 64 rem it stacks into one column. |
| U3 | **The job page gets a side apply kit.** It opens with a decision summary: fit tier and score, must-haves met N/M, why, what's missing, and "Can I apply?". Beside it, a numbered apply checklist stays visible as you scroll: Open posting → resume → cover letter (PDF, DOCX, Copy text) → screening answers (Copy) → Mark applied with a follow-up date. On a phone the checklist becomes a bottom bar ("Open posting" · "Mark applied"). Gig and contract pages use the same layout. |
| U4 | **List rows are balanced rows.** Each item is one line: a coloured left edge shows the fit tier, followed by the score and tier word. Actions sit on the right, with at most one exception pill per row. About 8–9 items fit on a desktop screen. On a phone, rows become cards with 44 px buttons. |
| U5 | **Fix the scorer.** Skills in `terms.missing` score 0 and show "(not in your facts)". "Must-haves met N/M" appears above the score. Tier cut points are **Strong ≥ 80, Good 70–79, Fair 63–69, Weak < 63**, and the scale is stated on screen. Rankings reorder once; the run strip announces it. |
| U6 | **Pay shows ₹ LPA/Cr first.** The posted range is shown muted, plus "listed range, not an India offer" for worldwide-remote roles. Numbers use en-IN grouping. |
| U7 | **Row actions are Shortlist and Not for me, both with Undo.** Mark applied appears only in the apply kit, because it snapshots the documents sent. Nothing is ever submitted automatically. |
| U8 | **Contract and B2B roles live in Freelance › Contract roles.** Jobs shows a "Contract" pill linking there, and Applications combines both. |
| U9 | **Follow-ups and "To decide".** A follow-up is due 5 days after applying, editable per item: `due = next_followup ?? applied_at + 5d`, in IST dates. "To decide" means untriaged items that are eligible or check-first, first seen in the last **7 days**; older untriaged items go to All. This is ONE predicate in one place, used by Today, Jobs and the nav counts. |
| U10 | **Navigation.** Work tabs: Today · Jobs · Freelance · Applications. Secondary: Profile · System. On a phone, a bottom bar with 4 tabs (Today · Jobs · Freelance · Apps), with Profile and System under "More". |

## 2. Amendments to the panel design (from the critic and the user; these win over section D)

1. **Safety net comes before any visual change (A0).** These land first, before any markup changes:
   - golden HTML snapshots, replacing the brittle `toContain` tests;
   - perf gates on every route (Review, Companies, Facts, and job and gig pages);
   - a 400 px no-horizontal-scroll check on every page;
   - browser suites that fail instead of skipping.
2. **Perf "fresh" means a cold process with a warm OS cache.** Prepared statements are warmed at startup, so the first request after a run still meets 150 ms. Companies' skipped hosts move to a paged sub-route (`/system/sources/skipped?page=`), not a collapsed `<details>`.
3. **Truthful without JS.**
   - Collapsible sections render closed everywhere, and a collapsed preview iframe still loads on a phone.
   - Mark applied is idempotent on the server: a second POST creates no second snapshot or history row.
4. **Forms.**
   - Bulk triage (Phase C) uses `form="bulk"` attributes and never nests forms.
   - Row actions sit above the stretched row link (`position:relative; z-index:1`), with a test that clicks each control.
5. **Previews show exactly what the employer receives.**
   - The PDF and DOCX carry no preview-only markers, and a test asserts it.
   - Previews stay white in dark mode.
   - An "Open full preview ↗" link avoids nested scrolling.
   - The blank cover-letter iframe at 400 px is investigated and fixed in A2.
6. **Colour rules.** Fit tiers use neutral and accent weights plus the U4 coloured edge, not "good" green. Green is kept for outcomes and passing checks.
7. **Keyboard shortcuts (Phase C)** are off by default, can be switched off or remapped (WCAG 2.1.4), and are stored per profile.
8. **Undo.**
   - Undo restores the previous status. It is offered for Shortlist and Not for me.
   - "Undo" on Mark applied returns the status but keeps the document snapshot, marked "withdrawn".
   - Undo tokens are bound to CSRF and the profile, and expire after 10 minutes.
9. **Pagination** uses a keyset on (tier, fit, pay, first_seen, key), so items that are triaged out of the list never cause skipped rows. After a triage action, the redirect goes to the **next** row's anchor.
10. **Eligibility and reason text** is mapped from codes at render time in `copy.ts`, so rows stored before this change read correctly too.
11. **The cover letter can be copied as text:** the apply kit offers Copy and a .txt download, as for answers and pitches.
12. **Daily-workflow additions:**
    - "You applied to <company> N days ago" in the decision summary and on rows;
    - a "run in progress" state on Today, reporting both the jobs and the freelance run;
    - "Open posting ↗" on shortlisted rows that have documents ready;
    - a gig "bid placed" note, and a freshness cutoff of 30 days;
    - the last list view and filters remembered per profile (a no-JS cookie);
    - "Rebuilt in the next run" shown when a confirmed fact change makes documents stale.
13. **Mobile chrome budget.** The header plus at most one sticky bar (top or bottom) at a time, taking at most 25 % of an 860 px viewport. Short tab labels ("Apps"). A 400 px screenshot assertion.
14. **Freshness.** "Posted N d ago" when the posting date is known, otherwise "First seen N d ago". Items are muted after 14 days and labelled "may be stale" after 30 days.
15. **Setup redirect on upgrade (P3).** The existing profile is marked as set up during the migration, so the new setup redirect never locks out the current user.
16. **Number and date format.** en-IN grouping, ₹ in LPA/Cr, dates in IST.

## 3. Constraints (binding)

- Server-rendered HTML; no SPA and no new build step.
- **No external assets** (CSP); system fonts only.
- CSRF on every POST; everything escaped.
- 127.0.0.1 only.
- **Every page under 150 ms**, enforced by the perf gate.
- Works at 400 px.
- Works without JS: htmx and app.js only enhance.
- Deterministic, with no LLM.
- Never auto-submits.
- WCAG 2.2 AA.
- The daily-run byte-identity golden is unchanged by UI work. The only exception is the deliberate scorer change (U5), done as its own reviewed step with the golden regenerated on purpose.

## 4. Delivery

The work runs in three phases, as in section D9 with the amendments above:
- **Phase A:** quick wins plus the safety net, 1–2 days.
- **Phase B:** the core redesign, about 2–3 weeks, with one reviewed PR per surface.
- **Phase C:** polish and growth.

Order inside Phase B:
1. the scorer fix (U5);
2. tokens and components;
3. the shell and navigation;
4. Today;
5. the Jobs list;
6. the job, gig and contract apply kit;
7. the Applications tracker;
8. Freelance on the shared rows;
9. the content pass;
10. System and Profile;
11. the accessibility matrix.

## 5. Coordination with other work

- **Freelance v2** (the Contract roles section, Networks, gig cover letters) merges **before** this work, so Freelance is redesigned only once, on top of it.
- **Profiles P1** (the profile switcher, `/p/<id>/` routes): the B3 shell reserves the switcher slot and the route prefix, and P1's dashboard tasks use the new shell. Whichever lands second rebases onto the first; neither duplicates the other's work.
- **Sleep-safe and freelance-boost** merge first, tonight.

---

# D. Detailed design (expert panel, amended by sections 1–2)

## D1. The core problems

All 11 experts found the same few root causes. Each is listed once below.

| # | Problem | Evidence (live and code) | Raised by | Severity |
|---|---|---|---|---|
| P1 | **No home and no daily loop.** `/` is a 100-row list (Page 1 of 5) that is 10,013 px tall at 1440 and 20,554 px at 400. Nothing answers "what do I do today?", and there is no "you're done" state. | `server.ts:350`, `layout.ts:42-43`, `PAGE_SIZE=100` | E1, E2, E9, E11 | Critical |
| P2 | **"New" means nothing.** The badge is driven by a visit cookie, so "430 shown, 430 new" and the badge appears on every row. No list action records "I've seen this", so triage starts from scratch each day. | `server.ts:378-385`, `jobs.ts:71` | E1, E2, E3, E4, E8, E9, E11 | Critical |
| P3 | **Finished items never leave the list.** "Not for me" and "Applied" jobs sit beside untouched ones (7 and 3 on page 1). | `server.ts:354` (no default status filter) | E1, E3 | High |
| P4 | **Pay outranks fit, and you can't change the sort.** A fit-64 "Senior CX Platform Engineer" is rank 1. Fit-84 and fit-88 backend roles rank lower. The pay is a USD worldwide band, which is misleading for an India hire. | `jobs.ts:98`, `app-store.ts:940` | E1, E2, E3, E4, E9, E11 | High |
| P5 | **The fit score can't be read and can't be trusted.** It is a bare number with no scale; about 59% of rows score 60–62. On the same page, "Core skill: Distributed Systems +4" is also listed under Missing. | `jobs.ts:69`, `job.ts:63-65,100`, `copy.ts:95` | E8, E9, E11, E6, E4 | Critical |
| P6 | **The job page is ordered as a report, not as the apply sequence.** The status buttons start 1,498 px down at 1440 and 2,285 px down at 400, below two iframes 34 rem and 28 rem tall. Screening answers are 7th of 8 sections. "Open the posting" is a secondary button while both Downloads are primary. Eligibility ("can I apply?") is 4th. | `job.ts:203-217`, `app.css:232-236` | E1, E2, E3, E4, E7, E9, E10, E11 | Critical |
| P7 | **No tracker and no follow-up.** Seeing what you've applied to means ticking 4 status boxes. Nothing shows "applied 33 days ago". Jobs, gigs and networks use three different status vocabularies. | `common.ts:16-24`, `freelance.ts:23,30` | E1, E2, E8, E11 | High |
| P8 | **List rows have no actions and are noisy.** Each row is about 100 px tall on desktop and 205–247 px at 400. There are 427 pills on 100 rows, 4.3 per row. Green marks routine states, so it means nothing. The order is pay, then bare score, then title. | `jobs.ts:66-81`, `common.ts:41,47`, `app.css:178` | E3, E4, E5, E7, E9, E11 | High |
| P9 | **Freelance opens on an empty tab, and the empty-state message is false.** It shows "Contracts 0 … The next run fills this list" after a 09:30 run that filtered out 75 roles. Review holds 354 unpaginated gigs: 520 KB, about 9,944 nodes, 82,444 px tall at 400, and 110–373 ms, against a 150 ms budget the perf gate never tests. | `freelance.ts:19,120,207`, `budget.perf.ts` | All 11 | High |
| P10 | **Boilerplate drowns the signal on gig rows.** "rate unknown - verify" appears 167 times, "hours not stated - verify" 156 times, and "IST overlap: not stated (your window…)" on every row. Bid count, the real competition signal, sits at the end. Gigs older than 1,000 days still show. | `freelance.ts:77,86,90,92` | E1, E4, E8, E9, E11 | Medium |
| P11 | **Admin pages put noise first.** Companies shows three empty cards, then 781 deferred hosts in full. Its jump links are in a different order from its sections and look like real tabs. Facts lists pending items last and leads each card with a machine slug. Runs leads with an audit paragraph and a table that is mostly zeros, and never links a problem to the jobs it affected. | `companies.ts:198-215`, `facts.ts:40-50,75`, `runs.ts` | E1, E2, E3, E4, E8, E9, E11 | Medium |
| P12 | **The words come from the pipeline, not the user.** Examples: "floor" (7 forms), "Pay band" (which mixes pay, eligibility and needs-review), "Needs a look", "Deferred", "Proposed", "Replayed", "Quarantined". Raw reason codes appear on screen, including "onsite onsite" and a regex `role:\bproduct manager\b`. File and CLI names show up too (`answers.yaml`, `jobpilot docs rebuild`). There is a grammar bug ("systems reads") and a dangling separator ("GitLab · · via Himalayas"). | `common.ts:31-41`, `copy.ts:73-84`, `job.ts:37,110`, `jobs.ts:72,76` | E8 (lead), E1, E2, E4, E7, E11 | High |
| P13 | **Accessibility gaps in the interactive layer.** After an htmx swap, focus drops to `<body>`. Status changes are not announced. Some information exists only in `title` tooltips, and the copy even says "Hover…". In forced-colors mode the current state is invisible. Control borders are 1.66:1 (WCAG 1.4.11 needs 3:1). The iframes have no focus ring. Scroll boxes can't take focus. Headings run into badge text ("Arccheck before use"). | `job.ts:170`, `facts.ts:38`, `freelance.ts:87,301`, `app.css:143,148` | E6 (lead), E3, E5, E7 | High |
| P14 | **The mobile layout is the desktop layout squeezed.** At 400 px the first job starts at y=480, so one row fits on the first screen. 136 of 136 tap targets are under 44 px (checkboxes 13 px, chips 20 px). Nothing is sticky. The resume iframe scrolls sideways inside itself. Tabs wrap so the active tab can land on line 2. The Runs table cuts off columns. | `app.css:291-300`, `jobs.ts:43-56` | E7 (lead), E4, E6, E10 | High |
| P15 | **No component system; the CSS has grown in patches.** Sections are named "fix round 1" and "Task 10"; `.job` and `.gig` are copies; there are 2 media blocks and 6 badge-like and 5 callout-like elements. The type scale is too flat (12/13/14/16) and the h2 is the same size as row titles. Weights 550 and 650 are non-standard. Cards don't separate from the page (1.08:1). Dark mode turns the resume preview dark. | `app.css:310,320,380` | E5 (lead), E4, E10 | High |
| P16 | **The tests and the perf gate can't support a redesign.** About 262 `toContain` checks match exact markup. The 400 px check covers only 2 pages. Browser suites skip silently when Chromium is missing. The heaviest routes are not perf-tested. Static files are served `no-cache` with no ETag, so 77 KB is re-downloaded on every view. | `web*.test.ts`, `budget.perf.ts`, `server.ts:346` | E10 | High |

---

## D2. Design principles

1. **Organise around the daily loop, not the pipeline.** Decide, prepare, apply, follow up. Work pages come first; Profile and System are secondary. (E1, E2)
2. **Every screen leads with its next action.** The first screenful at 400 px holds the decision and the button for it. (E3, E4, E7, E11)
3. **Show exceptions, not defaults.** A missing badge means "normal". Colour means something: blue is for actions, green for good outcomes, amber for "you decide", red for "blocked". Aim for at most about one pill per row. (E4, E5, E9)
4. **Plain words, written from the user's side.** Each concept has one term, there are no codes or file names on work pages, and every number has a label and a scale. (E8)
5. **Works with no JS, a keyboard, touch, or a screen reader.** HTML first; htmx and app.js only enhance. Nothing depends on hover. (E6, E10)
6. **The pipeline stays honest and visible.** It is deterministic: empty states state the real cause, scores agree with the evidence, and the user always applies themselves. (E8, E11)
7. **The system and its budgets are enforced in CI.** Tokens, components, golden HTML, the 150 ms and size budgets, and the 400 px and axe checks gate every PR. (E5, E10)

---

## D3. Information architecture and navigation

### 3.1 New structure

```
WORK (primary nav, with count badges)
  Today              /                      new home
  Jobs               /jobs                  views: To decide · Shortlist · Applied · All · Hidden
  Freelance          /freelance             Contract roles · Gigs · Networks · To check
  Applications       /applications          cross-type tracker and follow-ups

PROFILE (secondary)  /profile               Facts · Screening answers · Resume (update, history) · Writing & privacy · Theme
SYSTEM  (secondary)  /system                Runs · Sources (Companies registry + Freelance sources + Skipped hosts) · Audit

/setup               resume-upload wizard (per profile)
```

**Routing for profiles (Phase C).** Every route gets a `/p/<profileId>/` prefix. Old URLs answer with a 302 redirect to the active profile, and `/?status=…` redirects to `/jobs?status=…`, so bookmarks keep working.

### 3.2 Header

- **Desktop:** the brand, then the four Work links with small neutral count badges (for example "Jobs 23", "Applications 2 due"). On the right sit the quieter Profile and System links, the theme setting, and the profile switcher. The header is `position: sticky; top: env(safe-area-inset-top,0px)`.
- **400 px:** one 48 px row holds the brand and the 4 Work links. Profile, System and the switcher go into a no-JS `<details class="menu">` "More" menu. Sub-tabs scroll sideways on one line (`overflow-x:auto`, a fade mask at the right edge) and never wrap.
- **Two kinds of nav, styled differently.** `.tabs` (underlined, with `aria-current`) is only for real routes. `.jumpnav` chips are only for in-page anchors, and their order is generated from the same array as the sections they point to.
- **One banner pipeline on every page.** `commonBanners` runs inside the shared `page()` helper, so the critical "next run will refuse to start" warning also shows on Freelance and System. (E2)

### 3.3 Disagreements resolved

| Topic | Positions | Decision |
|---|---|---|
| What `/` shows | Most experts: a Today page. Status quo: the Jobs list. | **Today at `/`**, Jobs list at `/jobs`, with a 302 for old query strings. |
| Grouping | E2: Work / Profile / System. E5 and E7: keep 5 flat tabs and make them scroll. | **Three groups**, because the switcher, wizard and new sections have nowhere to go otherwise. On mobile, Profile and System go into "More". |
| Tracker location | E11: `/tracker` or a section on Jobs. E1: a "Pipeline" tab. E2: "Applications". | **One `/applications` tab** covering jobs, contracts, gigs and networks, with a summary card on Today. |
| Where contract roles live | E2: move B2B jobs into Freelance > Contract roles. Others: silent. | Default: **Freelance > Contract roles** is their home. Jobs shows a "Contract" pill and a cross-link. Listed as open decision D3. |
| "New" | Cookie (today) vs run-based (E9) vs a triage state (E1). | **Both, kept separate.** *New* = first seen in the latest run (a dot, not a sentence). *To decide* = status Not started. The visit cookie is retired. |
| Companies, Runs, Sources | Separate tabs today. | They merge under **System**. Freelance > Sources moves into System > Sources. |

---

## D4. Page-by-page redesign

### 4.1 Today (`/`), new

**Job:** "In 15–30 minutes, pick 3–10 things worth my time, send them, and don't lose track."

**Layout, top to bottom, one column at 400 px and two at ≥64 rem:**

1. **Run strip, one line:** "Updated 07:41 IST · 5 problems → Runs". It has a status dot plus words, so it never relies on colour alone.
2. **Four stat tiles, each a link to a filtered view:**
   - To decide: 23 new today
   - Ready to send: documents ready, not applied
   - Shortlisted, not applied: 9
   - Follow-ups due: 2
3. **To decide.** The top 5 jobs and top 3 gigs or contracts that are untriaged and eligible, ranked by fit then pay. Each card shows:
   - title, company and age;
   - "Fit 84 · Strong" and pay in ₹ LPA;
   - a one-line reason built from the top breakdown rows ("AWS, Go, title match");
   - inline **Shortlist** and **Not for me** forms (CSRF POST, then a 303 back to `/#card-KEY`);
   - an **Open** link.
4. **Ready to send:** shortlisted items with documents ready, each with "Open apply kit".
5. **Follow up:** applied items older than 7 days with no status change, oldest first, each with "Snooze 7 d" (POST).
6. **What changed since the last run:** at most 6 lines, all deterministic diffs. For example: "+23 eligible jobs", "4 now have documents", "2 postings closed", "1 company not responding".
7. **Done state.** When sections 3–5 are empty: "You're done for today. Next run at 07:00."

**Engineering:** 6 COUNTs plus 3 `LIMIT`ed queries on existing indexes, with a target under 60 ms. A non-empty "Waiting on you" line shows profile and system needs: "2 facts to confirm · 3 companies waiting".

**Disagreement resolved:** E9 wanted Today to be GET-only, with no status buttons. E1 and E3 wanted inline triage. **Decision: inline Shortlist and Not for me are allowed** as CSRF POST forms with an Undo flash. "Mark applied" never appears on Today, because applying stays a per-item act on the apply kit.

**Empty and error states:**
- No run yet: "The first daily run starts at 07:00."
- Last run failed: a critical callout linking to Runs.
- Setup not finished: redirect to `/setup`.

### 4.2 Jobs list (`/jobs`)

- **Saved views as tabs, each a plain GET link with a count:** To decide (default) · Shortlisted · Applied · All eligible · Hidden (12,044). "Not for me" and "Not selected" never appear in To decide. (E1, E2, E3)
- **Toolbar:**
  - Always visible: Search, a **Sort** select (Best fit · Highest pay · Newest), and Apply.
  - A `<details class="filters">` holds two fieldsets that replace "Pay band":
    - **Pay:** Meets your minimum (₹12 LPA) · Pay not listed · Under your minimum.
    - **Eligibility:** Check before applying · Not a match.
  - The same `<details>` also holds Status and Freshness (≤3 d, ≤7 d, ≤30 d). Its summary line reads "Filters · 3 active". The server opens it only when a non-default filter is set. With JS, filters apply as you change them through htmx `hx-get`, `hx-push-url`; without JS, the Apply button submits.
- **Results line:** "430 matches · sorted by best fit · 12,044 hidden: show". The sort is stated in words, and numbers are grouped.
- **Default ranking** (E11, adopted): eligibility tier (eligible, then check-first) → fit descending → INR pay descending → newest.
- **Row: one shared `listRow` component for jobs, contracts and gigs** (E4, E5, E10).
  - *Desktop grid:* `[fit chip] [title / meta / ≤1 exception] [pay] [actions]`.
    - **Fit chip:** "84" with a "fit" caption, the tone on its background only (≥80 good-soft, 60–79 neutral, below 60 outlined), and a visually-hidden "Fit score 84".
    - **Title:** 15 px/600, one line with ellipsis. It is the first thing in the DOM order, and its stretched link makes the whole row clickable.
    - **Meta:** company · "Remote · India +9" (India first) · "Posted 3 d ago" · "via Himalayas, apply on Greenhouse". Empty parts are dropped, so separators never dangle.
    - **Exceptions:** at most one pill, and only for a non-default state: Check remote rules / Pay not listed / Documents out of date / Contract (B2B).
    - **Pay:** "₹1.35–2.28 Cr" in bold, with "$139k–235k" muted below it.
    - **Actions:** Shortlist · Not for me · a "Resume PDF" link when documents are ready. Once the status is set, it shows as a pill in place of the buttons ("Applied 33 d ago").
  - *400 px:* two lines. Line 1 is title plus fit chip. Line 2 is ₹ pay · eligibility · age, with status or actions below. Rows target 64 px on desktop and ≤96 px on mobile, so 6–7 rows fit on the first screen instead of 1.
- **Optional bulk triage (Phase C):** a checkbox per row, plus a sticky bar shown via `:has(input:checked)` with "N selected: Shortlist · Not for me". "Applied" is deliberately left out. A 303 returns with "Marked 12 Not for me · Undo".
- **Pages:** 50 rows per page, with the pager at the top and the bottom.
- **Group by company:** a toggle that collapses 3 or more roles into "Sezzle · 6 roles · best fit 84 ›". (E11, Phase C)
- **Empty state:** "No jobs match *Search "zzzz"* · *Status Applied*." followed by **Clear search** and **Reset filters** links.

### 4.3 Job page (`/jobs/:key`) and gig or contract page

The page order follows the apply sequence (E1, E3, E4, E7, E9, E10 and E11 agree):

1. **Header.** Breadcrumb "← Jobs (To decide, page 2)" built from a validated `?from=` same-origin path back to `#job-KEY`. Title, company · location · age.
2. **Decision strip** (E11): four short answers.
   - **Can you apply?** Yes / *Check first: the posting doesn't say if India is allowed* / No: on-site only.
   - **Pay:** ₹ LPA, with a "vs your minimum: +125% at the low end" note and a "listed range, not an India offer" caveat when the role is worldwide-remote.
   - **Fit:** "84 · Strong", with "Must-haves met 9/13 · missing: SQS, Python".
   - **Fresh:** "Posted 3 d ago".
3. **Apply kit card.** Sticky on wide screens (a right column of 22 rem); a sticky bottom bar at 400 px with `padding-bottom: env(safe-area-inset-bottom)`. It holds four numbered steps:
   1. **Open the posting ↗** (the only `btn--primary` on the page)
   2. Download resume: "PDF · recommended for Greenhouse", and DOCX
   3. Download cover letter
   4. **Mark applied.** One POST that records the date and keeps a read-only copy of the documents sent, with a follow-up date field (`<input type=date>`, defaulting to +7 days). The button label states the side effect.

   Below the steps, a document quality line: "Resume 2 pages · QA passed · cites 14 facts · built 15 Oct · names Tide, Staff Software Engineer". It turns amber if the resume runs past 2 pages, QA failed, or the documents are stale. (E11)
4. **Status control.** The current status pill, one button for the next step (Shortlist → Mark applied → Got an interview), and `<details><summary>Change status</summary>` with the full list as 44 px rows in a `role="group"` labelled "Your status". Negative moves show a flash with **Undo**. Buttons use `hx-disabled-elt`, keep a stable id, and focus returns to the control.
5. **Screening answers.** Each answer has its own **Copy** button (progressive; without JS the text is still selectable). Keys are humanised ("Work authorisation (India)").
6. **Why it matched / Eligibility,** side by side on desktop. The breakdown has a contribution bar (inline SVG, geometry attributes only, which the CSP allows) and a table inside `<details>`. Raw reason codes go into a "Technical detail" `<details>`.
7. **Previews.** `<details open>` on desktop and closed at ≤48 rem, with `loading="lazy"` and `.preview{color-scheme:light;background:#fff}` so they always look like the paper document. Provenance is shown as visible footnote markers instead of hover. The renderer is fixed so URLs wrap and the iframe never scrolls sideways.
8. **Note** (with "Unsaved changes" and "Saved" states), then **Documents you sent,** then **Job description** (`tabindex=0`, `role=region`).
9. **Previous / Next in this list** links, computed server-side from the same filter.

**Goal:** the decision strip and apply kit fit in the first 1.5 screens at 400 px, and status is in the first viewport at 1440. Both are asserted in tests.

**Gig and contract variant:** the same skeleton. The apply kit holds Copy pitch (with a character count), CV, cover letter, and Open posting. "Before you bid" (competition, client, hours) sits directly under the decision strip.

**Error states:**
- Documents blocked: a critical callout naming the cause in words ("A fact this letter needs isn't confirmed yet: Confirm it"), with the CLI command only as a muted "Technical:" line.
- Posting gone: "This posting was removed by the site on 12 Oct", with documents still downloadable.

### 4.4 Freelance (`/freelance`)

- **Tabs:** Contract roles · Gigs · Networks · To check (renamed from Review). Every tab always shows its count, computed in one shared helper. Zero-count tabs are muted but stay in place.
- **Landing:** the first non-empty tab, in that order. URLs stay stable (`?tab=`).
- **Contract roles** (merging soon): built on `listRow`, with "CV · Pitch · Cover ready" in the actions column and the same apply kit on the detail page.
- **Gigs and To check rows:**
  - The rate in one unit: "$250–750 fixed", or "≈ ₹2,150/h" when the posting states an hourly rate. A fixed budget never gets an invented hourly rate; it says "budget only".
  - A competition pill: "Crowded · 362 bids".
  - Fit as a `<details><summary>Fit 61</summary>` breakdown.
  - Unknowns on one muted line: "Not stated: hours, overlap, client". The IST window moves to the lede and is stated once.
  - Duplicate caveats are removed.
- **To check:** 50 per page. Sorted by fit, then age. A soft fit floor with a "Show fit under 45 (70)" link. Gigs older than 30 days are hidden behind a link. Grouping by reason uses `<details>` with "Dismiss this group" and "Dismiss below fit N" POST forms.
- **Networks:** rows, not tall cards. Each row has the name, status as one next-step button ("Mark applied"), and the pack as text links (CV PDF · DOCX · Profile text). The warning appears once. The checklist goes to `/freelance/networks/:id` as a real `<ol>`, not a monospace `<pre>`.
- **Empty state (truthful):** "No contract roles passed your rules in today's 09:30 run. 75 were not a match: **show them**." The "first run fills this list" wording is used only when `lastRun === null`.

### 4.5 Profile > Facts (`/profile/facts`)

- A **Waiting for you (2) · All** tab strip. Pending facts sort first, each with "Blocks documents for 4 jobs".
- **Row order:** claim (14–15 px) → muted meta line (type · Acme Corp · dates · id in 12 px mono, truncated) → actions.
- **Asymmetric actions.**
  - Unverified facts: **Confirm** as the primary button and **Reject** as a `btn--danger` text button.
  - "Stated by you" facts: no primary button, just a quiet "Change" disclosure.
  - Unverified is encoded once: a 3 px warn bar plus the words.
- **Optional bulk:** "Confirm selected".
- **Lede rewrite:** "Your documents only say what's on this list. Confirmed facts and facts you wrote are used; the rest are not. Changing a status here doesn't edit your file; the next run rebuilds affected documents."
- **Profile also holds:** Screening answers (a viewable list), Resume (update and history, which links to the wizard), and Writing & privacy (names jobpilot must never use, in plain words).

### 4.6 System > Sources (Companies), `/system/sources`

- **Order:**
  1. **Needs you:** Waiting for you (Proposed), with Approve and Reject buttons named per company ("Approve <span class=visually-hidden>Acme</span>"); Not responding; Your additions not found yet.
  2. **Add a company:** the form, moved to the top.
  3. **Checked daily:** collapsed when long.
  4. **Turned off by you.**
- **Empty sections** fold into one line: "Nothing waiting, failing or turned off."
- **Skipped this week (781):** one summary line grouped by reason, "612 refused by robots.txt · 169 bot challenge", with nested `<details>` and the host list paginated or multi-column.
- **Freelance sources** health (platform counts, failed-in-a-row) appears on the same page.
- **Errors** sit next to their field, with `aria-invalid`, `aria-describedby` and autofocus.

### 4.7 System > Runs (`/system/runs`)

- **Verdict first:** "Today's run finished 07:41: 430 jobs, 382 documents, 5 problems (4 sites unreachable, 1 cover letter held back)."
- **Health:** a 14-run sparkline of problems per run plus jobs found per run (inline SVG; each bar links to its run).
- **Problems:** rows that lead with words ("Couldn't reach camunda's job list (Ashby): site not found"), each linking to the affected jobs or companies.
- **Counts by step:** inside `<details>`, open only for the latest run with problems. Zeros render as a muted en dash. The first column is sticky and agent names `nowrap`. At ≤40 rem the table stacks as label and value pairs.
- **Audit:** "History intact ✓ (570,418 events), checked 14 Oct". Hashes and event IDs sit inside `<details>`.
- **Run freshness** also appears on Today and as a nav badge whenever there are problems.

### 4.8 Applications (`/applications`), new

- **Groups:** Overdue · Due this week · Waiting · Interviewing · Outcomes (collapsed) · Not for me (collapsed).
- **Columns, which stack as cards at 400 px:** type pill (Job, Contract, Gig, Network) · role and company · stage · applied date · days since · follow-up due · "Documents you sent" · note.
- **Row actions:** Snooze 7 d · Got a reply · Didn't work out (POST + 303 + Undo).
- **Shared display stages** are mapped in `copy.ts` only; the stored enums don't change:

| Display stage | Jobs | Gigs | Networks |
|---|---|---|---|
| To do | Not started | Not started | Not applied |
| Shortlisted | Shortlisted | Shortlisted | — |
| Applied | Applied | Applied | Applied |
| In progress | Interviewing | Replied | In screening |
| Won | Offer | Won | Passed |
| Didn't work out | Not selected | Lost | Not accepted |
| Not for me | Not for me | Not for me | — |

- **Empty state:** "Nothing applied yet. Shortlisted roles you send will show up here with a follow-up date."

### 4.9 Profile switcher (Phase C)

- **Where it lives:** in the header's right slot on desktop and in the "More" menu on mobile.
- **How it works:** a path-prefix design (`/p/<id>/…`). Switching is *navigation*: a GET `<form>` with a labelled `<select>` of person names and a **Switch** button that goes to the same page under the other prefix. JS auto-submits on change.
- **Default profile:** setting which profile opens by default is a separate CSRF POST.
- **Visible everywhere:** the active name shows in the header, in `<title>` ("Jobs · Asha · jobpilot"), in every flash ("Shortlisted for Asha"), and in download filenames. Applying with the wrong person's resume becomes visibly impossible.
- **CSRF tokens are per profile.**

**Disagreement resolved:** E3 and E10 said a POST form, because switching changes state. E2, E6 and E9 said a GET form. **Decision: GET navigation between URL-scoped profiles changes no server state, so it is safe.** Any *persisted* preference uses POST with CSRF. E2's point also holds: two tabs on two profiles can't cross-post.

### 4.10 Setup wizard (`/setup/1..5`), Phase C

- **Steps:** 1 Upload resume → 2 Check extracted facts → 3 Pay minimum, location and remote rules → 4 Screening answers → 5 Review and finish.
- **Each step** is its own GET page with a POST form (CSRF) that returns a 303 to the next step. Back is a link, and entered values are kept server-side.
- **Progress:** an `<ol aria-label="Setup steps">` with `aria-current="step"` and CSS counters.
- **Upload:** `<input type=file accept=".pdf,.docx">` with a server-side size limit. A JS drop zone is optional enhancement only.
- **Errors:** inline per field (`aria-describedby`, `aria-invalid`), plus a summary at the top with `role=alert` that links to each field.
- **Parsing is deterministic,** with no LLM. Any fact it can't parse becomes "Not confirmed", and the user confirms it in step 2.
- **Entry:** a profile that hasn't finished setup redirects every Work page to `/setup`, which opens with an empty state: "Start with your resume. jobpilot only uses facts you confirm."

---

## D5. Visual system

### 5.1 Colour roles

Each colour has one job (E4, E5, E9):
- **Accent (blue):** interactive elements only (links, the one primary action, current nav or tab, focus).
- **Good:** outcomes the user achieved, and passing checks.
- **Warn:** needs your judgement.
- **Danger:** blocked or broken.
- **Everything else:** neutral.

Every value below was computed with the WCAG formula.

| Token | Light | Contrast (light) | Dark | Contrast (dark) |
|---|---|---|---|---|
| `--bg-page` | `#f4f4f1` | — | `#0e0f11` | — |
| `--bg-surface` | `#ffffff` | — | `#1a1b1f` | Cards separate through border + shadow, not fill (1.11:1) |
| `--bg-subtle` | `#efefea` | — | `#24262b` | — |
| `--fg-default` | `#1b1c1e` | 17.05 on surface · 15.48 on page | `#e8e8e6` | 14.02 |
| `--fg-muted` | `#4a4e55` | 8.36 | `#b4b7bd` | 8.56 |
| `--fg-subtle` | `#62666d` | 5.77 surface · 5.23 page · 5.00 subtle | `#9a9ea6` | 6.40 surface · 5.63 subtle |
| `--border-subtle` (decorative) | `#dcdcd5` | Decorative, exempt | `#33363c` | Decorative |
| `--border-control` (inputs, buttons) | `#8a8d92` | **3.33** surface · **3.02** page (1.4.11 ✓) | `#7a7e85` | **4.22** surface · **4.70** page |
| `--accent` (links, primary, focus) | `#1f5fbf` | 6.09 | `#7aa7ff` | 7.21 |
| `--fg-on-accent` | `#ffffff` | 6.09 on accent | `#0e0f11` | 8.03 on accent |
| `--accent-subtle` bg | `#e8effb` | Accent text 5.27 | `#1c2a44` | 6.01 |
| `--good-fg` / `--good-bg` | `#1d6b3a` / `#e5f3ea` | 5.70 | `#6fd394` / `#173a26` | 6.84 |
| `--warn-fg` / `--warn-bg` | `#8a5a00` / `#fdf1d8` | 5.29 | `#f2c063` / `#3d300f` | 7.67 |
| `--danger-fg` / `--danger-bg` | `#b42318` / `#fde8e6` | 5.59 (6.57 on white) | `#ff8a80` / `#46201c` | 6.20 |

**Rules:**
- In dark mode every tinted badge also gets a 1 px `*-border` token, so badges stay visible shapes rather than floating text.
- Primary hover uses `--accent-hover` (`#194e9e` light, `#9bbcff` dark), not `filter`.
- **Status tones:** To do = no pill; Shortlisted = info; Applied and In progress = good; Won = good, solid; Didn't work out and Not for me = muted.

### 5.2 Type: system fonts only

- `--font-sans: system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans", "Helvetica Neue", Arial, sans-serif`
- `--font-mono: ui-monospace, "SF Mono", "Cascadia Code", Menlo, Consolas, monospace`. Mono is for IDs and hosts only, at 0.875 em in muted colour, never bold.

| Token | Size / line height | Use |
|---|---|---|
| `--text-xs` | 12 px / 1.5 | Captions, table headers (no uppercase) |
| `--text-sm` | 13 px / 1.5 | Meta lines only |
| `--text-base` | **15 px** / 1.5 | Body (up from 14). Inputs are 16 px under `(pointer:coarse)` to stop iOS zooming. |
| `--text-lg` | 18 px / 1.35 | Section h2, card titles |
| `--text-xl` | 22 px / 1.2 | Key figures |
| `--text-2xl` | 28 px / 1.2 | h1 |

- **Row titles** are 15 px/600 and always the strongest text in the row.
- **Weights:** 400, 500 and 600 only. 550, 650 and 700 are removed, because they render unpredictably on non-variable fonts.
- **Numbers:** `tabular-nums` on numbers, `text-wrap: balance` on headings.
- **Reading measure:** `--measure: 70ch` on the lede and prose.

**Disagreement resolved:** E7 wanted 16 px body text on mobile, E5 15 px everywhere. **Decision: 15 px body everywhere, and 16 px for form inputs on touch devices.**

### 5.3 Spacing, radii, shadows, layout

- **Spacing (4 px grid):** 2 · 4 · 8 · 12 · 16 · 24 · **32 · 48**.
  - 4 and 8 px within a row; 12 and 16 px between blocks.
  - 24 px from the page head to the first section; 32 px between sections.
  - Use `gap` on `.stack` containers, not per-element margins.
- **Radii:** `--radius-sm 4`, `--radius-md 6`, `--radius-lg 10`, `--radius-full 999`.
- **Shadows:** `--shadow-1: 0 1px 2px rgb(0 0 0 / .06)` for cards; `--shadow-2: 0 4px 12px rgb(0 0 0 / .12)` for sticky bars and menus.
- **Z-index:** `--z-sticky 10`, `--z-toast 20`.
- **Controls:** `--control-h: 2.25rem` (36 px), and **2.75 rem (44 px)** under `(pointer:coarse)`.
- **Layout:** a 72 rem container with one left edge on every page. Rows and cards respond through container queries (`@container list (width < 40rem)`). Only the page frame uses a media query.

### 5.4 Components

Each component is one TypeScript helper in `views/components/*.ts` that returns escaped `Html`, plus one CSS block. Views stop writing class strings by hand. (E5, E10)

| Component | Replaces | Notes |
|---|---|---|
| `btn({variant: primary/secondary/ghost/danger, size})` | `.btn`, `.btn-current`, `.btn-disabled` | States: hover, active, focus-visible, `:disabled`, `aria-pressed` (✓ glyph + 2 px border), `.htmx-request` (CSS spinner, off under reduced motion) |
| `badge(text, tone, {solid})` | `.pill`, `.term`, `.chain`, `.new`, `.tab-count`, `.rec` | At most one per row on lists |
| `callout(tone, body, {action})` | `.banner`, `.toast`, `.blocked`, `.chain-ok`, `.empty` | Includes an empty variant: one muted line plus the one action that would fill it |
| `listRow({score, title, meta, exceptions, money, actions})` | `.job`, `.gig`, networks, contract roles | DOM order is title first; the layout uses grid areas |
| `fitChip(score, tier)` | `.job-score` | Visible "fit" caption, visually-hidden "Fit score" |
| `statusControl({vocab, current, next})` | 3 hand-built button rows | Next step plus a `<details>` menu, `role=group`, stable ids |
| `applyKit({steps})` | — | Sticky right column / bottom bar |
| `tabs()` / `jumpNav()` | `.tabs` misuse | Two distinct styles |
| `field({label, hint, error})`, `checkGroup`, `select` | Duplicate input rules | `select` uses a CSS gradient chevron (no image file) |
| `dataTable({sticky, zeroDash, stackBelow})` | Runs and Sources tables | Scroll shadow via `background-attachment:local` |
| `meta(parts)` | Hand-joined `·` | Drops empty parts, which fixes "GitLab · ·" at the source |
| `copyBlock`, `stat`, `card`, `toastRegion`, `menu` | Assorted | `toastRegion`: one `aria-live` region; errors stay until dismissed |
| `meterBar` (SVG) | — | Fit contribution and pay range against your minimum, using geometry attributes only, because inline `style=` is blocked by the CSP |

A **GET-only `/styleguide`** page renders every component in every state, in light and dark, inside a 400 px frame.

### 5.5 Dark mode

- Tokens use `light-dark()`, with the existing `@media (prefers-color-scheme)` block as a fallback.
- **A no-JS theme override:** a System / Light / Dark radio group in Profile, a POST with CSRF, stored per profile. The server emits `<html data-theme="…">`.
- `:root:not([data-theme=light])` inside the media query and `:root[data-theme=dark]` both carry the dark tokens and `color-scheme: dark`.
- **Previews stay light** (`color-scheme: light; background: #fff`), and the generated `resume.html` drops its dark `@media`. What you preview is what the employer receives.

### 5.6 Disagreement resolved: "Documents ready"

E5 wanted to keep it green ("actionable"). E4 and E9 wanted it neutral or gone. **Decision: on lists it is the default and gets no pill.** Readiness appears where it causes an action: in Today > Ready to send, in the row's "Resume PDF" link, and in the apply kit's quality line. Only *blocked*, *missing* or *stale* get a pill. Green is kept for Applied, Interviewing, Won and passing QA.

---

## D6. Content

### 6.1 Glossary: one term per concept, kept in `copy.ts`

| Current | New | Notes |
|---|---|---|
| Pay band (filter) | **Pay** and **Eligibility** (two fieldsets) | The same query values underneath |
| Pay ≥ floor | Meets your minimum (₹12 LPA); no pill on lists | The actual figure is always shown |
| Below floor | Pay under minimum | |
| Pay not disclosed | Pay not listed | |
| Needs a look | Check first: *<specific reason>* (e.g. "Check remote rules") | Never used alone |
| Not eligible | Not a match | |
| Fit floor 45 | Showing fit 45 and above | |
| Band (job header) | Can you apply? | |
| New since your last visit | New (a dot plus hidden text), meaning first seen in the latest run | |
| Not started | To do (no pill) | |
| Not selected / Lost / Not accepted | Didn't work out | |
| Review (Freelance) | To check | |
| Core skill: X +4 | Key skill they ask for: X **✓ in your facts** / **not in your facts (0)** | See decision D2 |
| Why it matched | How the fit score was worked out | |
| Starting points | Base score | |
| Your facts (nav) | Profile > Facts | |
| Verify (on "Stated by you") | Confirm | |
| Proposed | Waiting for you | |
| Verified (companies) | Checked daily | |
| Failing | Not responding | |
| Deferred this week | Skipped this week (site refused) | |
| Your picks not verified | Your additions, not found yet | |
| Resolve now | Check now | |
| board | job list | |
| Runs > Agent | Step | |
| Replayed / Gone / Quarantined / Input rejected | Reused / Removed by site / Held back for safety / Bad input | |
| Clean | No problems | |
| IST overlap | Overlap with your hours | |
| answers.yaml / facts.yaml / pack / naming.yaml / fx.yaml | your saved answers / your fact list / your profile / names to never use / exchange-rate settings | The file name appears only in a muted "Technical:" line |
| remote scope unclear - verify | Check: the posting doesn't say if India is allowed | |
| time zone may exclude India - verify | Check: working hours may not suit IST | |
| hours not stated - verify | Ask the client for weekly hours | |
| preset bracket - bids may exceed it | (removed; the rate label already says this) | |
| B2B contractor: no PF/benefits | Contractor (B2B): no PF or benefits | |
| onsite (untranslated code) | On-site only | |
| role:\bproduct manager\b | The title matches a role you filtered out | |

### 6.2 Key rewritten strings

- **Jobs lede:** "430 jobs · 23 new today · sorted by best fit · pay minimum ₹12 LPA · 12,044 hidden: show"
- **Freelance Contracts, empty:** "No contract roles passed your rules in today's 09:30 run. 75 were not a match: show them."
- **Jobs, empty:** "No jobs match Search "zzzz" · Status Applied. Clear search · Reset filters"
- **Format hint:** "Recommended for Greenhouse: PDF." (This fixes "systems reads".)
- **Download button:** "Download PDF" with a separate "Recommended" badge.
- **Mark applied:** "Mark applied (keeps a read-only copy of what you sent)"
- **Status flash:** "Status set to Applied on 15 Oct. A read-only copy of your documents was kept. Undo"
- **Hover copy:** "Hover a resume bullet…" becomes "Each marked line lists the fact it comes from below."
- **Runs audit:** "History intact ✓ (570,418 events), checked 14 Oct."
- **Companies lede:** "jobpilot checks these companies' own careers pages every day. Once a week it looks for new ones and re-checks the rest."
- **Skipped hosts:** "These sites refused or blocked jobpilot this week, so it left them alone. They're tried again next week."
- **Old gigs:** "posted 1009 days ago" becomes "posted over 2 years ago: probably closed" (and is hidden by default).
- **Numbers:** always grouped (12,044); ₹ amounts in LPA or Cr.

### 6.3 Copy rules, enforced by a lint test

Sentence case. A real dash (–), never " - ". No visible reason codes, regexes or file names on Work pages. Every number has a label. Every reason code has a translation (a test asserts `reasonText(code) !== code` for every code the code base can emit).

---

## D7. Accessibility: WCAG 2.2 AA checklist

**Perceivable**
- [ ] 1.4.3: text is at least 4.5:1 (the tokens in §5.1 are all ≥5.0) and pill text is at least 4.5:1 in both themes.
- [ ] 1.4.11: control borders are at least 3:1 (`--border-control`); the focus ring is 6.09:1 light and 7.21:1 dark.
- [ ] 1.4.1: no meaning carried by colour alone. Status, current tab and run health all have words or a glyph.
- [ ] Forced colors: an `@media (forced-colors: active)` block gives `aria-pressed` and `[aria-current]` a Highlight border or outline.
- [ ] 1.3.1 and 1.3.2: in each row the DOM order is title, then pay, then score. Scores have hidden labels. Headings contain no badge text. Status buttons sit in `role=group` with `aria-labelledby`.
- [ ] 1.4.10 and 1.4.12: no horizontal scroll at 320 or 400 px, including with text-spacing overrides. Only tables scroll, inside a focusable, named region.
- [ ] 1.4.13: no information exists only in `title` or on hover. Use `<details>` or visible text instead.

**Operable**
- [ ] 2.1.1: every scroll box (`.jd`, `pre.paste`, `.table-wrap`) has `tabindex=0`, `role=region` and a name. Optional shortcuts (j/k/s/o, `?` for help) are off whenever focus is in a field.
- [ ] 2.4.1: a skip link, landmarks, and pagination on every long list.
- [ ] 2.4.2: titles reflect the page state ("Jobs: Shortlisted, page 2 · Asha · jobpilot").
- [ ] 2.4.3: after an htmx swap, focus returns to the control (stable ids) or to the swapped section's heading (`tabindex=-1`).
- [ ] 2.4.6: repeated controls get unique names ("Download resume PDF", "Approve Acme").
- [ ] 2.4.7: a visible focus ring on everything, including iframes (`.preview:focus-visible`) and rows (`:has(a:focus-visible)`).
- [ ] 2.4.11 (2.2): sticky header and apply bar never hide the focused element (`scroll-padding-top` and `scroll-padding-bottom`).
- [ ] 2.5.8 (2.2): targets are at least 24 px everywhere, and the house rule is **44 px under `(pointer:coarse)`**.
- [ ] 2.3.3: animations and spinners are switched off under `prefers-reduced-motion`.

**Understandable**
- [ ] 3.3.1 and 3.3.3: errors sit next to their field (`aria-describedby`, `aria-invalid`), plus a linked summary in the wizard.
- [ ] 3.2.2: filters that apply on change exist only with JS, and the explicit Apply button is always present.
- [ ] 3.3.4: irreversible and negative actions (Mark applied, Didn't work out, bulk changes) state their side effect and offer Undo.
- [ ] 3.3.7 (2.2): the wizard never asks for something already entered; Back keeps values server-side.

**Robust**
- [ ] 4.1.2: native elements first (`details`, `dialog`, `select`). No fake disabled buttons; the pager's ends are plain text.
- [ ] 4.1.3: one polite live region announces every state change. Banners shown on page load use `role=status`; `role=alert` is reserved for real errors.

---

## D8. Engineering approach and verification

### 8.1 Within the constraints

- **Server-rendered TypeScript views with the escaping `html` tag.** No SPA and no build step. htmx (already vendored) and `app.js` stay optional enhancers. `app.js` becomes a `data-enhance` registry (copy, autosubmit, kbd, dropzone, focus-after-swap, dirty-note) and stays under 6 KB with no inline handlers.
- **CSS:** one ordered declaration, `@layer reset, tokens, base, legacy, components, pages, utilities;`. **The first PR wraps all of today's CSS in `@layer legacy {}` with zero visual change.** Without this, unlayered legacy rules would beat every new layered rule (E10). A test fails on any rule that sits outside a layer. There are at most three files (`tokens.css`, `app.css`, `components.css`), all on the static allow-list.
- **CSP:** inline `style=""` is blocked (there is no `style-src`), so proportional visuals use SVG geometry attributes, `<meter>`, or quantised `data-*` classes.
- **No-JS interactivity:** `<details>` for menus and filters, a stretched link for whole-row clicks, `:has()` for the bulk bar and active filters, POST, then 303 with `?done=` for flashes, and an Undo token.
- **Security:** every new POST (row triage, bulk, follow-up, snooze, theme, wizard steps) carries CSRF. `?from=` is validated as a same-origin path. Everything is escaped. The server binds to 127.0.0.1 only.
- **Performance:**
  - `LIMIT`ed queries; 50-row pages.
  - `content-visibility:auto` on rows; `loading=lazy` iframes.
  - The nav counts come from one summary query per request.
  - Static files get an **ETag** (sha256 computed at startup, answering 304), which ends the 77 KB re-download on every view.

### 8.2 Verification, landing in PR 0 before any visual change

| Gate | What it asserts |
|---|---|
| **Perf budget** (`budget.perf.ts`, extended) | Every GET route at ≤150 ms, fresh and warm, including `/`, `/jobs`, `/jobs/:k`, every Freelance tab, `/applications`, System pages, `/styleguide`. HTML ≤150 KB, ≤3,000 DOM nodes, `app.css` ≤40 KB. |
| **400 px / 1440 px matrix** (Playwright, GET-only, non-GET requests aborted) | JS on and off. `scrollWidth ≤ clientWidth`. One `h1`. First list row top <260 px at 400. At least 4 rows in the first screen. The apply kit visible without scrolling on detail pages. 0 targets under 44 px with `hasTouch`. No page taller than 12,000 px. No CSP violations. |
| **Axe-style checks** (vendored axe-core run inside Playwright, local only) plus custom checks | WCAG 2.2 AA rules on every page in light, dark and forced-colors. Custom checks: focus stays on a control after a simulated htmx swap; no information only in `title`; live-region text after each POST. |
| **Golden HTML snapshots** (`toMatchFileSnapshot`, fixed fixture, fixed clock, CSRF token `x`) | One reviewable diff per view. The ~262 exact-markup `toContain` checks move to role and text queries, page by page; security and escaping checks stay exact. |
| **CSS lint** | No colour literals outside the tokens layer, only weights 400/500/600, no unlayered rules. Class coverage: no class used in a view but undefined (today `.src-link`, `.sent-files`, `.breakdown`, `.net-status`), and none defined but unused. |
| **Copy lint** | The rules in §6.3 applied to rendered fixture pages. |
| **Fail, don't skip** | `JOBPILOT_REQUIRE_BROWSER=1` inside `node --run verify`. (Per local notes, run scripts with `node --run`, not `pnpm`.) |

Every PR carries before and after screenshots at 400 and 1440, in light and dark.

---

## D9. Phased delivery plan

Impact: **H**igh, **M**edium, **L**ow. Effort: **S** = under ½ day, **M** = 1–3 days, **L** = over 3 days.

### Phase A: quick wins (1–2 days, template, copy and CSS only)

| # | Item | Impact | Effort |
|---|---|---|---|
| A0 | Safety net: extend the perf gate to Review, Companies, Facts and job pages; 400 px scroll check on all pages; browser suites fail instead of skip | H | S |
| A1 | Default the Jobs list to hide Not for me and Not selected; sort fit-first within the eligibility tier; state the sort in the lede | H | S |
| A2 | Job page: move status and the apply links above documents; make "Open the posting" the only primary button; previews in `<details>` with `loading=lazy`; previews stay paper-white in dark mode | H | S |
| A3 | Paginate Freelance Review at 50 (reuse `pager()`); land on the first non-empty tab; truthful empty state with a "show them" link | H | S |
| A4 | Stop the per-row "New since your last visit"; say it once in the lede when not all rows are new; shorten to a dot | M | S |
| A5 | Pill diet: no pill for To do, Documents ready or Pay ≥ minimum; remote shown as text, India first | H | S |
| A6 | Copy fixes: dangling `·`, "systems read", "Download PDF (recommended)", hide `<code>` reason codes, add "On-site only", group numbers, gig hint labels, network heading space | M | S |
| A7 | Fit score gets a visible "fit" label plus a hidden label; title moved first in the DOM | M | S |
| A8 | Filters in a `<details>` (open when non-default); breadcrumb carries `?from=` back to `#job-KEY` | H | S |
| A9 | Companies: Skipped list collapsed and summarised by reason; Add a company moved to the top; jump-link order matches the sections | M | S |
| A10 | Facts: pending first, claim before slug, Reject as a danger button | M | S |
| A11 | Runs: zeros as en dashes, no 56 rem width cap, agent names `nowrap`, audit text inside `<details>` | L | S |
| A12 | A11y and CSS: `--border-control` 3:1; iframe focus ring; stable button ids plus focus restored after swaps; always-present `role=status`; forced-colors block; `(pointer:coarse)` 44 px block; `.htmx-request` and `hx-disabled-elt`; weights 550/650 removed; "Hover" copy replaced | H | S |
| A13 | ETag on static files | L | S |
| A14 | "Applied N days ago" on rows; "Last run 07:41 · 5 problems → Runs" line on Jobs | M | S |

### Phase B: core redesign (about 2–3 weeks, one PR per surface, in this order)

| # | Item | Impact | Effort |
|---|---|---|---|
| B1 | Golden HTML snapshots plus migration of the brittle tests; `/styleguide`; CSS and copy lint | H | M |
| B2 | `@layer legacy` wrap → tokens v2 (§5) → component helpers (§5.4) | H | M |
| B3 | Shell: Work / Profile / System nav, sticky header, mobile "More" menu, one banner pipeline, nav counts | H | M |
| B4 | **Today** page | H | M |
| B5 | Jobs list: saved views, Sort select, Pay and Eligibility fieldsets, Freshness filter, `listRow`, inline Shortlist and Not for me with Undo, 50 per page | H | M |
| B6 | Job, gig and contract pages: decision strip, apply kit (sticky), next-step status control, Mark applied with follow-up date, copy per answer, document quality line, prev/next | H | M |
| B7 | **Applications** tracker plus `next_followup` and snooze; shared display stages | H | M |
| B8 | Freelance on `listRow`, built *after* the Contract roles and Networks merge rather than restyled twice; normalised rate, bid pill, unknowns line, Networks as rows | H | M |
| B9 | Content pass: glossary in `copy.ts`, all strings moved there, eligibility notes rewritten | H | M |
| B10 | System: Sources (merged Companies + Freelance sources), Runs verdict-first with links to affected jobs; Profile > Facts and answers | M | M |
| B11 | Full matrix: axe in light, dark and forced-colors; 44 px; first-screen assertions | H | S |

### Phase C: polish and growth

| # | Item | Impact | Effort |
|---|---|---|---|
| C1 | Profile prefix routes, switcher, per-profile CSRF and theme | H | L |
| C2 | Setup wizard (5 steps, deterministic parsing) | H | L |
| C3 | Bulk triage (jobs, To check, facts, proposed companies) with Undo | M | L |
| C4 | Fit visuals: tier, percentile among eligible jobs, contribution bar; pay range bar against your minimum (SVG) | M | M |
| C5 | Run health sparklines; "what changed" diffs on Today | M | S |
| C6 | Optional keyboard model (j/k/s/x/o, `/` and `?`) | M | M |
| C7 | Group by company; hide gigs older than 30 days; dismiss a group | M | M |
| C8 | Theme override (System / Light / Dark) | L | S |
| C9 | Screenshot diff at 1440, 400 and dark for the main pages | L | S |

---

