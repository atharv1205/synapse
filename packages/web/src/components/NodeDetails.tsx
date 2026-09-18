import type { FileNode, FunctionNode } from "@synapse/core";

export interface NodeDetailsProps {
  node: FileNode;
  /** The file's declarations, resolved from the graph's canonical list. */
  declarations: FunctionNode[];
  onAskAbout(question: string): void;
  onClose(): void;
}

/** The question the "Ask about this file" button pre-fills. */
export function questionFor(node: FileNode): string {
  return `What does ${node.path} do and what depends on it?`;
}

export function NodeDetails({ node, declarations, onAskAbout, onClose }: NodeDetailsProps) {
  const { metrics } = node;
  const summarised = declarations.filter((fn) => fn.summary);
  // Functions carry an importance score already, so the panel just orders by it.
  const top = [...summarised].sort((a, b) => b.importance - a.importance).slice(0, 5);

  return (
    <aside className="panel panel-node">
      <header className="panel-head">
        <div>
          <p className="eyebrow">{node.language}</p>
          <h2 title={node.path}>{node.path}</h2>
        </div>
        <button className="icon-button" onClick={onClose} aria-label="Close details">
          ×
        </button>
      </header>

      <div className="metric-grid">
        <div>
          <span className="metric-value">{node.importance.toFixed(3)}</span>
          <span className="metric-label">importance</span>
        </div>
        <div>
          <span className="metric-value">{metrics.inDegree}</span>
          <span className="metric-label">imported by</span>
        </div>
        <div>
          <span className="metric-value">{metrics.outDegree}</span>
          <span className="metric-label">imports</span>
        </div>
        <div>
          <span className="metric-value">{metrics.churn}</span>
          <span className="metric-label">commits</span>
        </div>
        <div>
          <span className="metric-value">{metrics.loc}</span>
          <span className="metric-label">lines</span>
        </div>
        <div>
          <span className="metric-value">{declarations.length}</span>
          <span className="metric-label">declarations</span>
        </div>
      </div>

      {node.summary ? (
        <p className="summary">{node.summary}</p>
      ) : (
        <p className="summary muted">
          No summary for this file. It ranked below <code>--summarize-top</code>, so only its
          structure was analysed.
        </p>
      )}

      <button className="primary" onClick={() => onAskAbout(questionFor(node))}>
        Ask about this file
      </button>

      {top.length > 0 && (
        <section>
          <h3>Top functions</h3>
          <ul className="function-list">
            {top.map((fn) => (
              <li key={fn.id}>
                <code>{fn.qualifiedName}</code>
                <span className="line-ref">:{fn.startLine}</span>
                <p>{fn.summary}</p>
              </li>
            ))}
          </ul>
        </section>
      )}

      {summarised.length === 0 && declarations.length > 0 && (
        <section>
          <h3>Declarations</h3>
          <ul className="plain-list">
            {declarations.slice(0, 12).map((fn) => (
              <li key={fn.id}>
                <code>{fn.qualifiedName}</code>
                <span className="line-ref">:{fn.startLine}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </aside>
  );
}
