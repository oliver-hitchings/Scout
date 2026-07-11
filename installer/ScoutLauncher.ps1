$ErrorActionPreference = 'Stop'

$appRoot = Join-Path $PSScriptRoot 'app'
$node = Join-Path $PSScriptRoot 'runtime\node.exe'
$server = Join-Path $appRoot 'ui\server.mjs'
$url = 'http://127.0.0.1:8459/'

if (-not (Test-Path -LiteralPath $node)) {
    Add-Type -AssemblyName PresentationFramework
    [System.Windows.MessageBox]::Show('Scout could not find its bundled Node.js runtime. Reinstall Scout and try again.', 'Scout') | Out-Null
    exit 1
}

try {
    $info = Invoke-RestMethod -Uri ($url + 'api/app-info') -TimeoutSec 2
    $expected = [IO.Path]::GetFullPath($appRoot).TrimEnd('\')
    $actual = [IO.Path]::GetFullPath([string]$info.appRoot).TrimEnd('\')
    if ($actual -ieq $expected) {
        Start-Process $url
        exit 0
    }
    Add-Type -AssemblyName PresentationFramework
    [System.Windows.MessageBox]::Show("Another Scout copy is already running from:`n$actual`n`nClose it, then launch Scout again.", 'Scout') | Out-Null
    exit 2
} catch {
    # A failed probe is expected when Scout is not already running.
}

$workspace = $env:SCOUT_WORKSPACE
if ([string]::IsNullOrWhiteSpace($workspace)) {
    $workspace = Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'Scout Workspace'
}
$logDirectory = Join-Path $workspace 'logs'
New-Item -ItemType Directory -Force -Path $logDirectory | Out-Null
$stdout = Join-Path $logDirectory 'ui-stdout.log'
$stderr = Join-Path $logDirectory 'ui-stderr.log'

Start-Process -FilePath $node `
    -ArgumentList @($server) `
    -WorkingDirectory $appRoot `
    -WindowStyle Hidden `
    -RedirectStandardOutput $stdout `
    -RedirectStandardError $stderr | Out-Null

$deadline = (Get-Date).AddSeconds(15)
do {
    Start-Sleep -Milliseconds 300
    try {
        Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 1 | Out-Null
        Start-Process $url
        exit 0
    } catch {
        # Keep polling until the deadline.
    }
} while ((Get-Date) -lt $deadline)

Add-Type -AssemblyName PresentationFramework
[System.Windows.MessageBox]::Show("Scout did not start. Diagnostic logs are in:`n$logDirectory", 'Scout') | Out-Null
exit 1
