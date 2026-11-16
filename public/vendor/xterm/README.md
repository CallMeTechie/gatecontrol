# xterm.js (vendored)

| Field | Value |
|---|---|
| Source | npm `@xterm/xterm@5.5.0`, `@xterm/addon-fit@0.10.0` |
| Integrity | `@xterm/xterm@5.5.0`: `sha512-hqJHYaQb5OptNunnyAnkHyM8aCjZ1MEIDTQu1iIbbTD/xops91NB5yq1ZK/dC2JDbVWtF23zUtl9JE2NqwT87A==` · `@xterm/addon-fit@0.10.0`: `sha512-UFYkDm4HUahf2lnEyHvio51TNGiLK66mqP2JoATy7hRZeXaGMRDr00JiSF7m63vR5WKATF605yEggJKsw0JpMQ==` (checked against the tarballs) |
| Files | `lib/xterm.js`, `LICENSE` (MIT) · `lib/addon-fit.js`, its `LICENSE` as `LICENSE-addon-fit` (MIT) |
| Used by | the SSH terminal of gc.remote (`templates/aurora/pages/remote-term.njk`, `public/js/remote-term.js`) and the playback of SSH recordings (`templates/aurora/pages/remote-recording.njk`, `public/js/remote-player.js`) |

## How these files were obtained

```sh
npm pack @xterm/xterm@5.5.0 @xterm/addon-fit@0.10.0
tar -xzf xterm-xterm-5.5.0.tgz && cp package/lib/xterm.js package/LICENSE <repo>/public/vendor/xterm/
tar -xzf xterm-addon-fit-0.10.0.tgz && cp package/lib/addon-fit.js <repo>/public/vendor/xterm/ && cp package/LICENSE <repo>/public/vendor/xterm/LICENSE-addon-fit
```

The trailing `//# sourceMappingURL=…` line was removed from both scripts (the maps are not shipped);
nothing else was changed. No CDN: the pages load these files from GateControl itself.

`css/xterm.css` is not shipped as a file: the pages load exactly one stylesheet
(tests/app_css.test.js), so its rules sit verbatim in `public/css/app.css` (block "xterm.js 5.5.0").

## Content Security Policy

The DOM renderer of xterm.js adds two `<style>` elements of its own. The pages allow style
elements by nonce only (`style-src-elem 'self' 'nonce-…'`), so the page script gives each
`<style>` element it creates the nonce of the page before xterm.js runs
(an inline script with the nonce at the top of `remote-term.njk` and `remote-recording.njk`).
