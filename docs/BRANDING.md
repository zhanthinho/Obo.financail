# FINMAN — Branding and preferences: who owns what

Every screen shows exactly one owner's branding: a company's or the platform's. Never a mix.

## Where each setting lives

| Setting | Owner | Stored | Shared with | Changed by |
|---|---|---|---|---|
| Company name, tagline, logo, favicon, stamp | The company | Server: that company's `company_settings` | Every user of that company, on every device | Users whose role has **Settings** (`settingsManage`) in that company, or the Super Admin inside that workspace |
| Brand colour, secondary/accent colours, built-in theme, status colours, font family, font size, PDF accent colour | The company | Server: `company_settings` | Every user of that company, on every device | Same as above |
| PDF / Excel template look | The company | Server: `pdf_templates`, `excel_templates` (with version history) | Every user of that company | Template permissions |
| Company login link (`/<slug>`) | The platform | Server: control `companies.login_slug` | Visitors of that link | Super Admin only |
| Platform name, tagline, logo, favicon, colours | The platform | Server: control `platform_settings` (one row) | The main sign-in page and the Super Admin Console, on every device | Super Admin only (Console → **Platform branding**) |
| Light / dark theme | The person, per context | This browser only (`geeska_theme:<context>`) | Nobody else | Anyone, with the sun/moon switch |
| Language (SO / EN) | The person, per context | This browser only (`obo_lang:<context>`) | Nobody else | Anyone, with the SO / EN switch |
| Sidebar position, collapsed sidebar, table column layout, sort choices | The person | This browser only | Nobody else | Anyone |

A context is one of the following:
- `company:<login link>` or `company-name:<name>` for a company, whoever is signed in. This includes the Super Admin inside that workspace.
- `platform:<id>` for the Super Admin Console.
- `public` for the main sign-in page before anyone signs in.

A choice saved before contexts existed (`geeska_theme`, `obo_lang`) is adopted once by the first context that reads it, then removed. After that, it cannot reach another context.

Theme and language are personal on purpose. Two people of the same company can work in different languages, and that does not change anything for the company. Everything that defines how a company looks is kept on the server. It is therefore the same after a refresh, on another browser and on another device.

## Which branding is shown where

| Page | Branding |
|---|---|
| Main address, signed out | Platform |
| Super Admin Console | Platform |
| `/<slug>` (a company's sign-in page) | That company (name, logo, colours only; no contact details) |
| Company workspace (staff, or Super Admin after **Open workspace**) | That company |
| PDFs / Excel files | The company of the session (built on the server) |

The server decides the company: from the session token, or from the login link's slug. The address in the browser never grants access. A company's sign-in page accepts only that company's users. If a browser already has a session for another company, or for the console, that session is ended there.

In the browser, each branding reply is tagged with the context it was asked for, and each request is numbered. A reply that is late, or meant for another context, is dropped. The previous branding is cleared the moment the context changes. A missing or invalid colour falls back to the default theme.

## Validation

- **Colours:** `#rrggbb` only. Anything else is refused (400).
- **Logo and stamp:** PNG or JPEG, checked by the file's real bytes, not only its name. Maximum about 1 MB.
- **Favicon:** PNG, JPEG or ICO. Maximum about 90 KB.
- **Values already stored** that are not valid colours are ignored by the browser, and the default theme is used.
- **Readability:**
  - Text drawn on the brand colour automatically uses dark or light text, whichever is readable.
  - The sign-in page and the console header always use white text. With a very light brand colour they use the brand darkened just enough for that text.

## Audit

| Change | Recorded in | What is recorded |
|---|---|---|
| Company branding | The company's Audit Log ("Company settings updated") | Who, when, and each changed field with its old → new value. Images are recorded only as uploaded / replaced / removed. |
| Platform branding | The platform audit log ("Platform branding updated") | Who, when, and the changed field names |

No image contents, passwords or tokens are written to any log.
