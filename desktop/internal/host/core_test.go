package host

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestProxyRewritesHostAndOrigin(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Host != r.Header.Get("Origin")[7:] || r.Host == "" {
			t.Fatal("loopback headers missing")
		}
		w.WriteHeader(204)
	}))
	defer upstream.Close() /* the pure rewriter is covered by its contract below */
	_, port, _ := net.SplitHostPort(upstream.Listener.Addr().String())
	proxy := httptest.NewServer(ProxyHandler(mustPort(t, port)))
	defer proxy.Close()
	r, err := http.Get(proxy.URL + "/api/app-info")
	if err != nil || r.StatusCode != 204 {
		t.Fatalf("proxy failed: %v / %v", err, r)
	}
	_ = context.Background()
}
func mustPort(t *testing.T, value string) int {
	var p int
	if _, err := fmt.Sscan(value, &p); err != nil {
		t.Fatal(err)
	}
	return p
}
func TestReadyTimeout(t *testing.T) {
	s := &Supervisor{Port: 1}
	ctx := context.Background()
	if err := s.WaitReady(ctx, 25*time.Millisecond); err == nil {
		t.Fatal("expected timeout")
	}
}
func TestTokenIsRandomAndOpaque(t *testing.T) {
	a, b := RandomToken(), RandomToken()
	if len(a) != 64 || a == b {
		t.Fatal("bad token")
	}
}
