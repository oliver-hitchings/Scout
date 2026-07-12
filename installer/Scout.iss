#ifndef MyAppVersion
  #define MyAppVersion "0.1.0-beta.5"
#endif

#ifndef StageDir
  #define StageDir "..\dist\release\stage"
#endif

#define MyAppName "Scout"
#define MyAppPublisher "Scout contributors"
#define MyAppExeName "ScoutLauncher.ps1"

[Setup]
AppId={{1A8566F8-806A-4E97-9B74-E0941139DB0C}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppVerName={#MyAppName} {#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={localappdata}\Programs\Scout
DefaultGroupName=Scout
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=output
OutputBaseFilename=Scout-{#MyAppVersion}-windows-x64
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
UninstallDisplayName=Scout
LicenseFile={#StageDir}\app\LICENSE
ChangesEnvironment=no

[Files]
Source: "{#StageDir}\app\*"; DestDir: "{app}\app"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#StageDir}\runtime\node.exe"; DestDir: "{app}\runtime"; Flags: ignoreversion
Source: "{#StageDir}\launcher\ScoutLauncher.ps1"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\Scout"; Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoLogo -NoProfile -ExecutionPolicy Bypass -File ""{app}\{#MyAppExeName}"""; WorkingDir: "{app}"; IconFilename: "{sys}\shell32.dll"; IconIndex: 14
Name: "{userdesktop}\Scout"; Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoLogo -NoProfile -ExecutionPolicy Bypass -File ""{app}\{#MyAppExeName}"""; WorkingDir: "{app}"; IconFilename: "{sys}\shell32.dll"; IconIndex: 14; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "Create a &desktop shortcut"; GroupDescription: "Additional shortcuts:"; Flags: unchecked

[Run]
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoLogo -NoProfile -ExecutionPolicy Bypass -File ""{app}\{#MyAppExeName}"""; Description: "Launch Scout"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
; Remove any payload residue that Inno could not associate with the final
; installation pass (for example unchanged dependency files after an upgrade).
; The private workspace is always outside {app} and is deliberately untouched.
Type: filesandordirs; Name: "{app}\app"

; The private workspace is deliberately outside {app}. The uninstaller therefore
; removes application files only and never deletes Documents\Scout Workspace or
; a custom SCOUT_WORKSPACE location.
