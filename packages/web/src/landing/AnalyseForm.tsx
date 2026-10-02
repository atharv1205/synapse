import { useState, type FormEvent } from "react";
import { api, ApiError, type ProviderAvailability, type ProviderName } from "../api";
import { ProviderSwitch, useProviderChoice } from "../components/ProviderSwitch";
import { navigate } from "../router";

export interface AnalyseFormProps {
  providers: Record<ProviderName, ProviderAvailability>;
  defaultProvider: ProviderName;
}

/**
 * Paste a GitHub URL or a local path, pick who summarises, and go. The server analyses in
 * the background and the explorer shows its progress, so this only has to start it.
 *
 * The token field is for private repositories. Its value goes to the server once, in the
 * request body over localhost, is used for the clone and is never stored there; it is
 * cleared from the page as soon as the request is sent.
 */
export function AnalyseForm({ providers, defaultProvider }: AnalyseFormProps) {
  const [choice, choose] = useProviderChoice();
  const provider = choice ?? defaultProvider;
  const [target, setTarget] = useState("");
  const [token, setToken] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (pending || target.trim() === "") return;
    setPending(true);
    setError(undefined);
    const sent = token.trim();
    setToken("");
    try {
      await api.analyze({ target: target.trim(), token: sent || undefined, provider });
      navigate("/graph");
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : String(caught));
      setPending(false);
    }
  };

  const chosen = providers[provider];

  return (
    <form id="analyse" className="analyse" onSubmit={(event) => void submit(event)}>
      <label htmlFor="analyse-target" className="visually-hidden">
        Repository to analyse
      </label>
      <div className="analyse-row">
        <input
          id="analyse-target"
          type="text"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          placeholder="https://github.com/owner/repo  or  ~/code/project"
          value={target}
          onChange={(event) => setTarget(event.target.value)}
          disabled={pending}
          required
        />
        <button type="submit" className="button button-primary" disabled={pending || target.trim() === ""}>
          {pending ? "Starting …" : "Analyse"}
        </button>
      </div>

      <div className="analyse-options">
        <span className="analyse-label">Summarise with</span>
        <ProviderSwitch value={provider} providers={providers} onChange={choose} label="Summarise with" />
      </div>
      {chosen && !chosen.available && <p className="analyse-note">{chosen.message}</p>}

      <details className="analyse-token">
        <summary>Private repository?</summary>
        <label htmlFor="analyse-token-input" className="visually-hidden">
          GitHub token
        </label>
        <input
          id="analyse-token-input"
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder="GitHub token with read access"
          value={token}
          onChange={(event) => setToken(event.target.value)}
          disabled={pending}
        />
        <p className="analyse-note">
          Used for this repository only, to clone it and read its GitHub details, then
          discarded. Never saved, logged or shown again.
        </p>
      </details>

      {error && (
        <pre className="analyse-error" role="alert">
          {error}
        </pre>
      )}
    </form>
  );
}
