"use strict";
// PLATFORM BRANDING round — the platform's own look, kept apart from every
// company. It is what the general sign-in page (the main address) and the
// Super Admin Console show. It lives in the CONTROL database (one row,
// platform_settings.id = 'platform'); a company's branding lives in that
// company's own company_settings. Neither ever reads or writes the other.
const { cget, crun } = require("./tenancy");

const PLATFORM_NAME = "OBO Financial System";
const PLATFORM_TAGLINE = "Multi-company financial management";
const COLS = ["name", "tagline", "logo_data_url", "favicon_data_url", "brand_color", "secondary_color", "accent_color", "primary_dark", "primary_light", "accent_bright", "brand_theme_key"];

function row() {
  try { return cget("SELECT * FROM platform_settings WHERE id = 'platform'") || null; } catch (e) { return null; }
}

// The branding fields only — the same names the company branding uses, so
// the browser applies both the same way. Nothing else (no contact details).
// `forPublic` leaves out who changed it and when (the anonymous sign-in page).
function getPlatformBranding({ forPublic = false } = {}) {
  const r = row() || {};
  return {
    name: r.name || PLATFORM_NAME,
    tagline: r.tagline != null && r.tagline !== "" ? r.tagline : PLATFORM_TAGLINE,
    logoDataUrl: r.logo_data_url || null,
    faviconDataUrl: r.favicon_data_url || null,
    brandColor: r.brand_color || null,
    secondaryColor: r.secondary_color || null,
    accentColor: r.accent_color || null,
    primaryDark: r.primary_dark || null,
    primaryLight: r.primary_light || null,
    accentBright: r.accent_bright || null,
    brandThemeKey: r.brand_theme_key || null,
    isPlatform: true,
    ...(forPublic ? {} : { updatedAt: r.updated_at || null, updatedBy: r.updated_by || null }),
  };
}

const HEX_RE = /^#[0-9a-fA-F]{6}$/;
const FIELD = {
  name: "name", tagline: "tagline", logoDataUrl: "logo_data_url", faviconDataUrl: "favicon_data_url",
  brandColor: "brand_color", secondaryColor: "secondary_color", accentColor: "accent_color",
  primaryDark: "primary_dark", primaryLight: "primary_light", accentBright: "accent_bright", brandThemeKey: "brand_theme_key",
};
const COLOR_KEYS = ["brandColor", "secondaryColor", "accentColor", "primaryDark", "primaryLight", "accentBright"];
const MAX_LOGO_CHARS = 1_400_000, MAX_FAVICON_CHARS = 120_000;

// Validates and saves the fields present in `input`; returns the list of
// changed field names. Throws { status, message } on bad input.
function savePlatformBranding(input, actor) {
  const bad = (m) => { const e = new Error(m); e.status = 400; throw e; };
  const iv = require("./image-validate");
  const next = {};
  for (const [k, colName] of Object.entries(FIELD)) {
    if (input[k] === undefined) continue;
    let v = input[k] === "" ? null : input[k];
    if (v !== null && typeof v !== "string") bad(`${k} must be text.`);
    if (k === "name") { v = String(v || "").trim(); if (!v) bad("The platform name is required."); if (v.length > 120) bad("The platform name is too long."); }
    if (k === "tagline" && v && v.length > 200) bad("The tagline is too long.");
    if (COLOR_KEYS.includes(k) && v && !HEX_RE.test(v)) bad(`${k} must be a hex color like #084b83.`);
    if (k === "brandThemeKey" && v && !/^[a-z0-9-]{1,40}$/.test(v)) bad("Invalid brand theme key.");
    if (k === "logoDataUrl" && v) { if (v.length > MAX_LOGO_CHARS) bad("That logo is too large. Please use a smaller file (under ~1MB)."); if (!iv.isRealImageDataUrl(v, ["png", "jpeg"])) bad("Logo must be a PNG or JPEG image."); }
    if (k === "faviconDataUrl" && v) { if (v.length > MAX_FAVICON_CHARS) bad("That favicon is too large. Please use a smaller file (under ~90KB)."); if (!iv.isRealImageDataUrl(v, ["png", "jpeg", "ico"])) bad("Favicon must be a PNG, JPEG, or ICO image."); }
    next[colName] = v;
  }
  const cur = row();
  const changed = Object.keys(next).filter((c) => (cur ? cur[c] : null) !== next[c]);
  if (!changed.length) return [];
  const now = new Date().toISOString();
  if (!cur) {
    const cols = ["id", ...COLS, "updated_at", "updated_by"];
    const vals = ["platform", ...COLS.map((c) => (c in next ? next[c] : null)), now, (actor && actor.name) || "system"];
    crun(`INSERT INTO platform_settings (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(",")})`, vals);
  } else {
    const sets = changed.map((c) => `${c} = ?`);
    crun(`UPDATE platform_settings SET ${sets.join(", ")}, updated_at = ?, updated_by = ? WHERE id = 'platform'`, [...changed.map((c) => next[c]), now, (actor && actor.name) || "system"]);
  }
  return changed;
}

module.exports = { getPlatformBranding, savePlatformBranding, PLATFORM_NAME, PLATFORM_TAGLINE };
