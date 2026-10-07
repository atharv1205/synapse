/**
 * Min-max scale into 0..1. If every value is the same we return 0.5 for all of them, so a
 * flat component doesn't skew the blend.
 */
export function normalize(values: Map<string, number>): Map<string, number> {
  const out = new Map<string, number>();
  if (values.size === 0) return out;

  let min = Infinity;
  let max = -Infinity;
  for (const value of values.values()) {
    if (value < min) min = value;
    if (value > max) max = value;
  }

  const span = max - min;
  for (const [key, value] of values) {
    out.set(key, span === 0 ? 0.5 : (value - min) / span);
  }
  return out;
}

/**
 * Commit counts have a long tail. One config file with 400 commits would squash
 * everything else under plain min-max, so run them through log1p first.
 */
export function normalizeChurn(counts: Map<string, number>): Map<string, number> {
  const logged = new Map<string, number>();
  for (const [key, count] of counts) logged.set(key, Math.log1p(Math.max(0, count)));
  return normalize(logged);
}

export interface ScoreWeights {
  /** Weight for graph centrality. */
  centrality: number;
  /** Weight for git churn. */
  churn: number;
}

export const DEFAULT_WEIGHTS: ScoreWeights = { centrality: 0.7, churn: 0.3 };

/** Round to 4 decimals so the JSON stays readable and diffs stay small. */
export function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
