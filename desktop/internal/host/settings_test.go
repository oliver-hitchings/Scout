package host

import (
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestSettingsAreOutsideWorkspace(t *testing.T) {
	p := SettingsPath("/home/me", func(string) string { return "" })
	if strings.Contains(p, "Scout Workspace") {
		t.Fatal("private workspace path")
	}
	if runtime.GOOS == "windows" && !strings.Contains(strings.ToLower(p), "appdata") {
		t.Fatal("windows app data")
	}
	if filepath.Base(p) != "host-settings.json" {
		t.Fatal("settings name")
	}
}
