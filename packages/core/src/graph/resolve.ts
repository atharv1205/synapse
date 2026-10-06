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

function dirOf(filePath: string): string {
  const dir = path.posix.dirname(filePath);
  return dir === "." ? "" : dir;
}

/** An index of everything in the repo that an import could point at. */
export class ImportResolver {
  /** Every repo-relative source path, for O(1) existence checks. */
  private readonly files: Set<string>;
  /** Workspace/monorepo package name -> directory, so `@scope/pkg` resolves internally. */
  private readonly packages = new Map<string, string>();
  /** Go module path -> the directory holding its go.mod. */
  private readonly goModules = new Map<string, string>();
  /** Directory -> the source files directly in it, for packages that are directories. */
  private readonly byDirectory = new Map<string, string[]>();
  /** File name -> every path with that name, for suffix lookups of Java classes. */
  private readonly byName = new Map<string, string[]>();
  /** Java and Go answers depend only on the specifier, and repeat across thousands of files. */
  private readonly cache = new Map<string, string[]>();

  private constructor(files: SourceFile[]) {
    this.files = new Set(files.map((f) => f.path));
    for (const file of files) {
      const dir = path.posix.dirname(file.path);
      const key = dir === "." ? "" : dir;
      const inDir = this.byDirectory.get(key);
      if (inDir) inDir.push(file.path);
      else this.byDirectory.set(key, [file.path]);
      const name = path.posix.basename(file.path);
      const named = this.byName.get(name);
      if (named) named.push(file.path);
      else this.byName.set(name, [file.path]);
    }
  }

  /**
   * Builds the index. Reads every package.json outside node_modules so that
   * bare specifiers pointing at sibling workspace packages resolve to real files
   * rather than being written off as external.
   */
  static async create(root: string, files: SourceFile[], manifestPaths: string[]): Promise<ImportResolver> {
    const resolver = new ImportResolver(files);

    for (const manifest of manifestPaths) {
      const dir = path.posix.dirname(manifest) === "." ? "" : path.posix.dirname(manifest);
      if (path.posix.basename(manifest) === "go.mod") {
        try {
          const raw = await readFile(path.join(root, manifest), "utf8");
          const module = /^\s*module\s+"?([^\s"]+)"?/m.exec(raw)?.[1];
          if (module) resolver.goModules.set(module, dir);
        } catch {
          // An unreadable go.mod just means its module's imports read as external.
        }
        continue;
      }
      try {
        const raw = await readFile(path.join(root, manifest), "utf8");
        const name: unknown = JSON.parse(raw)?.name;
        if (typeof name === "string" && name.length > 0) {
          resolver.packages.set(name, dir);
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

  /** Directories whose path ends with `suffix` (`com/acme`), at any source root. */
  private directoriesEndingWith(suffix: string): string[] {
    const found: string[] = [];
    for (const dir of this.byDirectory.keys()) {
      if (dir === suffix || dir.endsWith(`/${suffix}`)) found.push(dir);
    }
    return found;
  }

  /**
   * `com.acme.Foo` -> `…/com/acme/Foo.java` under any source root (`src/main/java`,
   * `src/test/java`, a module's own). A static import or a nested class names more than
   * the file, so trailing segments drop off until a file matches.
   * `com.acme.*` -> every file of that package, in every source root that has it.
   */
  private resolveJava(fromFile: string, specifier: string): string[] {
    if (specifier === "*") return this.byDirectory.get(dirOf(fromFile)) ?? [];

    if (specifier.endsWith(".*")) {
      const key = `java:${specifier}`;
      let hit = this.cache.get(key);
      if (!hit) {
        const dirs = this.directoriesEndingWith(specifier.slice(0, -2).replaceAll(".", "/"));
        hit = dirs.flatMap((dir) => (this.byDirectory.get(dir) ?? []).filter((f) => f.endsWith(".java")));
        this.cache.set(key, hit);
      }
      return hit;
    }

    const parts = specifier.split(".");
    for (let end = parts.length; end >= 1; end--) {
      const name = `${parts[end - 1]}.java`;
      const suffix = [...parts.slice(0, end - 1), name].join("/");
      const matches = (this.byName.get(name) ?? []).filter((f) => f === suffix || f.endsWith(`/${suffix}`));
      // A class name alone (end = 1) would match any file of that name anywhere.
      if (matches.length > 0 && (end > 1 || parts.length === 1)) return matches;
    }
    return [];
  }

  /**
   * A Go import path names a package, which is a directory: the module whose path
   * prefixes it, plus the rest. `_test.go` files are not part of the importable package.
   * `.` is the importing file's own package, test files included when the importer is
   * one.
   */
  private resolveGo(fromFile: string, specifier: string): string[] {
    const goFiles = (dir: string, withTests: boolean) =>
      (this.byDirectory.get(dir) ?? []).filter((f) => f.endsWith(".go") && (withTests || !f.endsWith("_test.go")));

    if (specifier === ".") return goFiles(dirOf(fromFile), fromFile.endsWith("_test.go"));

    let best: [string, string] | undefined;
    for (const [module, dir] of this.goModules) {
      if (specifier !== module && !specifier.startsWith(`${module}/`)) continue;
      if (!best || module.length > best[0].length) best = [module, dir];
    }
    if (!best) return [];
    const rest = specifier.slice(best[0].length).replace(/^\//, "");
    return goFiles(rest ? path.posix.join(best[1], rest) : best[1], false);
  }

  /**
   * Maps an import to the repo-relative paths it points at: none when the target is
   * external (a dependency, the stdlib) or could not be resolved, one for a JavaScript or
   * Python module, and possibly several for a Java or Go package, which the caller
   * narrows to the files declaring what the importer uses.
   */
  resolveAll(fromFile: string, language: Language, ref: ImportRef): string[] {
    let targets: string[];
    if (language === "java") targets = this.resolveJava(fromFile, ref.specifier);
    else if (language === "go") targets = this.resolveGo(fromFile, ref.specifier);
    else {
      const target =
        language === "python" ? this.resolvePy(fromFile, ref.specifier) : this.resolveJs(fromFile, ref.specifier);
      targets = target ? [target] : [];
    }
    // A file importing itself adds nothing but a self-loop.
    return targets.filter((target) => target !== fromFile);
  }

  /** The first of `resolveAll`'s targets, for imports that name one module. */
  resolve(fromFile: string, language: Language, ref: ImportRef): string | undefined {
    return this.resolveAll(fromFile, language, ref)[0];
  }
}
