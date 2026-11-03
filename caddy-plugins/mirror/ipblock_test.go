package mirror

import (
	"bufio"
	"context"
	"net/http/httptest"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/caddyserver/caddy/v2"
	"github.com/caddyserver/caddy/v2/modules/caddyhttp"
	"go.uber.org/zap"
)

func sets(t *testing.T, text string) *prefixSets {
	t.Helper()
	s, err := parseIPBlock(bufio.NewScanner(strings.NewReader(text)))
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func TestIPBlockParseAndMatch(t *testing.T) {
	s := sets(t, `# GateControl IP-Sperre
198.51.100.23
203.0.113.0/24
2001:db8::/32
::ffff:192.0.2.9
!203.0.113.7
not-an-ip
10.0.0.0/33
`)
	if s.entries != 5 {
		t.Fatalf("entries = %d, want 5", s.entries)
	}
	cases := map[string]bool{
		"198.51.100.23":        true,
		"198.51.100.24":        false,
		"203.0.113.1":          true,
		"203.0.113.7":          false, // exception
		"2001:db8::1":          true,
		"2001:db9::1":          false,
		"192.0.2.9":            true, // written IPv4-mapped
		"::ffff:198.51.100.23": true, // asked IPv4-mapped
		"10.0.0.1":             false,
	}
	for ip, want := range cases {
		if got := s.blocked(netip.MustParseAddr(ip)); got != want {
			t.Errorf("%s: blocked = %v, want %v", ip, got, want)
		}
	}
}

func TestIPBlockEmptyBlocksNothing(t *testing.T) {
	var s *prefixSets
	if s.blocked(netip.MustParseAddr("1.2.3.4")) {
		t.Fatal("nil set must not block")
	}
	if sets(t, "").blocked(netip.MustParseAddr("1.2.3.4")) {
		t.Fatal("empty set must not block")
	}
}

func TestIPBlockMatcherUsesClientIPAndReloads(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "ipblock.list")
	if err := os.WriteFile(file, []byte("198.51.100.0/24\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	m := &IPBlock{File: file, Interval: caddy.Duration(20 * time.Millisecond), logger: zap.NewNop()}
	m.st = newIPBlockState(nil)
	m.reload(true)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go m.watch(ctx)

	req := func(client string) bool {
		r := httptest.NewRequest("GET", "/", nil)
		r.RemoteAddr = "10.9.9.9:1234"
		vars := map[string]any{caddyhttp.ClientIPVarKey: client}
		r = r.WithContext(context.WithValue(r.Context(), caddyhttp.VarsCtxKey, vars))
		ok, err := m.MatchWithError(r)
		if err != nil {
			t.Fatal(err)
		}
		return ok
	}
	if !req("198.51.100.5") {
		t.Fatal("198.51.100.5 should be blocked")
	}
	if req("192.0.2.1") {
		t.Fatal("192.0.2.1 should pass")
	}
	// a new file: picked up without a reload of the config
	time.Sleep(30 * time.Millisecond)
	if err := os.WriteFile(file, []byte("192.0.2.1\n!198.51.100.5\n198.51.100.0/24\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) && !req("192.0.2.1") {
		time.Sleep(10 * time.Millisecond)
	}
	if !req("192.0.2.1") {
		t.Fatal("the changed file was not picked up")
	}
	if req("198.51.100.5") {
		t.Fatal("the exception should win")
	}
	// file removed: nothing is blocked any more
	if err := os.Remove(file); err != nil {
		t.Fatal(err)
	}
	deadline = time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) && req("192.0.2.1") {
		time.Sleep(10 * time.Millisecond)
	}
	if req("192.0.2.1") {
		t.Fatal("a missing file must block nothing")
	}
}

func TestIPBlockRemoteAddrFallback(t *testing.T) {
	m := &IPBlock{st: newIPBlockState(sets(t, "203.0.113.9\n"))}
	r := httptest.NewRequest("GET", "/", nil)
	r.RemoteAddr = "203.0.113.9:443"
	if !m.Match(r) {
		t.Fatal("remote address should be used without a client IP variable")
	}
}
