package host

import (
	"os"
	"path/filepath"
	"testing"
)

func TestChannelInference(t *testing.T) {
	if InferChannel("1.0.0-beta.2", false) != Beta || InferChannel("1.0.0-beta.2", true) != Stable {
		t.Fatal("channel inference")
	}
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
