package host

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
)

// SetLaunchAtLogin writes only platform registration; scheduled scans remain CLI-owned.
func SetLaunchAtLogin(enabled bool, executable string) error {
	switch runtime.GOOS {
	case "windows":
		key := "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run"
		args := []string{"delete", key, "/v", "Scout", "/f"}
		if enabled {
			args = []string{"add", key, "/v", "Scout", "/t", "REG_SZ", "/d", fmt.Sprintf("\"%s\" --background", executable), "/f"}
		}
		return exec.Command("reg.exe", args...).Run()
	case "darwin":
		home, _ := os.UserHomeDir()
		dir := filepath.Join(home, "Library", "LaunchAgents")
		f := filepath.Join(dir, "app.scout.local.plist")
		if !enabled {
			return os.Remove(f)
		}
		os.MkdirAll(dir, 0700)
		return os.WriteFile(f, []byte(fmt.Sprintf("<?xml version=\"1.0\"?><plist version=\"1.0\"><dict><key>Label</key><string>app.scout.local</string><key>ProgramArguments</key><array><string>%s</string><string>--background</string></array><key>RunAtLoad</key><true/></dict></plist>", executable)), 0600)
	default:
		home, _ := os.UserHomeDir()
		dir := filepath.Join(home, ".config", "autostart")
		f := filepath.Join(dir, "scout.desktop")
		if !enabled {
			return os.Remove(f)
		}
		os.MkdirAll(dir, 0700)
		return os.WriteFile(f, []byte("[Desktop Entry]\nType=Application\nName=Scout\nExec="+executable+" --background\nX-GNOME-Autostart-enabled=true\n"), 0600)
	}
}
