package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"
)

// runUpdateHelper runs before Wails is initialised. The updater executable is
// copied outside the installed directory by UpdateManager, so replacing the
// installed host cannot lock the process that performs the handoff.
func runUpdateHelper(args []string) bool {
	if len(args) < 1 {
		return false
	}
	if args[0] == "--apply-portable-update" {
		applyPortableUpdate(args)
		return true
	}
	if args[0] == "--apply-macos-update" {
		applyMacUpdate(args)
		return true
	}
	if args[0] != "--apply-windows-update" {
		return false
	}
	if runtime.GOOS != "windows" || len(args) != 3 {
		return true
	}
	installer, relaunch := args[1], args[2]
	// The parent has already accepted the request and exits immediately after
	// this helper begins. Inno is deliberately started after that short handoff.
	time.Sleep(1200 * time.Millisecond)
	cmd := exec.Command(installer, "/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART")
	if err := cmd.Run(); err == nil {
		_ = exec.Command(relaunch).Start()
	}
	return true
}

func applyMacUpdate(args []string) {
	if runtime.GOOS != "darwin" || len(args) != 3 {
		return
	}
	time.Sleep(1200 * time.Millisecond)
	dmg, macosDir := args[1], filepath.Clean(args[2])
	bundle := filepath.Clean(filepath.Join(macosDir, "..", ".."))
	attached, err := exec.Command("hdiutil", "attach", "-nobrowse", "-readonly", dmg).CombinedOutput()
	if err != nil {
		return
	}
	var mount string
	for _, line := range strings.Split(string(attached), "\n") {
		if i := strings.Index(line, "/Volumes/"); i >= 0 {
			mount = strings.TrimSpace(line[i:])
		}
	}
	if mount == "" {
		return
	}
	defer exec.Command("hdiutil", "detach", mount).Run()
	source, replacement, backup := filepath.Join(mount, "Scout.app"), bundle+".new", bundle+".previous"
	_ = os.RemoveAll(replacement)
	_ = os.RemoveAll(backup)
	if exec.Command("ditto", source, replacement).Run() != nil {
		return
	}
	if err = os.Rename(bundle, backup); err != nil {
		// /Applications normally needs elevation; let macOS show its regular
		// authentication prompt instead of using unattended privilege escalation.
		command := fmt.Sprintf("rm -rf %s; ditto %s %s", shellQuote(bundle), shellQuote(source), shellQuote(bundle))
		if exec.Command("osascript", "-e", "do shell script "+strconv.Quote(command)+" with administrator privileges").Run() != nil {
			return
		}
	} else if err = os.Rename(replacement, bundle); err != nil {
		_ = os.Rename(backup, bundle)
		return
	}
	_ = exec.Command(filepath.Join(bundle, "Contents", "MacOS", "Scout")).Start()
}

func shellQuote(value string) string { return "'" + strings.ReplaceAll(value, "'", "'\\''") + "'" }

func applyPortableUpdate(args []string) {
	if runtime.GOOS == "windows" || len(args) != 3 {
		return
	}
	time.Sleep(1200 * time.Millisecond)
	archive, root := args[1], filepath.Clean(args[2])
	stage, err := os.MkdirTemp(filepath.Dir(root), ".scout-update-")
	if err != nil {
		return
	}
	defer os.RemoveAll(stage)
	if err = exec.Command("tar", "-xzf", archive, "-C", stage).Run(); err != nil {
		return
	}
	entries, err := os.ReadDir(stage)
	if err != nil || len(entries) != 1 || !entries[0].IsDir() {
		return
	}
	incoming := filepath.Join(stage, entries[0].Name())
	backup := root + ".previous"
	_ = os.RemoveAll(backup)
	if err = os.Rename(root, backup); err != nil {
		return
	}
	if err = os.Rename(incoming, root); err != nil {
		_ = os.Rename(backup, root)
		return
	}
	if err = exec.Command(filepath.Join(root, "Scout")).Start(); err != nil {
		_ = os.RemoveAll(root)
		_ = os.Rename(backup, root)
	}
}
