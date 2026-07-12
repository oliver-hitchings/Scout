package main

//go:generate go run ../icon-resource

import (
	"context"
	_ "embed"
	"encoding/json"
	"github.com/oliver-hitchings/scout/desktop/internal/host"
	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"time"
)

// The existing Scout favicon is the single native application/tray icon source.
//
//go:embed scout-icon.ico
var scoutIcon []byte

var key = [32]byte{0x53, 0x63, 0x6f, 0x75, 0x74, 0x57, 0x61, 0x69, 0x6c, 0x73, 0x56, 0x33}

func main() {
	if runUpdateHelper(os.Args[1:]) {
		return
	}
	root, _ := filepath.Abs(filepath.Dir(os.Args[0]))
	if os.Getenv("SCOUT_ROOT") != "" {
		root = os.Getenv("SCOUT_ROOT")
	}
	sup := &host.Supervisor{Paths: host.InstalledPaths(root), Port: configuredPort()}
	version := installedVersion(root)
	updates := host.NewUpdateManager(root, version)
	control := newControl(sup, updates)
	sup.ControlURL = control.URL
	if err := sup.Start(context.Background()); err != nil {
		log.Fatal(err)
	}
	app := application.New(application.Options{Name: "Scout", Description: "Local-first opportunity finder", Icon: scoutIcon, Assets: application.AssetOptions{Handler: host.ProxyHandler(sup.Port)}, Mac: application.MacOptions{ApplicationShouldTerminateAfterLastWindowClosed: false}, SingleInstance: &application.SingleInstanceOptions{UniqueID: "app.scout.local", EncryptionKey: key, OnSecondInstanceLaunch: func(application.SecondInstanceData) {
		if mainWindow != nil {
			mainWindow.Restore()
			mainWindow.Show().Focus()
		}
	}}})
	mainWindow = app.Window.NewWithOptions(application.WebviewWindowOptions{Title: "Scout", Width: 1200, Height: 820, MinWidth: 900, MinHeight: 640, URL: "/", Hidden: hasArg("--background")})
	mainWindow.RegisterHook(events.Common.WindowClosing, func(e *application.WindowEvent) { mainWindow.Hide(); e.Cancel() })
	tray := app.SystemTray.New()
	menu := app.NewMenu()
	menu.Add("Open Scout").OnClick(func(*application.Context) { mainWindow.Show().Focus() })
	menu.Add("Restart Scout").OnClick(func(*application.Context) { sup.Stop(); go sup.Start(context.Background()) })
	menu.Add("Check for updates").OnClick(func(*application.Context) { control.Check(true) })
	// Settings lives in the existing dashboard; do not replace its URL or API.
	menu.Add("Settings").OnClick(func(*application.Context) { mainWindow.Show().Focus() })
	menu.AddSeparator()
	menu.Add("Quit Scout").OnClick(func(*application.Context) { showQuitSheet(mainWindow) })
	tray.SetTooltip("Scout")
	tray.SetIcon(scoutIcon)
	tray.SetMenu(menu)
	tray.OnClick(func() { mainWindow.Show().Focus() })
	control.onQuit = app.Quit
	// Checks are automatic and rate-limited by the host manager. Installation
	// remains a visible user choice in Settings/tray after checksum verification.
	go func() {
		control.Check(false)
		ticker := time.NewTicker(24 * time.Hour)
		defer ticker.Stop()
		for range ticker.C {
			control.Check(false)
		}
	}()
	app.OnShutdown(func() { sup.Stop(); control.Close() })
	if err := app.Run(); err != nil {
		log.Print(err)
	}
}

var mainWindow *application.WebviewWindow

func hasArg(want string) bool {
	for _, a := range os.Args[1:] {
		if a == want {
			return true
		}
	}
	return false
}

// SCOUT_PORT is intentionally an opt-in developer/smoke-test escape hatch.
// Installed desktop launches retain the stable loopback default (8459).
func configuredPort() int {
	port, err := strconv.Atoi(os.Getenv("SCOUT_PORT"))
	if err == nil && port > 0 && port < 65536 {
		return port
	}
	return 8459
}

type controlServer struct {
	URL     string
	server  *http.Server
	token   string
	onQuit  func()
	updates *host.UpdateManager
}

func newControl(s *host.Supervisor, updates *host.UpdateManager) *controlServer {
	token := host.RandomToken()
	s.Token = token
	mux := http.NewServeMux()
	c := &controlServer{token: token, updates: updates}
	mux.HandleFunc("/v1/updates/check", func(w http.ResponseWriter, r *http.Request) {
		if !c.authorised(r) {
			http.Error(w, "forbidden", 403)
			return
		}
		var request struct {
			Force bool `json:"force"`
		}
		_ = json.NewDecoder(r.Body).Decode(&request)
		result := c.Check(request.Force || r.URL.Query().Get("force") == "true")
		w.Header().Set("content-type", "application/json")
		json.NewEncoder(w).Encode(result)
	})
	mux.HandleFunc("/v1/updates/install", func(w http.ResponseWriter, r *http.Request) {
		if !c.authorised(r) {
			http.Error(w, "forbidden", 403)
			return
		}
		if err := c.updates.Apply(r.Context()); err != nil {
			http.Error(w, err.Error(), http.StatusConflict)
			return
		}
		w.Header().Set("content-type", "application/json")
		w.WriteHeader(http.StatusAccepted)
		w.Write([]byte(`{"accepted":true}`))
		if c.onQuit != nil {
			go func() { time.Sleep(100 * time.Millisecond); c.onQuit() }()
		}
	})
	mux.HandleFunc("/v1/window/quit", func(w http.ResponseWriter, r *http.Request) {
		if !c.authorised(r) {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		w.Header().Set("content-type", "application/json")
		w.WriteHeader(http.StatusAccepted)
		w.Write([]byte(`{"accepted":true}`))
		if c.onQuit != nil {
			go func() { time.Sleep(100 * time.Millisecond); c.onQuit() }()
		}
	})
	l, _ := net.Listen("tcp", "127.0.0.1:0")
	c.URL = "http://" + l.Addr().String()
	c.server = &http.Server{Handler: mux}
	go c.server.Serve(l)
	return c
}
func (c *controlServer) authorised(r *http.Request) bool {
	return r.Header.Get("X-Scout-Host-Token") == c.token
}
func (c *controlServer) Check(force bool) host.UpdateResult {
	return c.updates.Check(context.Background(), force)
}
func (c *controlServer) Close() {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	c.server.Shutdown(ctx)
}

func installedVersion(root string) string {
	b, err := os.ReadFile(filepath.Join(root, "app", "package.json"))
	if err != nil {
		return "0.0.0"
	}
	var pkg struct {
		Version string `json:"version"`
	}
	if json.Unmarshal(b, &pkg) != nil || pkg.Version == "" {
		return "0.0.0"
	}
	return pkg.Version
}

func showQuitSheet(window *application.WebviewWindow) {
	window.ExecJS(`(() => {
	  document.getElementById('scout-host-quit-sheet')?.remove();
	  const sheet = document.createElement('div'); sheet.id = 'scout-host-quit-sheet';
	  sheet.innerHTML = '<div role="dialog" aria-modal="true" aria-labelledby="scout-host-quit-title" style="width:min(440px,calc(100vw - 32px));background:#172033;color:#f8fafc;border:1px solid #475569;border-radius:16px;padding:24px;box-shadow:0 24px 64px #0008;font:16px system-ui,-apple-system,Segoe UI,sans-serif"><h2 id="scout-host-quit-title" style="margin:0 0 10px;font-size:24px">Quit Scout</h2><p style="margin:0 0 22px;color:#cbd5e1;line-height:1.5">Scheduled scans can continue after Scout closes.</p><p id="scout-host-quit-error" role="alert" style="display:none;color:#fecaca;margin:0 0 14px"></p><div style="display:grid;gap:10px"><button type="button" data-choice="keep">Yes, keep scheduled scans running</button><button type="button" data-choice="disable">Yes, turn off scheduled scans</button><button type="button" data-choice="cancel">No, cancel</button></div></div>';
	  // Attach to documentElement rather than a dashboard container: setup and
	  // onboarding create their own stacking contexts, but quit must always win.
	  Object.assign(sheet.style, {position:'fixed',inset:'0',display:'grid',placeItems:'center',background:'rgba(15,23,42,.72)',padding:'16px',isolation:'isolate',pointerEvents:'auto'});
	  sheet.style.setProperty('z-index', '2147483647', 'important');
	  sheet.style.setProperty('position', 'fixed', 'important');
	  sheet.querySelectorAll('button').forEach((button) => Object.assign(button.style, {padding:'11px 14px',borderRadius:'9px',border:'1px solid #64748b',background:'#263751',color:'#f8fafc',font:'inherit',textAlign:'left',cursor:'pointer'}));
	  document.documentElement.append(sheet);
	  const error = sheet.querySelector('#scout-host-quit-error');
	  const fail = (message) => { error.textContent = message; error.style.display = 'block'; };
	  const requestQuit = async (disableSchedule) => { const response = await fetch('/api/host/quit', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({disableSchedule})}); if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || 'Scout could not quit'); };
	  sheet.addEventListener('click', async (event) => { event.preventDefault(); event.stopPropagation(); const choice = event.target?.dataset?.choice; if (!choice) return; if (choice === 'cancel') { sheet.remove(); return; } try { await requestQuit(choice === 'disable'); } catch (err) { fail(err.message || 'Something went wrong'); } });
	})()`)
}
