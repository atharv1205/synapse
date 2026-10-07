#!/usr/bin/env node
// Writes .br and .gz versions next to the text files in dist/ so the server can send
// them pre-compressed. Doing it once at build time beats compressing every request, and
// node's zlib means no extra dependency.
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";

const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist");
const COMPRESSIBLE = new Set([".js", ".css", ".html", ".svg", ".json", ".txt", ".webmanifest"]);
// not worth compressing anything smaller than this
const MIN_BYTES = 1024;

let before = 0;
let after = 0;

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const file = path.join(dir, name);
    if (statSync(file).isDirectory()) {
      walk(file);
      continue;
    }
    if (!COMPRESSIBLE.has(path.extname(name))) continue;

    const source = readFileSync(file);
    if (source.length < MIN_BYTES) continue;

    const br = brotliCompressSync(source, {
      params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: source.length },
    });
    writeFileSync(`${file}.br`, br);
    writeFileSync(`${file}.gz`, gzipSync(source, { level: 9 }));

    before += source.length;
    after += br.length;
  }
}

walk(dist);
console.log(`compressed ${Math.round(before / 1024)}KB of assets to ${Math.round(after / 1024)}KB (brotli)`);
