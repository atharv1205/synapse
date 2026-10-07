import path from "node:path";
import { isRepoUrl, redactUrl } from "@synapse/core";

/**
 * Where the .synapse files go. A URL has no local folder to put them in, so they go in
 * the current directory instead of some folder named after the URL.
 */
export function resolveOutDir(target: string, out: unknown, cwd: string = process.cwd()): string {
  if (typeof out === "string") return path.resolve(cwd, out);
  if (isRepoUrl(target)) return path.join(cwd, ".synapse");
  return path.join(path.resolve(cwd, target), ".synapse");
}

export interface ServeTarget {
  /** What we're serving: a local path, or a repo URL with any credential removed. */
  root: string;
  /** The URL to clone (credential included) when the target is remote. */
  cloneTarget?: string;
  cacheDir: string;
}

/**
 * Turn `serve`'s argument into what the server needs. The analysis clones URLs itself;
 * resolving the URL as a path first used to turn `serve https://github.com/org/repo` into
 * a folder that doesn't exist. `root` is redacted because serve prints it and /api/status
 * returns it. Only the clone step sees the original.
 */
export function serveTarget(target: string, out: unknown, cwd: string = process.cwd()): ServeTarget {
  const remote = isRepoUrl(target);
  return {
    root: remote ? redactUrl(target) : path.resolve(cwd, target),
    cloneTarget: remote ? target : undefined,
    cacheDir: resolveOutDir(target, out, cwd),
  };
}
