"use strict";
// SECURITY HARDENING round: a tiny, dependency-free .env loader — matches
// this codebase's existing "no external deps" philosophy (see auth.js's own
// hand-rolled JWT instead of a jsonwebtoken dependency). Reads a .env file
// from the project root if one exists and fills in any process.env keys
// that aren't already set from the real environment — a real environment
// variable ALWAYS wins over the .env file, same precedence `dotenv` itself
// uses, so a production deployment that sets JWT_SECRET properly through its
// own process manager is never overridden by a stray .env file.
const fs = require("fs");
const path = require("path");

function loadEnvFile(filePath) {
  let text;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch (e) {
    return; // no .env file — nothing to do, not an error
  }
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    // Strip one layer of matching quotes, same as dotenv.
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadEnvFile(path.join(__dirname, "..", ".env"));

module.exports = {};
