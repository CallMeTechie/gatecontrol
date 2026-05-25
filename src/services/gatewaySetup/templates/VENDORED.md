# Vendored from gatecontrol-gateway

Byte-identical copies of `gatecontrol-gateway` `deploy/` at the tag below. The CI drift check
(scripts/check-vendored-templates.js) fails the build if they diverge.

- tag: v1.10.1
- update.sh ← deploy/update.sh
- systemd/gatecontrol-gateway-update.service ← deploy/systemd/gatecontrol-gateway-update.service
- systemd/gatecontrol-gateway-update.path ← deploy/systemd/gatecontrol-gateway-update.path
