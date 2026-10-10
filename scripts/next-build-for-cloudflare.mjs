// The `next build` step of the Cloudflare build (open-next.config.ts sets it
// as buildCommand; run `npm run cf:build`, not this file).
//
// After the build, add the ESM build of @opentelemetry/api to the proxy's trace.
// OpenNext bundles src/proxy.ts preferring "module" entry points, and when the
// package is installed (vitest pulls it in) it uses it instead of Next.js's
// own copy, but Next.js only traced the CommonJS files, so the bundle fails.
import { execFileSync } from "node:child_process";
import { cpSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const run = (cmd, args) => execFileSync(cmd, args, { stdio: "inherit", env: { NEXT_TELEMETRY_DISABLED: "1", ...process.env } });

run("npx", ["next", "build"]);

const nftPath = ".next/server/middleware.js.nft.json";
const esmDir = "node_modules/@opentelemetry/api/build/esm";
const files = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full);
    else files.push(path.relative(".next/server", full).split(path.sep).join("/"));
  }
};
try {
  walk(esmDir);
} catch {
  // Not installed: OpenNext falls back to Next.js's bundled copy by itself.
}
if (files.length) {
  const nft = JSON.parse(readFileSync(nftPath, "utf8"));
  nft.files = [...new Set([...nft.files, ...files])];
  writeFileSync(nftPath, JSON.stringify(nft));
  // Next.js already copied the traced files into its standalone output, which
  // is what OpenNext copies from.
  cpSync(esmDir, path.join(".next/standalone", esmDir), { recursive: true });
}
