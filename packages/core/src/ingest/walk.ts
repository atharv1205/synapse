import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import ignoreFactory, { type Ignore } from "ignore";
import type { Language, SourceFile } from "../types.js";

// `ignore` is CJS with a namespace-merged default export, which NodeNext resolves to the
// module object rather than the callable factory it actually is at runtime. Re-type it.
const createIgnore = ignoreFactory as unknown as () => Ignore;

const EXTENSION_LANGUAGE: Record<string, Language> = {
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "tsx",
  ".py": "python",
  ".pyi": "python",
  ".java": "java",
  ".go": "go",
};

/** Directories skipped regardless of .gitignore, because they never hold first-party source. */
const ALWAYS_SKIP = new Set([
  ".git",
  "node_modules",
  ".venv",
  "venv",
  "__pycache__",
  "dist",
  "build",
  ".next",
  ".turbo",
  "site-packages",
  // Go's vendored dependencies, and the build output of Maven, Gradle and Go tooling.
  "vendor",
  "target",
  ".gradle",
]);

/** Skip anything larger than this; minified bundles blow up the parser for no benefit. */
const MAX_FILE_BYTES = 1_500_000;

export function languageForPath(filePath: string): Language | undefined {
  return EXTENSION_LANGUAGE[path.extname(filePath).toLowerCase()];
}

/** A .gitignore file plus the directory its patterns are relative to. */
interface IgnoreLayer {
  /** Directory the patterns anchor to, relative to the repo root, POSIX-separated. */
  base: string;
  matcher: Ignore;
}

async function loadIgnoreLayer(dirAbs: string, baseRel: string): Promise<IgnoreLayer | undefined> {
  try {
    const contents = await readFile(path.join(dirAbs, ".gitignore"), "utf8");
    return { base: baseRel, matcher: createIgnore().add(contents) };
  } catch {
    return undefined;
  }
}

/**
 * True when any .gitignore in scope ignores `relPath`. Each layer tests the path
 * relative to the directory that layer's .gitignore lives in, which is how git
 * itself scopes nested ignore files.
 */
function isIgnored(layers: IgnoreLayer[], relPath: string, isDir: boolean): boolean {
  for (const layer of layers) {
    const scoped = layer.base === "" ? relPath : relPath.slice(layer.base.length + 1);
    if (scoped === "" || scoped.startsWith("..")) continue;
    // `ignore` needs the trailing slash to apply directory-only patterns (`foo/`).
    if (layer.matcher.ignores(isDir ? `${scoped}/` : scoped)) return true;
  }
  return false;
}

export interface WalkResult {
  files: SourceFile[];
  /**
   * Repo-relative paths of every package.json and go.mod found, used to resolve imports
   * of workspace packages and Go modules to files in the repository.
   */
  manifests: string[];
}

/**
 * Recursively list every parseable source file under `root`, honouring .gitignore
 * files at every level. Returns paths relative to `root`, sorted for stable output.
 */
export async function walkSourceFiles(root: string): Promise<WalkResult> {
  const found: SourceFile[] = [];
  const manifests: string[] = [];

  async function visit(dirRel: string, inherited: IgnoreLayer[]): Promise<void> {
    const dirAbs = path.join(root, dirRel);
    const own = await loadIgnoreLayer(dirAbs, dirRel);
    const layers = own ? [...inherited, own] : inherited;

    let entries;
    try {
      entries = await readdir(dirAbs, { withFileTypes: true });
    } catch {
      return; // unreadable directory (permissions, race) — skip rather than abort the walk
    }

    for (const entry of entries) {
      if (ALWAYS_SKIP.has(entry.name)) continue;

      const childRel = dirRel === "" ? entry.name : `${dirRel}/${entry.name}`;

      if (entry.isSymbolicLink()) continue; // avoid cycles and escaping the repo root

      if (entry.isDirectory()) {
        if (isIgnored(layers, childRel, true)) continue;
        await visit(childRel, layers);
        continue;
      }

      if (!entry.isFile()) continue;

      if ((entry.name === "package.json" || entry.name === "go.mod") && !isIgnored(layers, childRel, false)) {
        manifests.push(childRel);
        continue;
      }

      const language = languageForPath(entry.name);
      if (!language) continue;
      if (isIgnored(layers, childRel, false)) continue;

      const info = await stat(path.join(root, childRel));
      if (info.size > MAX_FILE_BYTES) continue;

      found.push({
        path: childRel,
        absPath: path.join(root, childRel),
        language,
        sizeBytes: info.size,
      });
    }
  }

  await visit("", []);
  found.sort((a, b) => a.path.localeCompare(b.path));
  manifests.sort((a, b) => a.localeCompare(b));
  return { files: found, manifests };
}
