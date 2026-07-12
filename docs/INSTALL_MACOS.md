# Install Scout on macOS

Scout supports macOS 13 or newer on Apple Silicon and Intel Macs. Beta.5 is unsigned, local-first and requires your own authenticated Codex or Claude account.

1. Download the DMG matching your Mac (`arm64` for Apple Silicon or `x64` for Intel) and `checksums.txt` from [Scout releases](https://github.com/oliver-hitchings/Scout/releases).
2. Run `shasum -a 256 Scout-*-macos-*.dmg` and compare it with the published checksum.
3. Open the DMG and drag Scout to Applications.
4. On first launch, Control-click Scout and choose **Open**. If macOS still blocks it, use **System Settings → Privacy & Security → Open Anyway** after confirming the checksum. Do not disable Gatekeeper globally.
5. Complete provider setup, onboarding and the supervised first scan in the browser window Scout opens.

Scout stores private data in `~/Documents/Scout Workspace` unless `SCOUT_WORKSPACE` is set. Removing Scout from Applications does not delete that workspace. Disable its daily scan in Settings before uninstalling.
