'use strict';
/* The maths for Analytics: typical value and spread of a plain list of numbers, and ranking.
   Pure: no page, no data, so Node can run it too. */
(function () {
  const sum = (a) => a.reduce((s, x) => s + x, 0);
  /** Value at fraction p (0..1) of a sorted list, between neighbours when it falls between two (Excel's QUARTILE.INC). */
  function quantile(sorted, p) {
    const i = (sorted.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
  }

  /** Typical value and spread. null when there are fewer than 2 numbers: there is nothing to spread.
   *  The list is everything that happened (not a sample), so variance divides by n. */
  function summarize(nums) {
    const a = nums.filter(Number.isFinite).sort((x, y) => x - y);
    const n = a.length;
    if (n < 2) return null;
    const mean = sum(a) / n;
    const variance = sum(a.map((x) => (x - mean) ** 2)) / n;
    const sd = Math.sqrt(variance);
    const q1 = quantile(a, 0.25), q3 = quantile(a, 0.75);
    const freq = new Map();
    a.forEach((x) => freq.set(x, (freq.get(x) || 0) + 1));
    const top = Math.max(...freq.values());
    const modes = top > 1 ? [...freq].filter(([, c]) => c === top).map(([x]) => x) : []; // empty = no value repeats
    return {
      count: n, mean, median: quantile(a, 0.5), modes,
      min: a[0], max: a[n - 1], range: a[n - 1] - a[0],
      variance, sd, q1, q3, iqr: q3 - q1,
      cv: mean ? sd / Math.abs(mean) : null, // spread as a share of the average; lets different units be compared
    };
  }

  /** Biggest first. Equal values share a rank (1, 2, 2, 4). Rows are { value, name, ... }; each gets a `rank`. */
  function rank(rows) {
    const sorted = [...rows].sort((a, b) => b.value - a.value || String(a.name).localeCompare(String(b.name)));
    let last, pos = 0;
    return sorted.map((r, i) => { if (r.value !== last) { pos = i + 1; last = r.value; } return { ...r, rank: pos }; });
  }

  globalThis.Stats = { summarize, rank };
})();
