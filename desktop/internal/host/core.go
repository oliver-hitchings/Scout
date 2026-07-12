package host

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"time"
)

const LoopbackHost = "127.0.0.1"

type Paths struct{ Root, Node, Server string }

func InstalledPaths(root string) Paths {
	name := "node"
	if os.PathSeparator == '\\' {
		name = "ScoutRuntime.exe"
	}
	return Paths{Root: root, Node: filepath.Join(root, "runtime", name), Server: filepath.Join(root, "app", "ui", "server.mjs")}
}

type Supervisor struct {
	Paths             Paths
	Port              int
	Token, ControlURL string
	Cmd               *exec.Cmd
}

func (s *Supervisor) Start(ctx context.Context) error {
	if s.Port == 0 {
		s.Port = 8459
	}
	if s.Token == "" {
		s.Token = RandomToken()
	}
	s.Cmd = exec.CommandContext(ctx, s.Paths.Node, s.Paths.Server)
	s.Cmd.Dir = filepath.Join(s.Paths.Root, "app")
	s.Cmd.Env = append(os.Environ(), fmt.Sprintf("PORT=%d", s.Port), "SCOUT_HOST_CONTROL_URL="+s.ControlURL, "SCOUT_HOST_CONTROL_TOKEN="+s.Token)
	if err := s.Cmd.Start(); err != nil {
		return err
	}
	return s.WaitReady(ctx, 15*time.Second)
}
func (s *Supervisor) WaitReady(ctx context.Context, timeout time.Duration) error {
	deadline := time.NewTimer(timeout)
	defer deadline.Stop()
	tick := time.NewTicker(150 * time.Millisecond)
	defer tick.Stop()
	client := &http.Client{Timeout: 900 * time.Millisecond}
	endpoint := fmt.Sprintf("http://127.0.0.1:%d/api/app-info", s.Port)
	expectedAppRoot := filepath.Clean(filepath.Join(s.Paths.Root, "app"))
	for {
		req, _ := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
		r, err := client.Do(req)
		if err == nil {
			var info struct {
				AppRoot string `json:"appRoot"`
			}
			decodeErr := json.NewDecoder(r.Body).Decode(&info)
			r.Body.Close()
			if r.StatusCode == 200 && decodeErr == nil {
				actual, _ := filepath.Abs(info.AppRoot)
				expected, _ := filepath.Abs(expectedAppRoot)
				if filepath.Clean(actual) == filepath.Clean(expected) {
					return nil
				}
				return fmt.Errorf("another Scout installation is already serving port %d (%s)", s.Port, actual)
			}
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-deadline.C:
			return errors.New("Scout Node service did not become ready")
		case <-tick.C:
		}
	}
}
func (s *Supervisor) Stop() {
	if s.Cmd != nil && s.Cmd.Process != nil {
		_ = s.Cmd.Process.Kill()
		_ = s.Cmd.Wait()
	}
}
func RandomToken() string {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}

// ProxyHandler is used as Wails' asset handler. It preserves relative UI URLs
// while making requests look like genuine Node loopback requests.
func ProxyHandler(port int) http.Handler {
	target, _ := url.Parse(fmt.Sprintf("http://127.0.0.1:%d", port))
	p := httputil.NewSingleHostReverseProxy(target)
	original := p.Director
	p.Director = func(r *http.Request) {
		original(r)
		r.Host = target.Host
		r.Header.Set("Host", target.Host)
		r.Header.Set("Origin", target.String())
	}
	return p
}
