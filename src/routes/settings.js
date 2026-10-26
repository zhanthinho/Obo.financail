"use strict";
const { run } = require("../db");
const { sendJSON, badRequest, readJSONBody } = require("../http-helpers");
const { requireAuth, requirePerm } = require("../rbac");
const { getCompanySettings, addAudit } = require("../domain");
const { nowISO } = require("../util");

const MAX_LOGO_CHARS = 1_800_000; // ~1.3MB of image data as base64 — enough for a real logo, not a bloat vector
const MAX_FAVICON_CHARS = 120_000; // favicons are tiny (16-64px) — a much smaller cap than the logo is plenty

// APPEARANCE & BRANDING round 2: fontFamily/fontSize are a fixed set of
// curated keys (not free-form CSS) so a bad value can never break layout —
// the frontend maps each key to an actual CSS font stack / zoom level. Kept
// here (not just in the frontend) so the API rejects anything outside the
// set, the same way a hex regex guards the color fields below.
// POPPINS TABLE DESIGN round: "poppins" added as the new default key (must
// stay in sync with frontend/app.jsx's own FONT_FAMILY_OPTIONS whitelist).
const FONT_FAMILY_KEYS = ["poppins", "inter", "system", "georgia", "times", "verdana", "courier"];
const FONT_SIZE_KEYS = ["small", "medium", "large"];
const HEX_RE = /^#[0-9a-fA-F]{6}$/;

function serialize(row) {
  return {
    name: row.name, tagline: row.tagline || "", address: row.address || "", phone: row.phone || "",
    email: row.email || "", website: row.website || "", logoDataUrl: row.logo_data_url || null,
    faviconDataUrl: row.favicon_data_url || null, pdfAccentColor: row.pdf_accent_color || "#084b83",
    brandColor: row.brand_color || null, secondaryColor: row.secondary_color || null,
    accentColor: row.accent_color || null, statusPendingColor: row.status_pending_color || null,
    statusPaidColor: row.status_paid_color || null, statusRefundedColor: row.status_refunded_color || null,
    // POPPINS TABLE DESIGN round: default flipped from "inter" to "poppins"
    // — an install that never touched Settings > Typography (font_family
    // still null in the DB) now renders in Poppins by default, matching the
    // frontend's own THEME_CSS default exactly.
    fontFamily: row.font_family || "poppins", fontSize: row.font_size || "medium",
    // BRAND COLOR MANAGEMENT round: primaryDark/primaryLight/accentBright are
    // the exact extra shades a named theme (or a saved Custom Brand Color)
    // carries alongside brandColor/secondaryColor/accentColor above — null on
    // any row saved before this round, in which case the frontend falls back
    // to deriving them from brandColor the same way it always has.
    // brandThemeKey is one of BRAND_THEMES' keys, or "custom", or null
    // (meaning: pre-this-round data, treated as "custom").
    primaryDark: row.primary_dark || null, primaryLight: row.primary_light || null,
    accentBright: row.accent_bright || null, brandThemeKey: row.brand_theme_key || null,
    // PDF TEMPLATE & CUSTOMIZATION ENGINE round: plain optional company-
    // identity text, shown on a PDF only when a template's own show-toggle
    // is on (see src/pdf.js's resolveStyle — default off).
    registrationNumber: row.registration_number || "", taxNumber: row.tax_number || "",
    updatedAt: row.updated_at,
  };
}

// The neutral identity of the platform itself (login page, Super Admin console).
const PLATFORM_NAME = "OBO Financial System";
const PLATFORM_TAGLINE = "Multi-company financial management";

function register(router) {
  // Public: branding must be visible on the login screen, before anyone is authenticated.
  // MULTI-COMPANY round: a signed-in session sees its OWN company's branding
  // (the company id comes from the server-signed token only); the anonymous
  // login screen sees the primary company's public branding, as before.
  router.get("/api/settings/company", (req, res) => {
    const tenancy = require("../tenancy");
    const header = req.headers["authorization"] || "";
    const payload = require("../auth").verify(header.startsWith("Bearer ") ? header.slice(7) : null);
    const authLib = require("../auth");
    const cid = authLib.tokenCompanyId(payload);
    // GLOBAL LOGIN round: the login page is the shared entry point for every
    // company, so a visitor who is not signed in gets the neutral platform
    // identity — never any company's name, logo, address, phone, email,
    // registration/tax numbers or colours. The same neutral identity is used
    // by a signed-in session that is not inside a company (the Super Admin
    // console) or whose company no longer resolves. A company's own branding
    // is returned only to a session the server has bound to that company.
    //
    // The session is checked by the very same requireAuth every other API
    // uses (signature, expiry, deactivated user, suspended company, changed
    // permissions...). Its refusal is only observed, not sent: a session
    // that would be refused simply gets the neutral identity.
    const pu = payload && payload.kind === "platform" ? tenancy.getPlatformUser(payload.sub) : null;
    const isPlatform = !!(pu && pu.status === "active" && payload.pv === pu.permissions_version);
    const silent = { headersSent: false, writeHead() {}, setHeader() {}, end() {} };
    const sessionUser = payload && cid ? requireAuth(req, silent, { allowPasswordChange: true }) : null;
    const company = sessionUser && sessionUser._company ? sessionUser._company : null;
    if (!company) {
      return sendJSON(res, 200, { company: { ...serialize({ name: PLATFORM_NAME }), tagline: PLATFORM_TAGLINE, isDefault: true } });
    }
    const data = tenancy.withCompany(company, () => serialize(getCompanySettings()));
    // COMPANY ID VISIBILITY round: the Company ID is only included for a
    // Super Admin token; everyone else gets branding only.
    if (isPlatform) require("../tenant-context").allowCompanyIds();
    sendJSON(res, 200, { company: isPlatform ? { ...data, companyId: company.id } : data });
  });

  router.patch("/api/settings/company", async (req, res) => {
    const user = requireAuth(req, res); if (!user) return;
    if (!requirePerm(user, res, "settingsManage")) return;
    let body; try { body = await readJSONBody(req); } catch (e) { return badRequest(res, e.message); }
    const current = getCompanySettings();
    const name = body.name !== undefined ? body.name : current.name;
    if (!name || !name.trim()) return badRequest(res, "Company name is required.");
    if (body.logoDataUrl && body.logoDataUrl.length > MAX_LOGO_CHARS) {
      return badRequest(res, "That logo image is too large. Please use a smaller file (under ~1MB).");
    }
    if (body.logoDataUrl && !/^data:image\/(png|jpeg|jpg);base64,/.test(body.logoDataUrl)) {
      return badRequest(res, "Logo must be a PNG or JPEG image.");
    }
    if (body.pdfAccentColor !== undefined && body.pdfAccentColor !== null && body.pdfAccentColor !== "" && !/^#[0-9a-fA-F]{6}$/.test(body.pdfAccentColor)) {
      return badRequest(res, "PDF accent color must be a hex color like #084b83.");
    }
    if (body.brandColor !== undefined && body.brandColor !== null && body.brandColor !== "" && !HEX_RE.test(body.brandColor)) {
      return badRequest(res, "Brand color must be a hex color like #084b83.");
    }
    if (body.secondaryColor !== undefined && body.secondaryColor !== null && body.secondaryColor !== "" && !HEX_RE.test(body.secondaryColor)) {
      return badRequest(res, "Secondary color must be a hex color like #bbe6e4.");
    }
    if (body.accentColor !== undefined && body.accentColor !== null && body.accentColor !== "" && !HEX_RE.test(body.accentColor)) {
      return badRequest(res, "Accent color must be a hex color like #42bfdd.");
    }
    if (body.primaryDark !== undefined && body.primaryDark !== null && body.primaryDark !== "" && !HEX_RE.test(body.primaryDark)) {
      return badRequest(res, "Primary Dark color must be a hex color like #004c3d.");
    }
    if (body.primaryLight !== undefined && body.primaryLight !== null && body.primaryLight !== "" && !HEX_RE.test(body.primaryLight)) {
      return badRequest(res, "Primary Light color must be a hex color like #008e6d.");
    }
    if (body.accentBright !== undefined && body.accentBright !== null && body.accentBright !== "" && !HEX_RE.test(body.accentBright)) {
      return badRequest(res, "Accent Bright color must be a hex color like #00d7a0.");
    }
    if (body.brandThemeKey !== undefined && body.brandThemeKey !== null && body.brandThemeKey !== "" && !/^[a-z0-9-]{1,40}$/.test(body.brandThemeKey)) {
      return badRequest(res, "Invalid brand theme key.");
    }
    if (body.statusPendingColor !== undefined && body.statusPendingColor !== null && body.statusPendingColor !== "" && !HEX_RE.test(body.statusPendingColor)) {
      return badRequest(res, "Pending status color must be a hex color like #c98a2e.");
    }
    if (body.statusPaidColor !== undefined && body.statusPaidColor !== null && body.statusPaidColor !== "" && !HEX_RE.test(body.statusPaidColor)) {
      return badRequest(res, "Paid status color must be a hex color like #2f8f6a.");
    }
    if (body.statusRefundedColor !== undefined && body.statusRefundedColor !== null && body.statusRefundedColor !== "" && !HEX_RE.test(body.statusRefundedColor)) {
      return badRequest(res, "Refunded status color must be a hex color like #42bfdd.");
    }
    if (body.fontFamily !== undefined && body.fontFamily !== null && body.fontFamily !== "" && !FONT_FAMILY_KEYS.includes(body.fontFamily)) {
      return badRequest(res, `Font family must be one of: ${FONT_FAMILY_KEYS.join(", ")}.`);
    }
    if (body.fontSize !== undefined && body.fontSize !== null && body.fontSize !== "" && !FONT_SIZE_KEYS.includes(body.fontSize)) {
      return badRequest(res, `Font size must be one of: ${FONT_SIZE_KEYS.join(", ")}.`);
    }
    if (body.faviconDataUrl && body.faviconDataUrl.length > MAX_FAVICON_CHARS) {
      return badRequest(res, "That favicon image is too large. Please use a smaller file (under ~90KB).");
    }
    if (body.faviconDataUrl && !/^data:image\/(png|jpeg|jpg|x-icon|vnd\.microsoft\.icon);base64,/.test(body.faviconDataUrl)) {
      return badRequest(res, "Favicon must be a PNG, JPEG, or ICO image.");
    }
    const tagline = body.tagline !== undefined ? body.tagline : current.tagline;
    const address = body.address !== undefined ? body.address : current.address;
    const phone = body.phone !== undefined ? body.phone : current.phone;
    const email = body.email !== undefined ? body.email : current.email;
    const website = body.website !== undefined ? body.website : current.website;
    const logoDataUrl = body.logoDataUrl !== undefined ? body.logoDataUrl : current.logo_data_url;
    const faviconDataUrl = body.faviconDataUrl !== undefined ? body.faviconDataUrl : current.favicon_data_url;
    const pdfAccentColor = body.pdfAccentColor !== undefined ? body.pdfAccentColor : current.pdf_accent_color;
    const brandColor = body.brandColor !== undefined ? body.brandColor : current.brand_color;
    const secondaryColor = body.secondaryColor !== undefined ? body.secondaryColor : current.secondary_color;
    const accentColor = body.accentColor !== undefined ? body.accentColor : current.accent_color;
    const primaryDark = body.primaryDark !== undefined ? body.primaryDark : current.primary_dark;
    const primaryLight = body.primaryLight !== undefined ? body.primaryLight : current.primary_light;
    const accentBright = body.accentBright !== undefined ? body.accentBright : current.accent_bright;
    const brandThemeKey = body.brandThemeKey !== undefined ? body.brandThemeKey : current.brand_theme_key;
    const statusPendingColor = body.statusPendingColor !== undefined ? body.statusPendingColor : current.status_pending_color;
    const statusPaidColor = body.statusPaidColor !== undefined ? body.statusPaidColor : current.status_paid_color;
    const statusRefundedColor = body.statusRefundedColor !== undefined ? body.statusRefundedColor : current.status_refunded_color;
    const fontFamily = body.fontFamily !== undefined ? body.fontFamily : current.font_family;
    const fontSize = body.fontSize !== undefined ? body.fontSize : current.font_size;
    const registrationNumber = body.registrationNumber !== undefined ? body.registrationNumber : current.registration_number;
    const taxNumber = body.taxNumber !== undefined ? body.taxNumber : current.tax_number;
    run(
      `UPDATE company_settings SET name=?, tagline=?, address=?, phone=?, email=?, website=?, logo_data_url=?, favicon_data_url=?,
       pdf_accent_color=?, brand_color=?, secondary_color=?, accent_color=?, status_pending_color=?, status_paid_color=?,
       status_refunded_color=?, font_family=?, font_size=?, primary_dark=?, primary_light=?, accent_bright=?,
       brand_theme_key=?, registration_number=?, tax_number=?, updated_by=?, updated_at=? WHERE id=1`,
      [name, tagline, address, phone, email, website, logoDataUrl, faviconDataUrl, pdfAccentColor, brandColor,
       secondaryColor, accentColor, statusPendingColor, statusPaidColor, statusRefundedColor, fontFamily, fontSize,
       primaryDark, primaryLight, accentBright, brandThemeKey, registrationNumber, taxNumber, user.name, nowISO()]
    );
    addAudit(user, "Company settings updated", `${name}`);
    // Keep the Super Admin's Companies registry in step with this company's
    // own branding (name/logo/contact).
    require("../tenancy").syncRegistryFromSettings();
    sendJSON(res, 200, { company: serialize(getCompanySettings()) });
  });
}

module.exports = { register };
