import { simpleGit, type SimpleGit } from "simple-git";

export interface ChurnResult {
  /** Repo-relative path -> number of commits that touched it. */
  counts: Map<string, number>;
  /** False when the target is not a git repo, in which case every count is 0. */
  available: boolean;
}

/** How many `git log` processes to keep in flight at once. */
const CONCURRENCY = 16;

async function isGitRepo(git: SimpleGit): Promise<boolean> {
  try {
    return await git.checkIsRepo();
  } catch {
    return false;
  }
}

/**
 * Counts commits touching each file with `git log --follow`, so a file that was
 * renamed keeps the history it accumulated under its old name.
 *
 * `--follow` only works one path at a time, so this is one git process per file.
 * That is fine for the repo sizes this tool targets, but it is the slowest step
 * of an analysis by a wide margin on very large repositories.
 */
export async function measureChurn(root: string, paths: string[]): Promise<ChurnResult> {
  const git = simpleGit(root);
  const counts = new Map<string, number>();

  if (!(await isGitRepo(git))) {
    for (const p of paths) counts.set(p, 0);
    return { counts, available: false };
  }

  const queue = [...paths];

  async function worker(): Promise<void> {
    for (;;) {
      const filePath = queue.shift();
      if (filePath === undefined) return;
      counts.set(filePath, await countCommits(git, filePath));
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, paths.length) }, worker));
  return { counts, available: true };
}

async function countCommits(git: SimpleGit, filePath: string): Promise<number> {
  try {
    const out = await git.raw(["log", "--follow", "--oneline", "--", filePath]);
    const trimmed = out.trim();
    return trimmed === "" ? 0 : trimmed.split("\n").length;
  } catch {
    // Untracked or newly added files have no history; that is a churn of 0, not an error.
    return 0;
  }
}
