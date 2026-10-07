import { useCallback, useState } from "react";
import { PROVIDER_LABELS, PROVIDERS, type ProviderAvailability, type ProviderName } from "../api";

const STORAGE_KEY = "synapse:provider";

function stored(): ProviderName | undefined {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return PROVIDERS.includes(value as ProviderName) ? (value as ProviderName) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The provider this person picked, remembered in this browser only. Undefined until they
 * pick, so the server's default (whatever `serve` started with) applies.
 */
export function useProviderChoice(): [ProviderName | undefined, (provider: ProviderName) => void] {
  const [choice, setChoice] = useState<ProviderName | undefined>(stored);
  const choose = useCallback((provider: ProviderName) => {
    setChoice(provider);
    try {
      localStorage.setItem(STORAGE_KEY, provider);
    } catch {
      // Private window or blocked storage just means we don't remember the pick.
    }
  }, []);
  return [choice, choose];
}

export interface ProviderSwitchProps {
  value: ProviderName;
  providers: Record<ProviderName, ProviderAvailability>;
  onChange(provider: ProviderName): void;
  /** Name of the control for screen readers, e.g. "Answer with". */
  label: string;
}

/**
 * Local, Gemini or Claude. A provider that can't be used right now stays visible but
 * disabled, with the reason in its tooltip, so the fix is one hover away instead of a
 * mystery.
 */
export function ProviderSwitch({ value, providers, onChange, label }: ProviderSwitchProps) {
  return (
    <div className="provider-switch" role="radiogroup" aria-label={label}>
      {PROVIDERS.map((provider) => {
        const info = providers[provider];
        const usable = info?.available ?? false;
        return (
          <button
            key={provider}
            type="button"
            role="radio"
            aria-checked={value === provider}
            className={`provider-option${value === provider ? " is-active" : ""}`}
            disabled={!usable && value !== provider}
            title={usable ? `${PROVIDER_LABELS[provider]}: ${info.model}` : info?.message}
            onClick={() => onChange(provider)}
          >
            <span className={`provider-dot${usable ? " is-ready" : ""}`} aria-hidden="true" />
            {PROVIDER_LABELS[provider]}
          </button>
        );
      })}
    </div>
  );
}
