module github.com/custom/caddy-mirror

go 1.23

require (
	github.com/caddyserver/caddy/v2 v2.11.4
	go.uber.org/zap v1.27.0
	github.com/go-jose/go-jose/v3 v3.0.5
	github.com/go-jose/go-jose/v4 v4.1.4
	github.com/smallstep/certificates v0.30.0
	// Mindestversion erzwingt den Fix für GHSA-hrxh-6v49-42gf (gRPC-Go: xDS RBAC
	// und HTTP/2). Der Plugin-Graph zog sonst v1.81.0 herein, was Trivy als HIGH
	// meldet; behoben in v1.82.1.
	google.golang.org/grpc v1.82.1
)
