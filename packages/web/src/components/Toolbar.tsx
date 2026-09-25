import type { ColorMode } from "./GraphScene";

export interface ToolbarProps {
  fileCount: number;
  /** How many nodes are at or above the current cutoff. */
  visibleCount: number;
  /** Share of the graph shown prominently, 0-100. */
  topPercent: number;
  colorMode: ColorMode;
  indexing: boolean;
  indexMessage?: string;
  onTopPercentChange(value: number): void;
  onColorModeChange(mode: ColorMode): void;
  onReindex(): void;
}

/**
 * Finest step the slider offers. On a very large graph 0.1% is still ~19 files, which
 * is a sensible smallest increment; on a small one the count clamps to at least 1.
 */
const STEP = 0.1;

export function Toolbar({
  fileCount,
  visibleCount,
  topPercent,
  colorMode,
  indexing,
  indexMessage,
  onTopPercentChange,
  onColorModeChange,
  onReindex,
}: ToolbarProps) {
  return (
    <div className="toolbar">
      <div className="toolbar-group">
        <span className="brand">Synapse</span>
        <span className="muted small">
          {visibleCount} of {fileCount} files prominent
        </span>
      </div>

      {/*
        The slider works in rank percentile, not raw importance. PageRank is heavily
        right-skewed — on an 18,851-node graph the top node scored 1.0 and the 300th
        scored 0.0009 — so a linear importance slider put every useful value inside its
        first step. Percentile is scale-free: half the track always means half the files.
      */}
      <label className="toolbar-group">
        <span className="small">Top {topPercent.toFixed(1)}%</span>
        <input
          type="range"
          min={STEP}
          max={100}
          step={STEP}
          value={topPercent}
          onChange={(event) => onTopPercentChange(Number(event.target.value))}
        />
      </label>

      <div className="toolbar-group">
        <span className="small">Colour</span>
        <select
          value={colorMode}
          onChange={(event) => onColorModeChange(event.target.value as ColorMode)}
        >
          <option value="importance">by importance</option>
          <option value="directory">by directory</option>
        </select>
      </div>

      <div className="toolbar-group">
        <button onClick={onReindex} disabled={indexing}>
          {indexing ? "Indexing …" : "Rebuild index"}
        </button>
        {indexMessage && <span className="muted small">{indexMessage}</span>}
      </div>
    </div>
  );
}
