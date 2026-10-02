import path from "node:path";
import { isRepoUrl, redactUrl } from "@synapse/core";

/**
 * Where .synapse artefacts live. A URL has no local path to hang them off, so those
 * land in the current directory rather than a folder named after the URL.
 */
export function resolveOutDir(target: string, out: unknown, cwd: string = process.cwd()): string {
  if (typeof out === "string") return path.resolve(cwd, out);
  if (isRepoUrl(target)) return path.join(cwd, ".synapse");
  return path.join(path.resolve(cwd, target), ".synapse");
}

export interface ServeTarget {
  /** What is being served: a local path, or a repository URL with any credential removed. */
  root: string;
  /** The URL to clone, credential included, when the target is remote. */
  cloneTarget?: string;
  cacheDir: string;
}

/**
 * Turns `serve`'s argument into what the server needs. A URL is cloned by the analysis
 * itself; resolving it as a path first turned `serve https://github.com/org/repo` into a
 * directory that does not exist. It is redacted for `root` because serve prints it and
 * /api/status returns it; only the clone step sees the original.
 */
export function serveTarget(target: string, out: unknown, cwd: string = process.cwd()): ServeTarget {
  const remote = isRepoUrl(target);
  return {
    root: remote ? redactUrl(target) : path.resolve(cwd, target),
    cloneTarget: remote ? target : undefined,
    cacheDir: resolveOutDir(target, out, cwd),
  };
}
