# ATS + remote-aggregator JSON endpoints: live verification (2026-10-09)

Method: curl from this machine plus firecrawl for docs. "VERIFIED" means the endpoint returned HTTP 200 with jobs today. Shapes below are from real responses, with long HTML fields trimmed.

Caveat for all adapters: send a descriptive User-Agent, use a concurrency of 1 to 3 per host, and back off on 429. Workable's Cloudflare banned my IP (HTTP 429, error 1015) after about 100 requests in a burst.

---
## 1. Greenhouse Job Board API  (VERIFIED, slug `gitlab`, 220 jobs)
- List: `GET https://boards-api.greenhouse.io/v1/boards/{slug}/jobs?content=true[&pay_transparency=true]`
- Single job: `GET .../v1/boards/{slug}/jobs/{id}?pay_transparency=true` (also `questions=true`). Job ids must be real; a wrong id returns `{"status":404,"error":"Job not found"}`.
- Board info: `/v1/boards/{slug}`. Departments and offices: `/v1/boards/{slug}/departments` and `/offices`.
- Auth: none (GET is public; only POST application submits need a key).
- Pagination: none. The whole board is returned in one response (gitlab with content=true is 3.4 MB). `meta.total` gives the count. `per_page` and `page` are accepted but ignored in my test.
- ToS: public Job Board API intended for careers pages. No published rate limit, and I saw none at low concurrency. A 404 means a wrong or retired slug. Some boards return `{"jobs":[]}` (postman, razorpay and hasura returned 0 jobs, so they are not on Greenhouse any more).

Response shape (`content` is HTML-ESCAPED, so html-unescape it once to get HTML):
```json
{"jobs":[{
 "id": 8860302002, "internal_job_id": 6547054002, "requisition_id": "7109",
 "title": "Account Executive - France", "company_name": "GitLab",
 "location": {"name": "Remote, France"},
 "absolute_url": "https://job-boards.greenhouse.io/gitlab/jobs/8860302002",
 "first_published": "2026-10-02T11:31:50-04:00", "updated_at": "2026-10-02T11:31:50-04:00",
 "language": "en", "application_deadline": null,
 "content": "&lt;div class=&quot;content-intro&quot;&gt;...",
 "departments": [{"id":4096748002,"name":"EMEA - Commercial","parent_id":4096735002,"child_ids":[]}],
 "offices": [{"id":4042500002,"name":"France","location":"France"}],
 "metadata": [{"id":4595831002,"name":"Quota Coverage Type","value":"Account Executive","value_type":"single_select"}],
 "data_compliance": [{"type":"gdpr","requires_consent":false}]
}], "meta": {"total": 220}}
```
- id: `id` (numeric) and `internal_job_id`.
- Location: `location.name` is a free-text string (e.g. "Remote, India", "Bangalore, India"). There is NO structured remote flag and NO employment type. The `metadata[]` array is custom per company, and some boards expose employment type there.
- Posted/updated: `first_published` and `updated_at` (ISO with offset).
- Apply URL: `absolute_url`.
- **Pay transparency**: add `pay_transparency=true`, which works on the list endpoint as well as the single-job endpoint. Each job then gets `pay_input_ranges: []`. Without the flag the field is absent (0 jobs had it). Verified: coinbase 215 of 220 jobs, databricks 492 of 894, airbnb 124 of 159. Stripe and twilio return empty arrays because their pay text is in the content body.
```json
"pay_input_ranges":[{"min_cents":10880000,"max_cents":14960000,"currency_type":"USD","title":"Zone 3 Pay Range","blurb":"<p>...Pay Range Transparency...</p>"}]
```
  Divide cents by 100. Roles can have several ranges (per zone or country), and `blurb` is HTML. Coinbase also returns hourly ranges where min equals max.
- India detection: string-match `location.name` (India, Bangalore, Bengaluru, Pune, Hyderabad, Remote - India and so on). There is no country code.

---
## 2. Lever Postings API  (VERIFIED, slug `palantir`, 313 postings)
- `GET https://api.lever.co/v0/postings/{slug}?mode=json` (the EU region is `api.eu.lever.co`; palantir is not on it and returns 404 "Document not found").
- Filters: `skip`, `limit`, `location`, `commitment`, `team`, `department`. `limit=2` returned 2 items, so `skip` and `limit` page the list.
- Single: `/v0/postings/{slug}/{id}`.
- Auth: none. ToS: public postings API. No rate limit published.
- Response is a top-level ARRAY (the palantir response is 6 MB without paging).
```json
{"id":"6ed76ce8-4156-4b60-b120-403538bd66cd","text":"Administrative Business Partner",
 "categories":{"commitment":"Full-time","location":"Singapore, Singapore","team":"Administrative","allLocations":["Singapore, Singapore"]},
 "country":"SG","workplaceType":"hybrid",
 "createdAt":1786469891368,
 "description":"<div>...</div>","descriptionPlain":"...","descriptionBody":"<div>...","descriptionBodyPlain":"...",
 "opening":"<div>...","openingPlain":"...","additional":"<div>...","additionalPlain":"...",
 "lists":[{"text":"Responsibilities","content":"<li>...</li>"}],
 "hostedUrl":"https://jobs.lever.co/palantir/6ed7...","applyUrl":"https://jobs.lever.co/palantir/6ed7.../apply"}
```
- Employment type: `categories.commitment`.
- Remote: `workplaceType` is one of `remote | hybrid | onsite | unspecified` (palantir values seen: hybrid, onsite).
- Country: `country` is an ISO-2 code. Use it together with `categories.allLocations` for India detection.
- Posted: `createdAt` in epoch milliseconds. There is no updated date.
- Salary: `salaryRange` is present only when the company fills it in: `{"min":0,"max":0,"currency":"INR","interval":"per-year-salary"}`. Seen on paytm, but with zeros, and it was absent for palantir, spotify, toptal and zeta. Also check `salaryDescription` and `salaryDescriptionPlain`. Treat min=0 as "no salary".
- Full description = `description` (which includes the opening and body) plus each `lists[]` entry plus `additional`.

---
## 3. Ashby posting API  (VERIFIED, slug `ashby`, 68 jobs)
- `GET https://api.ashbyhq.com/posting-api/job-board/{slug}?includeCompensation=true`
- Auth: none. No pagination (the whole board is returned). No published rate limit. Retired slugs return 404 "Not Found".
```json
{"apiVersion":"1","jobs":[{
 "id":"7458d4e9-da2e-47bd-98cb-adfda43d42b2","title":"Engineering Manager - EU",
 "department":"Engineering","team":"EMEA Engineering","employmentType":"FullTime",
 "location":"Remote - European Union",
 "secondaryLocations":[{"location":"Spain","address":{"postalAddress":{"addressCountry":"Spain"}}}],
 "address":{"postalAddress":{"addressCountry":"European Union"}},
 "isRemote":true,"workplaceType":"Remote","isListed":true,
 "publishedAt":"2024-03-04T14:29:08.532+00:00",
 "shouldDisplayCompensationOnJobPostings":true,
 "descriptionHtml":"<p>...</p>","descriptionPlain":"...",
 "jobUrl":"https://jobs.ashbyhq.com/ashby/7458...","applyUrl":"https://jobs.ashbyhq.com/ashby/7458.../application",
 "compensation":{
   "compensationTierSummary":"€110K – €185K • Offers Equity • Offers Bonus",
   "scrapeableCompensationSalarySummary":"€110K - €185K",
   "compensationTiers":[{"id":"...","tierSummary":"...","title":"EU","additionalInformation":null,
     "components":[{"compensationType":"Salary","interval":"1 YEAR","currencyCode":"EUR","minValue":110000,"maxValue":185000,"summary":"€110K – €185K"},
                   {"compensationType":"Bonus","interval":"1 YEAR","minValue":null,"maxValue":null},
                   {"compensationType":"EquityPercentage","interval":"NONE"}]}],
   "summaryComponents":[{"compensationType":"Salary","interval":"1 YEAR","currencyCode":"EUR","minValue":110000,"maxValue":185000}]}
}]}
```
- Employment type enum: `FullTime | PartTime | Contract | Intern | Temporary`. Remote: `isRemote` (bool) and `workplaceType` (`Remote | Hybrid | OnSite`). Posted: `publishedAt`. No updated date.
- Compensation is optional per job. Use `compensation.summaryComponents` where `compensationType == "Salary"`. Without `includeCompensation=true` the `compensation` object is absent.
- India detection: match the text of `location` and `secondaryLocations[].location`, or `address.postalAddress.addressCountry`. Example from confluent: location "IN Remote India".

---
## 4. Workable  (PARTIALLY VERIFIED. Shape confirmed via firecrawl on `huggingface`; my IP was then rate-limited by Cloudflare)
- Widget: `GET https://apply.workable.com/api/v1/widget/accounts/{slug}?details=true`. Alias: `https://www.workable.com/api/accounts/{slug}?details=true`, which 302-redirects to the widget, so follow redirects.
- Account metadata: `GET https://apply.workable.com/api/v1/accounts/{slug}` returned 200 with JSON for `dataiku`.
- Companion endpoints: `.../accounts/{slug}/locations` and `.../departments`.
- Careers-site endpoint (unofficial): `POST https://apply.workable.com/api/v3/accounts/{slug}/jobs` with body `{"query":"","location":[],"department":[],"worktype":[],"remote":[]}`. It returned `{"results":[],"total":0}` with 200 for accounts that have no jobs, and 404 for unknown slugs. I could not capture a populated v3 sample, so treat v3 as UNVERIFIED and prefer the v1 widget.
- Auth: none. The official `{sub}.workable.com/spi/v3/jobs` requires a bearer token and is NOT usable.
- Rate limit: aggressive. About 100 quick requests got `HTTP 429 error code: 1015` (Cloudflare) for several minutes. Throttle to roughly 1 request per second.
- Pagination: none on the widget (all published jobs in one response).
- Wrong slugs return 404, and an account with no open roles returns 200 with `jobs: []`.
Widget shape (huggingface):
```json
{"name":"Hugging Face","description":"...","jobs":[{
 "title":"Senior Open-Source Python Engineer, ML Developer Tools - EMEA Remote",
 "shortcode":"DB4D7C0EC8","code":"","employment_type":"Full-time","telecommuting":true,
 "department":"Product","function":"","industry":"Computer Software","experience":"Mid-Senior level","education":"Master's Degree",
 "url":"https://apply.workable.com/j/DB4D7C0EC8","shortlink":"https://apply.workable.com/j/DB4D7C0EC8",
 "application_url":"https://apply.workable.com/j/DB4D7C0EC8/apply",
 "published_on":"2026-09-21","created_at":"2026-09-21",
 "country":"France","city":"","state":"",
 "locations":[{"country":"France","countryCode":"FR","city":"","region":null,"hidden":true}],
 "description":"...plain-ish text (HTML tags stripped, no separators)..."}]}
```
- Remote: `telecommuting` (bool). Posted: `published_on` and `created_at` are plain dates (no time).
- India: `locations[].countryCode == "IN"` or `country == "India"`. Note that Hugging Face's titles say "EMEA Remote" or "US Remote", so remote scope lives in the title and not in a field.
- Salary: none in the widget.
- `details=true` is needed to get `description`. `description` is HTML-stripped text. The `/spi/v3` API, not the widget, has `full_description`.

---
## 5. SmartRecruiters  (VERIFIED, `ServiceNow` totalFound 699, `Freshworks`)
- List: `GET https://api.smartrecruiters.com/v1/companies/{CompanyIdentifier}/postings?limit=100&offset=0[&country=in&q=...&city=...&department=...]`
- Detail (needed for the description): `GET .../v1/companies/{id}/postings/{postingId}`
- Auth: none for public postings. Pagination: `limit` (max 100), `offset`, `totalFound`. Case matters: `ServiceNow` works. Unknown or empty identifiers return 200 with `totalFound:0` and NOT 404, so you cannot distinguish a typo from a company with no jobs. Several big names (Visa, Wipro, Infosys, Cisco) returned 0.
- ToS: public Posting API. No rate limit published.
List item (no description):
```json
{"id":"744000154405299","name":"Lead Software Engineer - Systems","uuid":"e953...","refNumber":"P100628_1",
 "company":{"identifier":"Freshworks","name":"Freshworks"},"releasedDate":"2026-10-08T10:53:04.656Z",
 "location":{"city":"Chennai","country":"in","remote":false,"hybrid":false,"fullLocation":"Chennai, , India"},
 "industry":{"id":"it_and_services"},"function":{"id":"other"},
 "typeOfEmployment":{"id":"permanent","label":"Full-time"},
 "experienceLevel":{"id":"mid_senior_level","label":"Mid-Senior Level"},
 "ref":"https://api.smartrecruiters.com/v1/companies/Freshworks/postings/744000154405299"}
```
Detail adds: `postingUrl`, `applyUrl`, `jobAd.sections.{companyDescription,jobDescription,qualifications,additionalInformation}.text` (HTML) and `compensation` (usually `{"min":0,"max":0,"currency":"INR","period":"MONTHLY"}`, so treat 0 as absent).
- Remote: `location.remote` and `location.hybrid` (bools). Country: `location.country` as an ISO-2 code, and the `country=in` filter works server-side (Freshworks: returned India postings only). Posted: `releasedDate` (there is no updated date).
- Cost: one list call plus one detail call per posting.

---
## 6. Recruitee  (VERIFIED, `bunq.recruitee.com`, 20 offers)
- `GET https://{slug}.recruitee.com/api/offers` (`/api/offers/` also works; `/api/offers/{id}` for one). Unknown subdomains return 404 `{"error":"Not Found"}`. Wrong or empty ones may return `{"offers":[]}` (tellent).
- Auth: none. No pagination (all offers in one response). No published rate limit.
```json
{"offers":[{"id":2771751,"guid":"...","title":"Deputy AML Manager - Belgium","slug":"deputy-aml-manager-belgium",
 "status":"published","remote":false,"hybrid":true,"on_site":false,
 "employment_type_code":"fulltime_permanent","experience_code":"experienced","category_code":"...","education_code":"professional",
 "location":"Brussels, Brussels, Belgium","city":"Brussels","country":"Belgium","country_code":"BE","postal_code":"...",
 "locations":[...],"department":null,"tags":[],"min_hours":40,"max_hours":40,
 "salary":{"min":null,"max":null,"period":null,"currency":null},
 "created_at":"2026-10-05 15:45:18 UTC","published_at":"2026-10-05 16:05:18 UTC","updated_at":"...","close_at":null,
 "description":"<p>...</p>","requirements":"<p>...</p>",
 "careers_url":"https://careers.bunq.com/o/deputy-aml-manager-belgium",
 "careers_apply_url":"https://careers.bunq.com/o/deputy-aml-manager-belgium/c/new",
 "translations":{"en":{"title":"...","description":"...","requirements":"..."}}}]}
```
- Remote: `remote`, `hybrid` and `on_site` (bools). Country: `country_code`. Salary: `salary.{min,max,period,currency}` (often null). Full description = `description` plus `requirements`.
- Note: the subdomain is the slug, and many companies serve their careers site on a custom domain, so `careers.bunq.com/api/offers` may not work. Use the `{slug}.recruitee.com` form.

---
## 7. Remote aggregators

### Remotive  (VERIFIED, 200)
- `GET https://remotive.com/api/remote-jobs?category=software-dev&search=java&company_name=&limit=N`; categories at `/api/remote-jobs/categories` (this returned a Cloudflare challenge to curl once, so cache the categories).
- No auth. No pagination: `limit` only, and the default returns all active jobs.
- ToS (from the response `0-legal-notice` plus the GitHub README): link back to the Remotive URL AND name Remotive as the source. Do NOT redistribute the jobs to third-party job sites (Jooble, Google Jobs, LinkedIn Jobs and the like). Jobs are delayed by 24 hours. Max about 4 fetches per day, and more than 2 requests per minute gets blocked. Using it purely as a personal candidate-side lead source (link back, no republishing) fits the terms; cache for 6 hours or more.
```json
{"job-count":19,"jobs":[{"id":2091045,"url":"https://remotive.com/remote-jobs/...-2091045","title":"Tier III Service Desk Engineer",
 "company_name":"Unio Digital","company_logo":"...","category":"Information Technology","tags":["azure"],
 "job_type":"full_time","publication_date":"2026-10-07T01:11:09",
 "candidate_required_location":"Worldwide","salary":"","description":"<p>...</p>"}]}
```
- India: `candidate_required_location` is free text. Values seen in software-dev: "Worldwide", "Northern America, LATAM, Europe, APAC", and "USA, UK, India, Australia, ...". India-eligible = Worldwide, APAC, Asia, or text containing "India". Salary is a free-text string.

### RemoteOK  (VERIFIED, 200, 573 KB)
- `GET https://remoteok.com/api` (also `?tag=java`). No auth. Returns an ARRAY whose element [0] is the legal notice `{"last_updated":..,"legal":"..."}`, so skip it.
- ToS: link back to the Remote OK URL with follow (no nofollow) and name Remote OK as the source. Do not use their logo. API access gets suspended otherwise. No numeric rate limit is published, so poll gently (about once an hour or less) with a real User-Agent, because Cloudflare may challenge scripted clients.
```json
{"slug":"...","id":"1137461","epoch":1791058832,"date":"2026-10-03T20:20:32+00:00","company":"...","position":"Head of Operations",
 "tags":["exec"],"description":"<p>...</p>","location":"","apply_url":"https://remoteOK.com/remote-jobs/...","url":"...",
 "salary_min":170000,"salary_max":350000,"verified":true,"original":true,"logo":"","company_logo":""}
```
- India: `location` is free text and 37 of the first 100 entries are empty, so most jobs are effectively worldwide. There is no structured country field. Some text is mojibake, so decode as UTF-8. Salary is USD, and 0 means absent.

### Himalayas  (VERIFIED, 200, totalCount 117,354)
- Browse: `GET https://himalayas.app/jobs/api?limit=20&cursor=<nextCursor>`. Search: `GET https://himalayas.app/jobs/api/search?q=backend&country=IN&seniority=Senior&employment_type=Full%20Time&company=slug&timezone=&sort=recent&page=1`. OpenAPI: `https://himalayas.app/docs/openapi.json`.
- No auth. Max `limit` is 20. Cursor pagination is preferred (`nextCursor`; offset is deprecated). Data is refreshed every 24 hours. Rate limited with HTTP 429, so poll once a day at most.
- ToS: show a visible link back to himalayas.app and mention it as the source.
```json
{"updatedAt":..,"nextCursor":"MjAy...","limit":20,"totalCount":117354,"jobs":[{
 "title":"Senior Software Engineer (YDB Team)","excerpt":"...","companyName":"Nebius","companySlug":"nebius",
 "employmentType":"Full Time","minSalary":null,"maxSalary":null,"salaryPeriod":"annual","currency":null,
 "seniority":["Senior"],"locationRestrictions":[],"timezoneRestrictions":[-11,-10,...],
 "categories":["..."],"parentCategories":["Engineering"],"description":"<p>...</p>",
 "pubDate":1791509657,"expiryDate":1796695722,
 "applicationLink":"https://himalayas.app/companies/nebius/jobs/...","guid":"https://himalayas.app/..."}]}
```
- Doc vs live discrepancies: the docs say `locationRestrictions` is `[{alpha2,name,slug}]`, and the live samples I saw were all empty arrays, which means worldwide. Docs say `pubDate` is in ms, but live values are epoch SECONDS (1791509657), so normalise defensively (a value above 1e11 means ms). `timezoneRestrictions` are UTC offsets, so India = 5.5.
- India: server-side `country=IN` returns a mix of worldwide jobs and jobs that list India (java + IN = 585 hits). Check client-side that `locationRestrictions` is empty OR contains alpha2 "IN". This is the best India-identification field of any aggregator.

### Jobicy  (VERIFIED, 200 with params)
- `GET https://jobicy.com/api/v2/remote-jobs?count=50&geo=apac&industry=dev&tag=java&after=...`. Lookups: `?get=locations` and `?get=industries`. Cursor pagination via `nextCursor` and `hasMore`. There is no "india" geo slug. Valid slugs are anywhere, apac, emea, latam, usa, uk, singapore, and others. Passing `geo=india` returns HTTP 400.
- No auth. ToS (the `friendlyNotice` in each response): credit Jobicy with a direct link, and every apply button must redirect to the original Jobicy job URL. Docs are at https://jobi.cy/apidocs. The rate limit is not published, so poll at most hourly and keep `count` modest.
```json
{"apiVersion":"2.2.19","jobCount":2,"lastUpdate":"...","nextCursor":"...","hasMore":true,"jobs":[{
 "id":148702,"url":"https://jobicy.com/jobs/148702-...","jobSlug":"...","jobTitle":"Engineering Manager - Linux Hardware Enablement",
 "companyName":"Canonical","companyLogo":"...","jobIndustry":["Software Engineering"],"jobType":["Full-Time"],
 "jobGeo":"APAC,  EMEA,  LATAM,  Canada,  USA","jobLevel":"Midweight","jobExcerpt":"...","jobDescription":"<p>..</p>",
 "pubDate":"2026-10-08T03:35:17+00:00","salaryMin":..,"salaryMax":..,"salaryCurrency":"..","salaryPeriod":".."}]}
```
- Salary fields are present only on some jobs (key list from a `tag=java` response: salaryMin, salaryMax, salaryCurrency, salaryPeriod).
- India: `jobGeo` is a free-text region list. India-eligible = contains Anywhere, APAC, or Asia. There is no country-level India slug.

### We Work Remotely RSS  (VERIFIED, 200)
- `GET https://weworkremotely.com/categories/remote-back-end-programming-jobs.rss` (also remote-full-stack-programming-jobs and remote-devops-sysadmin-jobs). Also `https://weworkremotely.com/remote-jobs.rss`. XML RSS 2.0 with `ttl` 60 and only a handful of items per category (4 in this fetch). There is no pagination.
- Auth: none. Terms: RSS is offered for feed readers. Link back to the WWR URL, and do not republish.
```xml
<item><title>Twikey: Senior Java Developer</title><region>Anywhere in the World</region>
 <country>list of flag-emoji country names, EU only here</country><state>Région Flamande</state>
 <skills>Java, PostgreSQL, and Spring</skills><category>Back-End Programming</category><type>Full-Time</type>
 <description>&lt;p&gt;HTML-escaped...&lt;/p&gt;</description>
 <pubDate>Thu, 17 Sep 2026 10:51:23 +0000</pubDate><expires_at>Sat, 17 Oct 2026 10:51:23 +0000</expires_at>
 <guid>https://weworkremotely.com/remote-jobs/twikey-senior-java-developer</guid><link>same as guid</link></item>
```
- India: `<country>` lists eligible countries with flags. The `<region>` tag can say "Anywhere in the World". India-eligible = region is Anywhere or country contains "India". The Twikey job is "Anywhere" in region but its country list is EU-only, so check `country` as well as `region`. No salary field. Compensation appears only in the description text.

---
## India-identification summary
| Source | Structured? | How |
|---|---|---|
| Greenhouse | no | regex on `location.name` |
| Lever | yes | `country == "IN"` and `categories.allLocations`, `workplaceType` |
| Ashby | partial | `location` and `secondaryLocations[].location` text, `address.postalAddress.addressCountry`, `isRemote` |
| Workable | yes | `locations[].countryCode`, `telecommuting` |
| SmartRecruiters | yes | `location.country == "in"` (also `country=in` filter), `location.remote` |
| Recruitee | yes | `country_code`, `remote` |
| Himalayas | yes (best) | `locationRestrictions` (empty = worldwide), `timezoneRestrictions` includes 5.5 |
| Remotive | free text | `candidate_required_location` |
| RemoteOK | free text | `location` (mostly empty = worldwide) |
| Jobicy | free text | `jobGeo` (no India slug) |
| WWR | yes | `<region>` and `<country>` |

---
## Company slugs (checked 2026-10-09)
"VERIFIED" = endpoint returned HTTP 200 with jobs today. "IN-eng" = engineering-like titles with an India location. "IN-remote" = those whose location or workplaceType also says remote.

### Greenhouse (`boards-api.greenhouse.io/v1/boards/{slug}/jobs`)
| slug | status | jobs | India notes |
|---|---|---|---|
| coinbase | VERIFIED | 220 | many "Remote - India" (Senior Eng Manager, ML Engineer, Sr IT Automation Eng) |
| twilio | VERIFIED | 136 | 8 "Remote - India" (Principal Engineer L5, ML Eng L3, Applications Eng 2) |
| airbnb | VERIFIED | 159 | "Senior Staff Software Engineer, Payments - Remote - Bangalore, India" (best Staff backend lead) |
| gitlab | VERIFIED | 220 | "Intermediate Backend Engineer, India" (Bangalore), "Remote, India" roles |
| stripe | VERIFIED | 728 | Bengaluru SWE (e.g. Stripe Data Pipeline), not remote |
| databricks | VERIFIED | 894 | 47 India eng roles (e.g. Engineering Manager - Backend), Bengaluru, not remote |
| okta | VERIFIED | 375 | 77 Bengaluru eng roles incl. SRE |
| mongodb | VERIFIED | 396 | 34 India (Lead Platform Engineering, Gurugram) |
| elastic | VERIFIED | 415 | Bangalore roles |
| samsara | VERIFIED | 238 | "Staff Software Engineer - Platform and Infrastructure", Bengaluru |
| toast | VERIFIED | 310 | Principal SWE Bengaluru/Chennai |
| gleanwork | VERIFIED | 131 | Bangalore eng roles |
| rubrik | VERIFIED | 132 | 9 Bangalore Principal/Staff eng |
| zscaler | VERIFIED | 375 | Hyderabad/Bangalore distributed systems, 2 "Remote - India" |
| sumologic | VERIFIED | 9 | Staff SWE Noida/Bangalore |
| newrelic | VERIFIED | 49 | Lead SWE Hyderabad |
| yugabyte | VERIFIED | 14 | Sr Software Engineer / Staff Engineer, India |
| singlestore | VERIFIED | 44 | Cloud Platform Engineer / Software Engineer, India |
| starburst | VERIFIED | 32 | AI Platform Engineer, India |
| bitgo | VERIFIED | 43 | "Backend Engineer E2 - Ecosystem", India |
| pingidentity | VERIFIED | 51 | Staff SWE Bengaluru |
| commvault | VERIFIED | 58 | "Backend - Senior Engineer", Bangalore |
| cockroachlabs | VERIFIED | 18 | "Member of Technical Staff (Senior)", Bangalore |
| neo4j | VERIFIED | 67 | 1 "Remote: India" Cloud Operations Engineer |
| fivetran, anaplan, appian, netskope, purestorage, druva, logicmonitor | VERIFIED | 36 to 360 | Sizeable India eng presence, mostly onsite or hybrid |
| datadog, cloudflare, grafanalabs, canonical, reddit, roblox, pagerduty, mixpanel, dropbox, discord, figma, anthropic, robinhood, lyft, instacart | VERIFIED (boards live) | 32 to 647 | No India-eng matches today (global-remote roles may exist under non-India location text) |
| postman, razorpay, hasura, hashicorp, confluent, juspay, cred, phonepe, meesho | NOT ON GREENHOUSE | 0 | Returned empty or 404 board. Use their own site, Ashby or Lever |

### Ashby (`api.ashbyhq.com/posting-api/job-board/{slug}`)
| slug | status | jobs | India notes |
|---|---|---|---|
| confluent | VERIFIED | 17 | "Staff Software Engineer I - SRE", "IN Remote India" (Kafka vendor) |
| paxos | VERIFIED | 18 | "Data Platform Engineer, Remote - India" |
| atlan | VERIFIED | 7 | "Principal Software Engineer - Agent & App Platform", India remote |
| astronomer | VERIFIED | 23 | "Senior Software Engineer (Python) - India" (Hyderabad) |
| clickhouse | VERIFIED | 194 | "Senior Software Engineer - Identity & Authorization Platform", India (plus other countries) |
| notion | VERIFIED | 133 | SWE Infrastructure, Hyderabad |
| anyscale | VERIFIED | 20 | SWE Ray Core, Platform Infrastructure, Bengaluru |
| sarvam | VERIFIED | 41 | 16 India eng (Delhi), mostly onsite |
| supabase | VERIFIED | 52 | 7 "Remote, Global" eng roles (Software Engineer - Auth, AI Platform Engineer) |
| cohere | VERIFIED | 120 | APAC remote forward-deployed roles |
| openai, cursor, snowflake, ramp, linear, modal, replit, render, sentry, posthog, temporal, zapier, airbyte, neon, camunda, n8n, amplitude | VERIFIED (boards live) | 4 to 816 | India roles are mostly non-engineering or none, so check location text per run |
| deel, vercel | board empty today | 0 | |

### Lever (`api.lever.co/v0/postings/{slug}?mode=json`)
| slug | status | jobs | India notes |
|---|---|---|---|
| veeva | VERIFIED | 937 | 10 India eng roles, 7 remote-flagged (Platform Engineer - Integration Services) |
| paytm | VERIFIED | 183 | "Backend - Senior Software Engineer" and Backend TL/STL (Noida/Bangalore), onsite |
| meesho | VERIFIED | 60 | Engineering Manager - Backend, Bangalore |
| zeta | VERIFIED | 24 | Hyderabad, mostly infra roles |
| mindtickle | VERIFIED | 20 | Pune/Bengaluru eng |
| xsolla | VERIFIED | 185 | APAC dev-evangelist (not backend) |
| spotify, palantir, toptal, binance, gopuff, cred | VERIFIED (boards live) | 8 to 792 | No India backend roles |
| plaid, kong, shopify, mistral, fivetran, clari, highspot | NOT ON LEVER | 0 | |

### SmartRecruiters (`api.smartrecruiters.com/v1/companies/{id}/postings`)
| id | status | notes |
|---|---|---|
| Freshworks | VERIFIED | India postings (Lead Software Engineer - Systems, Staff Engineer - Full Stack, Chennai) |
| ServiceNow | VERIFIED | 699 postings, Hyderabad Principal and Sr SWE |
| Experian | VERIFIED | Hyderabad Senior and Senior Staff Engineers |
| BoschGroup | VERIFIED | embedded/automotive, not backend |
| NielsenIQ | VERIFIED | Chennai |
| Canva | VERIFIED | 100+ postings, no India eng |

### Recruitee: bunq VERIFIED (20 offers, Netherlands, no India). Workable: huggingface VERIFIED via widget (EMEA and US remote roles only, India-eligible roles unlikely).
Workable slugs tried that returned empty or 404 (dataiku, hotjar, payoneer, kpler, talkdesk, and many others) are UNVERIFIED because the Cloudflare rate limit hit during the sweep.

### Honest read on "fully-remote backend open to India"
- The strongest verified, currently-open leads are: airbnb (Remote - Bangalore, Senior Staff SWE Payments), coinbase and twilio (Remote - India, mostly non-backend), confluent (Staff SRE, Remote India), paxos (Data Platform Engineer, Remote India), atlan (Principal SWE, India), supabase (Remote Global), gitlab (Backend Engineer, India), astronomer (Sr SWE Python, India), clickhouse (Sr SWE, India), and veeva (Platform Engineer, remote-flagged).
- GitLab, Supabase, Automattic, Canonical, Grafana and Elastic hire distributed-worldwide, but their India-eligibility is encoded in location text such as "Remote, India" or "Remote, APAC" and not in a flag. Do text matching rather than relying on a boolean.
- Postman, Razorpay, Hasura, Juspay and CRED are NOT on Greenhouse today (Postman, Razorpay, Hasura and Juspay returned empty boards). Cred has 8 Lever postings, none engineering.
- I could not independently confirm any Java, Go or Kafka stack in the live postings by title alone. Confluent and Paxos are the best Kafka and data-platform fits. Filter on description text for `kafka|java|golang`.
