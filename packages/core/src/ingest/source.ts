import { execFile } from "node:child_process";
import { mkdtemp, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** A resolved analysis target: a local directory, plus how to clean it up. */
export interface ResolvedSource {
  /** Absolute path to the directory to analyse. */
  root: string;
  /**
   * The input, echoed into the output graph. Always credential-free: any userinfo in
   * the URL is stripped before it is stored, because this value is written to
   * graph.json.
   */
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

/**
 * Removes any credentials embedded in a URL's userinfo, so the result is safe to log,
 * to put in an error message, and to write into graph.json.
 *
 * A user can paste `https://ghp_xxx@github.com/org/repo`, so this has to run on every
 * URL, not only on ones where Synapse supplied the token itself. The `git@host:path`
 * scp form carries no password, so it passes through unchanged.
 */
export function redactUrl(input: string): string {
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(input)) return input;

  try {
    const url = new URL(input);
    if (!url.username && !url.password) return input;
    url.username = "";
    url.password = "";
    // Keep the shape recognisable rather than pretending there was no credential.
    return url.toString().replace("://", "://<redacted>@");
  } catch {
    // Not parseable as a URL; fall back to a textual strip of `scheme://userinfo@`.
    return input.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/i, "$1<redacted>@");
  }
}

/** Replaces every occurrence of a secret in text, for scrubbing tool output. */
export function redactSecret(text: string, secret?: string): string {
  if (!secret || secret.length < 4) return text;
  return text.split(secret).join("<redacted>");
}

export interface ResolveOptions {
  /** Clone depth. Deeper history gives better churn signal but a slower clone. */
  depth?: number;
  /**
   * Credential for private clones. Held in memory only: it reaches git through the
   * child process environment, and is never logged, embedded in a URL, written to the
   * clone's git config, or stored in any Synapse output.
   */
  token?: string;
  onProgress?: (message: string) => void;
}

/**
 * Builds the environment that hands git a token without exposing it.
 *
 * The token goes in as an environment variable and is read by an inline credential
 * helper. Three things are deliberately avoided: the token never appears in the process
 * arguments (where any user on the machine could read it from `ps`), never gets
 * embedded in the remote URL (where git would persist it into the clone's
 * `.git/config`), and never reaches a credential store on disk.
 *
 * The first, empty `credential.helper` resets the helpers git would otherwise inherit
 * from the user's own config, so a system keychain cannot answer instead.
 */
export function cloneEnv(
  token?: string,
  inherited: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const base: Record<string, string> = {
    ...(inherited as Record<string, string>),
    // Without this, git blocks forever waiting for a username on a private repo.
    GIT_TERMINAL_PROMPT: "0",
  };

  if (!token) return base;

  // Respect any GIT_CONFIG_* entries the user already exported rather than clobbering
  // their git configuration; ours are appended after theirs.
  const existing = Number.parseInt(base.GIT_CONFIG_COUNT ?? "0", 10);
  const offset = Number.isNaN(existing) || existing < 0 ? 0 : existing;

  return {
    ...base,
    SYNAPSE_GIT_TOKEN: token,
    GIT_CONFIG_COUNT: String(offset + 2),
    [`GIT_CONFIG_KEY_${offset}`]: "credential.helper",
    [`GIT_CONFIG_VALUE_${offset}`]: "",
    [`GIT_CONFIG_KEY_${offset + 1}`]: "credential.helper",
    [`GIT_CONFIG_VALUE_${offset + 1}`]:
      '!f() { echo username=x-access-token; echo "password=$SYNAPSE_GIT_TOKEN"; }; f',
  };
}

/**
 * Pulls the useful part out of a failed git invocation.
 *
 * execFile's error repeats the whole command line and all of stderr, which buries the
 * one line that matters. Only git's own `fatal:`/`remote:` lines are kept, and the
 * result is scrubbed of credentials before it is shown anywhere.
 */
export function cloneErrorDetail(error: unknown, token?: string): string {
  const failure = error as { stderr?: string; message?: string };
  const raw = failure.stderr?.trim() || failure.message?.trim() || String(error);

  const interesting = raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^(fatal|error|remote|warning):/i.test(line));

  const chosen = (interesting.length > 0 ? interesting : raw.split("\n"))
    .slice(0, 3)
    .join(" ")
    .slice(0, 300);

  return redactSecret(redactUrl(redactSecret(chosen, token)), token).trim();
}

/** Git's own auth failures, which say nothing useful about what to do next. */
function looksLikeAuthFailure(message: string): boolean {
  return /authentication failed|could not read username|terminal prompts disabled|repository not found|403|401/i.test(
    message,
  );
}

/**
 * Turns git's raw failure into something actionable.
 *
 * GitHub answers an unauthenticated request for a private repository with "Repository
 * not found" — the same thing it says for a typo — so the message has to cover both
 * possibilities rather than claiming to know which one it is.
 */
export function cloneFailureMessage(safeUrl: string, detail: string, hadToken: boolean): string {
  if (!looksLikeAuthFailure(detail)) {
    return `Failed to clone ${safeUrl}: ${detail}`;
  }

  if (hadToken) {
    return (
      `Could not clone ${safeUrl} with the token provided.\n` +
      "  The token may be expired, or may not grant access to this repository.\n" +
      "  A fine-grained token needs Contents: read on the repo; a classic token needs the `repo` scope.\n" +
      `  Git said: ${detail}`
    );
  }

  return (
    `Could not clone ${safeUrl}.\n` +
    "  If it is private, Synapse needs a token:\n" +
    "    export GITHUB_TOKEN=ghp_...   (preferred — keeps it out of shell history)\n" +
    "    or pass --token <token>\n" +
    "  If it is public, check the URL is spelled correctly.\n" +
    `  Git said: ${detail}`
  );
}

/**
 * Turns a GitHub URL or local path into a directory on disk. URLs are cloned into
 * a temp dir; local paths are used in place and never mutated.
 */
export async function resolveSource(
  input: string,
  options: ResolveOptions = {},
): Promise<ResolvedSource> {
  const { depth = 200, token, onProgress } = options;

  if (!isRepoUrl(input)) {
    const root = path.resolve(input);
    try {
      await access(root);
    } catch {
      throw new Error(`Path does not exist: ${root}`);
    }
    return { root, source: root, ephemeral: false, cleanup: async () => {} };
  }

  // Everything user-visible from here on uses the redacted form.
  const safeUrl = redactUrl(input);
  const dir = await mkdtemp(path.join(tmpdir(), "synapse-"));
  onProgress?.(`Cloning ${safeUrl} …`);

  try {
    // git is invoked directly rather than through simple-git here. simple-git's argv
    // guard rejects credential-helper and GIT_CONFIG_* environment injection outright,
    // which is exactly the mechanism that keeps the token out of argv and out of the
    // clone's config. Driving the one command ourselves keeps that property; simple-git
    // still runs the churn queries elsewhere.
    //
    // A shallow clone carries enough history for a useful churn signal, and
    // `--filter=blob:none` skips file contents we never read from git. The `--`
    // terminator stops a URL beginning with `-` being parsed as an option.
    await run(
      "git",
      ["clone", "--depth", String(depth), "--filter=blob:none", "--", input, dir],
      { env: cloneEnv(token), maxBuffer: 16 * 1024 * 1024 },
    );
  } catch (error) {
    await rm(dir, { recursive: true, force: true });

    // Git echoes the URL it was given, so its output can carry a credential the user
    // embedded in the URL — and the redaction has to run before anything is shown.
    const detail = cloneErrorDetail(error, token);

    throw new Error(cloneFailureMessage(safeUrl, detail, token !== undefined));
  }

  return {
    root: dir,
    source: safeUrl,
    ephemeral: true,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}
