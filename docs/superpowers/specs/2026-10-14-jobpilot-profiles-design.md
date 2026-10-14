# jobpilot profiles: a resume-driven job search anyone can run

Status: designed with the user on 2026-10-14 (brainstorm sections 1–4 approved).

It builds on:
- the architecture spec (`2026-10-08-jobpilot-architecture-design.md`);
- v1 (`2026-10-09-jobpilot-v1-daily-design.md`);
- freelance (`2026-10-12-jobpilot-freelance-design.md`);
- career sites (`2026-10-13-jobpilot-career-sites-design.md`).

## 1. What the user gets

Today jobpilot serves one person. Its pack holds one person's facts, targets and writing, and several rules are built
in for that person (residence India, Indian pay, Bengaluru, one tech stack). After this build, **anyone in a tech or
tech-adjacent role** can install jobpilot on their own computer and:

1. upload a resume (JSON Resume, LinkedIn data export, DOCX or PDF);
2. check and correct what jobpilot read from it, in a setup page;
3. choose a search: role family, titles, seniority, country, remote / office / hybrid, office cities, pay floor in any
   currency, notice period;
4. get daily matches from every source jobpilot has, with a tailored resume and cover letter per job, written only
   from facts they confirmed;
5. upload an updated resume later and see only what changed, with their own edits kept.

The existing user becomes the profile `gaurav`. His outputs stay byte-identical, and his profile follows the same
resume-update flow.

The constraints carry over unchanged:
- deterministic, with no LLM and no API key;
- runs without Claude Code;
- local-first: each person runs their own copy;
- never submits an application;
- no scraping against robots.txt or terms, and no evasion;
- the repo is public and holds no personal data.

## 2. Decisions (user, 2026-10-14)

- D1 **Distribution:** each person runs their own copy (local). No hosted service and no accounts.
- D2 **Resume input:** structured imports where available (JSON Resume, LinkedIn data export: exact), a deterministic
  DOCX/PDF reader otherwise, and in every case a confirmation form. Nothing unconfirmed ever reaches a document.
- D3 **Professions:** tech and tech-adjacent roles only (software, data, AI/ML, DevOps/SRE, QA, mobile, security,
  product/design, solutions/support, technical writing). There are no profession add-on packs.
- D4 **Resume changes:** the person's own edits (rewording, adding or hiding items, headline, emphasis) **plus**
  automatic tailoring per job. Edits are stored as confirmed facts and phrasing variants. Tailoring picks from them and
  never writes an unconfirmed claim.
- D5 **Architecture:** profiles inside jobpilot (one codebase), not a separate app and not only a converter.
- D6 **The existing profile** stays separate (`gaurav`) and is updated through the same resume re-import flow when his
  resume changes.

## 3. Profiles

```
~/.jobpilot/
  profiles/<id>/   pack/  jobpilot.db  out/  archive/  logs/  secrets/
  active-profile   (the default profile for the CLI and dashboard)
```

- **Isolation:** a profile is a complete home: pack, DB, outputs, archive, logs and secrets. Profiles share nothing,
  not even a lock or a document.
- **Migration of the existing home:** a one-time, reversible step (`jobpilot profile adopt gaurav`) moves today's
  `~/.jobpilot` contents into `profiles/gaurav/`. It takes a backup first and runs under the run lock. A golden test
  proves that the adopted profile's daily run is byte-identical to the pre-move run.
- **CLI:** every command takes `--profile <id>`; without it, the active profile is used. `jobpilot profile
  list|create|use|adopt|remove` (remove archives the profile; it never deletes it).
- **Schedule:** `schedule install` installs the jobs per profile. Runs of different profiles on one machine are
  serialised through a machine-wide politeness pacer, so per-host rate limits hold across all profiles.
- **Dashboard:** one server with a profile switcher. Every route is scoped to one profile, and CSRF tokens are per
  profile.

## 4. Resume intake (deterministic)

The new agent `resume-intake` produces `ResumeDraft@1`. Every item carries its source (file, page, line, original
text) and a status: `found` (a rule matched with certainty) or `check` (a rule was unsure). Nothing is guessed
silently.

| Source | Method | Expected accuracy |
|---|---|---|
| JSON Resume (`resume.json`) | direct field mapping (schema-validated) | exact |
| LinkedIn data export (CSV files) | column mapping: Positions, Education, Skills, Profile | exact |
| DOCX | document XML; heading styles and paragraph structure | high |
| PDF | text layer in reading order, then section-heading, date-range, contact, title/company and bullet rules; skills matched against the vocabularies (§6) | good for simple layouts; columns, tables and icons → `check` |

- **Unreadable files:** a scanned PDF with no text layer, or an unreadable file, gives a clear message offering the
  LinkedIn export or manual entry. It never produces a silently half-empty draft.
- **Determinism:** the same file always gives the same draft. Parsers are linear-time, with 1 MB adversarial tests,
  as in the career-sites build.
- **Out of scope:** OCR (scanned images), and any LLM.

## 5. Confirmation, edits and updates

- **Confirmation:** the setup page shows the original resume text beside the draft. The person accepts or edits each
  item. Confirmed items become pack facts (`facts.yaml`), experience (`experience.yaml`) and phrasing variants (their
  own wording). The new agent `profile-builder` turns a confirmed draft plus the person's search choices into a full
  pack, which must pass `pack check`.
- **Re-import (resume updated):**
  1. `resume-intake` reads the new file.
  2. A deterministic diff against the **current confirmed profile** lists only the changes: new roles, changed dates
     (for example an end date replacing "present"), added or removed bullets, skills and links.
  3. The person accepts, edits or rejects each change.
  4. A change never overwrites the person's own earlier edit silently: a conflict is shown side by side.
  5. On confirm, the pack changes, and so does its hash; documents re-render through the normal pipeline.
- **History:** each confirmed profile change is a new version, recorded as an event in the hash chain with the diff
  and the pack hashes before and after. `jobpilot profile history` lists the versions; `profile revert <version>`
  restores an earlier pack. A revert is logged too.

## 6. Generic rules

Every rule that is built in for one person becomes a profile setting.

| Today (one person) | Becomes | Source |
|---|---|---|
| `residence: 'IN'` (literal), remote scopes India/APAC/Worldwide | `residence` (any ISO country), with remote scopes derived from country → region → worldwide | resume location, confirmed |
| office city Bengaluru, city aliases for India | `officeCities`, with a city-alias table per country (data files) | setup page |
| pay floor in INR, India pay parsing | `floor` in any currency, using the fixed-rate table `fx.yaml` (extended), with pay parsing per currency and locale | setup page |
| one person's titles and seniority | `targets` per role family | resume titles → suggested family, confirmed |
| a scoring vocabulary centred on one stack | role-family starter vocabularies (data files) **plus** the person's confirmed skills | shipped files and the resume |
| fixed letter phrases ("I'm based in Bengaluru…") | templates filled from profile settings | profile |
| one person's forbidden terms | each profile's own `naming.yaml`; the privacy checks run per profile | setup page |

- **Role families:** backend, frontend, full-stack, data, ML/AI, DevOps/SRE, QA, mobile, security, product/design,
  solutions/support, technical writing.
- **Starter vocabularies:** readable YAML files that anyone can extend through a pull request.
- **Proof that the existing profile doesn't change:** the existing user's pack, run through the generic code, must
  give byte-identical step keys, verdicts, scores and documents. This uses the strict golden and a real-pack
  comparison. Every generalisation lands behind this gate.

## 7. Setup and the dashboard for a new person

1. `jobpilot init` creates `~/.jobpilot/profiles/<id>/` and starts the dashboard.
2. `/setup` has five steps:
   1. upload the resume;
   2. check the extracted profile;
   3. choose the search;
   4. writing and privacy (their own phrasing and their forbidden names);
   5. review: `pack check`, then the schedule install (daily at 07:00 local time, coverage on Sunday), and an optional
      first run now.
3. After setup, the dashboard works as it does for the existing user, plus **Update resume** (re-import with changes
   shown) and **Profile history** (versions, revert).

The rules for the existing tabs apply: 127.0.0.1 only, CSRF on every change, escaping of all text (resume text is
untrusted), and correct layout at 400 px width.

## 8. Error handling

- **Unreadable resume:** a named message offering the alternatives (§4).
- **Missing required settings** (role family, country, at least one target title): setup cannot finish, and the gap
  is named.
- **Re-import conflicts:** shown side by side. Nothing applies silently.
- **Pack invalid after edits:** `pack check` problems are shown, by field, on the setup page.
- **Privacy:** contact values, the pay floor and the profile's forbidden names are checked in every output, for each
  profile.
- **Politeness:** limits are machine-wide across profiles, so more profiles never means more pressure on any host.

## 9. Testing and measurement

- **Resume golden set:** at least 40 fictional resumes in many layouts (single column, two columns, tables,
  icon-heavy, DOCX styles), plus JSON Resume and LinkedIn-export samples. Each has hand-labelled expected drafts.
  - Structured imports must match exactly.
  - The PDF/DOCX reader is scored per field. Each field is reported as found-correct, `check`, or wrong, and the gate
    is "wrong = 0". Uncertain items must be `check`, never wrong.
  - No real person's resume is ever committed.
- **Existing profile:** byte-identical (§6).
- **Two fictional profiles, end to end:** a frontend developer in Berlin, paid in EUR, open to hybrid; and a data
  engineer in Toronto, remote only. Each goes through setup, a recorded daily run and tailored documents, and every
  claim is checked against confirmed facts (G-GROUND).
- **Re-import:** the diff is correct for added, changed and removed items; edit conflicts are detected; revert
  restores the earlier pack byte for byte.
- **Web:** setup at 400 px; CSRF; XSS payloads in resume text.
- **Performance:** the setup and dashboard routes join the perf gate's budgets.

## 10. Build order

1. Profiles: layout, CLI `--profile`, `profile adopt` for the existing home (byte-identical gate), dashboard switcher,
   machine-wide pacer.
2. Generic rules (§6), each behind the byte-identity gate for the existing profile.
3. `resume-intake`: the structured importers, then the DOCX and PDF readers, plus the golden set.
4. `profile-builder` and the setup wizard.
5. Re-import diff, conflicts, history and revert.
6. Role-family vocabularies; the two fictional end-to-end profiles.
7. Operator guide updates; final review; merge.

## 11. Out of scope

- hosted or multi-user web service, accounts, payments;
- non-tech professions;
- OCR of scanned resumes;
- any LLM;
- automatic application submission;
- LinkedIn scraping (only the user's own data export is read).
