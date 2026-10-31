"use strict";
// Bundles frontend/app.jsx (+ React/ReactDOM) into public/app.bundle.js.
// Run with: npm run build:frontend
const path = require("path");
let esbuild;
try {
  esbuild = require("esbuild");
} catch (e) {
  console.error(
    'esbuild is not installed. Run "npm install --include=dev" (it is listed as a devDependency) and try again.'
  );
  process.exit(1);
}

esbuild
  .build({
    entryPoints: [path.join(__dirname, "..", "frontend", "app.jsx")],
    bundle: true,
    minify: true,
    outfile: path.join(__dirname, "..", "public", "app.bundle.js"),
    loader: { ".js": "jsx" },
    jsx: "automatic",
    // SOMALI / ENGLISH LANGUAGE SUPPORT: React's JSX runtime wrapped with the
    // interface-text translation step (frontend/i18n-jsx/jsx-runtime.js).
    jsxImportSource: "obo-i18n",
    alias: { "obo-i18n": path.join(__dirname, "..", "frontend", "i18n-jsx") },
    target: ["chrome100", "firefox100", "safari15"],
    logLevel: "info",
  })
  .then(() => {
    // CACHE BUSTING: the hosting edge caches /app.bundle.js for a month, so
    // index.html (never cached) points at /app.bundle.js?v=<content hash>.
    // A new build = a new URL, and every browser loads the new code at once.
    const fs = require("fs");
    const crypto = require("crypto");
    const pub = path.join(__dirname, "..", "public");
    const hash = crypto.createHash("sha256").update(fs.readFileSync(path.join(pub, "app.bundle.js"))).digest("hex").slice(0, 12);
    const indexFile = path.join(pub, "index.html");
    const html = fs.readFileSync(indexFile, "utf8");
    const next = html.replace(/<script src="\/app\.bundle\.js(\?v=[a-f0-9]+)?"><\/script>/, `<script src="/app.bundle.js?v=${hash}"></script>`);
    if (next === html && !html.includes(`?v=${hash}`)) throw new Error("index.html has no <script src=\"/app.bundle.js\"> tag to version.");
    fs.writeFileSync(indexFile, next);
    console.log(`Frontend bundled -> public/app.bundle.js (index.html -> ?v=${hash})`);
  })
  .catch(() => process.exit(1));
