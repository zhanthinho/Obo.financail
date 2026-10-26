"use strict";

class Router {
  constructor() {
    this.routes = [];
  }
  _add(method, pattern, handler) {
    const keys = [];
    const regexStr = pattern
      .split("/")
      .map((seg) => {
        if (seg.startsWith(":")) {
          keys.push(seg.slice(1));
          return "([^/]+)";
        }
        return seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      })
      .join("/");
    this.routes.push({ method, regex: new RegExp(`^${regexStr}/?$`), keys, handler });
  }
  get(pattern, handler) { this._add("GET", pattern, handler); }
  post(pattern, handler) { this._add("POST", pattern, handler); }
  patch(pattern, handler) { this._add("PATCH", pattern, handler); }
  delete(pattern, handler) { this._add("DELETE", pattern, handler); }

  match(method, pathname) {
    for (const r of this.routes) {
      if (r.method !== method) continue;
      const m = r.regex.exec(pathname);
      if (m) {
        const params = {};
        // SECURITY AUDIT round: a malformed escape (e.g. "/api/accounts/%E0")
        // made decodeURIComponent throw synchronously inside the HTTP
        // server's request handler, which crashed the whole process — an
        // unauthenticated, one-request denial of service. It is now a
        // plain 400 for that request only.
        try {
          r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
        } catch (e) {
          return { malformed: true };
        }
        return { handler: r.handler, params };
      }
    }
    return null;
  }
}

module.exports = { Router };
