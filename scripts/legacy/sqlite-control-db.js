"use strict";
// LEGACY (SQLite) — OFFLINE USE ONLY. The last SQLite version of the platform
// control database (companies registry, platform Super Admins, username
// directory, platform audit), kept for scripts/migrate-sqlite-to-mysql.js and
// scripts/dev/generate-mysql-schema.js. Do not require this file from src/.
const { DatabaseSync } = require("node:sqlite");

const CONTROL_SCHEMA = `
CREATE TABLE IF NOT EXISTS companies (
  id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL UNIQUE,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','inactive','suspended')),
  status_reason TEXT,
  status_changed_at TEXT,
  status_changed_by TEXT,
  is_primary INTEGER NOT NULL DEFAULT 0,
  db_file TEXT NOT NULL UNIQUE,
  contact_name TEXT,
  phone TEXT,
  email TEXT,
  address TEXT,
  website TEXT,
  logo_data_url TEXT,
  notes TEXT,
  created_at TEXT NOT NULL,
  created_by TEXT,
  updated_at TEXT,
  updated_by TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_companies_name_ci ON companies(lower(name));
CREATE UNIQUE INDEX IF NOT EXISTS idx_companies_one_primary ON companies(is_primary) WHERE is_primary = 1;

CREATE TABLE IF NOT EXISTS platform_users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','deactivated')),
  permissions_version INTEGER NOT NULL DEFAULT 1,
  last_login TEXT,
  migrated_from_company TEXT,
  created_at TEXT NOT NULL
);

-- username -> the ONE company that user belongs to. Usernames are unique
-- across the whole installation so login never has to guess a company.
CREATE TABLE IF NOT EXISTS user_directory (
  username TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  user_id TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_user_directory_company ON user_directory(company_id);

CREATE TABLE IF NOT EXISTS platform_audit (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  actor_id TEXT,
  actor_name TEXT NOT NULL,
  action TEXT NOT NULL,
  company_id TEXT,
  details TEXT
);
CREATE INDEX IF NOT EXISTS idx_platform_audit_at ON platform_audit(at);
`;


// COMPANY STATUS round: Deactivate and Suspend are two INDEPENDENT switches.
function migrateCompanyStatusFlags(d) {
  const cols = d.prepare("PRAGMA table_info(companies)").all().map((c) => c.name);
  const add = (name, def) => { if (!cols.includes(name)) d.exec(`ALTER TABLE companies ADD COLUMN ${name} ${def}`); };
  const fresh = !cols.includes("deactivated");
  add("deactivated", "INTEGER NOT NULL DEFAULT 0");
  add("deactivated_reason", "TEXT");
  add("deactivated_at", "TEXT");
  add("deactivated_by", "TEXT");
  add("suspended", "INTEGER NOT NULL DEFAULT 0");
  add("suspended_reason", "TEXT");
  add("suspended_at", "TEXT");
  add("suspended_by", "TEXT");
  if (fresh) {
    d.exec("UPDATE companies SET deactivated = 1, deactivated_reason = status_reason, deactivated_at = status_changed_at, deactivated_by = status_changed_by WHERE status = 'inactive'");
    d.exec("UPDATE companies SET suspended = 1, suspended_reason = status_reason, suspended_at = status_changed_at, suspended_by = status_changed_by WHERE status = 'suspended'");
  }
}

// Opens a control database file. readOnly: never writes (no schema, no backfill).
function openControlDb(file, { readOnly = false } = {}) {
  const d = new DatabaseSync(file, { readOnly: !!readOnly });
  if (!readOnly) {
    d.exec("PRAGMA foreign_keys = ON;");
    d.exec(CONTROL_SCHEMA);
    migrateCompanyStatusFlags(d);
  }
  return d;
}

module.exports = { CONTROL_SCHEMA, migrateCompanyStatusFlags, openControlDb };
