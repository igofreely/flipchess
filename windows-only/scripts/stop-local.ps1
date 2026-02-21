$ErrorActionPreference = 'Continue'

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
if (-not (Test-Path (Join-Path $projectRoot 'package.json'))) {
    throw "[stop:local] project root not found: $projectRoot"
}
Set-Location $projectRoot

Write-Host '[stop:local] stopping FlipChess node processes...'
$projectRootEscaped = [Regex]::Escape($projectRoot)
$targets = Get-CimInstance Win32_Process | Where-Object {
    $_.Name -eq 'node.exe' -and (
        $_.CommandLine -match $projectRootEscaped -or
        $_.CommandLine -match 'vite --host 0.0.0.0 --port 2222' -or
        $_.CommandLine -match 'server/src/index.ts'
    )
}

if ($targets) {
    foreach ($proc in $targets) {
        try {
            Stop-Process -Id $proc.ProcessId -Force -ErrorAction Stop
            Write-Host "[stop:local] stopped PID=$($proc.ProcessId)"
        }
        catch {
            Write-Warning "[stop:local] failed to stop PID=$($proc.ProcessId): $($_.Exception.Message)"
        }
    }
}
else {
    Write-Host '[stop:local] no matching FlipChess node process found.'
}

$dockerMode = if (Get-Command docker -ErrorAction SilentlyContinue) {
    'native'
}
elseif (Get-Command bash -ErrorAction SilentlyContinue) {
    'bash'
}
else {
    'none'
}

function Invoke-DockerCapture {
    param([string]$Command)

    if ($dockerMode -eq 'native') {
        return cmd /c "docker $Command"
    }
    if ($dockerMode -eq 'bash') {
        return bash -lc "docker $Command 2>/dev/null"
    }
    throw '[stop:local] docker command not found in both PowerShell and bash.'
}

if ($dockerMode -ne 'none') {
    $containerName = 'flipchess-mysql'
    $exists = Invoke-DockerCapture "ps -a --format '{{.Names}}'" | Select-String -SimpleMatch $containerName
    if ($exists) {
        Write-Host '[stop:local] stopping MySQL container...'
        Invoke-DockerCapture "rm -f $containerName" | Out-Null
        Write-Host '[stop:local] MySQL container removed.'
    }
    else {
        Write-Host '[stop:local] MySQL container not found.'
    }
}
else {
    Write-Warning '[stop:local] docker command not found, skipped MySQL stop.'
}

Write-Host '[stop:local] done.'
