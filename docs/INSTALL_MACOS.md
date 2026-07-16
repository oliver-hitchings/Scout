# Install Scout on macOS

Scout supports macOS 13 or newer on Apple Silicon and Intel Macs. Beta.5 is unsigned, local-first and requires your own authenticated Codex or Claude account.

Private Remote Access is optional. After normal setup, install [Tailscale](https://tailscale.com/download), sign in, and enable **Settings -> Private Remote Access**. Connect clients and install the home-screen app as described in [Private Remote Access](PRIVATE_REMOTE_ACCESS.md). The Mac must be awake and signed in.

1. Download the DMG matching your Mac (`arm64` for Apple Silicon or `x64` for Intel) and `checksums.txt` from [Scout releases](https://github.com/oliver-hitchings/Scout/releases).
2. Run `shasum -a 256 Scout-*-macos-*.dmg` and compare it with the published checksum.
3. Open the DMG and drag Scout to Applications.
4. On first launch, Control-click Scout and choose **Open**. If macOS still blocks it, use **System Settings → Privacy & Security → Open Anyway** after confirming the checksum. Do not disable Gatekeeper globally.
5. Complete provider setup, onboarding and the supervised first scan in the browser window Scout opens.

Scout stores private data in `~/Documents/Scout Workspace` unless `SCOUT_WORKSPACE` is set. Removing Scout from Applications does not delete that workspace. Disable its daily scan in Settings before uninstalling.

## Optional login startup

Scout does not install macOS login startup automatically in this release. For a source checkout, create `~/Library/LaunchAgents/dev.scout.host.plist` with absolute paths for your Node executable and Scout checkout:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>dev.scout.host</string>
  <key>ProgramArguments</key><array>
    <string>/absolute/path/to/node</string>
    <string>/absolute/path/to/Scout/ui/server.mjs</string>
  </array>
  <key>WorkingDirectory</key><string>/absolute/path/to/Scout</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>/tmp/scout-host.log</string>
  <key>StandardErrorPath</key><string>/tmp/scout-host-error.log</string>
</dict></plist>
```

Validate and start it with `plutil -lint ~/Library/LaunchAgents/dev.scout.host.plist` and `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.scout.host.plist`. Remove it with `launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/dev.scout.host.plist`. This starts only after that user signs in and stores no password. Packaged macOS supervision remains manual for this release.
