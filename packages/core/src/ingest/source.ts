import { mkdtemp, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { simpleGit } from "simple-git";

/** A resolved analysis target: a local directory, plus how to clean it up. */
export interface ResolvedSource {
  /** Absolute path to the directory to analyse. */
  root: string;
  /** The original input (URL or path), echoed into the output graph. */
  source: string;
  /** True when `root` is a temp clone that the caller should dispose of. */
  ephemeral: boolean;
  /** Removes the clone if there is one; a no-op for local paths. */
  cleanup(): Promise<void>;
}

/** Recognises the URL forms git can clone: https://, git://, ssh://, and scp-style `git@host:org/repo`. */
export function isRepoUrl(input: string): boolean {
  if (/^(https?|git|ssh):\/\//i.test(input)) return true;
  return /^[\w.-]+@[\w.-]+:.+/.test(input);
}

export interface ResolveOptions {
  /** Clone depth. Deeper history gives better churn signal but a slower clone. */
  depth?: number;
  onProgress?: (message: string) => void;
}

/**
 * Turns a GitHub URL or local path into a directory on disk. URLs are cloned into
 * a temp dir; local paths are used in place and never mutated.
 */
export async function resolveSource(
  input: string,
  options: ResolveOptions = {},
): Promise<ResolvedSource> {
  const { depth = 200, onProgress } = options;

  if (!isRepoUrl(input)) {
    const root = path.resolve(input);
    try {
      await access(root);
    } catch {
      throw new Error(`Path does not exist: ${root}`);
    }
    return { root, source: root, ephemeral: false, cleanup: async () => {} };
  }

  const dir = await mkdtemp(path.join(tmpdir(), "repograph-"));
  onProgress?.(`Cloning ${input} …`);

  try {
    // A shallow clone still carries enough history for a useful churn signal,
    // and `--filter=blob:none` skips file contents we never read from git.
    await simpleGit().clone(input, dir, ["--depth", String(depth), "--filter=blob:none"]);
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw new Error(`Failed to clone ${input}: ${(error as Error).message}`);
  }

  return {
    root: dir,
    source: input,
    ephemeral: true,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}
