# SQLite → GoDaddy Managed MySQL (FINMAN / OBO Financial System)

Xaaladda (2026-10-22): **koodhka waa la beddelay oo waa la tijaabiyay (MySQL 8.0 maxalli ah).
Xogta dhabta ah WALI lama wareejin, wax lama deploy-gareyn, GoDaddy/GitHub laguma xidhin.**
Faylasha SQLite ee hadda jira lama taabanin.

---

## 1. GoDaddy — waxa la xaqiijiyay iyo waxa aan la xaqiijin

Ilaha: `godaddy/nodejs-hosting-agent-skill` (`references/contract.md`, contractVersion 3) iyo
bogga GoDaddy Node.js Hosting.

**La xaqiijiyay (qoraal GoDaddy ah) — koodhku sidan ayuu u dhisan yahay:**

| Shay | Xaqiiq | Koodhka |
|---|---|---|
| Runtime | Node.js 22 | `engines.node = "22.x"` |
| Pipeline | production install (devDependencies lama rakibo) → `npm run build` → `npm start` | `build` = `scripts/build.js` (hubin keliya), `start` = `node src/server.js` |
| package.json | `name`, `version`, `main`, `scripts.build`, `scripts.start` | dhammaan way jiraan |
| Port | `process.env.PORT` | `server.listen(process.env.PORT \|\| 4000)` |
| Database env vars | **`DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`** (platform-ka ayaa dejiya) | `src/mysql/connection.js` — magacyadan oo keliya |
| Driver | `mysql2` gudaha `dependencies`, parameterized queries | `mysql2@^3.24.6`; qiime kasta waa parameter |
| Database | hal MySQL database app kasta | jadwallada oo dhan hal database (prefix) |
| Faylal joogto ah | kaliya `public/assets/` (oo public ah) | xog/backup midna fayl kuma kaydiyo |
| Secrets | env vars qarsoon; `.env` ha la upload-gareyn | `.env` waa `.gitignore`; `.env.example` magacyo keliya |
| `.npmrc` | `registry=https://registry.npmjs.org/` | waa la daray |

**LAMA XAQIIJIN — waa inaad dashboard-ka ka eegtaa (koodhku ma qiyaasayo):**

1. **Preview iyo Publish ma isku database ayay wadaagaan?** Jawaabta: "Ma garanayo weli".
   → Ilaa tan la xaqiijiyo: **ha ku socodsiin preview tijaabo wax qorta, hana u wareejin xogta dhabta ah**.
2. **Nooca MySQL.** Koodhku wuxuu u baahan yahay **MySQL ≥ 8.0.16** (functional indexes + CHECK).
   Haddii uu yahay MariaDB ama 5.7, app-ku si cad ayuu u diidayaa inuu bilaabo (fariin cad) — ma qiyaaso.
3. **Privileges-ka DB user-ka:** waxaa loo baahan yahay `SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX, DROP, REFERENCES`.
   `TRIGGER` iyo `CREATE DATABASE` **looma baahna** (si ula kac ah). Tijaabooyinka waxaa lagu sameeyay user sidaas u xaddidan.
4. **Ma laga gaari karaa MySQL-ka meel ka baxsan GoDaddy** (kombiyuutarkaaga)? Ama ma jiraa console/SSH lagu socodsiiyo
   `node scripts/...`? Migration tool-ku wuxuu u baahan yahay mid ka mid ah (eeg §4). Haddii midna jirin, ii sheeg —
   waxaa loo baahan doonaa endpoint import ah oo hal mar ah oo la ilaaliyo (lama dhisin, sababtoo ah lama xaqiijin).
5. **Storage limit** iyo `max_allowed_packet` (backups-ka waxaa loo kala jaraa 4 MB chunks).
6. **Instances:** app-ku ma ku socdaa hal instance mise dhowr? Koodhku labadaba wuu ilaaliyaa transactions-ka
   (MySQL named lock shirkad kasta), laakiin **hal instance** ayaa la doorbidayaa.
7. **Health check-ga GoDaddy** ma isticmaalaa path gaar ah? App-ku wuxuu bixiyaa `GET /api/health`.

---

## 2. Architecture-ka cusub

### 2.1 Database-ka
- **Hal MySQL database** (`DB_NAME`), InnoDB, `utf8mb4`, collation `utf8mb4_0900_bin`
  (isbarbardhigga qoraalka = sidii SQLite: byte-ba-byte, NO PAD).
- **Platform tables** `ctl_*`: `ctl_companies`, `ctl_platform_users`, `ctl_user_directory`, `ctl_platform_audit`,
  `ctl_backups`, `ctl_backup_chunks`, `ctl_migration_runs`. **Xog maaliyadeed ma hayaan.**
- **Jadwallada shirkad kasta** `cmpNNNN_*`: `cmp0001_clients`, `cmp0002_account_ledger`, … (33 jadwal shirkad kasta).

### 2.2 Kala-saarka shirkadaha (tenant separation)
1. Shirkadda waxaa laga qaataa **token-ka server-ku saxeexay oo keliya** (sidii hore) — URL/body/header lagama qaato.
2. Query kasta waxaa lagu turjumaa **jadwallada shirkaddaas oo keliya** (`src/mysql/dialect.js`). Magac jadwal shirkad kale
   (`cmp0002_…`) ama platform (`ctl_…`) si toos ah haddii loo qoro → **waa la diidaa**.
3. Jadwal kasta oo shirkad: `CHECK (company_id = 'CMP-000N')` → MySQL laftiisa ayaa diida saf shirkad kale (triggers looma baahna).
4. `tenant_meta` → waxaa la hubiyaa ka hor inta aan jadwallada la furin.
5. Query aan shirkad la oggolaaday lahayn → throw (fail closed), sidii hore.

### 2.3 Sync code-ka iyo mysql2
- `src/mysql/worker.js`: worker thread hal connection mysql2 ah leh.
- `src/mysql/sync-client.js`: main thread-ku wuu sugaa (`Atomics.wait`) → `get/all/run/tx` waxay sii ahaanayaan synchronous;
  ~890-ka meelood ee koodhka **lama beddelin**.
- Hal query mar keliya (sidii SQLite) → transaction lama kala goyn karo.
- Timeout (`DB_QUERY_TIMEOUT_MS`, default 25 s): query xayiran → worker-ka waa la joojiyaa, MySQL ayaa rollback gareeya, jawaab 503.
- Connection go'ay transaction dhexdiisa → statement kasta oo xiga waa la diidaa ilaa ROLLBACK; **weligeed lagama sii wado connection cusub**.
- Nested transaction → waa la diidaa. DDL (CREATE/ALTER…) transaction dhexdiisa → waa la diidaa (MySQL wuxuu si qarsoodi ah u commit-gareyn lahaa).
- `tx()` wuxuu sidoo kale qaataa MySQL named lock shirkadda (`GET_LOCK`) → instances kala duwan isma dul qoraan.

### 2.4 SQL dialect
`date(x)` → `LEFT(x,10)` · `CAST(… AS INTEGER)` → `SIGNED` · `INSERT OR IGNORE` → `INSERT IGNORE` ·
`LIKE` → case-insensitive (`utf8mb4_general_ci`, sidii SQLite) · `COLLATE NOCASE` → `utf8mb4_general_ci` ·
`length()` → `CHAR_LENGTH()` · `MAX(a,b)` → `GREATEST` · tiirka `key` → `"key"` · upsert → `ON DUPLICATE KEY UPDATE`.
SQL kale oo SQLite u gaar ah (`julianday`, `GLOB`, `PRAGMA`, `sqlite_master`, `IS ?`, …) → **waa la diidaa** (error), lama oggola inuu si kale u shaqeeyo.
Session: `ANSI_QUOTES, PIPES_AS_CONCAT, NO_BACKSLASH_ESCAPES, STRICT_TRANS_TABLES`, `time_zone = +00:00`.

### 2.5 Schema
- `src/mysql/schema.json` waxaa laga dhaliyay schema-dii ugu dambaysay ee SQLite (`npm run schema:generate`):
  tiir kasta, NOT NULL, defaults, PK, UNIQUE, FK, 26 CHECK, indexes.
- Noocyada: TEXT → `LONGTEXT` (ama `VARCHAR(255)` haddii key/index yahay) · INTEGER → `BIGINT` · REAL → `DOUBLE` (lacagtu waa sidii — isla double-ka JS).
- Partial unique indexes: `WHERE x IS NOT NULL` → UNIQUE caadi ah; `WHERE is_default = 1` → functional `CASE WHEN … END`.
- Start kasta: `ensureScope` — jadwallada maqan way abuurtaa, tiirarka/indexes maqan way ku daraan; **weligeed ma tirtirto, ma beddesho**
  (migrations dib-u-socodsiin ammaan ah, nuqul ma abuuraan).
- Shirkad cusub: jadwallo cusub + xogta bilowga (roles, permissions, categories, templates — `src/mysql/tenant-seed.json`), hal transaction.

### 2.6 Backups, restore, health
- **Backup** = nuqul macquul ah (gzip JSON) **shirkad kasta gaar**, lagu kaydiyo MySQL (`ctl_backups`), sha256 la hubiyo.
  Toos (24 s kasta, 30 la hayo), manual (Super Admin), pre-reset / pre-restore (weligood lama tirtiro).
- **Download**: `GET /api/backups/:name` (Super Admin, shirkaddiisa oo keliya).
- **Restore (manual)**: `node scripts/backup.js restore --company CMP-000N --name <magac> --confirm`
  → kaliya backup isla shirkaddaas ah; marka hore pre-restore backup; hal transaction (dhammaan ama waxba); row count + checksum la hubiyo.
- `/api/_restore-db` (SQLite upload) **waa la saaray**.
- **`/api/health`**: `SELECT 1` → 200 (`database: ok`) ama 503 (`database: unavailable`). MySQL haddii uu dhacsan yahay marka la bilaabayo,
  server-ku wuu bilaabmaa, 503 ayuu bixiyaa, 15 s kasta dib ayuu isku dayaa.
- PDF/Excel exports iyo reports: isla koodhkii (xogta MySQL ayay akhriyaan).

---

## 3. Faylasha la beddelay (kooban)

| Fayl | Sababta |
|---|---|
| `src/mysql/worker.js`, `sync-client.js` | synchronous bridge (mysql2) |
| `src/mysql/connection.js` | env vars GoDaddy, hubinta nooca MySQL, health check |
| `src/mysql/dialect.js` | turjumaadda SQL + kala-saarka jadwallada shirkadaha |
| `src/mysql/compat-db.js` | handle leh qaabkii `prepare().get/all/run`, `exec` |
| `src/mysql/schema.js`, `schema.json`, `tenant-seed.json` | schema MySQL + xogta bilowga shirkad cusub |
| `src/mysql/dump.js`, `integrity.js` | backup/restore + hubinta FK |
| `src/db.js` | MySQL oo keliya (SQLite waa laga saaray) |
| `src/tenancy.js` | control tables MySQL, shirkad cusub = jadwallo cusub |
| `src/backup.js`, `src/routes/backups.js` | backups MySQL gudihiis + download |
| `src/server.js` | health check DB, 503 marka DB dhacsan yahay, start ammaan ah, graceful shutdown; `_restore-db` waa la saaray |
| `src/reset-operational.js`, `src/routes/systemOverview.js` | SQLite-ka laga saaray |
| `scripts/migrate-sqlite-to-mysql.js` | migration tool (§4) |
| `scripts/backup.js` | list/create/download/restore |
| `scripts/integrity-check.js` | MySQL, read-only |
| `scripts/build.js`, `.npmrc`, `.env.example`, `package.json` | GoDaddy packaging |
| `scripts/legacy/*` | koodhkii SQLite (offline oo keliya: migration tool) |
| `test/helpers/mysql.js`, `test/mysql.js`, `test/migration.js` + suites kale | tijaabooyin MySQL ah |
| Waa la tirtiray | `src/schema.sql` (→ `scripts/legacy/`), `src/routes/restore.js`, `scripts/export-db.js` |

---

## 4. Migration tool (SQLite → MySQL)

`scripts/migrate-sqlite-to-mysql.js` — kaliya qalabkan (iyo `scripts/dev`) ayaa SQLite akhriya; app-ku uma baahna SQLite.

1. **Backup aan isbeddelin** — faylasha (`.sqlite`, `-wal`, `-shm`) waxaa loo koobiyeeyaa byte-ba-byte (SQLite xataa uma furo asalka),
   sha256 + `manifest.json`, read-only. Asalka **weligiis lama beddelo** (tijaabo ayaa hubisay: byte-identical).
2. **Upgrade nuqul** — koodhkii SQLite ee ugu dambeeyay ayaa nuqulka cusboonaysiiya; wixii uu beddelo waa la soo sheegaa.
   Haddii xog jirta la beddelay, `--execute` wuu joogsadaa ilaa `--accept-upgrade-changes` (adiga go'aanka).
3. **Hubin qiime kasta** — Infinity/NaN, NULL meel NOT NULL ah, qoraal > 255 xaraf (key), unique keys isku dhaca → **joogsi + warbixin**, waxba lama qoro.
4. **`--dry-run`** — tirada saf-yada shirkad kasta, waxa la koobiyeyn doono; MySQL-ka **waxba laguma qoro**.
5. **`--execute`** — jadwal kasta hal transaction; ka hor commit: row count + sha256 content; `ctl_migration_runs` ayaa diiwaangeliya.
6. **Xaqiijin dhammaan** — row counts, checksums, FK/orphans (isku mid SQLite), wadarta maaliyadeed (ledger USD/SLSH, balances, cash, exchanges, transfers, expenses, payments, opening balances).
7. **Weligiis ma dul qoro** — jadwal xog aan isagu qorin leh → joogsi. Dib-u-socodsiin → kaliya kuwa aan dhammaan (nuqul ma jiro).
8. **Bundle offline** — `--bundle out.json.gz` (MySQL looma baahna) → `--from-bundle out.json.gz --dry-run|--execute` meel MySQL laga gaari karo.

Amarrada:
```
DB_HOST=… DB_PORT=… DB_NAME=… DB_USER=… DB_PASSWORD=…  (env, ha ku qorin fayl la commit-gareeyo)
node --experimental-sqlite scripts/migrate-sqlite-to-mysql.js --source data/geeska.sqlite --dry-run
node --experimental-sqlite scripts/migrate-sqlite-to-mysql.js --source data/geeska.sqlite --execute
node --experimental-sqlite scripts/migrate-sqlite-to-mysql.js --resume migration-runs/run-… --execute
node scripts/integrity-check.js
```

---

## 5. Environment variables (magacyo oo keliya)

- GoDaddy ayaa dejiya: `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`, `PORT`.
- Adiga (secrets, dashboard): `JWT_SECRET`; installation cusub: `SUPER_ADMIN_INITIAL_PASSWORD`.
- Ikhtiyaari: `BACKUP_ENABLED`, `BACKUP_INTERVAL_HOURS`, `BACKUP_KEEP`, `DB_QUERY_TIMEOUT_MS`, `DB_CONNECT_TIMEOUT_MS`, `RESET_OPERATIONAL_DATA`.
- Tijaabooyinka oo keliya: `TEST_MYSQL_HOST`, `TEST_MYSQL_PORT`, `TEST_MYSQL_USER`, `TEST_MYSQL_PASSWORD`, `SEED_DEMO_PASSWORD`.
- **Waa la saaray**: `DB_PATH`, `CONTROL_DB_PATH`, `COMPANIES_DIR`, `BACKUP_DIR`, `RESTORE_TOKEN`.

---

## 6. Amarrada

| Ujeeddo | Amar |
|---|---|
| Install | `npm install` (GoDaddy: production install) |
| Build | `npm run build` (hubin; frontend-ka horay ayaa loo dhisay — `npm run build:frontend` kombiyuutarkaaga) |
| Start | `npm start` → `node src/server.js` |
| Migration | `npm run migrate:sqlite:dry-run -- --source <geeska.sqlite>` / `npm run migrate:sqlite:execute -- --source <geeska.sqlite>` |
| Backup | `npm run backup -- list` · `create --company CMP-0001` · `download …` · `restore … --confirm` |
| Hubin | `npm run integrity-check` |
| Tests | `TEST_MYSQL_*` (MySQL maxalli ah, **weligeed production**) → `npm run test:mysql`, `test:migration`, `test:tenancy`, … |

---

## 7. Rollback

- Faylasha SQLite lama taabanin → version-kii SQLite (git) wuu sii shaqaynayaa xogtii hore.
- Migration fashilmay: MySQL-ka waxba lagama tirtiro; warbixinta (`migration-runs/run-…/report.json`) ayaa sheegaysa meesha;
  `--resume` ama database cusub oo madhan.
- MySQL ka dib: backups-ka MySQL + download; restore = `scripts/backup.js restore`.

---

## 8. Tallaabooyinka adiga (GoDaddy dashboard)

1. Xaqiiji §1 (1–7) — gaar ahaan **preview vs publish database** iyo **nooca MySQL**.
2. Abuur app-ka Node.js; database MySQL ku dar; hubi in `DB_*` ay dejisan yihiin.
3. Ku dar secrets: `JWT_SECRET` (cusub, dheer, random); `SUPER_ADMIN_INITIAL_PASSWORD` haddii installation cusub tahay.
4. Upload source-ka **adigoon** `.env`, `data/`, `node_modules/`, `migration-runs/` ku darin.
5. Hubi `GET /api/health` → 200 iyo `"database":"ok"`.
6. Migration (marka 1 la xaqiijiyo): `--dry-run` → eeg warbixinta → `--execute` → `integrity-check` → gal oo hubi haraagaha.
7. Ka dib: samee backup manual ah oo soo deji (download).
