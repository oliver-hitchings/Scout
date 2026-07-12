# Install Scout on macOS

Scout supports macOS 13 or newer on Apple Silicon and Intel Macs. Beta.5 is unsigned, local-first and requires your own authenticated Codex or Claude account.

1. Download the DMG matching your Mac (`arm64` for Apple Silicon or `x64` for Intel) and `checksums.txt` from [Scout releases](https://github.com/oliver-hitchings/Scout/releases).
2. Run `shasum -a 256 Scout-*-macos-*.dmg` and compare it with the published checksum.
3. Open the DMG and drag Scout to Applications.
4. On first launch, Control-click Scout and choose **Open**. If macOS still blocks it, use **System Settings → Privacy & Security → Open Anyway** after confirming the checksum. Do not disable Gatekeeper globally.
5. Complete provider setup, onboarding and the supervised first scan in Scout's native window.

Scout.app contains the Wails v3 native host plus the bundled Node payload. It keeps
the Node service loopback-only and displays the unchanged dashboard in the native
WebView. Closing the window hides it to the menu bar where available; use the menu
to open, restart, check for updates, enter Settings, or quit. Launch-at-login runs
the app in the background through the user's normal macOS login mechanism.

Scout stores private data in `~/Documents/Scout Workspace` unless `SCOUT_WORKSPACE`
is set. Removing Scout from Applications does not delete that workspace. Scheduled
scans are independent CLI jobs; disable them in Settings before uninstalling.
