"use strict";
// MYSQL round — backups from the command line (the same backups the app makes
// automatically and Super Admins can make/download in the app).
//
//   node scripts/backup.js list     [--company CMP-0002]
//   node scripts/backup.js create   --company CMP-0002
//   node scripts/backup.js download --company CMP-0002 --name <backup name> --out <file.json.gz>
//   node scripts/backup.js restore  --company CMP-0002 (--name <backup name> | --file <file.json.gz>) --confirm
//
// RESTORE replaces ALL of that company's data with the backup — only a backup
// OF THAT SAME COMPANY is accepted. A "prerestore" backup of the current data
// is stored first, and the restore runs as one transaction (all or nothing).
// Uses the app's MySQL settings (DB_HOST/DB_PORT/DB_NAME/DB_USER/DB_PASSWORD).
require("../src/env");
const fs = require("fs");

function arg(k) { const a = process.argv; const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; }

function main() {
  const cmd = process.argv[2];
  const tenancy = require("../src/tenancy");
  const backup = require("../src/backup");
  tenancy.bootstrap();
  const companyId = arg("--company");
  const company = companyId ? tenancy.getCompany(companyId) : null;
  if (companyId && !company) throw new Error(`Unknown company ${companyId}`);

  if (cmd === "list") {
    for (const c of company ? [company] : tenancy.listCompanies()) {
      console.log(`${c.id}  ${c.name}`);
      for (const b of backup.listBackups(c)) console.log(`   ${b.createdAt}  ${b.kind.padEnd(12)} ${String(b.size).padStart(10)} bytes  ${b.name}`);
    }
    return;
  }
  if (!company) throw new Error("--company CMP-XXXX is required.");
  if (cmd === "create") {
    const b = backup.backupNow(company, "manual", "command line");
    console.log(`Stored ${b.name} (${b.size} bytes).`);
    return;
  }
  if (cmd === "download") {
    const name = arg("--name"), out = arg("--out");
    if (!name || !out) throw new Error("--name and --out are required.");
    if (fs.existsSync(out)) throw new Error(`${out} already exists — not overwriting it.`);
    const gz = backup.backupFile(company, name);
    if (!gz) throw new Error("Backup not found.");
    fs.writeFileSync(out, gz, { flag: "wx" });
    console.log(`Saved ${name} to ${out} (${gz.length} bytes).`);
    return;
  }
  if (cmd === "restore") {
    if (!process.argv.includes("--confirm")) throw new Error(`Restore replaces ALL data of ${company.id} (${company.name}). Add --confirm to proceed.`);
    const name = arg("--name"), file = arg("--file");
    let gz;
    if (name) {
      gz = backup.backupFile(company, name);
      if (!gz) throw new Error(`Backup ${name} not found among ${company.id}'s backups.`);
    } else if (file) gz = fs.readFileSync(file);
    if (!gz) throw new Error("Give --name <stored backup> or --file <downloaded backup>.");
    const r = backup.restoreCompany(company, gz, "command line");
    tenancy.withCompany(company, () => require("../src/domain").addAudit(null, "Data restored from backup", `restored from ${r.restoredFrom}; previous data kept as ${r.preRestoreBackup}`));
    tenancy.syncDirectoryForCompany(company);
    console.log(`Restored ${company.id} from the backup made ${r.restoredFrom}.`);
    console.log(`The data it replaced is kept as backup ${r.preRestoreBackup}.`);
    console.log("Restart the app so every open session reloads.");
    return;
  }
  throw new Error("Command must be list, create, download or restore.");
}

try { main(); } catch (e) { console.error(`Error: ${e.message}`); process.exitCode = 1; } finally {
  require("../src/mysql/connection").close();
}
