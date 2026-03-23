package mirror

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/caddyserver/caddy/v2/modules/caddyhttp"
	"go.uber.org/zap"
)

func TestMirrorForwardsToTargets(t *testing.T) {
	var received atomic.Int32
	mirrorSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		received.Add(1)
		body, _ := io.ReadAll(r.Body)
		if string(body) != "hello" {
			t.Errorf("expected body 'hello', got '%s'", body)
		}
		w.WriteHeader(200)
	}))
	defer mirrorSrv.Close()

	addr := strings.TrimPrefix(mirrorSrv.URL, "http://")
	m := &Mirror{
		Targets:      []MirrorTarget{{Dial: addr}},
		MaxBodyBytes: 10 << 20,
		logger:       zap.NewNop(),
		client:       &http.Client{Timeout: 5 * time.Second},
	}

	req := httptest.NewRequest("POST", "/test", strings.NewReader("hello"))
	req.Header.Set("Content-Type", "text/plain")
	w := httptest.NewRecorder()

	next := caddyhttp.HandlerFunc(func(w http.ResponseWriter, r *http.Request) error {
		w.WriteHeader(200)
		return nil
	})

	err := m.ServeHTTP(w, req, next)
	if err != nil {
		t.Fatal(err)
	}
	if w.Code != 200 {
		t.Errorf("expected 200, got %d", w.Code)
	}

	time.Sleep(100 * time.Millisecond)
	if received.Load() != 1 {
		t.Errorf("expected 1 mirror request, got %d", received.Load())
	}
}

func TestMirrorSkipsWebSocket(t *testing.T) {
	var received atomic.Int32
	mirrorSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		received.Add(1)
		w.WriteHeader(200)
	}))
	defer mirrorSrv.Close()

	addr := strings.TrimPrefix(mirrorSrv.URL, "http://")
	m := &Mirror{
		Targets:      []MirrorTarget{{Dial: addr}},
		MaxBodyBytes: 10 << 20,
		logger:       zap.NewNop(),
		client:       &http.Client{Timeout: 5 * time.Second},
	}

	req := httptest.NewRequest("GET", "/ws", nil)
	req.Header.Set("Connection", "Upgrade")
	req.Header.Set("Upgrade", "websocket")
	w := httptest.NewRecorder()

	next := caddyhttp.HandlerFunc(func(w http.ResponseWriter, r *http.Request) error {
		w.WriteHeader(200)
		return nil
	})

	m.ServeHTTP(w, req, next)
	time.Sleep(100 * time.Millisecond)
	if received.Load() != 0 {
		t.Errorf("expected 0 mirror requests for WebSocket, got %d", received.Load())
	}
}
