package mirror

// caddy gc-dnstest — connection test for the DNS providers behind the
// wildcard certificate of the VPN zone (Einstellungen › VPN & Netzwerk ›
// Zertifikat für die Namen, button "Testen").
//
// It loads the chosen dns.providers.* module through Caddy's module
// registry — the very code Caddy uses later for the ACME DNS-01 challenge —
// writes one TXT record, waits until every authoritative nameserver of the
// zone serves it, and deletes it again. Let's Encrypt is never contacted, so
// a test costs no ACME rate limit.
//
// Input (stdin, one JSON object, at most 64 KiB):
//
//	{
//	  "provider": {"name": "<module>", ...fields as in the Caddy config...},
//	  "record":   "_acme-challenge.vpn.example.com",  // where the TXT is written
//	  "lookup":   "_acme-challenge.vpn.example.com",  // optional: public name that
//	                                                  // must CNAME to "record"
//	  "value":    "gc-test-…",                       // optional, random by default
//	  "resolvers": ["9.9.9.9:53", "1.1.1.1:53"],     // for SOA/NS/CNAME lookups
//	  "ttl": "60s", "propagation_timeout": "10m", "interval": "5s"
//	}
//
// Field values may use Caddy placeholders such as {file./path}; they are
// resolved by the module's own Provision, exactly as in the running server.
//
// Output (stdout): one JSON object per line — a line per step (login, zone,
// write, visible, delete) and a final {"done":true,...} line. Provider error
// texts are cleaned of every credential value given in the input before they
// are written. Exit code 0: all steps passed, 2: bad input, 3: a step failed
// (Caddy's command wrapper drops exit code 1 when no Go error is returned).

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"os"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/caddyserver/caddy/v2"
	caddycmd "github.com/caddyserver/caddy/v2/cmd"
	"github.com/caddyserver/certmagic"
	"github.com/libdns/libdns"
	"github.com/miekg/dns"
	"go.uber.org/zap"
)

func init() {
	caddycmd.RegisterCommand(caddycmd.Command{
		Name:  "gc-dnstest",
		Usage: "< request.json",
		Short: "Tests a DNS provider module with a temporary TXT record (GateControl)",
		Long: `
Reads a JSON request on stdin, loads the given dns.providers module, writes a
TXT record, waits until the authoritative nameservers serve it and deletes it
again. Prints one JSON line per step. Does not contact any ACME CA.`,
		Flags: flag.NewFlagSet("gc-dnstest", flag.ExitOnError),
		Func: func(caddycmd.Flags) (int, error) {
			return runDNSTest(context.Background(), os.Stdin, os.Stdout), nil
		},
	})
}

const (
	dnsTestMaxInput        = 64 << 10
	dnsTestDefaultTimeout  = 10 * time.Minute
	dnsTestMaxTimeout      = 30 * time.Minute
	dnsTestDefaultInterval = 5 * time.Second
	dnsTestQueryTimeout    = 5 * time.Second
	dnsTestCleanupTimeout  = 2 * time.Minute

	dnsTestExitBadInput = 2
	dnsTestExitFailed   = 3
)

// dnsTestNSPort is the port used to query authoritative nameservers. Tests
// point it at a local server.
var dnsTestNSPort = "53"

var defaultDNSTestResolvers = []string{"9.9.9.9:53", "1.1.1.1:53"}

var (
	providerNameRe = regexp.MustCompile(`^[a-z0-9_]{1,64}$`)
	dnsNameRe      = regexp.MustCompile(`^(?i)[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?(\.[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?)+\.?$`)
	testValueRe    = regexp.MustCompile(`^[A-Za-z0-9_.-]{1,255}$`)
)

type dnsTestRequest struct {
	Provider           json.RawMessage `json:"provider"`
	Record             string          `json:"record"`
	Lookup             string          `json:"lookup,omitempty"`
	Value              string          `json:"value,omitempty"`
	Resolvers          []string        `json:"resolvers,omitempty"`
	TTL                caddy.Duration  `json:"ttl,omitempty"`
	PropagationTimeout caddy.Duration  `json:"propagation_timeout,omitempty"`
	Interval           caddy.Duration  `json:"interval,omitempty"`
}

type dnsTestStep struct {
	Step   string `json:"step"`
	Status string `json:"status"` // ok | fail | skip
	MS     int64  `json:"ms"`
	Code   string `json:"code,omitempty"`
	Detail string `json:"detail,omitempty"`
	Error  string `json:"error,omitempty"`
}

type dnsTestResult struct {
	Done          bool     `json:"done"`
	OK            bool     `json:"ok"`
	Code          string   `json:"code,omitempty"`
	Error         string   `json:"error,omitempty"`
	Zone          string   `json:"zone,omitempty"`
	Nameservers   []string `json:"nameservers,omitempty"`
	PropagationMS int64    `json:"propagation_ms,omitempty"`
}

type dnsTestRun struct {
	enc     *json.Encoder
	secrets []string
}

func (r *dnsTestRun) redact(s string) string {
	for _, sec := range r.secrets {
		s = strings.ReplaceAll(s, sec, "***")
	}
	return s
}

func (r *dnsTestRun) step(s dnsTestStep, start time.Time) {
	s.MS = time.Since(start).Milliseconds()
	s.Error = r.redact(s.Error)
	s.Detail = r.redact(s.Detail)
	_ = r.enc.Encode(s)
}

func (r *dnsTestRun) finish(res dnsTestResult) int {
	res.Done = true
	res.Error = r.redact(res.Error)
	_ = r.enc.Encode(res)
	if res.OK {
		return 0
	}
	if res.Code == "bad_input" {
		return dnsTestExitBadInput
	}
	return dnsTestExitFailed
}

func runDNSTest(ctx context.Context, in io.Reader, out io.Writer) int {
	run := &dnsTestRun{enc: json.NewEncoder(out)}

	raw, err := io.ReadAll(io.LimitReader(in, dnsTestMaxInput+1))
	if err != nil || len(raw) > dnsTestMaxInput {
		return run.finish(dnsTestResult{Code: "bad_input", Error: "request unreadable or too large"})
	}
	var req dnsTestRequest
	if err := json.Unmarshal(raw, &req); err != nil {
		return run.finish(dnsTestResult{Code: "bad_input", Error: "request is not valid JSON"})
	}

	name, provRaw, secrets, err := splitProvider(req.Provider)
	run.secrets = secrets
	if err != nil {
		return run.finish(dnsTestResult{Code: "bad_input", Error: err.Error()})
	}
	record := strings.TrimSuffix(strings.ToLower(strings.TrimSpace(req.Record)), ".")
	if !dnsNameRe.MatchString(record) {
		return run.finish(dnsTestResult{Code: "bad_input", Error: "record is not a valid DNS name"})
	}
	lookup := strings.TrimSuffix(strings.ToLower(strings.TrimSpace(req.Lookup)), ".")
	if lookup != "" && !dnsNameRe.MatchString(lookup) {
		return run.finish(dnsTestResult{Code: "bad_input", Error: "lookup is not a valid DNS name"})
	}
	if lookup == record {
		lookup = ""
	}
	value := req.Value
	if value == "" {
		value = "gc-test-" + randomHex(12)
	} else if !testValueRe.MatchString(value) {
		return run.finish(dnsTestResult{Code: "bad_input", Error: "value has invalid characters"})
	}
	resolvers, err := normalizeResolvers(req.Resolvers)
	if err != nil {
		return run.finish(dnsTestResult{Code: "bad_input", Error: err.Error()})
	}
	timeout := time.Duration(req.PropagationTimeout)
	if timeout <= 0 {
		timeout = dnsTestDefaultTimeout
	}
	if timeout > dnsTestMaxTimeout {
		timeout = dnsTestMaxTimeout
	}
	interval := time.Duration(req.Interval)
	if interval <= 0 {
		interval = dnsTestDefaultInterval
	}

	ctx, cancel := context.WithTimeout(ctx, timeout+5*time.Minute)
	defer cancel()
	logger := zap.NewNop()

	// Zone of the record (SOA lookup over public resolvers). Needed before the
	// login check, since listing records is per zone.
	zone, zoneErr := certmagic.FindZoneByFQDN(ctx, logger, record+".", resolvers)

	// 1 · login: load and provision the module, then read the zone if the
	// provider can list records (proves credentials and access to the zone).
	start := time.Now()
	cctx, ccancel := caddy.NewContext(caddy.Context{Context: ctx})
	defer ccancel()
	mod, err := cctx.LoadModuleByID("dns.providers."+name, provRaw)
	if err != nil {
		run.step(dnsTestStep{Step: "login", Status: "fail", Code: "provider_config", Error: err.Error()}, start)
		return run.finish(dnsTestResult{Code: "provider_config", Error: err.Error()})
	}
	provider, ok := mod.(certmagic.DNSProvider)
	if !ok {
		msg := "module dns.providers." + name + " cannot write and delete records"
		run.step(dnsTestStep{Step: "login", Status: "fail", Code: "provider_config", Error: msg}, start)
		return run.finish(dnsTestResult{Code: "provider_config", Error: msg})
	}
	getter, canList := mod.(libdns.RecordGetter)
	switch {
	case zoneErr != nil:
		run.step(dnsTestStep{Step: "login", Status: "skip", Detail: "zone unknown"}, start)
	case canList:
		if _, err := getter.GetRecords(ctx, zone); err != nil {
			run.step(dnsTestStep{Step: "login", Status: "fail", Code: "credentials", Error: err.Error()}, start)
			return run.finish(dnsTestResult{Code: "credentials", Error: err.Error(), Zone: strings.TrimSuffix(zone, ".")})
		}
		run.step(dnsTestStep{Step: "login", Status: "ok"}, start)
	default:
		run.step(dnsTestStep{Step: "login", Status: "ok", Detail: "provider cannot list records; checked when writing"}, start)
	}

	// 2 · zone (and the CNAME of a delegated challenge name)
	start = time.Now()
	if zoneErr != nil {
		run.step(dnsTestStep{Step: "zone", Status: "fail", Code: "zone_not_found", Error: zoneErr.Error()}, start)
		return run.finish(dnsTestResult{Code: "zone_not_found", Error: zoneErr.Error()})
	}
	zoneName := strings.TrimSuffix(zone, ".")
	if lookup != "" {
		target, err := lookupCNAME(ctx, lookup, resolvers)
		if err != nil || target == "" {
			msg := lookup + " has no CNAME"
			if err != nil {
				msg += ": " + err.Error()
			}
			run.step(dnsTestStep{Step: "zone", Status: "fail", Code: "cname_missing", Detail: zoneName, Error: msg}, start)
			return run.finish(dnsTestResult{Code: "cname_missing", Error: msg, Zone: zoneName})
		}
		if target != record {
			msg := lookup + " points to " + target + ", expected " + record
			run.step(dnsTestStep{Step: "zone", Status: "fail", Code: "cname_wrong", Detail: zoneName, Error: msg}, start)
			return run.finish(dnsTestResult{Code: "cname_wrong", Error: msg, Zone: zoneName})
		}
	}
	nameservers, nsErr := lookupNameserverAddrs(ctx, zone, resolvers)
	if nsErr != nil {
		run.step(dnsTestStep{Step: "zone", Status: "fail", Code: "nameservers", Detail: zoneName, Error: nsErr.Error()}, start)
		return run.finish(dnsTestResult{Code: "nameservers", Error: nsErr.Error(), Zone: zoneName})
	}
	nsNames := make([]string, 0, len(nameservers))
	for _, ns := range nameservers {
		nsNames = append(nsNames, ns.name)
	}
	run.step(dnsTestStep{Step: "zone", Status: "ok", Detail: zoneName}, start)

	// 3 · write
	start = time.Now()
	rec := libdns.TXT{Name: libdns.RelativeName(record+".", zone), TTL: time.Duration(req.TTL), Text: value}
	written, err := provider.AppendRecords(ctx, zone, []libdns.Record{rec})
	if err != nil {
		run.step(dnsTestStep{Step: "write", Status: "fail", Code: "write_failed", Error: err.Error()}, start)
		return run.finish(dnsTestResult{Code: "write_failed", Error: err.Error(), Zone: zoneName, Nameservers: nsNames})
	}
	toDelete := written
	if len(toDelete) == 0 {
		toDelete = []libdns.Record{rec}
	}
	run.step(dnsTestStep{Step: "write", Status: "ok", Detail: record}, start)

	// 4 · visible on every authoritative nameserver
	start = time.Now()
	visErr := waitVisible(ctx, record, value, nameservers, timeout, interval)
	propagation := time.Since(start).Milliseconds()
	if visErr != nil {
		run.step(dnsTestStep{Step: "visible", Status: "fail", Code: "propagation_timeout", Error: visErr.Error()}, start)
	} else {
		run.step(dnsTestStep{Step: "visible", Status: "ok", Detail: strings.Join(nsNames, ", ")}, start)
	}

	// 5 · delete — always, with its own context (the main one may be spent)
	start = time.Now()
	dctx, dcancel := context.WithTimeout(context.Background(), dnsTestCleanupTimeout)
	defer dcancel()
	_, delErr := provider.DeleteRecords(dctx, zone, toDelete)
	if delErr != nil {
		run.step(dnsTestStep{Step: "delete", Status: "fail", Code: "delete_failed", Error: delErr.Error()}, start)
	} else {
		run.step(dnsTestStep{Step: "delete", Status: "ok"}, start)
	}

	res := dnsTestResult{Zone: zoneName, Nameservers: nsNames}
	switch {
	case visErr != nil:
		res.Code, res.Error = "propagation_timeout", visErr.Error()
	case delErr != nil:
		res.Code, res.Error = "delete_failed", delErr.Error()
		res.PropagationMS = propagation
	default:
		res.OK = true
		res.PropagationMS = propagation
	}
	return run.finish(res)
}

// splitProvider takes the inline module name off the provider object (as
// Caddy does for inline_key=name) and collects every string value as a
// secret to redact from error texts, placeholders resolved.
func splitProvider(raw json.RawMessage) (string, json.RawMessage, []string, error) {
	if len(raw) == 0 {
		return "", nil, nil, errors.New("provider missing")
	}
	var obj map[string]any
	if err := json.Unmarshal(raw, &obj); err != nil || obj == nil {
		return "", nil, nil, errors.New("provider must be a JSON object")
	}
	name, _ := obj["name"].(string)
	delete(obj, "name")
	secrets := collectSecrets(obj)
	if !providerNameRe.MatchString(name) {
		return "", nil, secrets, errors.New("provider name missing or invalid")
	}
	rest, err := json.Marshal(obj)
	if err != nil {
		return "", nil, secrets, errors.New("provider cannot be encoded")
	}
	return name, rest, secrets, nil
}

func collectSecrets(v any) []string {
	repl := caddy.NewReplacer()
	seen := map[string]bool{}
	var walk func(any)
	walk = func(v any) {
		switch t := v.(type) {
		case string:
			for _, s := range []string{t, strings.TrimSpace(repl.ReplaceAll(t, ""))} {
				if len(s) >= 4 {
					seen[s] = true
				}
			}
		case map[string]any:
			for _, x := range t {
				walk(x)
			}
		case []any:
			for _, x := range t {
				walk(x)
			}
		}
	}
	walk(v)
	out := make([]string, 0, len(seen))
	for s := range seen {
		out = append(out, s)
	}
	// longest first, so a secret containing another one is fully replaced
	sort.Slice(out, func(i, j int) bool { return len(out[i]) > len(out[j]) })
	return out
}

func normalizeResolvers(in []string) ([]string, error) {
	if len(in) == 0 {
		return append([]string(nil), defaultDNSTestResolvers...), nil
	}
	if len(in) > 8 {
		return nil, errors.New("too many resolvers")
	}
	out := make([]string, 0, len(in))
	for _, r := range in {
		r = strings.TrimSpace(r)
		host, port, err := net.SplitHostPort(r)
		if err != nil {
			host, port = r, "53"
		}
		if net.ParseIP(host) == nil || port == "" {
			return nil, fmt.Errorf("resolver %q is not an IP address", r)
		}
		out = append(out, net.JoinHostPort(host, port))
	}
	return out, nil
}

func randomHex(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func dnsExchange(ctx context.Context, name string, qtype uint16, server string, recursive bool) (*dns.Msg, error) {
	m := new(dns.Msg)
	m.SetQuestion(dns.Fqdn(name), qtype)
	m.RecursionDesired = recursive
	m.SetEdns0(1232, false)
	qctx, cancel := context.WithTimeout(ctx, dnsTestQueryTimeout)
	defer cancel()
	c := &dns.Client{Net: "udp", Timeout: dnsTestQueryTimeout}
	r, _, err := c.ExchangeContext(qctx, m, server)
	if err == nil && r != nil && r.Truncated {
		c.Net = "tcp"
		r, _, err = c.ExchangeContext(qctx, m, server)
	}
	return r, err
}

// queryResolvers asks the resolvers in turn and returns the first answer.
func queryResolvers(ctx context.Context, name string, qtype uint16, resolvers []string) (*dns.Msg, error) {
	var lastErr error
	for _, s := range resolvers {
		r, err := dnsExchange(ctx, name, qtype, s, true)
		if err != nil {
			lastErr = err
			continue
		}
		if r.Rcode != dns.RcodeSuccess && r.Rcode != dns.RcodeNameError {
			lastErr = fmt.Errorf("%s: %s", s, dns.RcodeToString[r.Rcode])
			continue
		}
		return r, nil
	}
	if lastErr == nil {
		lastErr = errors.New("no resolver answered")
	}
	return nil, lastErr
}

func lookupCNAME(ctx context.Context, name string, resolvers []string) (string, error) {
	r, err := queryResolvers(ctx, name, dns.TypeCNAME, resolvers)
	if err != nil {
		return "", err
	}
	for _, rr := range r.Answer {
		if c, ok := rr.(*dns.CNAME); ok && strings.EqualFold(strings.TrimSuffix(c.Hdr.Name, "."), name) {
			return strings.TrimSuffix(strings.ToLower(c.Target), "."), nil
		}
	}
	return "", nil
}

type nsAddr struct {
	name string
	addr string
}

func lookupNameserverAddrs(ctx context.Context, zone string, resolvers []string) ([]nsAddr, error) {
	r, err := queryResolvers(ctx, zone, dns.TypeNS, resolvers)
	if err != nil {
		return nil, fmt.Errorf("NS lookup for %s: %v", zone, err)
	}
	var out []nsAddr
	for _, rr := range r.Answer {
		ns, ok := rr.(*dns.NS)
		if !ok {
			continue
		}
		host := strings.ToLower(ns.Ns)
		ip := ""
	resolve:
		for _, qt := range []uint16{dns.TypeA, dns.TypeAAAA} {
			ar, err := queryResolvers(ctx, host, qt, resolvers)
			if err != nil {
				continue
			}
			for _, a := range ar.Answer {
				switch t := a.(type) {
				case *dns.A:
					ip = t.A.String()
				case *dns.AAAA:
					ip = t.AAAA.String()
				}
				if ip != "" {
					break resolve
				}
			}
		}
		if ip != "" {
			out = append(out, nsAddr{name: strings.TrimSuffix(host, "."), addr: net.JoinHostPort(ip, dnsTestNSPort)})
		}
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("no reachable nameserver found for %s", zone)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].name < out[j].name })
	return out, nil
}

func hasTXT(r *dns.Msg, value string) bool {
	for _, rr := range r.Answer {
		if t, ok := rr.(*dns.TXT); ok && strings.Join(t.Txt, "") == value {
			return true
		}
	}
	return false
}

// waitVisible polls the authoritative nameservers directly (no recursion, so
// no negative caching gets in the way) until all of them serve the value.
func waitVisible(ctx context.Context, record, value string, nameservers []nsAddr, timeout, interval time.Duration) error {
	deadline := time.Now().Add(timeout)
	seen := make(map[string]bool, len(nameservers))
	for {
		for _, ns := range nameservers {
			if seen[ns.addr] {
				continue
			}
			r, err := dnsExchange(ctx, record, dns.TypeTXT, ns.addr, false)
			if err == nil && r.Rcode == dns.RcodeSuccess && hasTXT(r, value) {
				seen[ns.addr] = true
			}
		}
		if len(seen) == len(nameservers) {
			return nil
		}
		if time.Now().Add(interval).After(deadline) {
			missing := []string{}
			for _, ns := range nameservers {
				if !seen[ns.addr] {
					missing = append(missing, ns.name)
				}
			}
			return fmt.Errorf("record not visible after %s on %d of %d nameservers (%s)",
				timeout, len(missing), len(nameservers), strings.Join(missing, ", "))
		}
		select {
		case <-time.After(interval):
		case <-ctx.Done():
			return ctx.Err()
		}
	}
}
