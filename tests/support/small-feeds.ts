/**
 * Task 9: single-job feeds for the nine small platforms, in each platform's real response shape (the recorded ones are
 * in tests/fixtures/small), with the job placed at one of four places. Fictional company, fictional ids.
 */
export type Where = 'blr' | 'remote-in' | 'paris' | 'remote-eu';
export const PLACES: Readonly<Record<Where, { city: string; region: string; country: string; code: string; remote: boolean }>> = {
  blr: { city: 'Bengaluru', region: 'Karnataka', country: 'India', code: 'IN', remote: false },
  'remote-in': { city: 'Bengaluru', region: 'Karnataka', country: 'India', code: 'IN', remote: true },
  paris: { city: 'Paris', region: 'Île-de-France', country: 'France', code: 'FR', remote: false },
  'remote-eu': { city: 'Paris', region: 'Île-de-France', country: 'France', code: 'FR', remote: true },
};
export const TITLE = 'Senior Software Engineer';
const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export const BUILD: Readonly<Record<string, (w: Where, title?: string) => string>> = {
  workable: (w, title = TITLE) => {
    const p = PLACES[w];
    return JSON.stringify({ name: 'Acme', description: 'x', jobs: [{ shortcode: 'ABC123', title, url: 'https://apply.workable.com/j/ABC123', city: p.city, state: p.region, country: p.country, telecommuting: p.remote, employment_type: 'Full-time', published_on: '2026-10-01', description: '<p>Build services.</p>', locations: [{ city: p.city, region: p.region, country: p.country, countryCode: p.code, hidden: false }] }] });
  },
  recruitee: (w, title = TITLE) => {
    const p = PLACES[w];
    return JSON.stringify({ offers: [{ id: 1001, title, slug: 'sse', careers_url: 'https://careers.acme.test/o/sse', location: `${p.city}, ${p.region}, ${p.country}`, city: p.city, country: p.country, country_code: p.code, remote: p.remote, hybrid: false, on_site: !p.remote, published_at: '2026-10-01 09:00:00 UTC', employment_type_code: 'fulltime_permanent', description: '<p>Build services.</p>', requirements: '<ul><li>Go</li></ul>', company_name: 'Acme', locations: [{ id: 1, name: p.city, state: p.region, country: p.country, country_code: p.code }] }] });
  },
  teamtailor: (w, title = TITLE) => {
    const p = PLACES[w];
    return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:tt="https://teamtailor.com/locations"><channel><title>Acme</title><item><title>${esc(title)}</title><description>&lt;p&gt;Build services.&lt;/p&gt;</description><pubDate>Thu, 01 Oct 2026 09:00:00 +0200</pubDate><link>https://career.acme.test/jobs/1-sse</link><remoteStatus>${p.remote ? 'fully' : 'none'}</remoteStatus><guid>aaaa-bbbb</guid><tt:locations><tt:location><tt:name>${p.city}</tt:name><tt:city>${p.city}</tt:city><tt:country>${p.country}</tt:country></tt:location></tt:locations><tt:department>Eng</tt:department></item></channel></rss>`;
  },
  personio: (w, title = TITLE) => {
    const office = w === 'blr' ? 'Bengaluru' : w === 'remote-in' ? 'Remote India' : w === 'paris' ? 'Paris' : 'Remote EU';
    return `<?xml version="1.0" encoding="UTF-8"?><workzag-jobs><position><id>9001</id><subcompany>Acme GmbH</subcompany><office>${office}</office><additionalOffices></additionalOffices><department>Eng</department><recruitingCategory>Engineering</recruitingCategory><name>${esc(title)}</name><jobDescriptions><jobDescription><name>Tasks</name><value><![CDATA[<p>Build services.</p>]]></value></jobDescription></jobDescriptions><employmentType>permanent</employmentType><schedule>full-time</schedule><createdAt>2026-10-01T09:00:00+00:00</createdAt></position></workzag-jobs>`;
  },
  bamboohr: (w, title = TITLE) => {
    const p = PLACES[w];
    return JSON.stringify({ meta: { totalCount: 1 }, result: [{ id: '7', jobOpeningName: title, departmentLabel: 'Eng', employmentStatusLabel: 'Full-Time', atsLocation: { country: p.country, state: p.region, province: null, city: p.city }, location: { city: p.city, state: p.region }, isRemote: p.remote ? true : null, locationType: '0' }] });
  },
  breezy: (w, title = TITLE) => {
    const p = PLACES[w];
    return JSON.stringify([{ id: 'a1b2c3', friendly_id: 'a1b2c3-sse', name: title, url: 'https://acme.breezy.hr/p/a1b2c3-sse', published_date: '2026-10-01T09:00:00.000Z', type: { id: 'fullTime', name: 'Full-Time' }, location: { country: { name: p.country, id: p.code }, state: { id: 'XX', name: p.region }, city: p.city, name: `${p.city}, ${p.region}`, is_remote: p.remote }, department: 'Eng', company: { name: 'Acme' }, locations: [] }]);
  },
  pinpoint: (w, title = TITLE) => {
    const p = PLACES[w];
    return JSON.stringify({ data: [{ id: '9', title, url: 'https://acme.pinpointhq.com/en/postings/1', path: '/en/postings/1', description: '<p>Build services.</p>', key_responsibilities: '<ul><li>Ship</li></ul>', key_responsibilities_header: 'What you will do', workplace_type: p.remote ? 'remote' : 'onsite', employment_type_text: 'Full Time', compensation_visible: false, location: { id: '1', name: p.remote ? 'Remote' : p.city, city: p.city, province: p.region }, job: { department: { name: 'Eng' } } }] });
  },
  rippling: (w, title = TITLE) => {
    const label = w === 'blr' ? 'Bengaluru, India' : w === 'remote-in' ? 'Remote (Bengaluru, India)' : w === 'paris' ? 'Paris, France' : 'Remote (Paris, France)';
    return JSON.stringify([{ uuid: '11111111-2222-3333-4444-555555555555', name: ` ${title} `, department: { id: 'Eng', label: 'Eng' }, url: 'https://ats.rippling.com/acme/jobs/11111111-2222-3333-4444-555555555555', workLocation: { label, id: label } }]);
  },
  gem: (w, title = TITLE) => {
    const p = PLACES[w];
    return JSON.stringify([{ id: 5001, title, absolute_url: 'https://jobs.gem.com/acme/5001', content: '<p>Build services.</p>', location: { name: `${p.city}, ${p.country}` }, location_type: p.remote ? 'remote' : 'in_office', offices: [], departments: [{ id: '1', name: 'Eng' }], employment_type: 'full_time', first_published_at: '2026-10-01T09:00:00.000Z' }]);
  },
};
