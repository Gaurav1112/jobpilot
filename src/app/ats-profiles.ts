/**
 * ATS profiles (architecture spec §10, `ats-profiles.v1`). Most ATSs license the same few parsers, so the layout is
 * the same everywhere (single column, Helvetica/Arial, literal "•" bullets, contact details in the body); what
 * differs is the file format each one parses best. Both formats are always rendered; `recommended` names the one to
 * upload. Pure: no imports, so agent code may use it.
 */

export type DocFormat = 'pdf' | 'docx';

export interface AtsProfile {
  readonly id: string;
  readonly recommended: DocFormat;
  readonly note: string;
}

const PDF_NOTE = 'PDF with a text layer: single column, Helvetica, literal bullets';
const DOCX_NOTE = 'DOCX: contact details in the body, never a Word header or footer';

export const ATS_PROFILES: Readonly<Record<string, AtsProfile>> = Object.freeze({
  greenhouse: { id: 'greenhouse', recommended: 'pdf', note: PDF_NOTE },
  lever: { id: 'lever', recommended: 'pdf', note: PDF_NOTE },
  ashby: { id: 'ashby', recommended: 'pdf', note: PDF_NOTE },
  careers: { id: 'careers', recommended: 'pdf', note: PDF_NOTE },
  workday: { id: 'workday', recommended: 'docx', note: DOCX_NOTE },
  icims: { id: 'icims', recommended: 'docx', note: `${DOCX_NOTE} (Textkernel parser)` },
  taleo: { id: 'taleo', recommended: 'docx', note: DOCX_NOTE },
  smartrecruiters: { id: 'smartrecruiters', recommended: 'docx', note: `${DOCX_NOTE} (Textkernel parser)` },
  feed: { id: 'feed', recommended: 'pdf', note: PDF_NOTE },
  unknown: { id: 'unknown', recommended: 'pdf', note: `${PDF_NOTE}; the DOCX is kept too` },
});

/** Hosts (and their subdomains) that identify an ATS from a posting URL, for postings that come through a feed or a careers page. */
const ATS_HOSTS: readonly (readonly [string, string])[] = [
  ['myworkdayjobs.com', 'workday'],
  ['myworkdaysite.com', 'workday'],
  ['icims.com', 'icims'],
  ['taleo.net', 'taleo'],
  ['smartrecruiters.com', 'smartrecruiters'],
  ['greenhouse.io', 'greenhouse'],
  ['lever.co', 'lever'],
  ['ashbyhq.com', 'ashby'],
];

/** The ATS a posting URL is hosted on, or undefined for any other host or an unparseable URL. */
export function atsOfUrl(url: string): string | undefined {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
  return ATS_HOSTS.find(([h]) => host === h || host.endsWith(`.${h}`))?.[1];
}

/**
 * The profile for a posting: its URL's ATS when the host names one (a Workday job found through a feed or a careers
 * page is still a Workday upload), else its `ats` field, else `unknown`.
 */
export function profileFor(ats: string, url?: string): AtsProfile {
  const fromUrl = url === undefined ? undefined : atsOfUrl(url);
  const id = fromUrl ?? ats;
  return Object.hasOwn(ATS_PROFILES, id) ? (ATS_PROFILES[id] as AtsProfile) : (ATS_PROFILES['unknown'] as AtsProfile);
}
