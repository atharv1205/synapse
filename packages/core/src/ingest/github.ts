import { simpleGit } from "simple-git";
import type { RepositoryInfo } from "../types.js";
import { redactSecret } from "./source.js";

/** owner/name of a GitHub repository. */
export interface GitHubRepo {
  owner: string;
  name: string;
}

/**
 * Reads owner/name from any form of GitHub remote: https (with or without a credential
 * or `.git`), `git@github.com:owner/name.git`, and `ssh://git@github.com/owner/name`.
 * Anything not on github.com is undefined.
 */
export function parseGitHubRepo(remote: string): GitHubRepo | undefined {
  const trimmed = remote.trim();
  const scp = /^[\w.-]+@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(trimmed);
  if (scp) return { owner: scp[1]!, name: scp[2]! };

  try {
    const url = new URL(trimmed);
    if (url.hostname.toLowerCase() !== "github.com") return undefined;
    const [owner, name] = url.pathname.replace(/^\/+/, "").split("/");
    if (!owner || !name) return undefined;
    return { owner, name: name.replace(/\.git$/i, "") };
  } catch {
    return undefined;
  }
}

/**
 * The GitHub repository a local folder was cloned from, read from its `origin` remote.
 * Undefined for a folder that is not a git repository, has no origin, or is not on
 * GitHub. Any credential in the remote URL is never returned; only owner and name are.
 */
export async function gitHubRepoOf(root: string): Promise<GitHubRepo | undefined> {
  try {
    const remote = await simpleGit(root).remote(["get-url", "origin"]);
    return typeof remote === "string" ? parseGitHubRepo(remote) : undefined;
  } catch {
    return undefined;
  }
}

export interface FetchRepositoryOptions {
  /** For a private repository: the same token used to clone it. Sent only to GitHub. */
  token?: string;
  /** Replaces global fetch, for tests. */
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** Either the details, or why they could not be had. Never throws. */
export type RepositoryLookup = { ok: true; info: RepositoryInfo } | { ok: false; reason: string };

interface GitHubRepoResponse {
  full_name?: string;
  html_url?: string;
  description?: string | null;
  homepage?: string | null;
  stargazers_count?: number;
  forks_count?: number;
  language?: string | null;
  topics?: string[];
  license?: { spdx_id?: string | null } | null;
  default_branch?: string;
  pushed_at?: string;
  archived?: boolean;
  private?: boolean;
}

/**
 * Asks GitHub's REST API for a repository's description, stars, language and the like.
 *
 * This is decoration on a graph that stands without it, so it never fails the analysis:
 * a network error, a private repository without a token, or the unauthenticated rate
 * limit of 60 requests an hour all come back as a reason the caller can mention and move
 * past. The token, when there is one, appears in no message.
 */
export async function fetchRepositoryInfo(
  repo: GitHubRepo,
  options: FetchRepositoryOptions = {},
): Promise<RepositoryLookup> {
  const request = options.fetch ?? fetch;
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "synapse-map",
  };
  if (options.token) headers.authorization = `Bearer ${options.token}`;

  const where = `${repo.owner}/${repo.name}`;
  const fail = (reason: string): RepositoryLookup => ({
    ok: false,
    reason: redactSecret(reason, options.token),
  });

  let response: Response;
  try {
    response = await request(
      `https://api.github.com/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`,
      { headers, signal: AbortSignal.timeout(options.timeoutMs ?? 8_000) },
    );
  } catch (error) {
    return fail(`Could not reach GitHub for ${where}'s details (${error instanceof Error ? error.message : error}).`);
  }

  if (response.status === 404) {
    return fail(
      options.token
        ? `GitHub has no repository ${where} that this token can see.`
        : `GitHub did not return ${where}; if it is private, its details need a token.`,
    );
  }
  if (response.status === 403 || response.status === 429) {
    const remaining = response.headers.get("x-ratelimit-remaining");
    return fail(
      remaining === "0"
        ? "GitHub's rate limit for unauthenticated requests is used up (60 an hour); details are skipped."
        : `GitHub refused the request for ${where}'s details (${response.status}).`,
    );
  }
  if (!response.ok) return fail(`GitHub answered ${response.status} for ${where}'s details.`);

  let body: GitHubRepoResponse;
  try {
    body = (await response.json()) as GitHubRepoResponse;
  } catch {
    return fail(`GitHub's answer for ${where} was not readable.`);
  }

  const info: RepositoryInfo = {
    host: "github.com",
    owner: repo.owner,
    name: repo.name,
    fullName: body.full_name ?? where,
    url: body.html_url ?? `https://github.com/${where}`,
    fetchedAt: new Date().toISOString(),
  };
  if (body.description) info.description = body.description;
  if (body.homepage) info.homepage = body.homepage;
  if (typeof body.stargazers_count === "number") info.stars = body.stargazers_count;
  if (typeof body.forks_count === "number") info.forks = body.forks_count;
  if (body.language) info.language = body.language;
  if (body.topics && body.topics.length > 0) info.topics = body.topics;
  if (body.license?.spdx_id && body.license.spdx_id !== "NOASSERTION") info.license = body.license.spdx_id;
  if (body.default_branch) info.defaultBranch = body.default_branch;
  if (body.pushed_at) info.pushedAt = body.pushed_at;
  if (body.archived) info.archived = true;
  if (body.private) info.private = true;
  return { ok: true, info };
}
