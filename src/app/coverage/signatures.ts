import type { Platform } from './types.js';

/**
 * The platform signature table (spec §3) as data: for each ATS, the hosts its boards live on and how a URL on them
 * names the board (slug) and the URL the platform's adapter reads (boardUrl). It is the single source of platform host
 * data: `platform-hosts.ts` derives `PLATFORM_HOSTS` and `platformForHost` from it.
 *
 * Matching works on parsed URLs only (never a RegExp built from page content). A row's `board` returns:
 * - `{ slug, boardUrl }` when the URL names a board;
 * - `'slugless'` when the URL is on the platform but names no board (a vendor asset, a bare root, a job link without
 *   the tenant): a signal of the platform that cannot be used on its own;
 * - `null` when the URL is not this platform's.
 *
 * Slugs keep their case where the platform is case-sensitive (SmartRecruiters company ids, Workday sites, Oracle site
 * numbers, SuccessFactors company ids, Workable, Ashby, Rippling, Gem) and are lower-cased where it is not (host names,
 * Greenhouse and Lever board tokens). Query strings and fragments never reach a slug.
 *
 * Page-level signals that are not a URL (a Phenom front-end, `gh_jid=`, a Teamtailor or SuccessFactors asset on the
 * company's own host, an Eightfold script) are the detector's (detector.ts), with the markers listed here.
 */

export type BoardMatch = { readonly slug: string; readonly boardUrl: string } | 'slugless' | null;

export interface PlatformHost {
  readonly suffix: string;
  /** A vendor suffix that is also the vendor's marketing domain: only a tenant subdomain (not the apex, not `www.`) is a board host. */
  readonly tenantOnly?: boolean;
}

export interface SignatureRow {
  readonly platform: Exclude<Platform, 'jsonld-sitemap'>;
  /** The hosts of this platform's boards, in table order (`PLATFORM_HOSTS` keeps this order). */
  readonly hosts: readonly PlatformHost[];
  /** What a URL names on this platform. `u` is an https URL with a lower-case host; the host may be any host (Eightfold API paths). */
  readonly board: (u: URL) => BoardMatch;
}

const segs = (u: URL): string[] => u.pathname.split('/').filter((s) => s !== '');
/** A path slug: letters, digits, `.`, `_`, `-`; nothing encoded. */
const SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
/** A locale path segment: language-COUNTRY only (`en-US`, the only form seen in the recorded Workday URLs), so a two-letter site name stays a site. */
const LOCALE = /^[a-z]{2}-[A-Z]{2}$/u;
/** First labels of a vendor's own infrastructure, never a tenant. */
const RESERVED_LABELS: ReadonlySet<string> = new Set([
  'www', 'app', 'api', 'cdn', 'static', 'assets', 'help', 'support', 'blog', 'status', 'docs', 'login', 'developer', 'developers', 'community', 'marketplace', 'info', 'go',
]);

/** A vendor's asset subdomain (`assets-cdn.breezy.hr`, `static-eu.example`): one of these words as a dash-separated part. */
const ASSET_LABEL = /(?:^|-)(?:cdn|assets|static|media|img|images|fonts)(?:-|$)/u;
const reservedLabel = (label: string): boolean => RESERVED_LABELS.has(label) || ASSET_LABEL.test(label);
/** First path segments that are a site's own assets, never a board (`jobs.lever.co/js/…`). */
const ASSET_SEGMENTS: ReadonlySet<string> = new Set(['js', 'css', 'img', 'images', 'assets', 'static', 'fonts', 'media', '_next', 'build', 'dist', 'favicon.ico', 'robots.txt', 'sitemap.xml']);
/** A path segment that is a file (`manifest.json`, `main.css`), never a board. */
const FILE_SEGMENT = /\.(?:json|js|mjs|css|map|ico|png|jpe?g|gif|svg|webp|woff2?|ttf|eot|xml|txt|webmanifest|html?)$/iu;
/** A path segment that can name a board: a plain slug, not an asset directory or a file. */
const boardSegment = (s: string | undefined): s is string => s !== undefined && SLUG.test(s) && !ASSET_SEGMENTS.has(s.toLowerCase()) && !FILE_SEGMENT.test(s);

/** The tenant label of `<label>.<suffix>` (exactly one label, not reserved or an asset host), or null. */
function tenantLabel(host: string, suffix: string): string | null {
  if (!host.endsWith(`.${suffix}`)) return null;
  const label = host.slice(0, -suffix.length - 1);
  return label !== '' && !label.includes('.') && /^[a-z0-9][a-z0-9-]*$/u.test(label) && !reservedLabel(label) ? label : null;
}

/** The first path segment as a slug (case as seen); null when absent, skipped, or not a board segment. */
function firstSeg(u: URL, skip: ReadonlySet<string> = new Set()): string | null {
  const s = segs(u)[0];
  return boardSegment(s) && !skip.has(s.toLowerCase()) ? s : null;
}

const onHost = (u: URL, ...hosts: string[]): boolean => hosts.includes(u.hostname);

function workday(u: URL): BoardMatch {
  const h = u.hostname;
  const jobs = /^([a-z0-9-]+)\.(wd\d+)\.myworkdayjobs\.com$/u.exec(h);
  const site = /^(?:wd\d+\.)?myworkdaysite\.com$/u.test(h);
  if (jobs === null && !site) return null;
  const p = segs(u);
  let tenant: string | null = jobs?.[1] ?? null;
  let name: string | undefined;
  if (p[0] === 'wday' && p[1] === 'cxs') {
    tenant = (p[2] ?? '').toLowerCase() || null;
    name = p[3];
  } else {
    const rest = p[0] !== undefined && LOCALE.test(p[0]) ? p.slice(1) : p;
    if (site) {
      if (rest[0] !== 'recruiting') return 'slugless';
      tenant = (rest[1] ?? '').toLowerCase() || null;
      name = rest[2];
    } else name = rest[0];
  }
  if (tenant === null || !SLUG.test(tenant) || !boardSegment(name) || name === 'wday') return 'slugless';
  return { slug: `${tenant}/${name}`, boardUrl: `https://${h}/wday/cxs/${tenant}/${name}/jobs` };
}

/** Eightfold: the domain parameter (a host name, lower-cased) of a careers or API URL. */
function eightfoldDomain(u: URL): string | null {
  const d = (u.searchParams.get('domain') ?? '').trim().toLowerCase();
  return /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/u.test(d) ? d : null;
}

export function eightfoldBoard(host: string, domain: string): { slug: string; boardUrl: string } {
  return { slug: `${host}/${domain}`, boardUrl: `https://${host}/api/apply/v2/jobs?domain=${domain}` };
}

function eightfold(u: URL): BoardMatch {
  const api = u.pathname.startsWith('/api/apply/v2/jobs') || u.pathname.startsWith('/api/pcsx/');
  const tenant = tenantLabel(u.hostname, 'eightfold.ai') !== null;
  if (!api && !tenant) return null;
  const d = eightfoldDomain(u);
  if (d === null) return 'slugless';
  if (api || u.pathname.startsWith('/careers')) return eightfoldBoard(u.hostname, d);
  return 'slugless';
}

function oracle(u: URL): BoardMatch {
  if (!u.hostname.endsWith('.oraclecloud.com') || u.hostname.startsWith('www.')) return null;
  const p = segs(u);
  let site: string | null = null;
  const ce = p.indexOf('CandidateExperience');
  if (p[0] === 'hcmUI' && ce >= 0) {
    const at = p.indexOf('sites', ce);
    site = at >= 0 ? (p[at + 1] ?? null) : null;
  } else if (p[0] === 'hcmRestApi' && p.some((s) => s.startsWith('recruitingCE'))) {
    // the finder parameter: findReqs;siteNumber=CX_1001,limit=25
    for (const part of (u.searchParams.get('finder') ?? '').split(/[;,]/u)) if (part.startsWith('siteNumber=')) site = part.slice('siteNumber='.length);
  }
  if (site === null || !SLUG.test(site)) return 'slugless';
  return {
    slug: `${u.hostname}/${site}`,
    boardUrl: `https://${u.hostname}/hcmRestApi/resources/latest/recruitingCEJobRequisitions?onlyData=true&finder=findReqs;siteNumber=${site}`,
  };
}

function icims(u: URL): BoardMatch {
  if (!u.hostname.endsWith('.icims.com')) return null;
  const label = u.hostname.slice(0, -'.icims.com'.length);
  if (label === 'www') return null;
  if (label === '' || label.includes('.') || reservedLabel(label)) return 'slugless';
  return { slug: u.hostname, boardUrl: `https://${u.hostname}/sitemap.xml` };
}

function successfactors(u: URL): BoardMatch {
  const h = u.hostname;
  if (!h.endsWith('.successfactors.com') && !h.endsWith('.successfactors.eu')) return null;
  if (h.startsWith('www.')) return null;
  const company = u.searchParams.get('company');
  if (company === null || !SLUG.test(company)) return 'slugless';
  return { slug: `${h}/${company}`, boardUrl: `https://${h}/career?company=${company}` };
}

function smartrecruiters(u: URL): BoardMatch {
  if (!onHost(u, 'jobs.smartrecruiters.com', 'careers.smartrecruiters.com')) return null;
  const p = segs(u);
  const co = p[0] === 'oneclick-ui' ? (p[1] === 'company' ? p[2] : undefined) : p[0];
  if (!boardSegment(co) || ['oneclick-ui', 'api', 'sr-jobs'].includes(co.toLowerCase())) return 'slugless';
  return { slug: co, boardUrl: `https://jobs.smartrecruiters.com/${co}` };
}

/** Workable paths that are not an account: job short links, assets, and the error page a missing account redirects to (`/oops`, seen live). */
const WORKABLE_NOT_BOARDS: ReadonlySet<string> = new Set(['j', 'embed', 'assets', 'static', 'oops']);

function workable(u: URL): BoardMatch {
  if (!onHost(u, 'apply.workable.com')) return null;
  const p = segs(u);
  let slug: string | undefined = p[0];
  if (p[0] === 'api') {
    const at = p.indexOf('accounts');
    slug = at >= 0 ? p[at + 1] : undefined;
  } else if (p[0] !== undefined && WORKABLE_NOT_BOARDS.has(p[0])) slug = undefined;
  if (!boardSegment(slug)) return 'slugless';
  return { slug, boardUrl: `https://apply.workable.com/api/v1/widget/accounts/${slug}` };
}

/** `<label>.<suffix>` platforms whose board is named by the tenant label alone. */
function labelBoard(suffix: string, boardUrl: (label: string, host: string) => string, path?: (u: URL) => boolean): (u: URL) => BoardMatch {
  return (u) => {
    if (u.hostname !== suffix && !u.hostname.endsWith(`.${suffix}`)) return null;
    const label = tenantLabel(u.hostname, suffix);
    if (label === null) return u.hostname === suffix || u.hostname === `www.${suffix}` ? null : 'slugless';
    if (path !== undefined && !path(u)) return 'slugless';
    return { slug: label, boardUrl: boardUrl(label, u.hostname) };
  };
}

function teamtailor(u: URL): BoardMatch {
  const label = tenantLabel(u.hostname, 'teamtailor.com');
  if (label === null) return u.hostname.endsWith('.teamtailor.com') && !u.hostname.startsWith('www.') ? 'slugless' : null;
  return teamtailorBoard(u.hostname);
}

/** A Teamtailor board is named by its host (a `<slug>.teamtailor.com` host or the company's own domain); its feed is `/jobs.rss`. */
export function teamtailorBoard(host: string): { slug: string; boardUrl: string } {
  return { slug: host, boardUrl: `https://${host}/jobs.rss` };
}

/** A SuccessFactors Career Site Builder (RMK) site on the company's own host: its job catalogue is `/sitemal.xml`. */
export function rmkBoard(host: string): { slug: string; boardUrl: string } {
  return { slug: host, boardUrl: `https://${host}/sitemal.xml` };
}

/** `https://<host>/<slug>` platforms (the first path segment names the board). */
/** A decoded board name that may hold spaces (Ashby: `jobs.ashbyhq.com/Blackpoint%20Cyber`). */
const SPACED_SLUG = /^[A-Za-z0-9][A-Za-z0-9 ._-]*$/u;
const decoded = (s: string | undefined): string | undefined => {
  if (s === undefined) return undefined;
  try {
    return decodeURIComponent(s);
  } catch {
    return undefined;
  }
};

/** `https://<host>/<slug>` platforms (the first path segment names the board). With `decode`, the segment is percent-decoded (spaces allowed). */
function pathBoard(
  hosts: readonly string[],
  boardUrl: (slug: string) => string,
  opts: { lower?: boolean; skip?: readonly string[]; locale?: boolean; decode?: boolean } = {},
): (u: URL) => BoardMatch {
  const skip = new Set(opts.skip ?? []);
  return (u) => {
    if (!hosts.includes(u.hostname)) return null;
    const p = segs(u);
    const s0 = opts.locale === true && p[0] !== undefined && LOCALE.test(p[0]) ? p[1] : p[0];
    const d = opts.decode === true ? decoded(s0) : s0;
    const ok = opts.decode === true ? d !== undefined && SPACED_SLUG.test(d) && boardSegment(d.replace(/ /gu, '-')) : boardSegment(d);
    const raw = ok && d !== undefined && !skip.has(d.toLowerCase()) ? d : null;
    if (raw === null) return 'slugless';
    const slug = opts.lower === true ? raw.toLowerCase() : raw;
    return { slug, boardUrl: boardUrl(slug) };
  };
}

function greenhouse(u: URL): BoardMatch {
  if (!onHost(u, 'boards.greenhouse.io', 'job-boards.greenhouse.io')) return null;
  const p = segs(u);
  if (p[0] === 'embed') {
    const f = (u.searchParams.get('for') ?? '').toLowerCase();
    return SLUG.test(f) ? greenhouseBoard(f) : 'slugless';
  }
  const s = firstSeg(u, new Set(['v1', 'embed', 'api']));
  return s === null ? 'slugless' : greenhouseBoard(s.toLowerCase());
}

const greenhouseBoard = (slug: string): { slug: string; boardUrl: string } => ({ slug, boardUrl: `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs` });

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const ZOHO_SUFFIXES = ['zohorecruit.com', 'zohorecruit.in', 'zohorecruit.eu', 'zohorecruit.com.au'] as const;

/** Zoho Recruit: the board is the whole host `<label>.<suffix>` (the TLD is the data region and is part of the board). */
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

/** UKG Pro: detected so the verifier can answer Proposed with the robots reason; never read (sources-x D8). */
function ukgBoard(u: URL): BoardMatch {
  const pro = tenantLabel(u.hostname, 'rec.pro.ukg.net') !== null;
  if (!pro && !onHost(u, 'recruiting.ultipro.com', 'recruiting2.ultipro.com')) return u.hostname.endsWith('.rec.pro.ukg.net') ? 'slugless' : null;
  const p = segs(u);
  const tenant = p[0];
  if (tenant === undefined || p[1]?.toLowerCase() !== 'jobboard' || !GUID.test(p[2] ?? '') || !/^[a-z0-9]{3,32}$/iu.test(tenant)) return 'slugless';
  const guid = (p[2] as string).toLowerCase();
  return { slug: `${u.hostname}/${tenant.toLowerCase()}/${guid}`, boardUrl: `https://${u.hostname}/${tenant.toLowerCase()}/JobBoard/${guid}/` };
}

/** The signature table, in the order of spec §3. `jsonld-sitemap` has no row: it is what is left when no row matches. */
export const SIGNATURES: readonly SignatureRow[] = [
  { platform: 'workday', hosts: [{ suffix: 'myworkdayjobs.com' }, { suffix: 'myworkdaysite.com' }], board: workday },
  { platform: 'eightfold', hosts: [{ suffix: 'eightfold.ai', tenantOnly: true }], board: eightfold },
  { platform: 'oracle', hosts: [{ suffix: 'oraclecloud.com', tenantOnly: true }], board: oracle },
  { platform: 'icims', hosts: [{ suffix: 'icims.com', tenantOnly: true }], board: icims },
  { platform: 'successfactors', hosts: [{ suffix: 'successfactors.com', tenantOnly: true }, { suffix: 'successfactors.eu', tenantOnly: true }], board: successfactors },
  // careers.smartrecruiters.com joined the host list in Task 4 (so the locator also accepts it); boards are read on jobs.
  { platform: 'smartrecruiters', hosts: [{ suffix: 'jobs.smartrecruiters.com' }, { suffix: 'careers.smartrecruiters.com' }], board: smartrecruiters },
  { platform: 'workable', hosts: [{ suffix: 'apply.workable.com' }], board: workable },
  { platform: 'recruitee', hosts: [{ suffix: 'recruitee.com', tenantOnly: true }], board: labelBoard('recruitee.com', (l) => `https://${l}.recruitee.com/api/offers/`) },
  { platform: 'teamtailor', hosts: [{ suffix: 'teamtailor.com', tenantOnly: true }], board: teamtailor },
  {
    platform: 'personio',
    hosts: [{ suffix: 'jobs.personio.de' }, { suffix: 'jobs.personio.com' }],
    board: (u) => labelBoard('jobs.personio.de', (l, h) => `https://${h}/xml`)(u) ?? labelBoard('jobs.personio.com', (l, h) => `https://${h}/xml`)(u),
  },
  {
    platform: 'bamboohr',
    hosts: [{ suffix: 'bamboohr.com', tenantOnly: true }],
    board: labelBoard('bamboohr.com', (l) => `https://${l}.bamboohr.com/careers/list`, (u) => /^\/(?:careers|jobs|js)(?:\/|$)/u.test(u.pathname)),
  },
  { platform: 'breezy', hosts: [{ suffix: 'breezy.hr', tenantOnly: true }], board: labelBoard('breezy.hr', (l) => `https://${l}.breezy.hr/json`) },
  { platform: 'pinpoint', hosts: [{ suffix: 'pinpointhq.com', tenantOnly: true }], board: labelBoard('pinpointhq.com', (l) => `https://${l}.pinpointhq.com/postings.json`) },
  {
    platform: 'rippling',
    hosts: [{ suffix: 'ats.rippling.com' }],
    board: pathBoard(['ats.rippling.com'], (s) => `https://api.rippling.com/platform/api/ats/v1/board/${s}/jobs`, { skip: ['api', 'internal', 'static'], locale: true }),
  },
  { platform: 'gem', hosts: [{ suffix: 'jobs.gem.com' }], board: pathBoard(['jobs.gem.com'], (s) => `https://api.gem.com/job_board/v0/${s}/job_posts/`, { skip: ['api', 'static'] }) },
  { platform: 'greenhouse', hosts: [{ suffix: 'boards.greenhouse.io' }, { suffix: 'job-boards.greenhouse.io' }], board: greenhouse },
  { platform: 'lever', hosts: [{ suffix: 'jobs.lever.co' }], board: pathBoard(['jobs.lever.co'], (s) => `https://api.lever.co/v0/postings/${s}`, { lower: true, skip: ['api', 'static'] }) },
  {
    platform: 'ashby',
    hosts: [{ suffix: 'jobs.ashbyhq.com' }],
    // the slug is the decoded board name; the posting API takes it percent-encoded, as the daily Ashby adapter sends it
    board: pathBoard(['jobs.ashbyhq.com'], (s) => `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(s)}`, { skip: ['api', 'static'], decode: true }),
  },
  // sources-x Task 1
  { platform: 'jazzhr', hosts: [{ suffix: 'applytojob.com', tenantOnly: true }], board: labelBoard('applytojob.com', (l) => `https://${l}.applytojob.com/apply`) },
  { platform: 'zohorecruit', hosts: ZOHO_SUFFIXES.map((suffix) => ({ suffix, tenantOnly: true })), board: zohoBoard },
  { platform: 'manatal', hosts: [{ suffix: 'careers-page.com' }], board: manatalBoard },
  { platform: 'freshteam', hosts: [{ suffix: 'freshteam.com', tenantOnly: true }], board: labelBoard('freshteam.com', (l) => `https://${l}.freshteam.com/jobs`) },
  { platform: 'ukg', hosts: [{ suffix: 'rec.pro.ukg.net', tenantOnly: true }, { suffix: 'recruiting.ultipro.com' }, { suffix: 'recruiting2.ultipro.com' }], board: ukgBoard },
];

/** Page markers that are not board URLs (substrings, matched case-insensitively on host names or page text). */
export const MARKERS = {
  /** A Phenom front-end: route to the ATS its apply links target (`routedFrom: 'phenom'`). */
  phenom: ['phenompeople'],
  /** A Teamtailor career site on the company's own domain (asset hosts). */
  teamtailorAssetHosts: ['teamtailor-cdn.com'],
  /** A SuccessFactors Career Site Builder site on the company's own domain (asset hosts). */
  rmkAssetHosts: ['rmkcdn.successfactors.com'],
  /** An Eightfold career site on a custom domain (script hosts). */
  eightfoldScriptHosts: ['eightfold.ai', 'eightfold-cdn.com', 'vscdn.net'],
  /** The ids of the elements holding an Eightfold site's configuration JSON (with its `domain`). */
  eightfoldConfigIds: ['pcsx-data', 'smartApplyData'],
  /** A Greenhouse job id on a company page. */
  greenhouseJobId: 'gh_jid=',
} as const;

/**
 * Vendor hosts that only report errors or telemetry (seen in the recorded pages): never a platform signal. A closed list,
 * never extended at run time.
 */
export const TELEMETRY_HOSTS: ReadonlySet<string> = new Set(['vs-errors.eightfold.ai', 'content.bhrpendo.bamboohr.com', 'otel-collector.gem.com']);

/** What the URL names: the first row that claims it, with its board or `'slugless'`; null when no row does (or a telemetry host). */
export function matchUrl(u: URL): { readonly platform: SignatureRow['platform']; readonly board: Exclude<BoardMatch, null> } | null {
  if (TELEMETRY_HOSTS.has(u.hostname)) return null;
  for (const row of SIGNATURES) {
    const b = row.board(u);
    if (b !== null) return { platform: row.platform, board: b };
  }
  return null;
}
