import type { Pack } from '../pack/schema.js';

/** n, en-IN grouped, international grouped, and "N LPA" (n >= 100,000; up to 2 decimals, trailing zeros dropped). */
export function numberForms(n: number): string[] {
  const forms = [String(n), n.toLocaleString('en-IN'), n.toLocaleString('en-US')];
  if (n >= 100_000) forms.push(`${Number((n / 100_000).toFixed(2))} LPA`);
  return [...new Set(forms)];
}

/** Every pack value worth masking (spec §3.4), at least 3 characters, sorted and unique. */
export function maskValues(pack: Pick<Pack, 'contact' | 'facts' | 'roles' | 'naming' | 'offers' | 'eligibility' | 'freelance'>): string[] {
  const out: string[] = [];
  const c = pack.contact;
  out.push(c.name, ...c.name.split(/[^\p{L}]+/u).filter((w) => w.length >= 3), c.email, c.phone, c.phone.replace(/\D/g, ''), c.city, ...c.links);
  for (const f of pack.facts) if (f.employer) out.push(f.employer);
  for (const r of pack.roles) out.push(r.employer);
  for (const [k, v] of Object.entries(pack.naming.employerDisplay)) out.push(k, v);
  out.push(...pack.naming.forbiddenTerms);
  out.push(...pack.eligibility.onsiteCities, ...(pack.eligibility.officeCities ?? []));
  if (pack.offers.floor) out.push(...numberForms(pack.offers.floor.amount));
  out.push(...numberForms(pack.freelance.rateFloorUsdHour));
  return [...new Set(out.map((v) => v.trim()).filter((v) => v.length >= 3))].sort();
}

const esc = (s: string): string => s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');

/** `::add-mask::` lines, with the workflow-command escapes; a multi-line value is also masked line by line. */
export function maskCommands(values: readonly string[]): string[] {
  const out: string[] = [];
  for (const v of values) {
    out.push(`::add-mask::${esc(v)}`);
    const lines = v.split(/\r\n|\r|\n/);
    if (lines.length > 1) for (const l of lines) if (l.length > 0) out.push(`::add-mask::${esc(l)}`);
  }
  return [...new Set(out)];
}
