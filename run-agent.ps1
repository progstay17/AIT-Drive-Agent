$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$envFile = Join-Path $PSScriptRoot 'agent.env'
if (-not (Test-Path $envFile)) { throw 'agent.env not found. Run setup-agent.bat first.' }

Get-Content $envFile | ForEach-Object {
    if ($_ -match '^\s*([^#][^=]*)=(.*)$') {
        [Environment]::SetEnvironmentVariable($matches[1].Trim(), $matches[2].Trim(), 'Process')
    }
}

$nodeExe = Join-Path $env:ProgramFiles 'nodejs\node.exe'
if (-not (Test-Path $nodeExe)) { $nodeExe = (Get-Command node.exe -ErrorAction Stop).Source }
& $nodeExe (Join-Path $PSScriptRoot 'server.js')
exit $LASTEXITCODE
