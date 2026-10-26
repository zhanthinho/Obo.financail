"use strict";
// LOCAL SETUP (Windows/Mac/Linux development machine only — not for GoDaddy).
// Used by RUN-MYSQL.bat. Creates the local MySQL database `finman` and its
// own user `finman` with a long random password, and adds the DB_* settings
// to this project's .env. You only type the MySQL ROOT password (in MySQL's
// own prompt); the app's password is generated here and written only to .env.
// Safe to run again: if .env already has DB_HOST it does nothing.
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

function main() {
  const env = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, "utf8") : "";
  if (/^\s*DB_HOST\s*=/m.test(env)) {
    console.log("    .env waxaa horay ugu jiray DB_HOST — database-ka mar hore ayaa la diyaariyay.");
    return 0;
  }
  const mysql = findMysql();
  if (!mysql) {
    console.log("[X] MySQL lama helin. Marka hore rakib MySQL 8.4: https://dev.mysql.com/downloads/mysql/");
    return 1;
  }
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
  const lines = [];
  if (env && !env.endsWith("\n")) lines.push("");
  lines.push("DB_HOST=localhost", "DB_PORT=3306", "DB_NAME=finman", "DB_USER=finman", `DB_PASSWORD=${pw}`);
  if (!/^\s*JWT_SECRET\s*=/m.test(env)) lines.push(`JWT_SECRET=${crypto.randomBytes(48).toString("hex")}`);
  fs.appendFileSync(ENV_FILE, lines.join("\n") + "\n");
  console.log("    OK — database 'finman' iyo user 'finman' waa la sameeyay; settings-ka waxaa lagu daray .env");
  return 0;
}

process.exitCode = main();
