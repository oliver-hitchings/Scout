package host

import (
	"os"
	"path/filepath"
	"runtime"
)

func SettingsPath(home string, getenv func(string) string) string {
	if runtime.GOOS == "windows" {
		base := getenv("LOCALAPPDATA")
		if base == "" {
			base = filepath.Join(home, "AppData", "Local")
		}
		return filepath.Join(base, "Scout", "host-settings.json")
	}
	if runtime.GOOS == "darwin" {
		return filepath.Join(home, "Library", "Application Support", "Scout", "host-settings.json")
	}
	base := getenv("XDG_CONFIG_HOME")
	if base == "" {
		base = filepath.Join(home, ".config")
	}
	return filepath.Join(base, "scout", "host-settings.json")
}
func DefaultSettingsPath() string { home, _ := os.UserHomeDir(); return SettingsPath(home, os.Getenv) }
