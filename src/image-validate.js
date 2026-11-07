"use strict";
// SYSTEM AUDIT round — uploaded images (company logo, favicon) were accepted
// on the strength of their "data:image/png;base64," prefix alone, so any
// bytes labelled as an image were stored and later fed to the PDF / Excel
// engines. The decoded bytes must now really be the declared kind.
const SIGS = {
  png: (b) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a,
  jpeg: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  ico: (b) => b.length > 4 && b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0,
};
const KIND_OF = { png: "png", jpeg: "jpeg", jpg: "jpeg", "x-icon": "ico", "vnd.microsoft.icon": "ico" };
// True when `dataUrl` is a base64 data URL of one of `allowed` kinds whose
// bytes match that kind's signature.
function isRealImageDataUrl(dataUrl, allowed = ["png", "jpeg"]) {
  const m = /^data:image\/([a-z.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(String(dataUrl || ""));
  if (!m) return false;
  const kind = KIND_OF[m[1].toLowerCase()];
  if (!kind || !allowed.includes(kind)) return false;
  let buf;
  try { buf = Buffer.from(m[2].replace(/\s+/g, ""), "base64"); } catch (e) { return false; }
  return SIGS[kind](buf);
}
module.exports = { isRealImageDataUrl };
