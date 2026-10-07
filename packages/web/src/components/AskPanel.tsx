import { useEffect, useRef, useState } from "react";
import type { Source } from "@synapse/core";
import { api, ApiError, PROVIDER_LABELS, type AskAnswer, type ProviderName } from "../api";

export interface AskPanelProps {
  /** Set when a file's "Ask about this file" button filled in a question. */
  prefill?: string;
  /** Whether /api/status says both models are ready. */
  canAsk: boolean;
  /** Who answers. Undefined means the server's default. */
  provider?: ProviderName;
  /** Fix-it text from /api/status, shown when asking isn't available. */
  unavailableMessage?: string;
  /** Clicking a cited source focuses that file in the 3D view. */
  onFocusSource(path: string): void;
  onSourcesChange(paths: string[]): void;
}

export function AskPanel({
  prefill,
  canAsk,
  provider,
  unavailableMessage,
  onFocusSource,
  onSourcesChange,
}: AskPanelProps) {
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<AskAnswer | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [pending, setPending] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // A pre-filled question replaces whatever's in the box and grabs focus, so after the
  // button on the file panel you're ready to hit Ask.
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
      const result = await api.ask(trimmed, provider);
      setAnswer(result);
      onSourcesChange(result.sources.map((s) => s.path));
    } catch (caught) {
      // Core's fix-it text comes through the API word for word, show it as is.
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
          // Enter sends, Shift+Enter adds a new line, like most chat boxes.
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
          {provider === undefined || provider === "ollama"
            ? "Retrieving context and running the local model. This can take a while on a large model."
            : `Retrieving context and asking ${PROVIDER_LABELS[provider]}.`}
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
