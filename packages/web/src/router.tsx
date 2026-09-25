import { useEffect, useState, type AnchorHTMLAttributes, type MouseEvent } from "react";

/**
 * Two routes do not justify a router dependency, so this is the whole of one: the
 * current pathname as state, pushState to move, popstate to follow back/forward.
 *
 * Real paths rather than hash routes, so `/graph` is a URL worth bookmarking. The
 * server already answers unknown paths with index.html, and so does Vite's dev server.
 */
const NAVIGATE = "synapse:navigate";

export function navigate(to: string): void {
  if (to === window.location.pathname) return;
  window.history.pushState(null, "", to);
  window.dispatchEvent(new Event(NAVIGATE));
  window.scrollTo(0, 0);
}

export function usePathname(): string {
  const [pathname, setPathname] = useState(window.location.pathname);

  useEffect(() => {
    const sync = () => setPathname(window.location.pathname);
    window.addEventListener("popstate", sync);
    window.addEventListener(NAVIGATE, sync);
    return () => {
      window.removeEventListener("popstate", sync);
      window.removeEventListener(NAVIGATE, sync);
    };
  }, []);

  return pathname;
}

/** An anchor that navigates in place, while modified clicks still open a new tab. */
export function Link({ href, onClick, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  const handle = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event);
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return;
    }
    event.preventDefault();
    navigate(href);
  };

  return <a href={href} onClick={handle} {...rest} />;
}
