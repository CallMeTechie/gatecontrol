'use strict';

// The container images of the messenger bridges, pinned by version AND digest
// (docs/feature-messenger-bridges.md, "Images"). The release
// docker-compose.yml names exactly these (tests/bridges_config.test.js keeps
// both in step); update.sh reports the image each container really runs, and
// a container on another image than the one pinned here shows as "outdated".
//
// Raising a pin: take the digest of the multi-arch index from the registry
// (HEAD /v2/<repo>/manifests/<tag> → Docker-Content-Digest), change it here
// and in both compose files, and check the generated configuration against
// the example configuration of THAT version (tests/fixtures/bridges/).

const IMAGES = Object.freeze({
  // Tuwunel 1.9.4 (10 Oct 2026) — one program, embedded RocksDB
  hs: Object.freeze({
    service: 'bruecken-hs',
    repo: 'ghcr.io/matrix-construct/tuwunel',
    tag: 'v1.9.4',
    version: '1.9.4',
    digest: 'sha256:0e86c6164d6c9f5b60291938eb61ad8395021c37fe58d47a963ea7edddbedaec',
  }),
  // mautrix-whatsapp v0.2610.0 (16 Oct 2026; mautrix-go v0.32.0)
  whatsapp: Object.freeze({
    service: 'bruecken-whatsapp',
    repo: 'dock.mau.dev/mautrix/whatsapp',
    tag: 'v0.2610.0',
    version: '0.2610.0',
    digest: 'sha256:c807054cb015d0f5c90d20d85aac216d062b4a6f4ae834b931fd5e7f03e27391',
  }),
  // socat 1.8.1.3 — hands the homeserver's calls to the bridge's Unix socket (see docker-compose.yml)
  'whatsapp-relay': Object.freeze({
    service: 'bruecken-whatsapp-relay',
    repo: 'alpine/socat',
    tag: '1.8.1.3',
    version: '1.8.1.3',
    digest: 'sha256:71131702f671a88b3808a70b7330f9679cd9b9933adcafadc191508edfe55bba',
  }),
});

/** The full reference as the compose file writes it: <repo>:<tag>@<digest>. */
function ref(name) {
  const i = IMAGES[name];
  return i ? `${i.repo}:${i.tag}@${i.digest}` : null;
}

const REF_RE = /^[a-z0-9][a-z0-9._/-]{1,120}:([A-Za-z0-9._-]{1,60})@(sha256:[0-9a-f]{64})$/;

/**
 * What a container runs (update.sh: `docker inspect` .Config.Image) against the pin.
 * → { version, outdated } — version from the tag of the reference, outdated
 * null when the host reported nothing usable.
 */
function compare(name, running) {
  const pin = IMAGES[name];
  const m = typeof running === 'string' ? REF_RE.exec(running) : null;
  if (!pin || !m) return { version: null, outdated: null };
  return { version: m[1].replace(/^v/, ''), outdated: running !== ref(name) };
}

module.exports = { IMAGES, ref, compare };
