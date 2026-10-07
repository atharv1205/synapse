import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import ignoreFactory, { type Ignore } from "ignore";
import type { Language, SourceFile } from "../types.js";

// `ignore` is CJS with a namespace-merged default export. NodeNext gives us the module
// object instead of the factory function it really is, so re-type it.
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

/** Folders we always skip, .gitignore or not. They never hold first-party code. */
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
  // Go's vendored deps, plus build output from Maven, Gradle and Go tooling.
  "vendor",
  "target",
  ".gradle",
]);

/** Skip anything bigger than this. Minified bundles just choke the parser for nothing. */
const MAX_FILE_BYTES = 1_500_000;

export function languageForPath(filePath: string): Language | undefined {
  return EXTENSION_LANGUAGE[path.extname(filePath).toLowerCase()];
}

/** A .gitignore and the folder its patterns are relative to. */
interface IgnoreLayer {
  /** Folder the patterns are relative to, repo-relative, forward slashes. */
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
 * True if any .gitignore in scope ignores `relPath`. Each layer checks the path relative
 * to its own .gitignore's folder, which is how git handles nested ignore files too.
 */
function isIgnored(layers: IgnoreLayer[], relPath: string, isDir: boolean): boolean {
  for (const layer of layers) {
    const scoped = layer.base === "" ? relPath : relPath.slice(layer.base.length + 1);
    if (scoped === "" || scoped.startsWith("..")) continue;
    // `ignore` needs the trailing slash for folder-only patterns (`foo/`).
    if (layer.matcher.ignores(isDir ? `${scoped}/` : scoped)) return true;
  }
  return false;
}

export interface WalkResult {
  files: SourceFile[];
  /**
   * Every package.json and go.mod we found (repo-relative). Used to resolve imports of
   * workspace packages and Go modules to files in the repo.
   */
  manifests: string[];
}

/**
 * Recursively list every source file we can parse under `root`, respecting .gitignore at
 * every level. Paths are relative to `root` and sorted so the output is stable.
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
      return; // can't read this folder (permissions, race), skip it and keep going
    }

    for (const entry of entries) {
      if (ALWAYS_SKIP.has(entry.name)) continue;

      const childRel = dirRel === "" ? entry.name : `${dirRel}/${entry.name}`;

      if (entry.isSymbolicLink()) continue; // skip symlinks: avoids loops and leaving the repo

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
