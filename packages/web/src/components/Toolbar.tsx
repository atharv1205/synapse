import type { RepositoryInfo } from "@synapse/core";
import { compactCount, type ProviderAvailability, type ProviderName } from "../api";
import { StarIcon } from "./icons";
import { Link } from "../router";
import { SITE } from "../site";
import type { ViewMode } from "../App";
import type { ColorMode } from "./GraphScene";
import { ProviderSwitch } from "./ProviderSwitch";

export interface ToolbarProps {
  /** The served repository's directory name, from /api/status. */
  repoName?: string;
  /** GitHub's details, when the repository is on GitHub. */
  repository?: RepositoryInfo;
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
  provider?: ProviderName;
  providers?: Record<ProviderName, ProviderAvailability>;
  onProviderChange(provider: ProviderName): void;
  viewMode: ViewMode;
  onViewModeChange(mode: ViewMode): void;
  /** Folders currently showing their files; offers "Collapse all" when above zero. */
  expandedCount: number;
  onCollapseAll(): void;
}

/**
 * Finest step the slider offers. On a very large graph 0.1% is still ~19 files, which
 * is a sensible smallest increment; on a small one the count clamps to at least 1.
 */
const STEP = 0.1;

export function Toolbar({
  repoName,
  repository,
  fileCount,
  visibleCount,
  topPercent,
  colorMode,
  indexing,
  indexMessage,
  onTopPercentChange,
  onColorModeChange,
  onReindex,
  provider,
  providers,
  onProviderChange,
  viewMode,
  onViewModeChange,
  expandedCount,
  onCollapseAll,
}: ToolbarProps) {
  return (
    <div className="toolbar">
      <div className="toolbar-group toolbar-identity">
        <Link href="/" className="wordmark" title="About Synapse">
          {SITE.name}
        </Link>
        <div className="repo">
          {repository ? (
            <a
              className="repo-name"
              href={repository.url}
              target="_blank"
              rel="noreferrer"
              title={repository.description ?? `${repository.fullName} on GitHub`}
            >
              {repository.fullName}
            </a>
          ) : (
            repoName && <span className="repo-name">{repoName}</span>
          )}
          <span className="repo-count">
            {visibleCount.toLocaleString()} of {fileCount.toLocaleString()} files prominent
            {repository?.stars !== undefined && (
              <span className="repo-stars" title={`${repository.stars.toLocaleString()} stars on GitHub`}>
                <StarIcon />
                {compactCount(repository.stars)}
              </span>
            )}
            {repository?.language && <span className="repo-language">{repository.language}</span>}
          </span>
        </div>
        <Link href="/" className="toolbar-link">
          Analyse another
        </Link>
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
        <span className="control-label">View</span>
        <select value={viewMode} onChange={(event) => onViewModeChange(event.target.value as ViewMode)}>
          <option value="files">files</option>
          <option value="folders">folders</option>
        </select>
      </label>
      {expandedCount > 0 && (
        <button className="toolbar-button-quiet" onClick={onCollapseAll}>
          Collapse all
        </button>
      )}

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

      {provider && providers && (
        <div className="toolbar-group">
          <span className="control-label">Answer with</span>
          <ProviderSwitch
            value={provider}
            providers={providers}
            onChange={onProviderChange}
            label="Answer questions with"
          />
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
