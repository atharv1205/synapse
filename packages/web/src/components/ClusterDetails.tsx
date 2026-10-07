import type { FileNode } from "@synapse/core";
import type { Cluster } from "../clusters";
import { CloseIcon } from "./icons";

export interface ClusterDetailsProps {
  cluster: Cluster;
  /** Its files, most important first. */
  files: FileNode[];
  expanded: boolean;
  onToggle(): void;
  onOpenFile(path: string): void;
  onAskAbout(question: string): void;
  onClose(): void;
}

/** How many of a folder's files the panel lists. */
const TOP_FILES = 8;

/** The question "Ask about this folder" fills in. */
export function questionForFolder(cluster: Cluster): string {
  const where = cluster.folder || "the repository root";
  return `What is ${where} responsible for, and which of its files matter most?`;
}

/**
 * Details for a folder bubble: what's in it, its most important files, and a way in.
 * Expanding swaps the bubble for its files in place; opening a file expands the folder
 * and selects that file.
 */
export function ClusterDetails({
  cluster,
  files,
  expanded,
  onToggle,
  onOpenFile,
  onAskAbout,
  onClose,
}: ClusterDetailsProps) {
  const top = files.slice(0, TOP_FILES);
  return (
    <aside className="panel panel-node">
      <header className="panel-head">
        <div>
          <h2 className="node-path" title={cluster.folder}>
            {cluster.folder ? `${cluster.folder}/` : "(root)"}
          </h2>
          <p className="node-meta">
            {cluster.folded > 0
              ? `${cluster.folded.toLocaleString()} smaller folders grouped together, ${files.length.toLocaleString()} files`
              : `Folder, ${files.length.toLocaleString()} files`}
          </p>
        </div>
        <button className="icon-button" onClick={onClose} aria-label="Close folder details">
          <CloseIcon />
        </button>
      </header>

      <div className="cluster-actions">
        <button className="primary" onClick={onToggle}>
          {expanded ? "Collapse into a bubble" : "Show its files"}
        </button>
        <button onClick={() => onAskAbout(questionForFolder(cluster))}>Ask about this folder</button>
      </div>

      <h3>Most important files</h3>
      <ul className="source-list">
        {top.map((file) => (
          <li key={file.id}>
            <button className="link" onClick={() => onOpenFile(file.path)}>
              <span className="source-label">{file.path.slice(cluster.folder ? cluster.folder.length + 1 : 0)}</span>
              <span className="score">{file.importance.toFixed(3)}</span>
            </button>
          </li>
        ))}
      </ul>
      {files.length > TOP_FILES && (
        <p className="muted small">and {(files.length - TOP_FILES).toLocaleString()} more</p>
      )}
    </aside>
  );
}
