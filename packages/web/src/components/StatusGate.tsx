import type { Status } from "../api";

export interface StatusGateProps {
  /** Undefined while the first /api/status call is still in flight. */
  status?: Status;
  error?: string;
  onRetry(): void;
}

/**
 * The pre-render states. Everything shown here comes from /api/status, which is itself
 * just core's preflight output — so the remediation text the browser shows is the same
 * text the CLI prints, rather than a second set of wordings to keep in step.
 *
 * Returns undefined once the graph exists, meaning the scene can take over. Missing
 * embeddings deliberately do not gate: the graph is worth exploring without Q&A.
 */
export function StatusGate({ status, error, onRetry }: StatusGateProps): JSX.Element | undefined {
  if (error) {
    return (
      <Splash title="Cannot reach the Synapse server">
        <pre className="remediation">{error}</pre>
        <button className="primary" onClick={onRetry}>
          Retry
        </button>
      </Splash>
    );
  }

  if (!status) {
    return (
      <Splash title="Connecting …">
        <Spinner />
      </Splash>
    );
  }

  if (!status.graph.exists) {
    // An analysis that died leaves no graph and never will, so say so rather than spin.
    if (status.analysis.error) {
      return (
        <Splash title="The analysis failed">
          <pre className="remediation">{status.analysis.error}</pre>
          <button className="primary" onClick={onRetry}>
            Check again
          </button>
        </Splash>
      );
    }

    if (!status.analysis.running) {
      return (
        <Splash title="No graph for this repository">
          <p className="muted">
            Nothing has been analysed into <code>.synapse/graph.json</code> yet.
          </p>
          <pre className="remediation">synapse analyze {status.root}</pre>
          <button className="primary" onClick={onRetry}>
            Check again
          </button>
        </Splash>
      );
    }

    return (
      <Splash title="Analysing repository">
        <Spinner />
        <p className="muted">
          Parsing <code>{status.root}</code>, building the dependency graph and measuring git
          churn. This runs once; the result is cached in <code>.synapse/graph.json</code>.
          Summarising with a local model is the slow part.
        </p>
        {status.analysis.message && <p className="progress">{status.analysis.message}</p>}
      </Splash>
    );
  }

  return undefined;
}

/** A non-blocking banner for conditions the scene can render alongside. */
export function StatusBanner({ status }: { status: Status }): JSX.Element | undefined {
  if (!status.ollama.reachable) {
    return (
      <Banner tone="error" title="Ollama is not reachable — questions are unavailable">
        {status.chatModel.message}
      </Banner>
    );
  }

  const missing = [
    !status.chatModel.available ? status.chatModel : undefined,
    !status.embedModel.available ? status.embedModel : undefined,
  ].filter((m): m is NonNullable<typeof m> => m !== undefined);

  if (missing.length > 0) {
    return (
      <Banner tone="error" title="A model is missing — questions are unavailable">
        {missing.map((m) => m.message).join("\n")}
      </Banner>
    );
  }

  if (!status.index.exists) {
    return (
      <Banner tone="info" title="No embedding index yet">
        {"Questions will build one on the first ask, or use “Rebuild index” to pre-warm it."}
      </Banner>
    );
  }

  return undefined;
}

function Banner({
  tone,
  title,
  children,
}: {
  tone: "error" | "info";
  title: string;
  children?: React.ReactNode;
}) {
  return (
    <div className={`banner banner-${tone}`}>
      <strong>{title}</strong>
      {children && <pre className="remediation">{children}</pre>}
    </div>
  );
}

export function Splash({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="splash">
      <div className="splash-card">
        <h1>{title}</h1>
        {children}
      </div>
    </div>
  );
}

export function Spinner() {
  return <div className="spinner" aria-label="Loading" />;
}
