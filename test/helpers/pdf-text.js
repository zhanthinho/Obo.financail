"use strict";
// Text of a generated PDF, for tests. Handles both kinds of text FINMAN
// writes: the standard fonts (WinAnsi hex strings) and, since the NUMERIC
// TYPOGRAPHY round, Inter for numbers (Identity-H glyph ids, decoded through
// each font's own ToUnicode map). One line per drawn text item.
const { PDFDocument, PDFName, PDFDict, PDFRef, PDFRawStream, decodePDFRawStream } = require("pdf-lib");

function cmapToMap(text) {
  const map = new Map();
  for (const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const m of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) map.set(parseInt(m[1], 16), Buffer.from(m[2], "hex").swap16().toString("utf16le"));
  }
  for (const block of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const m of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      const a = parseInt(m[1], 16), b = parseInt(m[2], 16), start = parseInt(m[3], 16);
      for (let c = a; c <= b; c++) map.set(c, String.fromCodePoint(start + c - a));
    }
  }
  return map;
}
const streamText = (s) => Buffer.from(decodePDFRawStream(s).decode()).toString("latin1");

async function pdfText(buf) {
  const doc = await PDFDocument.load(buf);
  const ctx = doc.context;
  const lookup = (o) => (o instanceof PDFRef ? ctx.lookup(o) : o);
  let out = "";
  for (const page of doc.getPages()) {
    const fonts = new Map();
    const res = lookup(page.node.get(PDFName.of("Resources")));
    const fdict = res && lookup(res.get(PDFName.of("Font")));
    if (fdict instanceof PDFDict) {
      for (const [name, ref] of fdict.entries()) {
        const f = lookup(ref);
        const tu = f && lookup(f.get(PDFName.of("ToUnicode")));
        fonts.set(name.toString(), tu instanceof PDFRawStream ? cmapToMap(streamText(tu)) : null);
      }
    }
    const contents = lookup(page.node.get(PDFName.of("Contents")));
    const parts = Array.isArray(contents?.array) ? contents.array.map(lookup) : [contents];
    for (const part of parts) {
      if (!(part instanceof PDFRawStream)) continue;
      const s = streamText(part);
      let current = null;
      for (const m of s.matchAll(/(\/[^\s/]+)\s+[\d.]+\s+Tf|<([0-9A-Fa-f\s]*)>\s*Tj/g)) {
        if (m[1]) { current = fonts.get(m[1]) || null; continue; }
        const hex = m[2].replace(/\s+/g, "");
        if (current) { let t = ""; for (let i = 0; i + 4 <= hex.length; i += 4) t += current.get(parseInt(hex.slice(i, i + 4), 16)) || ""; out += t + "\n"; }
        else out += Buffer.from(hex, "hex").toString("latin1") + "\n";
      }
    }
  }
  return out;
}

module.exports = { pdfText };
