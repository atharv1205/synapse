import { Link } from "../router";
import { SITE } from "../site";
import type { ColorMode } from "./GraphScene";

export interface ToolbarProps {
  /** The served repository's directory name, from /api/status. */
  repoName?: string;
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
  repoName,
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
      <div className="toolbar-group toolbar-identity">
        <Link href="/" className="wordmark" title="About Synapse">
          {SITE.name}
        </Link>
        <div className="repo">
          {repoName && <span className="repo-name">{repoName}</span>}
          <span className="repo-count">
            {visibleCount.toLocaleString()} of {fileCount.toLocaleString()} files prominent
          </span>
        </div>
      </div>

      {/*
        The slider works in rank percentile, not raw importance. PageRank is heavily
        right-skewed — on an 18,851-node graph the top node scored 1.0 and the 300th
        scored 0.0009 — so a linear importance slider put every useful value inside its
        first step. Percentile is scale-free: half the track always means half the files.
      */}
      <label className="toolbar-group">
        <span className="control-label">Top {topPercent.toFixed(1)}%</span>
        <input
          type="range"
          min={STEP}
          max={100}
          step={STEP}
          value={topPercent}
          onChange={(event) => onTopPercentChange(Number(event.target.value))}
        />
      </label>

      <label className="toolbar-group">
        <span className="control-label">Colour</span>
        <select
          value={colorMode}
          onChange={(event) => onColorModeChange(event.target.value as ColorMode)}
        >
          <option value="importance">by importance</option>
          <option value="directory">by directory</option>
        </select>
      </label>

      {colorMode === "importance" && (
        <div className="legend" aria-label="Importance scale, low to high">
          <span>low</span>
          <span className="legend-bar" />
          <span>high</span>
        </div>
      )}

      <div className="toolbar-group">
        <button onClick={onReindex} disabled={indexing}>
          {indexing ? "Indexing …" : "Rebuild index"}
        </button>
        {indexMessage && <span className="control-label">{indexMessage}</span>}
      </div>
    </div>
  );
}
