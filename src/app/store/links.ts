import { idScope, type AtsIdPlatform } from '../text/ats-id.js';

/** Sources that are the employer's own ATS or career site; their listing is preferred over a feed's (the v1 rule). */
export const ATS_SOURCES: ReadonlySet<string> = new Set(['greenhouse', 'lever', 'ashby', 'careers']);
/** Sources that only point at a posting elsewhere (freehire leads): ranked after every source that read the job itself. */
export const LEAD_SOURCES: ReadonlySet<string> = new Set(['freehire']);

/** One job row as the linker sees it. */
export interface LinkRow {
  readonly jobKey: string;
  readonly source: string;
  readonly firstSeen: string;
  readonly dedupeKey: string;
  /** The row's ATS id (`text/ats-id.ts`), with the posting's own board (`slug`) and its company's normalised name. */
  readonly ats: {
    readonly platform: AtsIdPlatform;
    readonly board: string | null;
    readonly id: string;
    readonly slug: string;
    readonly companyNorm: string;
  } | null;
  /** Fix round 5: a tenant-scoped posting's board ref and platform id (its source id split), with its company. */
  readonly tenant?: { readonly board: string; readonly id: string; readonly companyNorm: string } | null;
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The v1 order: an ATS source over a feed, then the earliest first_seen, then the job key. */
export function preferred(a: Pick<LinkRow, 'source' | 'firstSeen' | 'jobKey'>, b: Pick<LinkRow, 'source' | 'firstSeen' | 'jobKey'>): number {
  const rank = (s: string) => (ATS_SOURCES.has(s) ? 0 : LEAD_SOURCES.has(s) ? 2 : 1);
  return rank(a.source) - rank(b.source) || cmp(a.firstSeen, b.firstSeen) || cmp(a.jobKey, b.jobKey);
}

interface Comp {
  readonly members: string[];
  /** `<company>\0<id scope>` (`idScope`: the platform for global ids, else platform and board) -> the one job id the component has there. */
  readonly slots: Map<string, string>;
  readonly sources: Set<string>;
  /** Whether an ATS-id match joined rows of this component. */
  ats: boolean;
}

/**
 * Who is a duplicate of whom (career-sites Task 10, spec §4): `duplicateOf` for every row (null for a primary), and the
 * named notes of the ATS-id collisions it refused. Deterministic: it depends on the rows' fields, never their order.
 *
 * 1. **ATS id.** Rows of one company (`companyNorm`, the coverage name matcher's fixed normalisation; a generic name has
 *    none) with the same `<platform>:<board>:<id>` are one job. A board-less ref (a bare `gh_jid`) takes the board of
 *    the company's stored rows that carry this very id (Greenhouse ids are global): one board, that board; several, no
 *    merge and an `ats-id-ambiguous` note. Only with no such row yet does it fall back to the company's one known board
 *    on the platform (the boards its other rows state plus `knownBoards`, the verified registry); none or several:
 *    unmerged. So a second board appearing later can never split a pair the stored row joined. Two rows from the SAME source and board with one key are a source bug, never
 *    hidden: no row of that key is merged, and an `ats-id-collision` note names them.
 * 1c. **Retired board ref (fix round 5).** A tenant-scoped posting's identity is `<board ref>|<platform id>`
 *    (`postingSourceId`), so a registry re-verify that changes the ref (a host move, a tenant rename) gives the same job
 *    a new row. Rows of one company and source with one platform id AND one v1 dedupe key (title and place, fix round 6)
 *    under different refs are linked when at most one of those refs is a current registry board of the company
 *    (`currentBoards`); two current boards are two tenants: never linked, an `ats-id-ambiguous` note. With no registry
 *    view nothing is linked. Only rows seen again are re-linked. Accepted: a rename whose title or place was also
 *    edited is two rows (a visible duplicate, never a hidden job).
 * 2. **v1 dedupe key, unchanged.** In each dedupe group the preferred row (`preferred`) takes every row from another
 *    source. Such a link is refused when it would put two different ids of one company in one job within their
 *    `idScope` (any board of a global-id platform, Greenhouse, Lever, Ashby; the same board or tenant otherwise): the ids
 *    prove two jobs. It is also refused when, in a job an ATS id joined, it would add a second row of one source.
 * 3. **Primary.** The earliest first_seen (then job key) among the job's rows, an ATS source, or a row an ATS id joined,
 *    ahead of a feed: with no ATS id this is the v1 preferred row exactly.
 */
export function linkJobs(
  rows: readonly LinkRow[],
  knownBoards: (companyNorm: string, platform: AtsIdPlatform) => readonly string[],
  currentBoards: ((companyNorm: string, source: string) => ReadonlySet<string>) | null = null,
): { duplicateOf: Map<string, string | null>; notes: string[]; slots: Map<string, { scope: string; id: string }> } {
  const sorted = [...rows].sort((a, b) => cmp(a.jobKey, b.jobKey));
  const byKey = new Map(sorted.map((r) => [r.jobKey, r]));
  const notes: string[] = [];

  // 1a. resolved keys: a board-less ref takes the company's one known board on its platform
  const boardsOf = new Map<string, Set<string>>();
  for (const r of sorted) {
    if (r.ats === null || r.ats.board === null) continue;
    const k = `${r.ats.companyNorm}\u0000${r.ats.platform}`;
    boardsOf.set(k, (boardsOf.get(k) ?? new Set()).add(r.ats.board));
  }
  // Fix round 1 (I2a): the boards whose stored rows carry each job id (Greenhouse job ids are global)
  const idBoards = new Map<string, Set<string>>();
  for (const r of sorted) {
    if (r.ats === null || r.ats.board === null) continue;
    const k = `${r.ats.companyNorm}\u0000${r.ats.platform}\u0000${r.ats.id}`;
    idBoards.set(k, (idBoards.get(k) ?? new Set()).add(r.ats.board));
  }
  const ambiguous = new Map<string, { platform: AtsIdPlatform; id: string; boards: string[]; keys: string[] }>();
  const slotOf = new Map<string, { slot: string; scope: string; id: string; key: string }>();
  for (const r of sorted) {
    if (r.ats === null || r.ats.companyNorm === '') continue;
    let board = r.ats.board;
    if (board === null) {
      // a bare id: the one board a stored row of the company lists this very id on; else (no such row yet) the company's
      // one known board on the platform. A stored match is never undone by another board appearing later.
      const k = `${r.ats.companyNorm}\u0000${r.ats.platform}\u0000${r.ats.id}`;
      const withId = [...(idBoards.get(k) ?? [])].sort();
      if (withId.length > 1) {
        const a = ambiguous.get(k) ?? { platform: r.ats.platform, id: r.ats.id, boards: withId, keys: [] };
        a.keys.push(r.jobKey);
        ambiguous.set(k, a);
        continue;
      }
      if (withId.length === 1) board = withId[0] as string;
      else {
        const known = new Set([...(boardsOf.get(`${r.ats.companyNorm}\u0000${r.ats.platform}`) ?? []), ...knownBoards(r.ats.companyNorm, r.ats.platform)]);
        if (known.size !== 1) continue;
        board = [...known][0] as string;
      }
    }
    slotOf.set(r.jobKey, {
      slot: `${r.ats.companyNorm}\u0000${r.ats.platform}:${board}`,
      scope: `${r.ats.companyNorm}\u0000${idScope(r.ats.platform, board)}`,
      id: r.ats.id,
      key: `${r.ats.platform}:${board}:${r.ats.id}`,
    });
  }
  for (const k of [...ambiguous.keys()].sort()) {
    const a = ambiguous.get(k) as { platform: AtsIdPlatform; id: string; boards: string[]; keys: string[] };
    const what = a.platform === 'greenhouse' ? 'gh_jid' : a.platform;
    notes.push(`ats-id-ambiguous ${what} ${a.id}: boards ${a.boards.join(', ')} ${a.boards.length === 2 ? 'both' : 'all'} list it (${a.keys.sort().join(', ')}); not merged`);
  }

  // union-find over components
  const parent = new Map<string, string>();
  const comps = new Map<string, Comp>();
  for (const r of sorted) {
    parent.set(r.jobKey, r.jobKey);
    const s = slotOf.get(r.jobKey);
    comps.set(r.jobKey, { members: [r.jobKey], slots: new Map(s ? [[s.scope, s.id]] : []), sources: new Set([r.source]), ats: false });
  }
  const find = (k: string): string => {
    let x = k;
    while (parent.get(x) !== x) x = parent.get(x) as string;
    return x;
  };
  const join = (a: string, b: string, how: 'ats' | 'v1'): boolean => {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return true;
    const ca = comps.get(ra) as Comp;
    const cb = comps.get(rb) as Comp;
    if (how === 'v1') {
      for (const [slot, id] of cb.slots) if (ca.slots.has(slot) && ca.slots.get(slot) !== id) return false;
      if ((ca.ats || cb.ats) && [...cb.sources].some((s) => ca.sources.has(s))) return false;
    }
    const [keep, gone] = cmp(ra, rb) <= 0 ? [ra, rb] : [rb, ra];
    const ck = comps.get(keep) as Comp;
    const cg = comps.get(gone) as Comp;
    ck.members.push(...cg.members);
    for (const [slot, id] of cg.slots) ck.slots.set(slot, id);
    for (const s of cg.sources) ck.sources.add(s);
    ck.ats = ck.ats || cg.ats || how === 'ats';
    parent.set(gone, keep);
    comps.delete(gone);
    return true;
  };

  // 1b. ATS-id clusters; a key two postings of one source and board share is a collision: no merge, a note
  const clusters = new Map<string, string[]>();
  for (const [jobKey, s] of slotOf) clusters.set(`${s.slot}\u0000${s.id}`, [...(clusters.get(`${s.slot}\u0000${s.id}`) ?? []), jobKey]);
  const joined = new Set<string>();
  for (const id of [...clusters.keys()].sort()) {
    const keys = (clusters.get(id) as string[]).sort();
    if (keys.length < 2) continue;
    const origins = new Map<string, string[]>();
    for (const k of keys) {
      const r = byKey.get(k) as LinkRow;
      const o = `${r.source} ${r.ats?.slug ?? ''}`;
      origins.set(o, [...(origins.get(o) ?? []), k]);
    }
    const twice = [...origins].filter(([, ks]) => ks.length > 1).sort(([a], [b]) => cmp(a, b));
    if (twice.length > 0) {
      const key = (slotOf.get(keys[0] as string) as { key: string }).key;
      for (const [o, ks] of twice) notes.push(`ats-id-collision ${key}: ${o} lists it ${ks.length} times (${ks.join(', ')}); not merged`);
      continue;
    }
    for (const k of keys.slice(1)) join(keys[0] as string, k, 'ats');
    for (const k of keys) joined.add(k);
  }

  // 1c. fix round 5: one tenant-scoped job under two board refs (a re-verify, a host move, a tenant rename). Rows of one
  //     company and source with one platform id on different boards are one job only when at most one of those boards
  //     is a current registry board of the company (the others are retired refs); two current boards are two tenants
  //     whose ids may collide: never linked, and named. With no registry view (null) nothing is linked.
  if (currentBoards !== null) {
    const tenants = new Map<string, LinkRow[]>();
    for (const r of sorted) {
      if (!r.tenant || r.tenant.companyNorm === '') continue;
      // fix round 6: and the same v1 dedupe key (title and place). Ids are small, repeat across tenants and over time,
      // and old rows stay in the store: a rename of one job keeps its title and place; another job with the id does not
      const k = `${r.tenant.companyNorm}\u0000${r.source}\u0000${r.tenant.id}\u0000${r.dedupeKey}`;
      tenants.set(k, [...(tenants.get(k) ?? []), r]);
    }
    for (const k of [...tenants.keys()].sort()) {
      const g = tenants.get(k) as LinkRow[];
      const boards = [...new Set(g.map((r) => (r.tenant as { board: string }).board))].sort();
      if (boards.length < 2) continue;
      const first = g[0] as LinkRow;
      const live = currentBoards((first.tenant as { companyNorm: string }).companyNorm, first.source);
      const current = boards.filter((b) => live.has(b));
      if (current.length > 1) {
        notes.push(`ats-id-ambiguous ${first.source} ${(first.tenant as { id: string }).id}: boards ${current.join(', ')} are both current registry boards (${g.map((r) => r.jobKey).join(', ')}); not merged`);
        continue;
      }
      // one source's rows: the primary is ranked as v1 ranks that source (no ATS-id promotion over a feed)
      for (const r of g.slice(1)) join(first.jobKey, r.jobKey, 'ats');
    }
  }

  // 2. the v1 rule, per dedupe group, in a fixed order
  const groups = new Map<string, LinkRow[]>();
  for (const r of sorted) groups.set(r.dedupeKey, [...(groups.get(r.dedupeKey) ?? []), r]);
  for (const d of [...groups.keys()].sort()) {
    const g = (groups.get(d) as LinkRow[]).sort(preferred);
    const top = g[0] as LinkRow;
    for (const r of g.slice(1)) if (r.source !== top.source) join(r.jobKey, top.jobKey, 'v1');
  }

  // 3. one primary per component
  const rank = (r: LinkRow): number => (ATS_SOURCES.has(r.source) || joined.has(r.jobKey) ? 0 : LEAD_SOURCES.has(r.source) ? 2 : 1);
  const duplicateOf = new Map<string, string | null>();
  for (const c of comps.values()) {
    const members = c.members.map((k) => byKey.get(k) as LinkRow);
    const primary = members.sort((a, b) => rank(a) - rank(b) || cmp(a.firstSeen, b.firstSeen) || cmp(a.jobKey, b.jobKey))[0] as LinkRow;
    for (const m of members) duplicateOf.set(m.jobKey, m === primary ? null : primary.jobKey);
  }
  // each row's resolved ATS id (`<company>\0<platform>:<board>` and the id): the store tells a departing row that is
  // another job from one that is the same job by it
  const slots = new Map([...slotOf].map(([k, v]) => [k, { scope: v.scope, id: v.id }]));
  return { duplicateOf, notes, slots };
}
