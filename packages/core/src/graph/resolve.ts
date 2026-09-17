import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Language, SourceFile } from "../types.js";
import type { ImportRef } from "../parse/extract.js";

/** Extensions tried, in order, when a JS/TS specifier has no usable extension. */
const JS_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
const JS_INDEX_FILES = JS_EXTENSIONS.map((ext) => `index${ext}`);

/**
 * TypeScript's NodeNext resolution has source files import `./foo.js` to mean `./foo.ts`.
 * Maps a runtime extension back to the source extensions that could have produced it.
 */
const RUNTIME_TO_SOURCE: Record<string, string[]> = {
  ".js": [".ts", ".tsx", ".js", ".jsx"],
  ".mjs": [".mts", ".mjs"],
  ".cjs": [".cts", ".cjs"],
};

/** An index of everything in the repo that an import could point at. */
export class ImportResolver {
  /** Every repo-relative source path, for O(1) existence checks. */
  private readonly files: Set<string>;
  /** Workspace/monorepo package name -> directory, so `@scope/pkg` resolves internally. */
  private readonly packages = new Map<string, string>();

  private constructor(files: SourceFile[]) {
    this.files = new Set(files.map((f) => f.path));
  }

  /**
   * Builds the index. Reads every package.json outside node_modules so that
   * bare specifiers pointing at sibling workspace packages resolve to real files
   * rather than being written off as external.
   */
  static async create(root: string, files: SourceFile[], manifestPaths: string[]): Promise<ImportResolver> {
    const resolver = new ImportResolver(files);

    for (const manifest of manifestPaths) {
      try {
        const raw = await readFile(path.join(root, manifest), "utf8");
        const name: unknown = JSON.parse(raw)?.name;
        if (typeof name === "string" && name.length > 0) {
          resolver.packages.set(name, path.posix.dirname(manifest) === "." ? "" : path.posix.dirname(manifest));
        }
      } catch {
        // A malformed or unreadable package.json just means no workspace alias from it.
      }
    }

    return resolver;
  }

  private has(candidate: string): string | undefined {
    return this.files.has(candidate) ? candidate : undefined;
  }

  /** Tries `base` itself, then `base + ext`, then `base/index.*`. */
  private resolveJsTarget(base: string): string | undefined {
    const ext = path.posix.extname(base);

    if (ext) {
      const sourceExts = RUNTIME_TO_SOURCE[ext];
      if (sourceExts) {
        const stem = base.slice(0, -ext.length);
        for (const candidate of sourceExts) {
          const hit = this.has(stem + candidate);
          if (hit) return hit;
        }
      }
      const direct = this.has(base);
      if (direct) return direct;
    }

    for (const candidate of JS_EXTENSIONS) {
      const hit = this.has(base + candidate);
      if (hit) return hit;
    }
    for (const indexFile of JS_INDEX_FILES) {
      const hit = this.has(path.posix.join(base, indexFile));
      if (hit) return hit;
    }
    return undefined;
  }

  /** Tries `base.py`, `base.pyi`, then `base/__init__.py`. */
  private resolvePyTarget(base: string): string | undefined {
    return (
      this.has(`${base}.py`) ??
      this.has(`${base}.pyi`) ??
      this.has(path.posix.join(base, "__init__.py")) ??
      this.has(path.posix.join(base, "__init__.pyi"))
    );
  }

  private resolveJs(fromFile: string, specifier: string): string | undefined {
    if (specifier.startsWith(".")) {
      const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), specifier));
      return this.resolveJsTarget(base);
    }

    if (specifier.startsWith("/")) return undefined; // absolute filesystem import; not ours to resolve

    // Bare specifier: a workspace package is internal, anything else is a dependency.
    for (const [name, dir] of this.packages) {
      if (specifier !== name && !specifier.startsWith(`${name}/`)) continue;
      const subpath = specifier.slice(name.length).replace(/^\//, "");
      const base = subpath ? path.posix.join(dir, subpath) : dir;
      return this.resolveJsTarget(base) ?? this.resolveJsTarget(path.posix.join(base, "src"));
    }

    return undefined;
  }

  private resolvePy(fromFile: string, specifier: string): string | undefined {
    const dots = /^\.+/.exec(specifier)?.[0].length ?? 0;

    if (dots > 0) {
      // One dot is the current package, each extra dot walks one directory up.
      let dir = path.posix.dirname(fromFile);
      for (let i = 1; i < dots; i++) dir = path.posix.dirname(dir);
      if (dir === ".") dir = "";
      const rest = specifier.slice(dots).split(".").filter(Boolean);
      return this.resolvePyTarget(path.posix.join(dir, ...rest));
    }

    const parts = specifier.split(".").filter(Boolean);
    if (parts.length === 0) return undefined;

    // Absolute imports are relative to some source root. Try the repo root, then
    // each ancestor of the importing file, which covers `src/` and similar layouts.
    const roots = [""];
    let dir = path.posix.dirname(fromFile);
    while (dir !== "." && dir !== "") {
      roots.push(dir);
      dir = path.posix.dirname(dir);
    }

    for (const base of roots) {
      const hit = this.resolvePyTarget(path.posix.join(base, ...parts));
      if (hit) return hit;
    }
    return undefined;
  }

  /**
   * Maps an import to the repo-relative path it points at, or undefined when the
   * target is external (a dependency, the stdlib) or could not be resolved.
   */
  resolve(fromFile: string, language: Language, ref: ImportRef): string | undefined {
    const target =
      language === "python"
        ? this.resolvePy(fromFile, ref.specifier)
        : this.resolveJs(fromFile, ref.specifier);

    // A file importing itself adds nothing but a self-loop.
    return target === fromFile ? undefined : target;
  }
}
