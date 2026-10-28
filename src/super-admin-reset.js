"use strict";
// ONE-TIME SUPER ADMIN PASSWORD RESET — inert unless SUPER_ADMIN_RESET_PASSWORD
// is set. On startup it sets that password on the platform Super Admin account
// (SUPER_ADMIN_RESET_USERNAME, default "super.admin"), re-activates it and
// signs out its old sessions. The password value is never logged.
// Remove the variable again after signing in, or every restart resets it.
const tenancy = require("./tenancy");
const { hashPassword } = require("./auth");

function runFromEnv() {
  const pw = process.env.SUPER_ADMIN_RESET_PASSWORD;
  if (!pw) return;
  const uname = tenancy.normalizeUsername(process.env.SUPER_ADMIN_RESET_USERNAME || "super.admin");
  if (String(pw).length < 8) {
    console.error("[super-admin-reset] SUPER_ADMIN_RESET_PASSWORD must be at least 8 characters — nothing changed.");
    return;
  }
  const pu = tenancy.getPlatformUserByUsername(uname);
  if (!pu) {
    const names = tenancy.call("SELECT username FROM platform_users ORDER BY created_at").map((r) => r.username);
    console.error(`[super-admin-reset] No platform Super Admin named "${uname}". Existing: ${names.join(", ") || "(none)"}`);
    return;
  }
  const { hash, salt } = hashPassword(String(pw));
  tenancy.crun(
    "UPDATE platform_users SET password_hash = ?, password_salt = ?, status = 'active', permissions_version = permissions_version + 1 WHERE id = ?",
    [hash, salt, pu.id]
  );
  tenancy.platformAudit({ id: pu.id, name: pu.name }, "Password reset", null, "Super Admin password reset from SUPER_ADMIN_RESET_PASSWORD at startup");
  console.log(`[super-admin-reset] Password for "${uname}" was reset. Remove SUPER_ADMIN_RESET_PASSWORD now.`);
}

module.exports = { runFromEnv };
