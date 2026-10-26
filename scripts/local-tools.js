"use strict";
// LOCAL (OFFLINE) USE — helpers for FINMAN.bat on the office computer.
//   node scripts/local-tools.js wait [port]      waits until the app answers
//   node scripts/local-tools.js urls [port]      prints the addresses other
//                                                devices on the same Wi-Fi use
//   node scripts/local-tools.js backup [--if-older-than DAYS] [--keep N]
//        writes a full copy of the local MySQL database (the DB_* settings in
//        .env) to Backups\finman-YYYY-MM-DD_HHMM.sql.gz, checks the file is
//        complete, and keeps the newest N (default 12). The Backups folder is
//        never sent to GitHub (.gitignore).
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const http = require("http");
const { spawn, spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const BACKUP_DIR = process.env.FINMAN_BACKUP_DIR || path.join(ROOT, "Backups");

function envValue(text, key) {
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (m && m[1] === key) {
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      return v;
    }
  }
  return null;
}

function healthOnce(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/api/health", timeout: 2000 }, (res) => { res.resume(); resolve(res.statusCode === 200); });
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
  });
}

async function wait(port) {
  const start = Date.now();
  while (Date.now() - start < 60000) {
    if (await healthOnce(port)) return 0;
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.log("[X] System-ku ma shidmin 60 ilbiriqsi gudahood. Eeg daaqadda 'FINMAN server'.");
  return 1;
}

function urls(port) {
  const list = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === "IPv4" && !a.internal && !/^169\.254\./.test(a.address) && !/vEthernet|VirtualBox|VMware|WSL/i.test(name)) list.push(a.address);
    }
  }
  console.log(`    Kombiyuutarkan:  http://localhost:${port}`);
  for (const ip of list) console.log(`    WiFi-ga (telefoon/kombiyuutar kale): http://${ip}:${port}`);
  return 0;
}

function findTool(name) {
  const exe = process.platform === "win32" ? `${name}.exe` : name;
  const r = spawnSync(process.platform === "win32" ? "where" : "which", [name], { encoding: "utf8" });
  if (r.status === 0 && r.stdout.trim()) return r.stdout.trim().split(/\r?\n/)[0];
  const bases = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]].filter(Boolean).map((p) => path.join(p, "MySQL"));
  for (const base of bases) {
    if (!fs.existsSync(base)) continue;
    for (const d of fs.readdirSync(base).sort().reverse()) {
      const p = path.join(base, d, "bin", exe);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

function listBackups() {
  if (!fs.existsSync(BACKUP_DIR)) return [];
  return fs.readdirSync(BACKUP_DIR).filter((f) => /^finman-\d{4}-\d{2}-\d{2}_\d{4}\.sql\.gz$/.test(f)).sort();
}

async function backup(args) {
  const i = args.indexOf("--if-older-than");
  const olderDays = i >= 0 ? Number(args[i + 1]) : 0;
  const k = args.indexOf("--keep");
  const keep = k >= 0 ? Math.max(1, Number(args[k + 1]) || 12) : 12;
  const existing = listBackups();
  if (olderDays > 0 && existing.length) {
    const last = fs.statSync(path.join(BACKUP_DIR, existing[existing.length - 1])).mtimeMs;
    const days = (Date.now() - last) / 86400000;
    if (days < olderDays) { console.log(`    Backup-kii ugu dambeeyay waa ${days.toFixed(1)} maalmood jir — hadda looma baahna.`); return 0; }
  }
  const envFile = process.env.FINMAN_ENV_FILE || path.join(ROOT, ".env");
  if (!fs.existsSync(envFile)) { console.log("[X] .env lama helin — marka hore socodsii RUN-MYSQL.bat."); return 1; }
  const env = fs.readFileSync(envFile, "utf8");
  const db = { host: envValue(env, "DB_HOST") || "localhost", port: envValue(env, "DB_PORT") || "3306", user: envValue(env, "DB_USER"), password: envValue(env, "DB_PASSWORD") || "", name: envValue(env, "DB_NAME") };
  if (!db.user || !db.name) { console.log("[X] DB_* settings-ka .env ma dhammaystirna."); return 1; }
  const dump = findTool("mysqldump");
  if (!dump) { console.log("[X] mysqldump lama helin (wuxuu la socdaa MySQL)."); return 1; }

  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const name = `finman-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}.sql.gz`;
  const final = path.join(BACKUP_DIR, name);
  const tmp = final + ".part";
  console.log(`    Backup ayaa la samaynayaa: Backups\\${name}`);
  // One consistent snapshot; the password goes only through the environment.
  const child = spawn(dump, ["-h", db.host, "-P", String(db.port), "-u", db.user, "--single-transaction", "--quick", "--no-tablespaces",
    "--set-gtid-purged=OFF", "--default-character-set=utf8mb4", "--hex-blob", "--routines=false", "--triggers", db.name],
  { env: { ...process.env, MYSQL_PWD: db.password }, stdio: ["ignore", "pipe", "pipe"] });
  let err = "";
  child.stderr.on("data", (c) => { err += c; });
  const out = fs.createWriteStream(tmp);
  child.stdout.pipe(zlib.createGzip()).pipe(out);
  const code = await new Promise((r) => child.on("close", r));
  await new Promise((r) => (out.writableFinished ? r() : out.on("finish", r)));
  if (code !== 0) {
    fs.rmSync(tmp, { force: true });
    console.log(`[X] Backup-ku wuu fashilmay: ${err.split("\n").filter((l) => !/Using a password/i.test(l)).join(" ").trim()}`);
    return 1;
  }
  // A complete mysqldump always ends with "-- Dump completed".
  const text = zlib.gunzipSync(fs.readFileSync(tmp)).toString("utf8");
  if (!/-- Dump completed/.test(text.slice(-300)) || !/CREATE TABLE/.test(text)) {
    fs.rmSync(tmp, { force: true });
    console.log("[X] Backup-ku ma dhammaystirna — lama keydin.");
    return 1;
  }
  fs.renameSync(tmp, final);
  const tables = (text.match(/^CREATE TABLE /gm) || []).length;
  console.log(`    OK — ${tables} table, ${(fs.statSync(final).size / 1024).toFixed(0)} KB.`);
  const all = listBackups();
  for (const old of all.slice(0, Math.max(0, all.length - keep))) fs.rmSync(path.join(BACKUP_DIR, old), { force: true });
  return 0;
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  const port = Number((cmd === "wait" || cmd === "urls") && args[0] ? args[0] : 4000);
  if (cmd === "wait") return wait(port);
  if (cmd === "urls") return urls(port);
  if (cmd === "backup") return backup(args);
  console.log("Usage: local-tools.js wait|urls [port] | backup [--if-older-than DAYS] [--keep N]");
  return 1;
}
main().then((c) => { process.exitCode = c; }).catch((e) => { console.log(`[X] ${e.message}`); process.exitCode = 1; });
