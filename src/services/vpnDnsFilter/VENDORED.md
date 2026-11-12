# Vendored from gatecontrol-gateway

`dnsfilter-core/` is a byte-identical copy of `gatecontrol-gateway` `src/dnsfilter-core/` (the whole
directory) at the tag below — the DNS filter engine the home gateways run. The filter service of the
DNS protection for VPN devices (`service.js`) is built on it. The CI drift check
(scripts/check-vendored-dnsfilter.js) fails the build if a file differs, is missing or is extra.

Never change a file in `dnsfilter-core/` here: change it in the gateway repository, release the gateway
and raise the tag below together with the copy (`node scripts/check-vendored-dnsfilter.js --update`
with `GC_GATEWAY_REPO=<path to a gateway checkout>` copies the tag's files).

- tag: v1.38.1
- dnsfilter-core/ ← src/dnsfilter-core/
