import { canonicalJson } from '../kernel/canonical.js';

export function exactMatch(pairs: readonly { expected: unknown; actual: unknown }[]): number {
  if (pairs.length === 0) return 0;
  return pairs.filter((p) => canonicalJson(p.expected) === canonicalJson(p.actual)).length / pairs.length;
}

/** For a rule or classifier: positive = "the rule fired". */
export function precisionRecall(pairs: readonly { expected: boolean; actual: boolean }[]): { precision: number; recall: number } {
  const tp = pairs.filter((p) => p.expected && p.actual).length;
  const fp = pairs.filter((p) => !p.expected && p.actual).length;
  const fn = pairs.filter((p) => p.expected && !p.actual).length;
  return { precision: tp + fp === 0 ? 1 : tp / (tp + fp), recall: tp + fn === 0 ? 1 : tp / (tp + fn) };
}

/** Average ranks for ties, then Pearson on the ranks. */
export function spearman(xs: readonly number[], ys: readonly number[]): number {
  if (xs.length !== ys.length || xs.length < 2) throw new RangeError('spearman needs two equal-length series of at least 2');
  const rank = (v: readonly number[]) => {
    const order = v.map((x, i) => ({ x, i })).sort((a, b) => a.x - b.x);
    const r = new Array<number>(v.length);
    for (let i = 0; i < order.length; ) {
      let j = i;
      while (j + 1 < order.length && order[j + 1]!.x === order[i]!.x) j++;
      for (let k = i; k <= j; k++) r[order[k]!.i] = (i + j) / 2 + 1;
      i = j + 1;
    }
    return r;
  };
  const rx = rank(xs);
  const ry = rank(ys);
  const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;
  const mx = mean(rx);
  const my = mean(ry);
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < rx.length; i++) {
    const a = rx[i]! - mx;
    const b = ry[i]! - my;
    num += a * b;
    dx += a * a;
    dy += b * b;
  }
  return dx === 0 || dy === 0 ? 0 : num / Math.sqrt(dx * dy);
}
