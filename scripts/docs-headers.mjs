/**
 * After the docs are built (VitePress, into dist/docs): let their few inline
 * scripts run under the site's Content-Security-Policy.
 *
 * The app allows no inline scripts at all (public/_headers: script-src
 * 'self'). VitePress puts three small ones in every page: the dark-mode
 * check, a Mac check, and the map of its pages, which changes whenever the
 * docs do. Each is allowed by its exact SHA-256 hash, added here to the
 * policy in dist/_headers: only those exact scripts can run, so the app
 * gains nothing it could misuse, and the site keeps one policy.
 *
 * Run by `npm run docs:build` (part of `npm run build`).
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DIST = new URL("../dist/", import.meta.url).pathname;
const DOCS = join(DIST, "docs");
const HEADERS = join(DIST, "_headers");

/** Every .html file under a folder. */
function pages(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return pages(path);
    return entry.name.endsWith(".html") ? [path] : [];
  });
}

const hashes = new Set();
for (const page of pages(DOCS)) {
  const html = readFileSync(page, "utf8");
  for (const [, attributes, body] of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
    if (/\bsrc=/.test(attributes) || !body.trim()) continue;
    hashes.add(`'sha256-${createHash("sha256").update(body, "utf8").digest("base64")}'`);
  }
}

const headers = readFileSync(HEADERS, "utf8");
const policy = /^(\s+Content-Security-Policy:.*script-src 'self')/m;
if (!policy.test(headers)) throw new Error(`No "script-src 'self'" in a Content-Security-Policy line of ${HEADERS}`);
writeFileSync(HEADERS, headers.replace(policy, `$1 ${[...hashes].sort().join(" ")}`));
console.log(`docs: allowed ${hashes.size} inline script(s) by hash in dist/_headers`);
