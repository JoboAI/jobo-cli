/**
 * Nearest-match lookups for what people mistype: flags, commands, fixed
 * values and facet names all go through here, so a typo gets the same kind of
 * answer everywhere.
 */

/** Lower-case, without the separators people swap or drop: `Full Time`, `full_time` and `full-time` are one key. */
function squash(text: string): string {
  return text.toLowerCase().replace(/[\s_-]+/g, "");
}

/** Edit distance where swapping two neighbouring characters counts as one edit (`serach`). */
export function editDistance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const d: number[][] = Array.from({ length: rows }, (_, i) => Array.from({ length: cols }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  const at = (i: number, j: number) => d[i]?.[j] ?? 0;
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let best = Math.min(at(i - 1, j) + 1, at(i, j - 1) + 1, at(i - 1, j - 1) + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) best = Math.min(best, at(i - 2, j - 2) + 1);
      (d[i] as number[])[j] = best;
    }
  }
  return at(a.length, b.length);
}

/**
 * The candidate `input` is another spelling of: the same text in a different
 * case, or with `-`, `_` and spaces swapped or left out (`Remote`, `on-site`,
 * `job-categories` for `job_categories`). Undefined when there is none, or
 * when two candidates would both fit.
 */
export function canonical(input: string, candidates: readonly string[]): string | undefined {
  const lower = input.trim().toLowerCase();
  const exact = candidates.find((candidate) => candidate.toLowerCase() === lower);
  if (exact !== undefined) return exact;
  const key = squash(input);
  const loose = key === "" ? [] : candidates.filter((candidate) => squash(candidate) === key);
  return loose.length === 1 ? loose[0] : undefined;
}

/**
 * The candidate closest to `input`, when it is close enough to be what was
 * meant: a few edits away (in proportion to the length), or one being the
 * start of the other (`senior level` for `senior`). Undefined otherwise: no
 * guess is better than a wrong one.
 */
export function nearest(input: string, candidates: readonly string[]): string | undefined {
  const wanted = squash(input);
  if (wanted === "") return undefined;

  let best: string | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const distance = editDistance(wanted, squash(candidate));
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  if (best !== undefined && bestDistance <= Math.min(3, Math.max(1, Math.floor(wanted.length / 3)))) return best;

  const related = candidates.filter((candidate) => {
    const key = squash(candidate);
    return key.length >= 3 && wanted.length >= 3 && (wanted.startsWith(key) || key.startsWith(wanted));
  });
  return related.length === 1 ? related[0] : undefined;
}

/** ` Did you mean "x"?` (with its leading space), or nothing. `wrap` formats the guess, e.g. as a flag. */
export function didYouMean(
  input: string,
  candidates: readonly string[],
  wrap: (guess: string) => string = (guess) => `"${guess}"`,
): string {
  const guess = nearest(input, candidates);
  return guess === undefined ? "" : ` Did you mean ${wrap(guess)}?`;
}
