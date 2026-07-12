// Command icon-resource converts Scout's canonical favicon into the Windows
// resource object linked into the native host. It is invoked by go generate
// from cmd/scout-host and is not part of the installed application.
package main

import (
	"fmt"
	"os"

	"github.com/tc-hib/winres"
)

func main() {
	icon, err := os.Open("scout-icon.ico")
	if err != nil {
		panic(fmt.Errorf("open favicon: %w", err))
	}
	defer icon.Close()
	ico, err := winres.LoadICO(icon)
	if err != nil {
		panic(fmt.Errorf("read favicon: %w", err))
	}
	resources := winres.ResourceSet{}
	if err := resources.SetIcon(winres.RT_ICON, ico); err != nil {
		panic(fmt.Errorf("set icon resource: %w", err))
	}
	manifest, err := os.ReadFile("windows.manifest")
	if err != nil {
		panic(fmt.Errorf("read manifest: %w", err))
	}
	parsedManifest, err := winres.AppManifestFromXML(manifest)
	if err != nil {
		panic(fmt.Errorf("parse manifest: %w", err))
	}
	resources.SetManifest(parsedManifest)
	output, err := os.Create("rsrc_windows_amd64.syso")
	if err != nil {
		panic(fmt.Errorf("create resource: %w", err))
	}
	defer output.Close()
	if err := resources.WriteObject(output, winres.ArchAMD64); err != nil {
		panic(fmt.Errorf("write resource: %w", err))
	}
}
