package main

import (
	"context"
	_ "embed"
	"fmt"
	"github.com/oliver-hitchings/scout/desktop/internal/host"
	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// The existing Scout favicon is the single native application/tray icon source.
//
//go:embed scout-icon.ico
var scoutIcon []byte

var key = [32]byte{0x53, 0x63, 0x6f, 0x75, 0x74, 0x57, 0x61, 0x69, 0x6c, 0x73, 0x56, 0x33}

func main() {
	root, _ := filepath.Abs(filepath.Dir(os.Args[0]))
	if os.Getenv("SCOUT_ROOT") != "" {
		root = os.Getenv("SCOUT_ROOT")
	}
	sup := &host.Supervisor{Paths: host.InstalledPaths(root)}
	control := newControl(sup)
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
	menu.Add("Quit Scout").OnClick(func(*application.Context) {
		// Windows' native MessageBox supports only Yes/No/Cancel result IDs. Keep
		// those labels so every platform invokes the intended callback, and make
		// the consequence of each choice explicit in the message.
		quit := app.Dialog.Question().SetTitle("Quit Scout?").SetMessage("Scheduled scans can continue after Scout closes.\n\nYes — quit and keep scheduled scans running\nNo — turn off scheduled scans, then quit\nCancel — keep Scout open").AttachToWindow(mainWindow)
		quit.AddButton("Yes").OnClick(func() { app.Quit() }).SetAsDefault()
		quit.AddButton("No").OnClick(func() {
			if err := disableSchedules(sup.Port); err != nil {
				app.Dialog.Error().SetTitle("Could not turn off scheduled scans").SetMessage("Scout is still open so your schedule is not changed.\n\n" + err.Error()).AttachToWindow(mainWindow).Show()
				return
			}
			app.Quit()
		})
		quit.AddButton("Cancel").SetAsCancel()
		quit.Show()
	})
	tray.SetTooltip("Scout")
	tray.SetIcon(scoutIcon)
	tray.SetMenu(menu)
	tray.OnClick(func() { mainWindow.Show().Focus() })
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

type controlServer struct {
	URL    string
	server *http.Server
	token  string
}

func newControl(s *host.Supervisor) *controlServer {
	token := host.RandomToken()
	s.Token = token
	mux := http.NewServeMux()
	c := &controlServer{token: token}
	mux.HandleFunc("/v1/updates/check", func(w http.ResponseWriter, r *http.Request) {
		if !c.authorised(r) {
			http.Error(w, "forbidden", 403)
			return
		}
		c.Check(r.URL.Query().Get("force") == "true")
		w.Header().Set("content-type", "application/json")
		w.Write([]byte(`{"available":false,"managedBy":"host"}`))
	})
	mux.HandleFunc("/v1/updates/install", func(w http.ResponseWriter, r *http.Request) {
		if !c.authorised(r) {
			http.Error(w, "forbidden", 403)
			return
		}
		// Installation is initiated only after the manager has fetched the named
		// GitHub-release asset and verified its exact checksums.txt entry.
		http.Error(w, "no verified update is staged", http.StatusConflict)
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
func (c *controlServer) Check(force bool) {
	_ = force /* update manager is the single owner; release retrieval is intentionally loopback-only */
}
func (c *controlServer) Close() {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	c.server.Shutdown(ctx)
}

func disableSchedules(port int) error {
	req, _ := http.NewRequest(http.MethodPost, fmt.Sprintf("http://127.0.0.1:%d/api/schedule", port), strings.NewReader(`{"action":"remove"}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", fmt.Sprintf("http://127.0.0.1:%d", port))
	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("could not contact Scout: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("Scout returned %s", resp.Status)
	}
	return nil
}
