# Leaflet (vendored)

| Field | Value |
|---|---|
| Source | npm `leaflet@1.9.4` |
| Integrity | `sha512-nxS1ynzJOmOlHp+iL3FyWqK89GtNL8U8rvlMOsQdTTssxZwCXh8N2NB3GDQOL+YR3XnWyZAxwQixURb+FA74PA==` (checked against the tarball) |
| Files | `dist/leaflet.js`, `dist/images/*.png` (markers, layers), `LICENSE` (BSD-2-Clause) |
| Used by | the device page of the user profile (`templates/aurora/pages/user-device.njk`, `public/js/user-profile.js`) |

## How these files were obtained

```sh
npm pack leaflet@1.9.4
tar -xzf leaflet-1.9.4.tgz
cp package/dist/leaflet.js package/LICENSE <repo>/public/vendor/leaflet/
cp package/dist/images/*.png <repo>/public/vendor/leaflet/images/
```

The trailing `//# sourceMappingURL=leaflet.js.map` line was removed from
`leaflet.js` (the map is not shipped); nothing else was changed.

`dist/leaflet.css` is not shipped as a file: the admin pages load exactly one
stylesheet (tests/app_css.test.js), so its rules sit in `public/css/app.css`
(section "Leaflet 1.9.4", `url(images/…)` rewritten to
`url(/vendor/leaflet/images/…)`).

Map tiles come from `https://tile.openstreetmap.org` (OpenStreetMap
contributors, ODbL). Only the device page allows that host in its
`img-src`; see docs/feature-device-location.md.
