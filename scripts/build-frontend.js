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
  .then(() => console.log("Frontend bundled -> public/app.bundle.js"))
  .catch(() => process.exit(1));
