import { simpleGit, type SimpleGit } from "simple-git";

export interface ChurnResult {
  /** Repo-relative path -> how many commits touched it. */
  counts: Map<string, number>;
  /** False if the target isn't a git repo. All counts are 0 then. */
  available: boolean;
}

/** How many `git log` processes we run at once. */
const CONCURRENCY = 16;

async function isGitRepo(git: SimpleGit): Promise<boolean> {
  try {
    return await git.checkIsRepo();
  } catch {
    return false;
  }
}

/**
 * Count the commits touching each file with `git log --follow`, so a renamed file keeps
 * the history from its old name.
 *
 * `--follow` only takes one path, so it's one git process per file. Fine for most repos,
 * but on really big ones it's by far the slowest step.
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
    // Untracked or brand new files have no history. That's churn 0, not an error.
    return 0;
  }
}
