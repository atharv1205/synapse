import { PROVIDER_LABELS, type ProviderName, type Status } from "../api";
import { Link } from "../router";

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
          <Link href="/" className="splash-home">
            Try another repository
          </Link>
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
          <Link href="/" className="splash-home">
            Or analyse a repository from the start page
          </Link>
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

/**
 * A non-blocking banner for conditions the scene can render alongside. It describes the
 * provider the viewer has selected, not Ollama in general: with Gemini selected and
 * working, a stopped Ollama is not a problem worth a red banner.
 */
export function StatusBanner({ status }: { status: Status }): JSX.Element | undefined {
  const label = PROVIDER_LABELS[status.provider.chat as ProviderName] ?? status.provider.chat;
  const problems = [status.chatModel, status.embedModel]
    .filter((m) => !m.available && m.message)
    .map((m) => m.message!);
  // Chat and embeddings often fail for the same reason (Ollama is down); say it once.
  const unique = [...new Set(problems)];

  if (unique.length > 0) {
    return (
      <Banner tone="error" title={`${label} isn't ready, so questions are unavailable`}>
        {unique.join("\n\n")}
      </Banner>
    );
  }

  if (!status.index.exists) {
    return (
      <Banner tone="info" title="No question index yet">
        {"The first question builds one, or use “Rebuild index” to build it now."}
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
