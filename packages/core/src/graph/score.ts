/**
 * Scales values into 0..1 by min-max. A flat input (every value identical) maps to
 * 0.5 across the board, which keeps a degenerate component from dominating the blend.
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
 * Commit counts are heavy-tailed — one config file with 400 commits would flatten
 * everything else under min-max. Compressing with log1p first keeps the mid-range legible.
 */
export function normalizeChurn(counts: Map<string, number>): Map<string, number> {
  const logged = new Map<string, number>();
  for (const [key, count] of counts) logged.set(key, Math.log1p(Math.max(0, count)));
  return normalize(logged);
}

export interface ScoreWeights {
  /** Weight on graph centrality. */
  centrality: number;
  /** Weight on git churn. */
  churn: number;
}

export const DEFAULT_WEIGHTS: ScoreWeights = { centrality: 0.7, churn: 0.3 };

/** Rounds to 4 decimals so the JSON output stays readable and diff-friendly. */
export function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
