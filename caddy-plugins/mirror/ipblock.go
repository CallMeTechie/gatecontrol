package mirror

// http.matchers.gc_ipblock — the IP block of GateControl (Einstellungen ›
// Sicherheit › IP-Sperre, src/services/ipBlock.js).
//
// GateControl writes one file with the addresses that must not reach any
// route, the portal or the login: one IP or CIDR per line, `!` before an
// entry makes it an exception (VPN subnet, "Nie sperren"), `#` starts a
// comment. The matcher re-reads the file when its modification time or size
// changes (checked every `interval`, default 2 s) and swaps the set
// atomically — a new ban takes effect within seconds without a Caddy reload
// (a reload re-provisions every app, the WAF rule sets included). A missing
// or unreadable file is an empty set: nothing is blocked.
//
// The address checked is Caddy's client IP (the server's trusted_proxies
// decide whether X-Forwarded-For counts), the same one the access log and
// the WAF see.

import (
	"bufio"
	"context"
	"net"
	"net/http"
	"net/netip"
	"os"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/caddyserver/caddy/v2"
	"github.com/caddyserver/caddy/v2/modules/caddyhttp"
	"go.uber.org/zap"
)

func init() {
	caddy.RegisterModule(IPBlock{})
}

// maxIPBlockEntries bounds what one file may load (a broken or hostile file
// must not eat the memory of the proxy).
const maxIPBlockEntries = 500000

// IPBlock matches requests whose client IP is in the block file and not in
// one of its exceptions.
type IPBlock struct {
	File     string         `json:"file,omitempty"`
	Interval caddy.Duration `json:"interval,omitempty"`

	logger *zap.Logger
	stop   context.CancelFunc
	st     *ipBlockState
}

// ipBlockState: the loaded set and what it was read from (a pointer, so the
// module value itself stays copyable as Caddy requires).
type ipBlockState struct {
	set   atomic.Pointer[prefixSets]
	mu    sync.Mutex
	mtime time.Time
	size  int64
}

func newIPBlockState(s *prefixSets) *ipBlockState {
	st := &ipBlockState{}
	if s == nil {
		s = &prefixSets{}
	}
	st.set.Store(s)
	return st
}

// prefixSets: block and allow entries, each as one map per prefix length.
type prefixSets struct {
	block   prefixSet
	allow   prefixSet
	entries int
}

type prefixSet struct {
	byLen map[int]map[netip.Prefix]struct{}
	lens  []int // descending
}

func (s *prefixSet) add(p netip.Prefix) {
	if s.byLen == nil {
		s.byLen = map[int]map[netip.Prefix]struct{}{}
	}
	bits := p.Bits()
	if p.Addr().Is4() {
		bits += 96 // IPv4 entries live in the IPv4-mapped space, like the lookups
	}
	m, ok := s.byLen[bits]
	if !ok {
		m = map[netip.Prefix]struct{}{}
		s.byLen[bits] = m
		s.lens = append(s.lens, bits)
		sort.Sort(sort.Reverse(sort.IntSlice(s.lens)))
	}
	m[netip.PrefixFrom(mapped(p.Addr()), bits).Masked()] = struct{}{}
}

func (s *prefixSet) has(a netip.Addr) bool {
	for _, bits := range s.lens {
		p, err := a.Prefix(bits)
		if err != nil {
			continue
		}
		if _, ok := s.byLen[bits][p]; ok {
			return true
		}
	}
	return false
}

func mapped(a netip.Addr) netip.Addr {
	if a.Is4() {
		return netip.AddrFrom16(a.As16())
	}
	return a
}

// CaddyModule returns the Caddy module information.
func (IPBlock) CaddyModule() caddy.ModuleInfo {
	return caddy.ModuleInfo{
		ID:  "http.matchers.gc_ipblock",
		New: func() caddy.Module { return new(IPBlock) },
	}
}

// Provision loads the file once and starts watching it.
func (m *IPBlock) Provision(ctx caddy.Context) error {
	m.logger = ctx.Logger()
	if m.Interval <= 0 {
		m.Interval = caddy.Duration(2 * time.Second)
	}
	m.st = newIPBlockState(nil)
	m.reload(true)
	watch, cancel := context.WithCancel(ctx)
	m.stop = cancel
	go m.watch(watch)
	return nil
}

// Cleanup stops the watcher of this config generation.
func (m *IPBlock) Cleanup() error {
	if m.stop != nil {
		m.stop()
	}
	return nil
}

func (m *IPBlock) watch(ctx context.Context) {
	t := time.NewTicker(time.Duration(m.Interval))
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			m.reload(false)
		}
	}
}

// reload reads the file when it changed since the last read (or always with force).
func (m *IPBlock) reload(force bool) {
	if m.File == "" {
		return
	}
	s := m.st
	s.mu.Lock()
	defer s.mu.Unlock()
	st, err := os.Stat(m.File)
	if err != nil {
		if !s.mtime.IsZero() || s.size != 0 {
			s.set.Store(&prefixSets{})
			s.mtime, s.size = time.Time{}, 0
		}
		return
	}
	if !force && st.ModTime().Equal(s.mtime) && st.Size() == s.size {
		return
	}
	sets, err := readIPBlockFile(m.File)
	if err != nil {
		if m.logger != nil {
			m.logger.Warn("gc_ipblock: cannot read the block file", zap.String("file", m.File), zap.Error(err))
		}
		return
	}
	s.set.Store(sets)
	s.mtime, s.size = st.ModTime(), st.Size()
}

func readIPBlockFile(name string) (*prefixSets, error) {
	f, err := os.Open(name)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return parseIPBlock(bufio.NewScanner(f))
}

func parseIPBlock(sc *bufio.Scanner) (*prefixSets, error) {
	out := &prefixSets{}
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if i := strings.IndexByte(line, '#'); i >= 0 {
			line = strings.TrimSpace(line[:i])
		}
		if line == "" {
			continue
		}
		allow := false
		if line[0] == '!' {
			allow = true
			line = strings.TrimSpace(line[1:])
		}
		p, ok := parseEntry(line)
		if !ok {
			continue
		}
		if out.entries >= maxIPBlockEntries {
			break
		}
		out.entries++
		if allow {
			out.allow.add(p)
		} else {
			out.block.add(p)
		}
	}
	return out, sc.Err()
}

func parseEntry(s string) (netip.Prefix, bool) {
	if strings.Contains(s, "/") {
		p, err := netip.ParsePrefix(s)
		if err != nil {
			return netip.Prefix{}, false
		}
		if p.Addr().Is4In6() {
			p = netip.PrefixFrom(p.Addr().Unmap(), p.Bits()-96)
			if !p.IsValid() {
				return netip.Prefix{}, false
			}
		}
		return p.Masked(), true
	}
	a, err := netip.ParseAddr(s)
	if err != nil {
		return netip.Prefix{}, false
	}
	a = a.Unmap().WithZone("")
	return netip.PrefixFrom(a, a.BitLen()), true
}

// blocked: the address is in the block set and in no exception.
func (s *prefixSets) blocked(a netip.Addr) bool {
	if s == nil || s.entries == 0 {
		return false
	}
	a = mapped(a.Unmap().WithZone(""))
	return s.block.has(a) && !s.allow.has(a)
}

func clientAddr(r *http.Request) (netip.Addr, bool) {
	raw := ""
	if v, ok := caddyhttp.GetVar(r.Context(), caddyhttp.ClientIPVarKey).(string); ok {
		raw = v
	}
	if raw == "" {
		host, _, err := net.SplitHostPort(r.RemoteAddr)
		if err != nil {
			host = r.RemoteAddr
		}
		raw = host
	}
	a, err := netip.ParseAddr(raw)
	if err != nil {
		return netip.Addr{}, false
	}
	return a, true
}

// MatchWithError reports whether the client IP of r is blocked.
func (m *IPBlock) MatchWithError(r *http.Request) (bool, error) {
	a, ok := clientAddr(r)
	if !ok {
		return false, nil
	}
	if m.st == nil {
		return false, nil
	}
	return m.st.set.Load().blocked(a), nil
}

// Match reports whether the client IP of r is blocked.
func (m *IPBlock) Match(r *http.Request) bool {
	ok, _ := m.MatchWithError(r)
	return ok
}

var (
	_ caddy.Provisioner                 = (*IPBlock)(nil)
	_ caddy.CleanerUpper                = (*IPBlock)(nil)
	_ caddyhttp.RequestMatcherWithError = (*IPBlock)(nil)
)
