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
 * The provider this viewer picked, remembered in this browser only. Undefined until they
 * pick one, so the server's own default (whatever `serve` was started with) applies.
 */
export function useProviderChoice(): [ProviderName | undefined, (provider: ProviderName) => void] {
  const [choice, setChoice] = useState<ProviderName | undefined>(stored);
  const choose = useCallback((provider: ProviderName) => {
    setChoice(provider);
    try {
      localStorage.setItem(STORAGE_KEY, provider);
    } catch {
      // Private windows and blocked storage just mean the choice is not remembered.
    }
  }, []);
  return [choice, choose];
}

export interface ProviderSwitchProps {
  value: ProviderName;
  providers: Record<ProviderName, ProviderAvailability>;
  onChange(provider: ProviderName): void;
  /** Names the control for screen readers, e.g. "Answer with". */
  label: string;
}

/**
 * Local, Gemini or Claude. A provider that cannot be used right now stays visible but
 * disabled, with the reason as its tooltip, so the fix is one hover away rather than a
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
