"use strict";
// MYSQL / GODADDY round — the `npm run build` step of the hosting pipeline.
//
// GoDaddy runs: production install (no devDependencies) -> npm run build ->
// npm start. The browser app is ALREADY built and committed
// (public/app.bundle.js; rebuild it locally with `npm run build:frontend`,
// which needs the dev dependencies), so nothing is compiled here. This step
// only fails the deploy early if something the server needs is missing.
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const problems = [];
for (const f of ["public/index.html", "public/app.bundle.js", "src/server.js", "src/mysql/schema.json", "src/mysql/tenant-seed.json"]) {
  const p = path.join(ROOT, f);
  if (!fs.existsSync(p) || fs.statSync(p).size === 0) problems.push(`missing: ${f}`);
}
for (const dep of ["mysql2", "pdf-lib", "exceljs"]) {
  try { require.resolve(dep, { paths: [ROOT] }); } catch (e) { problems.push(`dependency not installed: ${dep}`); }
}
const major = Number(process.versions.node.split(".")[0]);
if (major < 22) problems.push(`Node.js 22 or newer is required (this is ${process.version})`);
if (problems.length) {
  console.error("Build check failed:\n  " + problems.join("\n  "));
  process.exit(1);
}
console.log("Build check passed: pre-built frontend present, runtime dependencies installed.");
