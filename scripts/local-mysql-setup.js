"use strict";
// LOCAL SETUP (Windows/Mac/Linux development machine only — not for GoDaddy).
// Used by RUN-MYSQL.bat. Creates the local MySQL database `finman` and its
// own user `finman` with a long random password, and adds the DB_* settings
// to this project's .env. You only type the MySQL ROOT password (in MySQL's
// own prompt); the app's password is generated here and written only to .env.
// Safe to run again: if the DB_* settings in .env already log in, it does
// nothing; if they no longer work, it sets a new password for `finman` (root
// password asked again) and rewrites only the DB_* lines (.env.bak kept).
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const ENV_FILE = path.join(ROOT, ".env");

function findMysql() {
  const r = spawnSync(process.platform === "win32" ? "where" : "which", ["mysql"], { encoding: "utf8" });
  if (r.status === 0 && r.stdout.trim()) return r.stdout.trim().split(/\r?\n/)[0];
  const bases = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]].filter(Boolean).map((p) => path.join(p, "MySQL"));
  for (const base of bases) {
    if (!fs.existsSync(base)) continue;
    for (const d of fs.readdirSync(base).sort().reverse()) {
      const exe = path.join(base, d, "bin", process.platform === "win32" ? "mysql.exe" : "mysql");
      if (fs.existsSync(exe)) return exe;
    }
  }
  return null;
}

// Reads KEY=value pairs from the .env text (first occurrence wins, as in src/env.js).
function envValue(text, key) {
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (m && m[1] === key) { let v = m[2].trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1); return v; }
  }
  return null;
}
// True when the DB_* settings in .env can log in to MySQL.
function settingsWork(mysql, text) {
  const host = envValue(text, "DB_HOST"), user = envValue(text, "DB_USER"), pw = envValue(text, "DB_PASSWORD"), db = envValue(text, "DB_NAME"), port = envValue(text, "DB_PORT") || "3306";
  if (!host || !user || !db) return false;
  const r = spawnSync(mysql, ["-h", host, "-P", port, "-u", user, db, "-e", "SELECT 1"], { env: { ...process.env, MYSQL_PWD: pw || "" }, stdio: "ignore" });
  return r.status === 0;
}

function main() {
  const env = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, "utf8") : "";
  const mysql = findMysql();
  if (!mysql) {
    console.log("[X] MySQL lama helin. Marka hore rakib MySQL 8.4: https://dev.mysql.com/downloads/mysql/");
    return 1;
  }
  const configured = /^\s*DB_HOST\s*=/m.test(env);
  if (configured && settingsWork(mysql, env)) {
    console.log("    OK — database-ka waa diyaar (settings-ka .env way shaqaynayaan).");
    return 0;
  }
  if (configured) console.log("    Settings-ka database-ka ee .env ma shaqaynayaan — waa la hagaajinayaa (password cusub ayaa la samaynayaa).");
  const pw = crypto.randomBytes(18).toString("base64url");
  const sql = [
    "CREATE DATABASE IF NOT EXISTS finman CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin;",
    `CREATE USER IF NOT EXISTS 'finman'@'localhost' IDENTIFIED BY '${pw}';`,
    `ALTER USER 'finman'@'localhost' IDENTIFIED BY '${pw}';`,
    "GRANT ALL PRIVILEGES ON finman.* TO 'finman'@'localhost';",
    "FLUSH PRIVILEGES;",
    "",
  ].join("\n");
  const tmp = path.join(os.tmpdir(), `finman-setup-${crypto.randomBytes(6).toString("hex")}.sql`);
  fs.writeFileSync(tmp, sql, { mode: 0o600 });
  console.log("    Geli password-ka ROOT ee MySQL (kii aad dejisay markii aad rakibaysay):");
  let r;
  try {
    r = spawnSync(mysql, ["-u", "root", "-p", "-h", "localhost", "-e", `source ${tmp.replace(/\\/g, "/")}`], { stdio: "inherit" });
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch (_) { /* ignore */ }
  }
  if (!r || r.status !== 0) {
    console.log("[X] Database-ka lama samayn karin (password-ka root ma khaldanaa?). Dib u socodsii RUN-MYSQL.bat.");
    return 1;
  }
  // Keep every other line of .env exactly; replace only the DB_* settings.
  const kept = env.split(/\r?\n/).filter((l) => !/^\s*DB_(HOST|PORT|NAME|USER|PASSWORD)\s*=/.test(l));
  while (kept.length && kept[kept.length - 1].trim() === "") kept.pop();
  kept.push("DB_HOST=localhost", "DB_PORT=3306", "DB_NAME=finman", "DB_USER=finman", `DB_PASSWORD=${pw}`);
  if (!/^\s*JWT_SECRET\s*=/m.test(env)) kept.push(`JWT_SECRET=${crypto.randomBytes(48).toString("hex")}`);
  if (fs.existsSync(ENV_FILE)) fs.copyFileSync(ENV_FILE, ENV_FILE + ".bak");
  fs.writeFileSync(ENV_FILE, kept.join("\n") + "\n");
  console.log("    OK — database 'finman' iyo user 'finman' waa la sameeyay; settings-ka waxaa lagu daray .env");
  return 0;
}

process.exitCode = main();
