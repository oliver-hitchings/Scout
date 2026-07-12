package host

import (
	"bufio"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

type Channel string

const (
	Stable Channel = "stable"
	Beta   Channel = "beta"
)

func InferChannel(version string, optedOut bool) Channel {
	if strings.Contains(version, "-") && !optedOut {
		return Beta
	}
	return Stable
}

type Release struct {
	Tag        string         `json:"tag_name"`
	Prerelease bool           `json:"prerelease"`
	Draft      bool           `json:"draft"`
	Assets     []ReleaseAsset `json:"assets"`
}
type ReleaseAsset struct {
	Name string `json:"name"`
	URL  string `json:"browser_download_url"`
}

func SelectRelease(releases []Release, channel Channel) *Release {
	for i := range releases {
		r := &releases[i]
		if r.Draft || (channel == Stable && r.Prerelease) {
			continue
		}
		return r
	}
	return nil
}
func VerifySHA256(file, expected string) error {
	b, e := os.ReadFile(file)
	if e != nil {
		return e
	}
	got := sha256.Sum256(b)
	if !strings.EqualFold(hex.EncodeToString(got[:]), strings.TrimSpace(expected)) {
		return fmt.Errorf("sha256 mismatch for %s", filepath.Base(file))
	}
	return nil
}

// ChecksumForAsset accepts the release's single checksums.txt manifest and
// refuses ambiguous/missing names before any installer is executed.
func ChecksumForAsset(manifest, asset string) (string, error) {
	s := bufio.NewScanner(strings.NewReader(manifest))
	var found string
	for s.Scan() {
		fields := strings.Fields(s.Text())
		if len(fields) == 2 && fields[1] == asset {
			if found != "" {
				return "", fmt.Errorf("duplicate checksum for %s", asset)
			}
			found = fields[0]
		}
	}
	if found == "" {
		return "", fmt.Errorf("checksum missing for %s", asset)
	}
	return found, nil
}
func AssetName(version string) string {
	switch runtime.GOOS {
	case "windows":
		return "Scout-" + version + "-windows-x64.exe"
	case "darwin":
		if runtime.GOARCH == "arm64" {
			return "Scout-" + version + "-macos-arm64.dmg"
		}
		return "Scout-" + version + "-macos-x64.dmg"
	default:
		return "Scout-" + version + "-linux-x64.tar.gz"
	}
}
func UpdateCommand(installKind, installer, host string) (string, []string, error) {
	switch installKind {
	case "aur", "pacman":
		return "", nil, fmt.Errorf("pacman-owned install: run paru -Syu scout or yay -Syu scout")
	case "windows":
		return installer, []string{"/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART"}, nil
	case "deb":
		return "pkexec", []string{"dpkg", "-i", installer}, nil
	case "portable":
		return host, []string{"--apply-portable-update", installer}, nil
	case "mac":
		return host, []string{"--apply-macos-update", installer}, nil
	}
	return "", nil, fmt.Errorf("unsupported install kind")
}
func StartDetached(command string, args []string) error {
	return exec.Command(command, args...).Start()
}
