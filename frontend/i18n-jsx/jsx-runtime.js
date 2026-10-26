// SOMALI / ENGLISH LANGUAGE SUPPORT — the JSX runtime the frontend is built
// with (scripts/build-frontend.js sets jsxImportSource to this folder). It
// is React's own runtime plus one step: when the interface language is
// Somali, the text an HTML element is about to show — its text children and
// its placeholder / title / aria-label / alt — is passed through the shared
// dictionary (src/i18n). Custom components receive their props untouched
// (so internal keys such as column ids and icon lookups stay in English);
// their text is translated once it reaches a real HTML element.
import * as R from "react/jsx-runtime";
import { translate, getLang } from "../../src/i18n/index.js";

const TEXT_PROPS = ["placeholder", "title", "aria-label", "alt"];

function translateChildren(c) {
  if (typeof c === "string") return translate(c);
  if (!Array.isArray(c)) return c;
  // A run of plain text and numbers ("Showing ", 1, " to ", 10, …) is
  // translated as ONE sentence first, so word order can change in Somali.
  if (c.length > 1 && c.every((x) => typeof x === "string" || typeof x === "number")) {
    const joined = c.join("");
    const t = translate(joined);
    if (t !== joined) return t;
  }
  let changed = false;
  const out = c.map((x) => {
    if (typeof x !== "string") return x;
    const t = translate(x);
    if (t !== x) changed = true;
    return t;
  });
  return changed ? out : c;
}

function localize(type, props) {
  if (typeof type !== "string" || !props || getLang() !== "so") return props;
  if (props.translate === "no" || props["data-no-i18n"]) return props;
  let out = props;
  for (const k of TEXT_PROPS) {
    const v = props[k];
    if (typeof v === "string") {
      const t = translate(v);
      if (t !== v) { if (out === props) out = { ...props }; out[k] = t; }
    }
  }
  if (props.children != null && type !== "style" && type !== "script" && type !== "textarea") {
    const c = translateChildren(props.children);
    if (c !== props.children) { if (out === props) out = { ...props }; out.children = c; }
  }
  return out;
}

export const Fragment = R.Fragment;
export function jsx(type, props, key) { return R.jsx(type, localize(type, props), key); }
export function jsxs(type, props, key) { return R.jsxs(type, localize(type, props), key); }
