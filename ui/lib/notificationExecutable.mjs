import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const WINDOWS_COMMAND_SECURITY = String.raw`
$ErrorActionPreference = 'Stop'
try {
  $selected = $env:SCOUT_OUTBOUND_EXECUTABLE
  $current = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $trusted = @($current, 'S-1-5-18', 'S-1-5-32-544', 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
  $write = [System.Security.AccessControl.FileSystemRights]::Write -bor [System.Security.AccessControl.FileSystemRights]::Delete -bor [System.Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor [System.Security.AccessControl.FileSystemRights]::ChangePermissions -bor [System.Security.AccessControl.FileSystemRights]::TakeOwnership
  $replace = [System.Security.AccessControl.FileSystemRights]::Delete -bor [System.Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor [System.Security.AccessControl.FileSystemRights]::ChangePermissions -bor [System.Security.AccessControl.FileSystemRights]::TakeOwnership
  $entry = Get-Item -LiteralPath $selected -Force
  $immediate = $true
  while ($null -ne $entry) {
    if (($entry.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'unsafe' }
    $acl = Get-Acl -LiteralPath $entry.FullName
    $owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
    if ($trusted -notcontains $owner) { throw 'unsafe' }
    $mask = if ($immediate -or $entry.FullName -eq [System.IO.Path]::GetDirectoryName($selected)) { $write } else { $replace }
    foreach ($rule in $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
      if ($rule.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow -and
          ($rule.PropagationFlags -band [System.Security.AccessControl.PropagationFlags]::InheritOnly) -eq 0 -and
          $trusted -notcontains $rule.IdentityReference.Value -and ($rule.FileSystemRights -band $mask) -ne 0) { throw 'unsafe' }
    }
    $immediate = $false
    $entry = if ($entry -is [System.IO.FileInfo]) { $entry.Directory } else { $entry.Parent }
  }
  [Console]::Write('{"ok":true}')
} catch { [Console]::Write('{"ok":false}'); exit 1 }
`;

export function inspectWindowsNotificationExecutable(command, { spawn = spawnSync } = {}) {
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot || !path.isAbsolute(systemRoot)) return false;
  try {
    const result = spawn(path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(WINDOWS_COMMAND_SECURITY, 'utf16le').toString('base64')], {
        windowsHide: true, shell: false, encoding: 'utf8', timeout: 5000, maxBuffer: 4096,
        env: { SystemRoot: systemRoot, WINDIR: systemRoot, SCOUT_OUTBOUND_EXECUTABLE: command },
      });
    return result.status === 0 && !result.error && result.stdout.trim() === '{"ok":true}';
  } catch { return false; }
}

export function validateNotificationExecutable(value, {
  platform = process.platform, inspectWindows = inspectWindowsNotificationExecutable,
} = {}) {
  let command;
  try {
    command = fs.realpathSync(value);
    const stat = fs.statSync(command);
    if (!stat.isFile()) throw new Error();
    if (platform === 'win32') {
      if (!inspectWindows(command)) throw new Error();
      return command;
    }
    const trustedOwner = (uid) => uid === 0 || uid === process.getuid();
    if (!trustedOwner(stat.uid) || (stat.mode & 0o022) || !(stat.mode & 0o111)) throw new Error();
    let child = stat;
    let parent = path.dirname(command);
    while (true) {
      const directory = fs.lstatSync(parent);
      if (!directory.isDirectory() || directory.isSymbolicLink() || !trustedOwner(directory.uid)) throw new Error();
      if ((directory.mode & 0o022) && !((directory.mode & 0o1000) && trustedOwner(child.uid))) throw new Error();
      const next = path.dirname(parent);
      if (next === parent) break;
      child = directory; parent = next;
    }
    return command;
  } catch { throw new Error('notification command requires a protected executable and protected parent directories'); }
}
