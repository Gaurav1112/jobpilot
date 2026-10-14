import { childText, children, parseXml, XmlError, type XmlNode } from '../../../text/xml-lite.js';
import type { RawPosting } from '../../../types.js';
import { feedBoard, feedProblem, sortedNames, textOf, type FeedPage } from './feed-board.js';

/**
 * Personio (career-sites spec §4, Task 9): the officially documented XML feed, `GET https://<slug>.jobs.personio.de/xml`
 * (or `.jobs.personio.com`). A board is its host (the ref and the DiscoveryRequest slug). One request returns every
 * position (no paging). Documented API: robots.txt is not asked (it says `Allow: /` anyway); a 401/403/429 disables the
 * host.
 *
 * The feed is `<workzag-jobs><position>…`, read with the linear XML reader. A document that is not that is a page-level
 * problem. A position needs an `id` and a `name`, else it is skipped with a note. The feed has no remote flag and its
 * offices are city names without a country. `raw` (normalizer mapper `personio`): `{ id, title, url, offices,
 * subcompany, department, category, employmentType, schedule, seniority, createdAt, description }`; `offices` = `office`
 * then `additionalOffices`; `description` = each `jobDescription` as `<h3>name</h3>value` (the feed carries none for a
 * board that does not publish them, seen live); `url` = `https://<host>/job/<id>` (the apply URL). `sourceId` = the id.
 */

export const PERSONIO_EGRESS = 'registry:personio-hosts';
const HOST = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.jobs\.personio\.(?:de|com)$/u;

export const parsePersonioRef = (ref: string): string | null => (HOST.test(ref) ? ref : null);
export const personioUrl = (host: string): string => `https://${host}/xml`;

export function personioBoardOfUrl(boardUrl: string): string | null {
  try {
    const u = new URL(boardUrl);
    return u.protocol === 'https:' && u.port === '' && u.pathname === '/xml' ? parsePersonioRef(u.hostname.toLowerCase()) : null;
  } catch {
    return null;
  }
}

export function parsePersonio(body: string, host: string, req: { company: string; slug: string }): FeedPage {
  const what = `personio ${host}`;
  let root: XmlNode;
  try {
    root = parseXml(body);
  } catch (e) {
    if (e instanceof XmlError) throw feedProblem(what, `the response is not an XML feed (${e.message})`);
    throw e;
  }
  if (root.name !== 'workzag-jobs') throw feedProblem(what, 'the response is not a Personio feed (no <workzag-jobs>)');
  const positions = children(root, 'position');
  const postings: RawPosting[] = [];
  const malformed: string[] = [];
  const names: (string | null)[] = [];
  positions.forEach((p, i) => {
    const id = childText(p, 'id');
    const name = childText(p, 'name');
    if (id === null || !/^\d{1,18}$/u.test(id)) return void malformed.push(`entry ${i}: no id`);
    if (name === null || name === '') return void malformed.push(`entry ${i}: blank title`);
    const extra = children(children(p, 'additionalOffices')[0] ?? { name: '', text: '', children: [] }, 'office').map((o) => textOf(o.text));
    const offices = [...new Set([textOf(childText(p, 'office')), ...extra].filter((x): x is string => x !== null))];
    const desc = children(children(p, 'jobDescriptions')[0] ?? { name: '', text: '', children: [] }, 'jobDescription')
      .map((d) => {
        const v = textOf(childText(d, 'value'));
        const n = textOf(childText(d, 'name'));
        return v === null ? null : n === null ? v : `<h3>${n.replace(/[<>&]/gu, '')}</h3>${v}`;
      })
      .filter((x): x is string => x !== null);
    names.push(textOf(childText(p, 'subcompany')));
    const raw = {
      id,
      title: name,
      url: `https://${host}/job/${id}`,
      offices,
      subcompany: textOf(childText(p, 'subcompany')),
      department: textOf(childText(p, 'department')),
      category: textOf(childText(p, 'recruitingCategory')),
      employmentType: textOf(childText(p, 'employmentType')),
      schedule: textOf(childText(p, 'schedule')),
      seniority: textOf(childText(p, 'seniority')),
      createdAt: textOf(childText(p, 'createdAt')),
      description: desc.length > 0 ? desc.join('\n') : null,
    };
    postings.push({ source: 'personio', sourceId: id, company: req.company, slug: req.slug, raw });
  });
  // one company name only when every position agrees; several subcompanies are one employer's subsidiaries, so none
  const distinct = sortedNames(names);
  return { postings, malformed, listed: positions.length, names: distinct.length === 1 ? distinct : [], total: null };
}

export const personio = feedBoard<string>({
  platform: 'personio',
  label: 'Personio',
  team: 'sourcing-personio',
  egress: PERSONIO_EGRESS,
  documented: true,
  fixedHost: null,
  parseRef: parsePersonioRef,
  refOf: (s) => s,
  hostOf: (s) => s,
  urlOf: personioUrl,
  boardOfUrl: personioBoardOfUrl,
  nameKey: (host) => host.split('.')[0] ?? host,
  parse: (body, host, req) => parsePersonio(body, host, req),
});
export const srcPersonioContract = personio.contract;
export const makeSrcPersonio = personio.make;
