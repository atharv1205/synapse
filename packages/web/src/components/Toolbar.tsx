import type { ColorMode } from "./GraphScene";

export interface ToolbarProps {
  fileCount: number;
  /** How many nodes are at or above the current threshold. */
  visibleCount: number;
  threshold: number;
  maxImportance: number;
  colorMode: ColorMode;
  indexing: boolean;
  indexMessage?: string;
  onThresholdChange(value: number): void;
  onColorModeChange(mode: ColorMode): void;
  onReindex(): void;
}

export function Toolbar({
  fileCount,
  visibleCount,
  threshold,
  maxImportance,
  colorMode,
  indexing,
  indexMessage,
  onThresholdChange,
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

      <label className="toolbar-group">
        <span className="small">Importance ≥ {threshold.toFixed(3)}</span>
        <input
          type="range"
          min={0}
          max={maxImportance}
          step={maxImportance / 200}
          value={threshold}
          onChange={(event) => onThresholdChange(Number(event.target.value))}
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
