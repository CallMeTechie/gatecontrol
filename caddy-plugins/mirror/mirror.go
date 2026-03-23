package mirror

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/caddyserver/caddy/v2"
	"github.com/caddyserver/caddy/v2/modules/caddyhttp"
	"go.uber.org/zap"
)

func init() {
	caddy.RegisterModule(Mirror{})
}

var bufPool = sync.Pool{
	New: func() any { return new(bytes.Buffer) },
}

var mirrorSem = make(chan struct{}, 100)

type Mirror struct {
	Targets      []MirrorTarget `json:"targets,omitempty"`
	MaxBodyBytes int64          `json:"max_body_bytes,omitempty"`
	logger       *zap.Logger
	client       *http.Client
}

type MirrorTarget struct {
	Dial string `json:"dial,omitempty"`
}

func (Mirror) CaddyModule() caddy.ModuleInfo {
	return caddy.ModuleInfo{
		ID:  "http.handlers.mirror",
		New: func() caddy.Module { return new(Mirror) },
	}
}

func (m *Mirror) Provision(ctx caddy.Context) error {
	m.logger = ctx.Logger()
	if m.MaxBodyBytes <= 0 {
		m.MaxBodyBytes = 10 << 20
	}
	m.client = &http.Client{Timeout: 10 * time.Second}
	return nil
}

func (m *Mirror) Validate() error {
	return nil
}

func (m Mirror) ServeHTTP(w http.ResponseWriter, r *http.Request, next caddyhttp.Handler) error {
	if strings.Contains(strings.ToLower(r.Header.Get("Connection")), "upgrade") {
		return next.ServeHTTP(w, r)
	}

	var bodyBytes []byte
	if r.Body != nil && r.ContentLength != 0 {
		buf := bufPool.Get().(*bytes.Buffer)
		buf.Reset()
		_, err := io.Copy(buf, io.LimitReader(r.Body, m.MaxBodyBytes+1))

		// Always copy bytes out of pool buffer before returning it
		raw := make([]byte, buf.Len())
		copy(raw, buf.Bytes())
		bufPool.Put(buf) // safe: no more references to buf

		if err != nil {
			m.logger.Warn("failed to read request body for mirroring", zap.Error(err))
			r.Body = io.NopCloser(bytes.NewReader(raw))
			m.fireTargets(r, nil)
			return next.ServeHTTP(w, r)
		}
		if int64(len(raw)) > m.MaxBodyBytes {
			m.logger.Info("request body exceeds mirror max size, mirroring without body",
				zap.Int64("size", int64(len(raw))),
				zap.Int64("max", m.MaxBodyBytes))
			r.Body = io.NopCloser(bytes.NewReader(raw))
			m.fireTargets(r, nil)
			return next.ServeHTTP(w, r)
		}
		bodyBytes = raw
		r.Body = io.NopCloser(bytes.NewReader(bodyBytes))
	}

	m.fireTargets(r, bodyBytes)
	return next.ServeHTTP(w, r)
}

func (m *Mirror) fireTargets(r *http.Request, body []byte) {
	for _, t := range m.Targets {
		target := t
		go func() {
			select {
			case mirrorSem <- struct{}{}:
				defer func() { <-mirrorSem }()
			default:
				m.logger.Warn("mirror: concurrency limit reached, dropping request", zap.String("target", target.Dial))
				return
			}

			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()

			url := "http://" + target.Dial + r.RequestURI

			var bodyReader io.Reader
			if body != nil {
				bodyReader = bytes.NewReader(body)
			}

			req, err := http.NewRequestWithContext(ctx, r.Method, url, bodyReader)
			if err != nil {
				m.logger.Warn("mirror: failed to create request", zap.String("target", target.Dial), zap.Error(err))
				return
			}
			for k, vv := range r.Header {
				for _, v := range vv {
					req.Header.Add(k, v)
				}
			}
			req.Host = r.Host

			resp, err := m.client.Do(req)
			if err != nil {
				m.logger.Warn("mirror: request failed", zap.String("target", target.Dial), zap.Error(err))
				return
			}
			io.Copy(io.Discard, resp.Body)
			resp.Body.Close()
		}()
	}
}

var (
	_ caddy.Module                = (*Mirror)(nil)
	_ caddy.Provisioner           = (*Mirror)(nil)
	_ caddy.Validator             = (*Mirror)(nil)
	_ caddyhttp.MiddlewareHandler = (*Mirror)(nil)
)
