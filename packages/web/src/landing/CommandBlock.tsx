import { useEffect, useRef, useState } from "react";
import { CheckIcon, CopyIcon } from "../components/icons";

export interface CommandBlockProps {
  /** One shell command per entry. Copied joined by newlines, without prompts. */
  commands: string[];
  /** What the block is for, for screen readers and the copy button. */
  label: string;
}

/**
 * Shell commands with a copy button. The `$` prompts are drawn with CSS, so selecting
 * text or hitting copy never picks them up.
 */
export function CommandBlock({ commands, label }: CommandBlockProps) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const preRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    if (state === "idle") return;
    const timer = setTimeout(() => setState("idle"), 1800);
    return () => clearTimeout(timer);
  }, [state]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(commands.join("\n"));
      setState("copied");
    } catch {
      // Clipboard access can be refused (insecure origin, permission denied). Selecting
      // the text at least leaves them one keystroke from copying it.
      const pre = preRef.current;
      const selection = window.getSelection();
      if (pre && selection) {
        const range = document.createRange();
        range.selectNodeContents(pre);
        selection.removeAllRanges();
        selection.addRange(range);
      }
      setState("failed");
    }
  };

  return (
    <div className="command">
      <pre ref={preRef} aria-label={label}>
        {commands.map((command) => (
          <code key={command}>{command}</code>
        ))}
      </pre>
      <button
        type="button"
        className="command-copy"
        onClick={() => void copy()}
        aria-label={`Copy: ${label}`}
      >
        {state === "copied" ? <CheckIcon /> : <CopyIcon />}
        <span aria-live="polite">
          {state === "copied" ? "Copied" : state === "failed" ? "Selected" : "Copy"}
        </span>
      </button>
    </div>
  );
}
