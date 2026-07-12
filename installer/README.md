# Windows installer

Scout uses a per-user Inno Setup installer. It installs application files under
`%LOCALAPPDATA%\Programs\Scout`, needs no administrator rights, and launches the
bundled Node.js runtime through a Start-menu shortcut.

The private workspace is never part of the installer. By default it lives at
`Documents\Scout Workspace`; `SCOUT_WORKSPACE` can point somewhere else. Upgrade
and uninstall operations only replace or remove application files, so they leave
the workspace and its Git history untouched.

## Build an unsigned beta

Install Inno Setup 6, run `npm ci --omit=dev`, then:

```powershell
node tools/build-release.mjs --installer
```

Set `ISCC_PATH` if `ISCC.exe` is not in its usual installation directory. Use
`--version 0.1.0-beta.4` to override the package version. Outputs are written to
`installer/output/`, including `checksums.txt`. The beta is intentionally
unsigned until a code-signing certificate and secure signing pipeline exist.

Run `node tools/build-release.mjs --stage-only` to inspect the allowlisted bundle
without compiling an installer.
