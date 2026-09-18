import { useEffect, useRef, useState } from "react";
import type { Source } from "@synapse/core";
import { api, ApiError, type AskAnswer } from "../api";

export interface AskPanelProps {
  /** Set when a node's "Ask about this file" button pre-filled a question. */
  prefill?: string;
  /** Whether /api/status says both models are ready. */
  canAsk: boolean;
  /** Remediation from /api/status, shown when asking is unavailable. */
  unavailableMessage?: string;
  /** Clicking a cited source focuses that file in the 3D view. */
  onFocusSource(path: string): void;
  onSourcesChange(paths: string[]): void;
}

export function AskPanel({
  prefill,
  canAsk,
  unavailableMessage,
  onFocusSource,
  onSourcesChange,
}: AskPanelProps) {
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<AskAnswer | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [pending, setPending] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // A pre-filled question replaces whatever was in the box and takes focus, so the
  // button on the node panel lands the user ready to hit Ask.
  useEffect(() => {
    if (!prefill) return;
    setQuestion(prefill);
    inputRef.current?.focus();
  }, [prefill]);

  const submit = async () => {
    const trimmed = question.trim();
    if (trimmed === "" || pending) return;

    setPending(true);
    setError(undefined);
    setAnswer(undefined);
    onSourcesChange([]);

    try {
      const result = await api.ask(trimmed);
      setAnswer(result);
      onSourcesChange(result.sources.map((s) => s.path));
    } catch (caught) {
      // Core's remediation text comes through the API verbatim; show it as-is.
      setError(caught instanceof ApiError ? caught.message : String(caught));
    } finally {
      setPending(false);
    }
  };

  const label = (source: Source) =>
    source.ref ? `${source.ref} — ${source.path}:${source.startLine}` : source.path;

  return (
    <aside className="panel panel-ask">
      <header className="panel-head">
        <h2>Ask</h2>
      </header>

      {!canAsk && unavailableMessage && (
        <pre className="remediation">{unavailableMessage}</pre>
      )}

      <textarea
        ref={inputRef}
        value={question}
        onChange={(event) => setQuestion(event.target.value)}
        onKeyDown={(event) => {
          // Enter submits; Shift+Enter is a newline, as in most chat inputs.
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            void submit();
          }
        }}
        placeholder="What does the import resolver handle?"
        rows={3}
        disabled={!canAsk}
      />

      <button className="primary" onClick={() => void submit()} disabled={!canAsk || pending}>
        {pending ? "Thinking …" : "Ask"}
      </button>

      {pending && (
        <p className="muted small">
          Retrieving chunks and running the model locally. This can take a while on a large
          model.
        </p>
      )}

      {error && <pre className="remediation">{error}</pre>}

      {answer && (
        <>
          <div className="answer">
            {answer.answer.split(/\n{2,}/).map((paragraph, i) => (
              <p key={i}>{paragraph}</p>
            ))}
          </div>

          <section>
            <h3>Sources</h3>
            <ul className="source-list">
              {answer.sources.map((source, i) => (
                <li key={`${source.path}-${source.ref ?? i}`}>
                  <button className="link" onClick={() => onFocusSource(source.path)}>
                    <span className={`kind kind-${source.kind}`}>{source.kind}</span>
                    <span className="source-label">{label(source)}</span>
                    <span className="score">{source.score.toFixed(3)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
    </aside>
  );
}
