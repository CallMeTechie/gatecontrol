# jsQR (vendored)

| Field | Value |
|---|---|
| Source | npm `jsqr@1.4.0` ([cozmo/jsQR](https://github.com/cozmo/jsQR), Cosmo Wolfe, Jefff Nelson) |
| Integrity | `sha512-dxLob7q65Xg2DvstYkRpkYtmKm2sPJ9oFhrhmudT1dZvNFFTlroai3AWSpLey/w5vMcLBXRgOJsbXpdN9HzU/A==` (checked against the tarball) |
| Files | `dist/jsQR.js` (unchanged), `LICENSE` (Apache License 2.0) |
| Used by | the QR code dialog of the plugin frames, `public/js/qr-scan.js` (`GC.scanQr`, docs/plugins.md "QR codes") |

## How these files were obtained

```sh
npm pack jsqr@1.4.0
tar -xzf jsqr-1.4.0.tgz
cp package/dist/jsQR.js package/LICENSE <repo>/public/vendor/jsqr/
```

`sha256(jsQR.js) = bc40c8a15196236b2314db0856f72ca0b49980cd5413b8c852a7349f5fee0859`.

The dialog loads it only in browsers without a `BarcodeDetector` that reads QR
codes (Chrome and Edge on Windows and Linux, Firefox, Safari) and
only when a scan starts — never on page load.
