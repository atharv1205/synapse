#!/usr/bin/env node
/**
 * Assembles the publishable `synapse-map` package from the monorepo's builds, then runs
 * `npm pack` on it. Nothing is published; the tarball lands in release/.
 *
 *   npm run release:pack
 *
 * Why a staged package rather than publishing the workspaces: the internal names are
 * `@synapse/*`, and that npm scope belongs to someone else, so they can never be
 * published. One self-contained package also gives `npx synapse-map` a single install.
 *
 * Layout of the package:
 *   dist/cli, dist/core, dist/server   compiled JS, with @synapse/* imports made relative
 *   web/                               the built web app, served by `serve`
 *   THIRD_PARTY_NOTICES.md             licences of everything bundled into web/
 *
 * It fails loudly on the packaging bugs `npm link` hides: an internal import left
 * unrewritten, or a third-party import that is not a declared dependency.
 */
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { isBuiltin } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const NAME = "synapse-map";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RELEASE = path.join(ROOT, "release");
const STAGE = path.join(RELEASE, NAME);

/** Monorepo packages whose compiled source ships, and where it goes in the package. */
const PARTS = {
  "@synapse/core": { from: "packages/core", to: "dist/core" },
  "@synapse/server": { from: "packages/server", to: "dist/server" },
  "@synapse/cli": { from: "packages/cli", to: "dist/cli" },
};

const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
const fail = (message) => {
  console.error(`pack: ${message}`);
  process.exit(1);
};

function walk(dir, visit) {
  for (const name of readdirSync(dir)) {
    const file = path.join(dir, name);
    if (statSync(file).isDirectory()) walk(file, visit);
    else visit(file);
  }
}

// --- 0. the builds must exist --------------------------------------------------

for (const { from } of Object.values(PARTS)) {
  if (!existsSync(path.join(ROOT, from, "dist/src/index.js"))) {
    fail(`${from} is not built. Run \`npm run build\` first.`);
  }
}
const WEB_DIST = path.join(ROOT, "packages/web/dist");
if (!existsSync(path.join(WEB_DIST, "index.html"))) fail("packages/web is not built.");

rmSync(STAGE, { recursive: true, force: true });
mkdirSync(STAGE, { recursive: true });

// --- 1. compiled JS, with internal imports rewritten ----------------------------

for (const { from, to } of Object.values(PARTS)) {
  cpSync(path.join(ROOT, from, "dist/src"), path.join(STAGE, to), {
    recursive: true,
    // Declarations, maps and build info are for developing Synapse, not running it.
    filter: (source) => statSync(source).isDirectory() || source.endsWith(".js"),
  });
}

const SPECIFIER = /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(["'])([^"']+)\2/g;
const imported = new Set();

walk(path.join(STAGE, "dist"), (file) => {
  if (!file.endsWith(".js")) return;
  const source = readFileSync(file, "utf8");

  // Collect bare imports from code lines only: tsc keeps comments, and a comment that
  // quotes an example like `export ... from "x"` is not a dependency.
  for (const line of source.split("\n")) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*")) continue;
    for (const [, , , specifier] of line.matchAll(SPECIFIER)) {
      if (!specifier.startsWith(".") && !(specifier in PARTS)) imported.add(specifier);
    }
  }

  const rewritten = source.replace(SPECIFIER, (match, lead, quote, specifier) => {
    const part = PARTS[specifier];
    if (!part) return match;
    let relative = path.relative(path.dirname(file), path.join(STAGE, part.to, "index.js"));
    if (!relative.startsWith(".")) relative = `./${relative}`;
    return `${lead}${quote}${relative.split(path.sep).join("/")}${quote}`;
  });

  writeFileSync(file, rewritten);
});

// --- 2. dependencies: the union of the parts' own, checked against the imports --

const dependencies = {};
for (const { from } of Object.values(PARTS)) {
  const manifest = readJson(path.join(ROOT, from, "package.json"));
  for (const [dep, range] of Object.entries(manifest.dependencies ?? {})) {
    if (dep in PARTS) continue;
    if (dependencies[dep] && dependencies[dep] !== range) {
      fail(`${dep} is required as both ${dependencies[dep]} and ${range}.`);
    }
    dependencies[dep] = range;
  }
}

const packageOf = (specifier) =>
  specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0];

for (const specifier of imported) {
  if (isBuiltin(specifier)) continue;
  if (specifier.startsWith("@synapse/")) fail(`an internal import survived: ${specifier}`);
  if (!(packageOf(specifier) in dependencies)) {
    fail(`the shipped code imports ${specifier}, which is not a declared dependency.`);
  }
}

// --- 3. the web app ------------------------------------------------------------

cpSync(WEB_DIST, path.join(STAGE, "web"), { recursive: true });

// --- 4. third-party notices for what the web bundle contains --------------------

/**
 * For a package published without a licence file. MIT's text is standard and only the
 * copyright line varies, so it is written out with the holder from package.json and a
 * note saying where that came from. Any other licence is named, not reconstructed.
 */
function licenceFromManifest(manifest) {
  const author = typeof manifest.author === "string" ? manifest.author : manifest.author?.name;
  if (manifest.license !== "MIT" || !author) {
    return `Licensed under ${manifest.license ?? "an unstated licence"}; the package ships no licence file.`;
  }
  return [
    `(The package ships no licence file. This is the MIT licence its package.json declares,`,
    `with the copyright holder taken from its author field.)`,
    ``,
    `MIT License`,
    ``,
    `Copyright (c) ${author}`,
    ``,
    readFileSync(path.join(ROOT, "LICENSE"), "utf8").split("\n").slice(4).join("\n").trim(),
  ].join("\n");
}

/** Maps each npm package named in a build's sourcemaps to its directory on disk. */
function collectSources(out, found) {
  walk(out, (file) => {
    if (!file.endsWith(".map")) return;
    const map = readJson(file);
    for (const source of map.sources ?? []) {
      const absolute = path.resolve(path.dirname(file), map.sourceRoot ?? "", source);
      const marker = `${path.sep}node_modules${path.sep}`;
      const at = absolute.lastIndexOf(marker);
      if (at === -1) continue;
      const rest = absolute.slice(at + marker.length).split(path.sep);
      const name = rest[0].startsWith("@") ? `${rest[0]}/${rest[1]}` : rest[0];
      found.set(name, path.join(absolute.slice(0, at + marker.length), name));
    }
  });
}

/**
 * The web bundle is minified, which strips every licence comment, yet MIT and OFL both
 * require their notices to travel with copies. A second, sourcemapped build says
 * exactly which packages made it into the bundle; their licence files are collected
 * from there. Fonts ship as CSS-referenced files that no JS sourcemap sees, so the
 * @fontsource packages are added from the web app's dependencies.
 */
function thirdPartyNotices() {
  // Built beside dist/, at the same depth: the sourcemaps' relative paths are written as
  // if from dist/assets, so an output folder anywhere else resolves them wrongly.
  const out = path.join(ROOT, "packages/web/.notices-build");
  const found = new Map();
  try {
    execFileSync(
      "npm",
      ["exec", "--workspace", "@synapse/web", "--", "vite", "build", "--sourcemap", "--outDir", out, "--emptyOutDir", "--logLevel", "error"],
      { cwd: ROOT, stdio: "inherit" },
    );
    collectSources(out, found);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }

  const webManifest = readJson(path.join(ROOT, "packages/web/package.json"));
  for (const dep of Object.keys(webManifest.dependencies ?? {})) {
    if (!dep.startsWith("@fontsource")) continue;
    const dir = [path.join(ROOT, "node_modules", dep), path.join(ROOT, "packages/web/node_modules", dep)].find(
      (candidate) => existsSync(candidate),
    );
    if (dir) found.set(dep, dir);
  }

  if (!found.has("three") || !found.has("react")) {
    fail("the sourcemaps did not list three and react; the notices would be incomplete.");
  }

  const sections = [...found.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, dir]) => {
      const manifest = readJson(path.join(dir, "package.json"));
      const licenceFile = readdirSync(dir).find((f) => /^(licen[cs]e|copying)(\.(md|txt))?$/i.test(f));
      const text = licenceFile
        ? readFileSync(path.join(dir, licenceFile), "utf8").trim()
        : licenceFromManifest(manifest);
      return `## ${name} ${manifest.version}\n\nLicence: ${manifest.license ?? "unstated"}\n\n\`\`\`\n${text}\n\`\`\``;
    });

  return [
    "# Third-party notices",
    "",
    `The web app in \`web/\` bundles the following ${found.size} packages, minified. Their`,
    "licences require these notices to accompany copies. Runtime dependencies that npm",
    "installs alongside this package carry their own licences and are not repeated here.",
    "",
    sections.join("\n\n"),
    "",
  ].join("\n");
}

writeFileSync(path.join(STAGE, "THIRD_PARTY_NOTICES.md"), thirdPartyNotices());

// --- 5. manifest, readme, licence ----------------------------------------------

const cli = readJson(path.join(ROOT, "packages/cli/package.json"));
const manifest = {
  name: NAME,
  version: cli.version,
  description:
    "Map a codebase by what it depends on: a ranked 3D graph of its files and functions, with questions answered from cited sources. Runs locally.",
  keywords: ["codebase", "dependency-graph", "code-intelligence", "pagerank", "tree-sitter", "rag", "ollama", "cli"],
  license: "MIT",
  author: "Atharva Dudhe",
  homepage: "https://github.com/atharv1205/synapse#readme",
  repository: { type: "git", url: "git+https://github.com/atharv1205/synapse.git" },
  bugs: { url: "https://github.com/atharv1205/synapse/issues" },
  type: "module",
  bin: { [NAME]: "dist/cli/index.js", synapse: "dist/cli/index.js" },
  files: ["dist", "web", "THIRD_PARTY_NOTICES.md"],
  engines: { node: ">=20" },
  dependencies: Object.fromEntries(Object.entries(dependencies).sort(([a], [b]) => a.localeCompare(b))),
};
writeFileSync(path.join(STAGE, "package.json"), JSON.stringify(manifest, null, 2) + "\n");
cpSync(path.join(ROOT, "README.md"), path.join(STAGE, "README.md"));
cpSync(path.join(ROOT, "LICENSE"), path.join(STAGE, "LICENSE"));

// --- 6. pack -------------------------------------------------------------------

const [result] = JSON.parse(
  execFileSync("npm", ["pack", "--json", "--pack-destination", RELEASE], { cwd: STAGE, encoding: "utf8" }),
);
const kb = (bytes) => `${Math.round(bytes / 1024)}KB`;
console.log(
  `\n${result.filename}: ${result.entryCount} files, ${kb(result.size)} packed, ${kb(result.unpackedSize)} unpacked`,
);
console.log(`  ${Object.keys(dependencies).length} runtime dependencies, ${imported.size} distinct bare imports checked`);
console.log(`  ${path.relative(ROOT, path.join(RELEASE, result.filename))}`);
