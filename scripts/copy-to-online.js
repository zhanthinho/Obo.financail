"use strict";
// COPY LOCAL DATA ONLINE — copies this computer's FINMAN MySQL database
// (the DB_* settings in .env) into an EMPTY online MySQL database (for
// example an Aiven free MySQL used by the Render web service).
//
// Used by COPY-XOGTA-ONLINE.bat. Safety rules:
//   * the local database is only READ (one consistent snapshot) — never changed;
//   * the online database must be EMPTY — if it already has tables the script
//     stops and changes nothing (it never overwrites online data);
//   * every table is copied with its exact structure (SHOW CREATE TABLE), then
//     every table's row count AND a checksum of all its rows are compared on
//     both sides; any difference is reported as a failure;
//   * the online password is typed by you (hidden) and never written to disk;
//     the connection is encrypted (TLS), verified with ca.pem when present.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const readline = require("readline");
const mysql = require("mysql2/promise");

const ROOT = path.join(__dirname, "..");

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

function ask(q, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      rl._writeToOutput = (s) => { if (s.includes(q)) rl.output.write(s); else if (s === "\r\n" || s === "\n") rl.output.write(s); else rl.output.write("*"); };
    }
    rl.question(q, (a) => { rl.close(); if (hidden) process.stdout.write("\n"); resolve(a.trim()); });
  });
}

// Values come back exactly as stored: dates/decimals/big numbers as text,
// JSON as its text, binary as Buffers — so nothing is reformatted in transit.
const typeCast = (field, next) => (field.type === "JSON" ? field.string("utf8") : next());
const COMMON = { dateStrings: true, supportBigNumbers: true, bigNumberStrings: true, decimalNumbers: false, charset: "UTF8MB4_GENERAL_CI", typeCast, multipleStatements: false };

async function session(c) {
  await c.query("SET NAMES utf8mb4 COLLATE utf8mb4_0900_bin");
  await c.query("SET SESSION time_zone = '+00:00'");
}

function rowHash(h, row, cols) {
  h.update("\u0001");
  for (const c of cols) {
    const v = row[c];
    if (v === null || v === undefined) h.update("N");
    else if (Buffer.isBuffer(v)) { h.update("b"); h.update(v); }
    else h.update("s" + String(v));
    h.update("\u0000");
  }
}

async function tableChecksum(c, table, cols, pk) {
  const h = crypto.createHash("sha256");
  const order = (pk.length ? pk : cols).map((x) => `\`${x}\``).join(", ");
  const [rows] = await c.query(`SELECT * FROM \`${table}\` ORDER BY ${order}`);
  for (const r of rows) rowHash(h, r, cols);
  return { count: rows.length, sum: h.digest("hex") };
}

async function main() {
  console.log("");
  const envFile = process.env.COPY_TEST_ENV_FILE || path.join(ROOT, ".env");
  if (!fs.existsSync(envFile)) { console.log("[X] .env lama helin — marka hore socodsii RUN-MYSQL.bat."); return 1; }
  const env = fs.readFileSync(envFile, "utf8");
  const src = {
    host: envValue(env, "DB_HOST") || "localhost", port: Number(envValue(env, "DB_PORT") || 3306),
    user: envValue(env, "DB_USER"), password: envValue(env, "DB_PASSWORD") || "", database: envValue(env, "DB_NAME"),
  };
  if (!src.user || !src.database) { console.log("[X] DB_* settings-ka .env ma dhammaystirna — socodsii RUN-MYSQL.bat marka hore."); return 1; }

  let host, port, user, database, password;
  if (process.env.COPY_TEST_TARGET) {
    // Automated tests only (test/copy-to-online.js): a disposable local target.
    ({ host, port, user, database, password } = JSON.parse(process.env.COPY_TEST_TARGET));
  } else {
    console.log("Geli xogta database-ka ONLINE-ka (Aiven -> service-kaaga -> Overview -> Connection information):");
    host = await ask("  Host: ");
    port = Number(await ask("  Port: "));
    user = (await ask("  User [avnadmin]: ")) || "avnadmin";
    database = (await ask("  Database name [defaultdb]: ")) || "defaultdb";
    password = await ask("  Password (lama muujinayo): ", { hidden: true });
  }
  if (!host || !Number.isInteger(port) || !password) { console.log("[X] Host, port iyo password waa lagama maarmaan."); return 1; }
  const caFile = path.join(ROOT, "ca.pem");
  let ssl;
  if (process.env.COPY_TEST_TARGET) ssl = undefined;
  else if (fs.existsSync(caFile)) { ssl = { ca: fs.readFileSync(caFile, "utf8"), rejectUnauthorized: true }; console.log("  TLS: ca.pem ayaa la isticmaalayaa (shahaadada waa la hubinayaa)."); }
  else { ssl = { rejectUnauthorized: false }; console.log("  TLS: ca.pem lama helin — xidhiidhku waa qarsoon yahay laakiin shahaadada lama hubin."); }

  console.log("\n[1/4] Xidhiidhka labada database...");
  const a = await mysql.createConnection({ ...COMMON, ...src });
  const b = await mysql.createConnection({ ...COMMON, host, port, user, password, database, ssl, connectTimeout: 20000 });
  await session(a); await session(b);
  const [[ver]] = await b.query("SELECT VERSION() AS v, @@version_comment AS c");
  if (/mariadb/i.test(`${ver.v} ${ver.c}`)) { console.log(`[X] Online-ku waa MariaDB (${ver.v}); app-ku wuxuu u baahan yahay MySQL 8.`); return 1; }
  console.log(`    Local: ${src.database}  ->  Online: ${database} (MySQL ${ver.v})`);

  const [onlineTables] = await b.query("SELECT TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()");
  if (onlineTables.length) {
    console.log(`[X] Database-ka online-ka horay ayuu u leeyahay ${onlineTables.length} table. Waxba lama beddelin.`);
    console.log("    (Script-kani xog online ah dul kuma qoro. Isticmaal database madhan.)");
    return 1;
  }

  // One consistent snapshot of the local database.
  await a.query("SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ");
  await a.query("START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY");
  const [tables] = await a.query("SELECT TABLE_NAME AS t, DATA_LENGTH + INDEX_LENGTH AS bytes FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME");
  const totalMb = tables.reduce((s, t) => s + Number(t.bytes || 0), 0) / 1048576;
  console.log(`    ${tables.length} table, qiyaastii ${totalMb.toFixed(1)} MB.`);
  if (!tables.length) { console.log("[X] Database-ka local-ka waa madhan yahay."); return 1; }

  console.log("[2/4] Samaynta table-yada online-ka...");
  await b.query("SET FOREIGN_KEY_CHECKS = 0");
  const meta = {};
  const created = [];
  try {
  for (const { t } of tables) {
    const [[ct]] = await a.query(`SHOW CREATE TABLE \`${t}\``);
    await b.query(ct["Create Table"]);
    created.push(t);
    const [cols] = await a.query("SELECT COLUMN_NAME AS c, EXTRA AS x FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION", [t]);
    const [pk] = await a.query("SELECT COLUMN_NAME AS c FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND CONSTRAINT_NAME = 'PRIMARY' ORDER BY ORDINAL_POSITION", [t]);
    meta[t] = { cols: cols.filter((c) => !/\b(VIRTUAL|STORED) GENERATED\b/i.test(c.x)).map((c) => c.c), all: cols.map((c) => c.c), pk: pk.map((p) => p.c) };
  }

  console.log("[3/4] Koobiyaynta xogta...");
  await b.query("START TRANSACTION");
  try {
    for (const { t } of tables) {
      const { cols, pk } = meta[t];
      const order = (pk.length ? pk : cols).map((x) => `\`${x}\``).join(", ");
      const [rows] = await a.query(`SELECT ${cols.map((c) => `\`${c}\``).join(", ")} FROM \`${t}\` ORDER BY ${order}`);
      const list = cols.map((c) => `\`${c}\``).join(", ");
      // Batches of up to 200 rows / ~2 MB, so no single statement is too big.
      const size = (r) => cols.reduce((n, c) => n + (r[c] == null ? 4 : Buffer.isBuffer(r[c]) ? r[c].length * 2 : String(r[c]).length * 2), 0);
      let chunk = [], bytes = 0;
      const flush = async () => {
        if (!chunk.length) return;
        const ph = chunk.map(() => `(${cols.map(() => "?").join(", ")})`).join(", ");
        await b.query(`INSERT INTO \`${t}\` (${list}) VALUES ${ph}`, chunk.flatMap((r) => cols.map((c) => r[c])));
        chunk = []; bytes = 0;
      };
      for (const r of rows) {
        const n = size(r);
        if (chunk.length && (chunk.length >= 200 || bytes + n > 2 * 1048576)) await flush();
        chunk.push(r); bytes += n;
      }
      await flush();
      process.stdout.write(`    ${t}: ${rows.length}\n`);
    }
    await b.query("COMMIT");
  } catch (e) {
    await b.query("ROLLBACK").catch(() => {});
    throw e;
  }
  } catch (e) {
    // The online database was empty before: remove what this run created, so
    // it is empty again and the copy can simply be run once more.
    await b.query("SET FOREIGN_KEY_CHECKS = 0").catch(() => {});
    for (const t of created) await b.query(`DROP TABLE IF EXISTS \`${t}\``).catch(() => {});
    throw e;
  }
  await b.query("SET FOREIGN_KEY_CHECKS = 1");

  console.log("[4/4] Hubinta (tirada iyo checksum-ka table kasta)...");
  let bad = 0;
  for (const { t } of tables) {
    const x = await tableChecksum(a, t, meta[t].all, meta[t].pk);
    const y = await tableChecksum(b, t, meta[t].all, meta[t].pk);
    if (x.count !== y.count || x.sum !== y.sum) { bad += 1; console.log(`    [X] ${t}: local ${x.count} / online ${y.count} — ma isku mid aha`); }
  }
  await a.query("COMMIT");
  await a.end(); await b.end();
  if (bad) { console.log(`\n[X] ${bad} table ayaan isku mid ahayn. Ha isticmaalin online-ka; ii soo dir qoraalkan.`); return 1; }
  console.log(`\n[OK] Dhammaan ${tables.length} table waa la koobiyeeyay oo la hubiyay — xogta online-ku waa la mid tan kombiyuutarka.`);
  console.log("     Xogta kombiyuutarka waxba lagama beddelin.");
  console.log("\nRender: Blueprint-ka (render.yaml) wuxuu ku weydiin doonaa qiimayaashan — adigu geli:");
  console.log(`  DB_HOST=${host}\n  DB_PORT=${port}\n  DB_NAME=${database}\n  DB_USER=${user}\n  DB_PASSWORD=(password-ka Aiven)\n  DB_SSL_CA=(nuxurka ca.pem oo dhan)`);
  return 0;
}

main().then((code) => { process.exitCode = code; }).catch((e) => {
  console.log(`\n[X] Khalad: ${e.message}`);
  console.log("    Online-ka waxa la bilaabay waa la celiyay haddii ay suurtagal ahayd; xogta kombiyuutarka waxba lagama beddelin.");
  process.exitCode = 1;
});
