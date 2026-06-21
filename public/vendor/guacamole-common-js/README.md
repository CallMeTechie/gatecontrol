# guacamole-common-js (vendored)

| Field | Value |
|---|---|
| Source | npm `guacamole-common-js@1.5.0` |
| File | `dist/esm/guacamole-common.min.js` (ESM bundle, `export default Guacamole`) |
| Used with | guacd 1.6.0 |
| Protocol compat | Guacamole wire protocol is stable across minor versions; 1.5.0 client ↔ 1.6.0 guacd confirmed by handshake spike (see _phase2a-spike-findings.md, finding C6). |

## Why npm 1.5.0 and not Apache 1.6.0?

- `npm guacamole-common-js` tops out at 1.5.0 — there is no 1.6.0 npm release.
- The Apache 1.6.0 source tarball (`guacamole-client-1.6.0.tar.gz`) ships only
  source that must be built with Maven + webpack. That build is not reproducible
  here without the full Java toolchain and is overkill for a throwaway smoke page.
- 1.5.0 ships a ready ESM bundle and is protocol-compatible (see above).

## How this file was obtained

```sh
cd /tmp && npm pack guacamole-common-js@1.5.0
tar -xzf guacamole-common-js-1.5.0.tgz package/dist/esm/guacamole-common.min.js
cp package/dist/esm/guacamole-common.min.js \
   <repo>/public/vendor/guacamole-common-js/guacamole-common.min.js
```

## Provenance note — trailing ESM export stripped (Phase 3b)

The upstream `dist/esm/guacamole-common.min.js` ends with the single ESM line:

```js
export default Guacamole;
```

This causes a `SyntaxError: Unexpected token 'export'` pageerror when the file
is loaded via a plain `<script>` tag (not `type="module"`). The body of the
file already establishes `window.Guacamole` via a top-level `var Guacamole`
declaration, so the `export default` line is redundant for classic-script use.

For Phase 3b the production RDP session page (`/rdp/:id/session`) loads this
file as a classic `<script>` and accesses `window.Guacamole` directly. The
trailing `export default Guacamole;` was therefore stripped so the bundle
parses cleanly as a classic browser script. The file is otherwise the verbatim
npm 1.5.0 ESM bundle body.

## Purpose

This is a vendored static asset used by the Phase-2a throwaway smoke page
(`public/_guac-smoke.html`) **and** the Phase-3b production RDP session player
(`public/rdp-session.html`). It is NOT a server npm dependency and must NOT be
added to `package.json`.
