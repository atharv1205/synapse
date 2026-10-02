/**
 * The handful of icons the UI needs, drawn inline at one 16px grid and one 1.5px stroke
 * so they sit together. The GitHub mark is GitHub's own (Octicons, MIT), used only to
 * link to GitHub, which is what their logo guidelines allow it for.
 */
interface IconProps {
  className?: string;
}

const stroke = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

export function GitHubIcon({ className = "icon" }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 16 16" aria-hidden="true" fill="currentColor">
      <path d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z" />
    </svg>
  );
}

export function CopyIcon({ className = "icon" }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 16 16" aria-hidden="true" {...stroke}>
      <rect x="5.25" y="5.25" width="8.5" height="8.5" rx="1.5" />
      <path d="M10.75 5.25V3.75a1.5 1.5 0 0 0-1.5-1.5h-5.5a1.5 1.5 0 0 0-1.5 1.5v5.5a1.5 1.5 0 0 0 1.5 1.5h1.5" />
    </svg>
  );
}

export function CheckIcon({ className = "icon" }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 16 16" aria-hidden="true" {...stroke}>
      <path d="M3 8.5l3.25 3.25L13 5" />
    </svg>
  );
}

export function CloseIcon({ className = "icon" }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 16 16" aria-hidden="true" {...stroke}>
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  );
}

export function StarIcon({ className = "icon" }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 16 16" aria-hidden="true" {...stroke}>
      <path d="M8 1.75l1.9 3.85 4.25.62-3.08 3 .73 4.23L8 11.45l-3.8 2 .73-4.23-3.08-3 4.25-.62L8 1.75z" />
    </svg>
  );
}
