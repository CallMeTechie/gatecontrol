package mirror

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/caddyserver/caddy/v2"
	"github.com/libdns/libdns"
	"github.com/miekg/dns"
)

// ---- fake provider: dns.providers.gc_fake (tests only) ----------------------

type fakeZoneStore struct {
	mu      sync.Mutex
	txt     map[string][]string // fqdn (no dot) -> values
	cname   map[string]string   // fqdn -> target
	hidden  bool                // do not serve TXT records (slow provider)
	appends int
	deletes int
}

var fakeStore = &fakeZoneStore{}

func (s *fakeZoneStore) reset() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.txt = map[string][]string{}
	s.cname = map[string]string{}
	s.hidden = false
	s.appends, s.deletes = 0, 0
}

type fakeProvider struct {
	APIToken  string `json:"api_token,omitempty"`
	FailLogin bool   `json:"fail_login,omitempty"`
	FailWrite bool   `json:"fail_write,omitempty"`
	token     string
}

func (fakeProvider) CaddyModule() caddy.ModuleInfo {
	return caddy.ModuleInfo{ID: "dns.providers.gc_fake", New: func() caddy.Module { return new(fakeProvider) }}
}

func (p *fakeProvider) Provision(caddy.Context) error {
	p.token = caddy.NewReplacer().ReplaceAll(p.APIToken, "")
	if p.token == "" {
		return errors.New("api_token missing")
	}
	return nil
}

func (p *fakeProvider) GetRecords(_ context.Context, zone string) ([]libdns.Record, error) {
	if p.FailLogin {
		// Real providers sometimes echo the credential (URLs, headers).
		return nil, errors.New("401 unauthorized for token " + p.token)
	}
	return nil, nil
}

func (p *fakeProvider) AppendRecords(_ context.Context, zone string, recs []libdns.Record) ([]libdns.Record, error) {
	if p.FailWrite {
		return nil, errors.New("403 forbidden: token " + p.token + " may not write")
	}
	fakeStore.mu.Lock()
	defer fakeStore.mu.Unlock()
	for _, r := range recs {
		rr := r.RR()
		name := strings.TrimSuffix(libdns.AbsoluteName(rr.Name, zone), ".")
		fakeStore.txt[name] = append(fakeStore.txt[name], rr.Data)
		fakeStore.appends++
	}
	return recs, nil
}

func (p *fakeProvider) DeleteRecords(_ context.Context, zone string, recs []libdns.Record) ([]libdns.Record, error) {
	fakeStore.mu.Lock()
	defer fakeStore.mu.Unlock()
	for _, r := range recs {
		rr := r.RR()
		name := strings.TrimSuffix(libdns.AbsoluteName(rr.Name, zone), ".")
		vals := fakeStore.txt[name][:0]
		for _, v := range fakeStore.txt[name] {
			if v != rr.Data {
				vals = append(vals, v)
			}
		}
		if len(vals) == 0 {
			delete(fakeStore.txt, name)
		} else {
			fakeStore.txt[name] = vals
		}
		fakeStore.deletes++
	}
	return recs, nil
}

func init() {
	caddy.RegisterModule(fakeProvider{})
}

// ---- local DNS server: zones example.com and example.net -------------------

var fakeZones = []string{"example.com.", "example.net."}

func zoneOf(name string) string {
	for _, z := range fakeZones {
		if name == z || strings.HasSuffix(name, "."+z) {
			return z
		}
	}
	return ""
}

func serveFakeDNS(w dns.ResponseWriter, req *dns.Msg) {
	m := new(dns.Msg)
	m.SetReply(req)
	m.Authoritative = true
	q := req.Question[0]
	name := strings.ToLower(q.Name)
	zone := zoneOf(name)
	hdr := func(t uint16) dns.RR_Header {
		return dns.RR_Header{Name: q.Name, Rrtype: t, Class: dns.ClassINET, Ttl: 60}
	}
	fakeStore.mu.Lock()
	defer fakeStore.mu.Unlock()
	switch {
	case zone == "":
		m.Rcode = dns.RcodeNameError
	case q.Qtype == dns.TypeSOA && name == zone:
		m.Answer = append(m.Answer, &dns.SOA{Hdr: hdr(dns.TypeSOA), Ns: "ns1." + zone, Mbox: "hostmaster." + zone, Serial: 1, Refresh: 3600, Retry: 600, Expire: 86400, Minttl: 60})
	case q.Qtype == dns.TypeNS && name == zone:
		m.Answer = append(m.Answer, &dns.NS{Hdr: hdr(dns.TypeNS), Ns: "ns1." + zone})
	case q.Qtype == dns.TypeA && name == "ns1."+zone:
		m.Answer = append(m.Answer, &dns.A{Hdr: hdr(dns.TypeA), A: net.ParseIP("127.0.0.1")})
	case q.Qtype == dns.TypeCNAME:
		if t, ok := fakeStore.cname[strings.TrimSuffix(name, ".")]; ok {
			m.Answer = append(m.Answer, &dns.CNAME{Hdr: hdr(dns.TypeCNAME), Target: t + "."})
		}
	case q.Qtype == dns.TypeTXT && !fakeStore.hidden:
		for _, v := range fakeStore.txt[strings.TrimSuffix(name, ".")] {
			m.Answer = append(m.Answer, &dns.TXT{Hdr: hdr(dns.TypeTXT), Txt: []string{v}})
		}
	}
	_ = w.WriteMsg(m)
}

func startFakeDNS(t *testing.T) string {
	t.Helper()
	pc, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	srv := &dns.Server{PacketConn: pc, Handler: dns.HandlerFunc(serveFakeDNS)}
	go func() { _ = srv.ActivateAndServe() }()
	t.Cleanup(func() { _ = srv.Shutdown() })
	_, port, _ := net.SplitHostPort(pc.LocalAddr().String())
	old := dnsTestNSPort
	dnsTestNSPort = port
	t.Cleanup(func() { dnsTestNSPort = old })
	return pc.LocalAddr().String()
}

// ---- helpers ---------------------------------------------------------------

type testOutput struct {
	steps map[string]dnsTestStep
	order []string
	final dnsTestResult
	raw   string
}

func runTest(t *testing.T, req map[string]any) (int, testOutput) {
	t.Helper()
	in, _ := json.Marshal(req)
	var out bytes.Buffer
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	code := runDNSTest(ctx, bytes.NewReader(in), &out)
	res := testOutput{steps: map[string]dnsTestStep{}, raw: out.String()}
	for _, line := range strings.Split(strings.TrimSpace(out.String()), "\n") {
		if strings.Contains(line, `"done":true`) {
			if err := json.Unmarshal([]byte(line), &res.final); err != nil {
				t.Fatalf("bad final line %q: %v", line, err)
			}
			continue
		}
		var s dnsTestStep
		if err := json.Unmarshal([]byte(line), &s); err != nil {
			t.Fatalf("bad step line %q: %v", line, err)
		}
		res.steps[s.Step] = s
		res.order = append(res.order, s.Step)
	}
	if !res.final.Done {
		t.Fatalf("no final line in output:\n%s", out.String())
	}
	return code, res
}

const fakeToken = "fake-token-for-tests-0001"

func baseRequest(resolver string) map[string]any {
	return map[string]any{
		"provider":            map[string]any{"name": "gc_fake", "api_token": fakeToken},
		"record":              "_acme-challenge.vpn.example.com",
		"resolvers":           []string{resolver},
		"propagation_timeout": "2s",
		"interval":            "100ms",
	}
}

// ---- tests -----------------------------------------------------------------

func TestDNSTestAllStepsPass(t *testing.T) {
	fakeStore.reset()
	resolver := startFakeDNS(t)
	req := baseRequest(resolver)
	req["value"] = "gc-test-abc"

	code, out := runTest(t, req)
	if code != 0 || !out.final.OK {
		t.Fatalf("expected success, got code %d:\n%s", code, out.raw)
	}
	want := []string{"login", "zone", "write", "visible", "delete"}
	if strings.Join(out.order, ",") != strings.Join(want, ",") {
		t.Fatalf("steps = %v, want %v", out.order, want)
	}
	for _, s := range want {
		if out.steps[s].Status != "ok" {
			t.Errorf("step %s = %+v", s, out.steps[s])
		}
	}
	if out.final.Zone != "example.com" || out.steps["zone"].Detail != "example.com" {
		t.Errorf("zone = %q", out.final.Zone)
	}
	if len(out.final.Nameservers) != 1 || out.final.Nameservers[0] != "ns1.example.com" {
		t.Errorf("nameservers = %v", out.final.Nameservers)
	}
	fakeStore.mu.Lock()
	defer fakeStore.mu.Unlock()
	if fakeStore.appends != 1 || fakeStore.deletes != 1 || len(fakeStore.txt) != 0 {
		t.Errorf("record not cleaned up: appends=%d deletes=%d left=%v", fakeStore.appends, fakeStore.deletes, fakeStore.txt)
	}
}

func TestDNSTestRandomValueKeepsOtherRecords(t *testing.T) {
	fakeStore.reset()
	resolver := startFakeDNS(t)
	fakeStore.txt["_acme-challenge.vpn.example.com"] = []string{"running-acme-challenge"}

	code, out := runTest(t, baseRequest(resolver))
	if code != 0 {
		t.Fatalf("code %d:\n%s", code, out.raw)
	}
	fakeStore.mu.Lock()
	defer fakeStore.mu.Unlock()
	if got := fakeStore.txt["_acme-challenge.vpn.example.com"]; len(got) != 1 || got[0] != "running-acme-challenge" {
		t.Errorf("foreign TXT value touched: %v", got)
	}
}

func TestDNSTestLoginFailureIsRedacted(t *testing.T) {
	fakeStore.reset()
	resolver := startFakeDNS(t)
	req := baseRequest(resolver)
	req["provider"].(map[string]any)["fail_login"] = true

	code, out := runTest(t, req)
	if code != dnsTestExitFailed || out.final.Code != "credentials" {
		t.Fatalf("code %d final %+v", code, out.final)
	}
	if out.steps["login"].Status != "fail" || !strings.Contains(out.steps["login"].Error, "401 unauthorized") {
		t.Errorf("login step = %+v", out.steps["login"])
	}
	if strings.Contains(out.raw, fakeToken) {
		t.Fatalf("token leaked into output:\n%s", out.raw)
	}
	if fakeStore.appends != 0 {
		t.Error("record written after failed login")
	}
}

func TestDNSTestFilePlaceholderResolvedAndRedacted(t *testing.T) {
	fakeStore.reset()
	resolver := startFakeDNS(t)
	dir := t.TempDir()
	tokenFile := filepath.Join(dir, "api_token")
	const fileToken = "token-from-file-0002"
	if err := os.WriteFile(tokenFile, []byte(fileToken), 0o600); err != nil {
		t.Fatal(err)
	}
	req := baseRequest(resolver)
	req["provider"] = map[string]any{"name": "gc_fake", "api_token": "{file." + tokenFile + "}", "fail_write": true}

	code, out := runTest(t, req)
	if code != dnsTestExitFailed || out.steps["write"].Code != "write_failed" {
		t.Fatalf("code %d:\n%s", code, out.raw)
	}
	if out.steps["login"].Status != "ok" {
		t.Errorf("placeholder not resolved: %+v", out.steps["login"])
	}
	if strings.Contains(out.raw, fileToken) {
		t.Fatalf("token from file leaked into output:\n%s", out.raw)
	}
}

func TestDNSTestPropagationTimeoutStillDeletes(t *testing.T) {
	fakeStore.reset()
	resolver := startFakeDNS(t)
	fakeStore.hidden = true
	req := baseRequest(resolver)
	req["propagation_timeout"] = "500ms"

	code, out := runTest(t, req)
	if code != dnsTestExitFailed || out.final.Code != "propagation_timeout" {
		t.Fatalf("code %d:\n%s", code, out.raw)
	}
	if out.steps["visible"].Status != "fail" || !strings.Contains(out.steps["visible"].Error, "ns1.example.com") {
		t.Errorf("visible step = %+v", out.steps["visible"])
	}
	if out.steps["delete"].Status != "ok" {
		t.Errorf("delete step = %+v", out.steps["delete"])
	}
	fakeStore.mu.Lock()
	defer fakeStore.mu.Unlock()
	if len(fakeStore.txt) != 0 {
		t.Errorf("record left behind: %v", fakeStore.txt)
	}
}

func TestDNSTestDelegationViaCNAME(t *testing.T) {
	fakeStore.reset()
	resolver := startFakeDNS(t)
	req := baseRequest(resolver)
	req["record"] = "_acme-challenge.vpn-example.example.net"
	req["lookup"] = "_acme-challenge.vpn.example.com"

	// CNAME not set yet
	code, out := runTest(t, req)
	if code != dnsTestExitFailed || out.final.Code != "cname_missing" || fakeStore.appends != 0 {
		t.Fatalf("code %d:\n%s", code, out.raw)
	}

	// CNAME to a different target
	fakeStore.mu.Lock()
	fakeStore.cname["_acme-challenge.vpn.example.com"] = "_acme-challenge.other.example.net"
	fakeStore.mu.Unlock()
	code, out = runTest(t, req)
	if code != dnsTestExitFailed || out.final.Code != "cname_wrong" {
		t.Fatalf("code %d:\n%s", code, out.raw)
	}

	// correct CNAME: the record lands in the delegated zone
	fakeStore.mu.Lock()
	fakeStore.cname["_acme-challenge.vpn.example.com"] = "_acme-challenge.vpn-example.example.net"
	fakeStore.mu.Unlock()
	code, out = runTest(t, req)
	if code != 0 || out.final.Zone != "example.net" {
		t.Fatalf("code %d:\n%s", code, out.raw)
	}
}

func TestDNSTestBadInput(t *testing.T) {
	fakeStore.reset()
	resolver := startFakeDNS(t)
	cases := map[string]func(map[string]any){
		"no provider":      func(r map[string]any) { delete(r, "provider") },
		"no name":          func(r map[string]any) { r["provider"] = map[string]any{"api_token": fakeToken} },
		"bad name":         func(r map[string]any) { r["provider"] = map[string]any{"name": "../x", "api_token": fakeToken} },
		"bad record":       func(r map[string]any) { r["record"] = "not a name" },
		"bad resolver":     func(r map[string]any) { r["resolvers"] = []string{"resolver.example.com"} },
		"bad value":        func(r map[string]any) { r["value"] = "a b\"c" },
		"provider not obj": func(r map[string]any) { r["provider"] = "gc_fake" },
	}
	for name, mod := range cases {
		t.Run(name, func(t *testing.T) {
			req := baseRequest(resolver)
			mod(req)
			code, out := runTest(t, req)
			if code != dnsTestExitBadInput || out.final.Code != "bad_input" {
				t.Fatalf("code %d:\n%s", code, out.raw)
			}
			if strings.Contains(out.raw, fakeToken) {
				t.Fatalf("token leaked:\n%s", out.raw)
			}
		})
	}

	var out bytes.Buffer
	if code := runDNSTest(context.Background(), strings.NewReader("{not json"), &out); code != dnsTestExitBadInput {
		t.Errorf("invalid JSON: code %d", code)
	}
}

func TestDNSTestUnknownProviderModule(t *testing.T) {
	fakeStore.reset()
	resolver := startFakeDNS(t)
	req := baseRequest(resolver)
	req["provider"] = map[string]any{"name": "does_not_exist", "api_token": fakeToken}
	code, out := runTest(t, req)
	if code != dnsTestExitFailed || out.final.Code != "provider_config" || !strings.Contains(out.final.Error, "unknown module") {
		t.Fatalf("code %d:\n%s", code, out.raw)
	}
	if strings.Contains(out.raw, fakeToken) {
		t.Fatalf("token leaked:\n%s", out.raw)
	}
}

func TestDNSTestUnknownFieldRejected(t *testing.T) {
	fakeStore.reset()
	resolver := startFakeDNS(t)
	req := baseRequest(resolver)
	req["provider"].(map[string]any)["no_such_field"] = "secret-looking-value"
	code, out := runTest(t, req)
	if code != dnsTestExitFailed || out.final.Code != "provider_config" {
		t.Fatalf("code %d:\n%s", code, out.raw)
	}
	if strings.Contains(out.raw, "secret-looking-value") || strings.Contains(out.raw, fakeToken) {
		t.Fatalf("value leaked:\n%s", out.raw)
	}
}

func TestNormalizeResolvers(t *testing.T) {
	got, err := normalizeResolvers([]string{"9.9.9.9", "[2620:fe::fe]:53", "1.1.1.1:5353"})
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"9.9.9.9:53", "[2620:fe::fe]:53", "1.1.1.1:5353"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Errorf("got %v want %v", got, want)
	}
	if def, _ := normalizeResolvers(nil); len(def) != 2 {
		t.Errorf("default resolvers = %v", def)
	}
}
