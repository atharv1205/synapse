import { execFile } from "node:child_process";
import { mkdtemp, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** What we're analysing: a local folder, plus how to clean it up afterwards. */
export interface ResolvedSource {
  /** Absolute path of the folder to analyse. */
  root: string;
  /**
   * The input, copied into the output graph. Never contains credentials: any userinfo in
   * the URL gets stripped first, since this ends up in graph.json.
   */
  source: string;
  /** True if `root` is a temp clone the caller should get rid of. */
  ephemeral: boolean;
  /** Deletes the clone if there is one. Does nothing for local paths. */
  cleanup(): Promise<void>;
}

/**
 * Matches the URL forms git can clone: https://, git://, ssh:// and scp-style
 * `git@host:org/repo`.
 */
export function isRepoUrl(input: string): boolean {
  if (/^(https?|git|ssh):\/\//i.test(input)) return true;
  return /^[\w.-]+@[\w.-]+:.+/.test(input);
}

/**
 * Strip any credentials out of a URL's userinfo so it's safe to log, show in errors and
 * write to graph.json.
 *
 * People can paste `https://ghp_xxx@github.com/org/repo`, so this has to run on every
 * URL, not just ones where we added the token ourselves. The scp-style `git@host:path`
 * has no password in it, so it's left alone.
 */
export function redactUrl(input: string): string {
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(input)) return input;

  try {
    const url = new URL(input);
    if (!url.username && !url.password) return input;
    url.username = "";
    url.password = "";
    // Keep it looking like the original instead of hiding that there was a credential.
    return url.toString().replace("://", "://<redacted>@");
  } catch {
    // Not a parseable URL, so just strip `scheme://userinfo@` as text.
    return input.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/i, "$1<redacted>@");
  }
}

/**
 * Strip userinfo from every URL inside some text, not just text that is a URL. Git quotes
 * the URL in its own errors, e.g.
 * `could not read Password for 'https://<token>@github.com'`, so a pasted credential can
 * show up mid-sentence where `redactUrl` wouldn't catch it.
 */
export function redactUrlsInText(text: string): string {
  return text.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@'"<>]+@/gi, "$1<redacted>@");
}

/** Replace every occurrence of a secret in some text. Used to clean up tool output. */
export function redactSecret(text: string, secret?: string): string {
  if (!secret || secret.length < 4) return text;
  return text.split(secret).join("<redacted>");
}

export interface ResolveOptions {
  /** Clone depth. More history means a better churn signal but a slower clone. */
  depth?: number;
  /**
   * Token for private clones. It only lives in memory and reaches git through the child
   * process env. Never logged, never put in a URL, never written to the clone's git
   * config or any Synapse output.
   */
  token?: string;
  onProgress?: (message: string) => void;
}

/**
 * Builds the env that gives git the token without exposing it.
 *
 * The token goes in an env var that an inline credential helper reads. That way it's
 * never in the process args (anyone on the machine could see it with `ps`), never in the
 * remote URL (git would save it into `.git/config`), and never in a credential store on
 * disk.
 *
 * The first, empty `credential.helper` clears any helpers inherited from the user's own
 * git config, so their keychain can't answer instead.
 */
export function cloneEnv(
  token?: string,
  inherited: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const base: Record<string, string> = {
    ...(inherited as Record<string, string>),
    // Otherwise git hangs forever asking for a username on a private repo.
    GIT_TERMINAL_PROMPT: "0",
  };

  if (!token) return base;

  // Keep any GIT_CONFIG_* entries the user already set and add ours after them, instead
  // of overwriting their config.
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
 * Get the useful bit out of a failed git command.
 *
 * execFile's error repeats the whole command line plus all of stderr, which buries the
 * one line that matters. We keep only git's `fatal:`/`remote:` lines and scrub
 * credentials before showing anything.
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

  return redactSecret(redactUrlsInText(redactSecret(chosen, token)), token).trim();
}

/** Git's own auth errors, which don't tell you what to actually do. */
function looksLikeAuthFailure(message: string): boolean {
  return /authentication failed|could not read username|terminal prompts disabled|repository not found|403|401/i.test(
    message,
  );
}

/**
 * Turn git's raw error into something you can act on.
 *
 * GitHub says "Repository not found" both for a private repo without auth and for a plain
 * typo, so the message has to mention both. We can't tell which one it is.
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
 * Turn a GitHub URL or local path into a folder on disk. URLs get cloned into a temp dir;
 * local paths are used as they are and never modified.
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

  // From here on, anything the user sees uses the redacted URL.
  const safeUrl = redactUrl(input);
  const dir = await mkdtemp(path.join(tmpdir(), "synapse-"));
  onProgress?.(`Cloning ${safeUrl} …`);

  try {
    // We call git directly here instead of going through simple-git. simple-git's argv
    // guard refuses credential-helper and GIT_CONFIG_* env injection, and that's exactly
    // how we keep the token out of argv and out of the clone's config. simple-git still
    // handles the churn queries elsewhere.
    //
    // A shallow clone has enough history for churn, and `--filter=blob:none` skips file
    // contents we never read through git. The `--` stops a URL starting with `-` from
    // being read as an option.
    await run(
      "git",
      ["clone", "--depth", String(depth), "--filter=blob:none", "--", input, dir],
      { env: cloneEnv(token), maxBuffer: 16 * 1024 * 1024 },
    );
  } catch (error) {
    await rm(dir, { recursive: true, force: true });

    // Git echoes the URL back, so its output might contain a credential the user put in
    // the URL. Redact before showing anything.
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
