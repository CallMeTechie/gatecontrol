module github.com/custom/caddy-mirror

go 1.23

require (
	github.com/caddyserver/caddy/v2 v2.11.4
	go.uber.org/zap v1.27.0
	github.com/go-jose/go-jose/v3 v3.0.5
	github.com/go-jose/go-jose/v4 v4.1.4
	github.com/smallstep/certificates v0.30.0
	// Mindestversionen erzwingen Fixes, die der Plugin-Graph sonst nicht
	// hereinzieht (Trivy HIGH im Caddy-Binary). MVS übernimmt sie in den
	// xcaddy-Build.
	// gRPC-Go: GHSA-hrxh-6v49-42gf (v1.82.1), CVE-2026-84304 (v1.83.1),
	// CVE-2026-84445 (v1.83.2).
	google.golang.org/grpc v1.83.2
	golang.org/x/crypto v0.55.0 // CVE-2026-56854
	golang.org/x/net v0.56.0 // CVE-2026-46600
	golang.org/x/text v0.39.0 // CVE-2026-56852
)
