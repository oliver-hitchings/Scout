# Install Scout on Linux

Scout supports Ubuntu 22.04+ and Debian 12+ on x64. Other x64 distributions can try the portable tarball. Scout requires your own authenticated Codex or Claude account.

1. Download the `.deb` or `.tar.gz` and `checksums.txt` from [Scout releases](https://github.com/oliver-hitchings/Scout/releases).
2. Run `sha256sum Scout-*-linux-x64.*` and compare it with the published checksum.
3. On Ubuntu/Debian, run `sudo apt install ./Scout-*-linux-x64.deb`, then open Scout from the application menu or run `scout-dashboard`.
4. For the portable build, extract it and run `./Scout-*-linux-x64/scout-dashboard`.
5. Complete provider setup, onboarding and the supervised first scan in the browser window Scout opens.

Private data defaults to `~/Documents/Scout Workspace`. `sudo apt remove scout` removes application files but preserves that workspace. Daily scans use the current user’s systemd service manager; systems without systemd user services retain supervised manual scans.
