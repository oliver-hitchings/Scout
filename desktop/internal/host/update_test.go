package host

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestChannelInference(t *testing.T) {
	if InferChannel("1.0.0-beta.2", false) != Beta || InferChannel("1.0.0-beta.2", true) != Stable {
		t.Fatal("channel inference")
	}
}

func TestManagerChecksExpectedReleaseAsset(t *testing.T) {
	asset := AssetName("1.1.0")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/releases" {
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
		json.NewEncoder(w).Encode([]Release{{Tag: "v1.1.0", Assets: []ReleaseAsset{{Name: asset, URL: "https://example.test/" + asset}}}})
	}))
	defer server.Close()
	m := NewUpdateManager(t.TempDir(), "1.0.0")
	m.Client = server.Client()
	m.StateFile = filepath.Join(t.TempDir(), "update-state.json")
	// The manager normally uses the public ReleasesURL. A test transport keeps
	// the production endpoint fixed while proving release parsing and selection.
	m.Client.Transport = rewriteTransport{base: server.URL, next: server.Client().Transport}
	r := m.Check(context.Background(), true)
	if !r.Available || r.LatestVersion != "1.1.0" {
		t.Fatalf("unexpected result %#v", r)
	}
}

type rewriteTransport struct {
	base string
	next http.RoundTripper
}

func (t rewriteTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	copy := r.Clone(r.Context())
	copy.URL.Scheme = "http"
	copy.URL.Host = t.base[len("http://"):]
	copy.URL.Path = "/releases"
	if t.next == nil {
		t.next = http.DefaultTransport
	}
	return t.next.RoundTrip(copy)
}
func TestReleaseSelection(t *testing.T) {
	rs := []Release{{Tag: "v2", Prerelease: true}, {Tag: "v1"}}
	if SelectRelease(rs, Stable).Tag != "v1" || SelectRelease(rs, Beta).Tag != "v2" {
		t.Fatal("selection")
	}
}
func TestChecksum(t *testing.T) {
	p := filepath.Join(t.TempDir(), "a")
	os.WriteFile(p, []byte("a"), 0600)
	if VerifySHA256(p, "ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb") != nil {
		t.Fatal("valid checksum")
	}
	if VerifySHA256(p, "0") == nil {
		t.Fatal("invalid checksum accepted")
	}
}
func TestUpdaterCommands(t *testing.T) {
	cmd, args, _ := UpdateCommand("deb", "/tmp/a.deb", "")
	if cmd != "pkexec" || len(args) != 3 {
		t.Fatal("deb command")
	}
	if _, _, err := UpdateCommand("aur", "", ""); err == nil {
		t.Fatal("aur must not self update")
	}
}
func TestChecksumManifestRequiresExactAsset(t *testing.T) {
	got, e := ChecksumForAsset("abc  Scout-1-windows-x64.exe\ndef  other", "Scout-1-windows-x64.exe")
	if e != nil || got != "abc" {
		t.Fatal("exact asset")
	}
	if _, e = ChecksumForAsset("abc  x", "y"); e == nil {
		t.Fatal("missing accepted")
	}
}
