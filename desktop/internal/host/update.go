package host

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"time"
)

const ReleasesURL = "https://api.github.com/repos/oliver-hitchings/Scout/releases?per_page=30"

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
		if !r.Draft && !(channel == Stable && r.Prerelease) {
			return r
		}
	}
	return nil
}

var versionRE = regexp.MustCompile(`^v?(\d+)\.(\d+)\.(\d+)(?:-beta\.(\d+))?$`)

func CompareVersions(a, b string) int {
	aa, bb := versionRE.FindStringSubmatch(a), versionRE.FindStringSubmatch(b)
	if aa == nil || bb == nil {
		return strings.Compare(a, b)
	}
	for i := 1; i <= 3; i++ {
		if aa[i] != bb[i] {
			var x, y int
			fmt.Sscan(aa[i], &x)
			fmt.Sscan(bb[i], &y)
			if x > y {
				return 1
			}
			return -1
		}
	}
	if aa[4] == bb[4] {
		return 0
	}
	if aa[4] == "" {
		return 1
	}
	if bb[4] == "" {
		return -1
	}
	var x, y int
	fmt.Sscan(aa[4], &x)
	fmt.Sscan(bb[4], &y)
	if x > y {
		return 1
	}
	return -1
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
func ChecksumForAsset(manifest, asset string) (string, error) {
	s := bufio.NewScanner(strings.NewReader(manifest))
	var found string
	for s.Scan() {
		f := strings.Fields(s.Text())
		if len(f) == 2 && f[1] == asset {
			if found != "" {
				return "", fmt.Errorf("duplicate checksum for %s", asset)
			}
			found = f[0]
		}
	}
	if found == "" {
		return "", fmt.Errorf("checksum missing for %s", asset)
	}
	return found, s.Err()
}

func AssetName(version string) string {
	return AssetNameFor(version, runtime.GOOS, runtime.GOARCH, "portable")
}
func AssetNameFor(version, goos, arch, installKind string) string {
	switch goos {
	case "windows":
		return "Scout-" + version + "-windows-x64.exe"
	case "darwin":
		if arch == "arm64" {
			return "Scout-" + version + "-macos-arm64.dmg"
		}
		return "Scout-" + version + "-macos-x64.dmg"
	default:
		if installKind == "deb" {
			return "Scout-" + version + "-linux-x64.deb"
		}
		return "Scout-" + version + "-linux-x64.tar.gz"
	}
}
func UpdateCommand(installKind, installer, host string) (string, []string, error) {
	switch installKind {
	case "aur", "pacman":
		return "", nil, fmt.Errorf("pacman-owned install: run paru -Syu scout or yay -Syu scout")
	case "windows":
		return host, []string{"--apply-windows-update", installer}, nil
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
	c := exec.Command(command, args...)
	c.Stdout = nil
	c.Stderr = nil
	c.Stdin = nil
	return c.Start()
}

type UpdateResult struct {
	Available      bool    `json:"available"`
	CurrentVersion string  `json:"currentVersion"`
	LatestVersion  string  `json:"latestVersion"`
	Channel        Channel `json:"channel"`
	ManagedBy      string  `json:"managedBy"`
	Guidance       string  `json:"guidance,omitempty"`
	Error          string  `json:"error,omitempty"`
}
type updateState struct {
	LastCheckedAt time.Time    `json:"lastCheckedAt"`
	Result        UpdateResult `json:"result"`
	AssetURL      string       `json:"assetURL,omitempty"`
}
type UpdateManager struct {
	Root, HostPath, CurrentVersion, InstallKind string
	Channel                                     Channel
	Client                                      *http.Client
	StateFile                                   string
	mu                                          sync.Mutex
	state                                       updateState
}

func NewUpdateManager(root, version string) *UpdateManager {
	kind := DetectInstallKind(root)
	cfg, _ := os.UserConfigDir()
	if cfg == "" {
		cfg = os.TempDir()
	}
	m := &UpdateManager{Root: root, HostPath: filepath.Join(root, hostExecutableName()), CurrentVersion: version, InstallKind: kind, Channel: InferChannel(version, false), Client: &http.Client{Timeout: 20 * time.Second}, StateFile: filepath.Join(cfg, "Scout", "update-state.json")}
	m.load()
	return m
}
func hostExecutableName() string {
	if runtime.GOOS == "windows" {
		return "Scout.exe"
	}
	return "Scout"
}
func DetectInstallKind(root string) string {
	if runtime.GOOS == "windows" {
		return "windows"
	}
	if runtime.GOOS == "darwin" {
		return "mac"
	}
	clean := filepath.Clean(root)
	if strings.HasPrefix(clean, "/opt/scout") {
		return "deb"
	}
	return "portable"
}
func (m *UpdateManager) load() {
	b, e := os.ReadFile(m.StateFile)
	if e == nil {
		_ = json.Unmarshal(b, &m.state)
	}
}
func (m *UpdateManager) save() {
	_ = os.MkdirAll(filepath.Dir(m.StateFile), 0700)
	b, _ := json.MarshalIndent(m.state, "", "  ")
	_ = os.WriteFile(m.StateFile, b, 0600)
}
func (m *UpdateManager) result() UpdateResult {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.state.Result
}
func (m *UpdateManager) Check(ctx context.Context, force bool) UpdateResult {
	m.mu.Lock()
	if !force && !m.state.LastCheckedAt.IsZero() && time.Since(m.state.LastCheckedAt) < 24*time.Hour {
		r := m.state.Result
		m.mu.Unlock()
		return r
	}
	m.mu.Unlock()
	r := UpdateResult{CurrentVersion: m.CurrentVersion, LatestVersion: m.CurrentVersion, Channel: m.Channel, ManagedBy: "host"}
	if m.InstallKind == "aur" || m.InstallKind == "pacman" {
		r.Guidance = "Run paru -Syu scout or yay -Syu scout"
		m.record(r, "")
		return r
	}
	req, e := http.NewRequestWithContext(ctx, http.MethodGet, ReleasesURL, nil)
	if e != nil {
		r.Error = e.Error()
		m.record(r, "")
		return r
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "Scout/"+m.CurrentVersion)
	resp, e := m.Client.Do(req)
	if e != nil {
		r.Error = e.Error()
		m.record(r, "")
		return r
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		r.Error = fmt.Sprintf("GitHub update check failed (%s)", resp.Status)
		m.record(r, "")
		return r
	}
	var releases []Release
	if e = json.NewDecoder(resp.Body).Decode(&releases); e != nil {
		r.Error = e.Error()
		m.record(r, "")
		return r
	}
	selected := SelectRelease(releases, m.Channel)
	if selected == nil {
		m.record(r, "")
		return r
	}
	latest := strings.TrimPrefix(selected.Tag, "v")
	r.LatestVersion = latest
	if CompareVersions(latest, m.CurrentVersion) <= 0 {
		m.record(r, "")
		return r
	}
	asset := AssetNameFor(latest, runtime.GOOS, runtime.GOARCH, m.InstallKind)
	for _, a := range selected.Assets {
		if a.Name == asset {
			r.Available = true
			m.record(r, a.URL)
			return r
		}
	}
	r.Error = "release is missing expected asset " + asset
	m.record(r, "")
	return r
}
func (m *UpdateManager) record(r UpdateResult, url string) {
	m.mu.Lock()
	m.state = updateState{LastCheckedAt: time.Now().UTC(), Result: r, AssetURL: url}
	m.save()
	m.mu.Unlock()
}
func (m *UpdateManager) Apply(ctx context.Context) error {
	m.mu.Lock()
	s := m.state
	m.mu.Unlock()
	if !s.Result.Available || s.AssetURL == "" {
		return fmt.Errorf("no verified update is available")
	}
	if m.InstallKind == "aur" || m.InstallKind == "pacman" {
		return fmt.Errorf("%s", s.Result.Guidance)
	}
	version := s.Result.LatestVersion
	asset := AssetNameFor(version, runtime.GOOS, runtime.GOARCH, m.InstallKind)
	dir := filepath.Join(filepath.Dir(m.StateFile), "updates", version)
	if e := os.MkdirAll(dir, 0700); e != nil {
		return e
	}
	installer := filepath.Join(dir, asset)
	manifest, e := m.download(ctx, findChecksumURL(s.AssetURL), filepath.Join(dir, "checksums.txt"))
	if e != nil {
		return e
	}
	expected, e := ChecksumForAsset(string(manifest), asset)
	if e != nil {
		return e
	}
	if _, e = os.Stat(installer); e != nil {
		if _, e = m.download(ctx, s.AssetURL, installer); e != nil {
			return e
		}
	}
	if e = VerifySHA256(installer, expected); e != nil {
		_ = os.Remove(installer)
		return e
	}
	cmd, args, e := UpdateCommand(m.InstallKind, installer, m.HostPath)
	if e != nil {
		return e
	}
	if m.InstallKind == "windows" {
		// Do not run the installer from the installed host: Inno needs that file
		// released. This short-lived copy survives the parent process exiting.
		helper := filepath.Join(dir, "ScoutUpdater.exe")
		if e := copyFile(m.HostPath, helper); e != nil {
			return e
		}
		cmd = helper
		args = []string{"--apply-windows-update", installer, m.HostPath}
	}
	if m.InstallKind == "portable" {
		helper := filepath.Join(dir, "ScoutUpdater")
		if e := copyFile(m.HostPath, helper); e != nil {
			return e
		}
		if e := os.Chmod(helper, 0700); e != nil {
			return e
		}
		cmd, args = helper, []string{"--apply-portable-update", installer, m.Root}
	}
	if m.InstallKind == "mac" {
		helper := filepath.Join(dir, "ScoutUpdater")
		if e := copyFile(m.HostPath, helper); e != nil {
			return e
		}
		if e := os.Chmod(helper, 0700); e != nil {
			return e
		}
		cmd, args = helper, []string{"--apply-macos-update", installer, m.Root}
	}
	return StartDetached(cmd, args)
}
func findChecksumURL(assetURL string) string {
	return assetURL[:strings.LastIndex(assetURL, "/")+1] + "checksums.txt"
}
func (m *UpdateManager) download(ctx context.Context, url, target string) ([]byte, error) {
	req, e := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if e != nil {
		return nil, e
	}
	req.Header.Set("User-Agent", "Scout updater")
	r, e := m.Client.Do(req)
	if e != nil {
		return nil, e
	}
	defer r.Body.Close()
	if r.StatusCode != 200 {
		return nil, fmt.Errorf("download failed (%s)", r.Status)
	}
	b, e := io.ReadAll(io.LimitReader(r.Body, 2<<30))
	if e != nil {
		return nil, e
	}
	if e = os.WriteFile(target, b, 0600); e != nil {
		return nil, e
	}
	return b, nil
}
func copyFile(source, target string) error {
	in, e := os.Open(source)
	if e != nil {
		return e
	}
	defer in.Close()
	out, e := os.Create(target)
	if e != nil {
		return e
	}
	_, e = io.Copy(out, in)
	closeErr := out.Close()
	if e != nil {
		return e
	}
	return closeErr
}
