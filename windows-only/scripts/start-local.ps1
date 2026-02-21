$ErrorActionPreference = 'Stop'

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
if (-not (Test-Path (Join-Path $projectRoot 'package.json'))) {
    throw "[start:local] project root not found: $projectRoot"
}
Set-Location $projectRoot

$projectParent = Split-Path -Parent $projectRoot
$defaultEnginePath = Join-Path $projectParent 'Pikafish-jieqi-old\src\PikaJieQi'
$defaultNnuePath = Join-Path $projectParent 'Pikafish-jieqi-old\src\pikafish.nnue'

function Test-PortOpen {
    param([int]$Port)
    try {
        $client = New-Object System.Net.Sockets.TcpClient
        $iar = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
        $ok = $iar.AsyncWaitHandle.WaitOne(400)
        if ($ok -and $client.Connected) {
            $client.EndConnect($iar)
            $client.Close()
            return $true
        }
        $client.Close()
        return $false
    }
    catch {
        return $false
    }
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
    throw '[start:local] docker command not found in both PowerShell and bash. Please install Docker Desktop.'
}

function Ensure-MySqlUp {
    $containerName = 'flipchess-mysql'
    $mysqlPort = '3306'
    $rootPassword = '123456'
    $dbName = 'flipchess'

    $exists = Invoke-DockerCapture "ps -a --format '{{.Names}}'" | Select-String -SimpleMatch $containerName
    if ($exists) {
        $running = Invoke-DockerCapture "ps --format '{{.Names}}'" | Select-String -SimpleMatch $containerName
        if (-not $running) {
            Write-Host '[start:local] starting existing MySQL container...'
            Invoke-DockerCapture "start $containerName" | Out-Null
        }
        else {
            Write-Host '[start:local] MySQL container already running.'
        }
    }
    else {
        Write-Host '[start:local] creating MySQL container...'
        Invoke-DockerCapture "run -d --name $containerName -e MYSQL_ROOT_PASSWORD=$rootPassword -e MYSQL_DATABASE=$dbName -p $mysqlPort`:3306 mysql:8" | Out-Null
    }

    Write-Host '[start:local] waiting for MySQL readiness...'
    for ($i = 0; $i -lt 60; $i++) {
        Invoke-DockerCapture "exec $containerName mysqladmin ping -uroot -p$rootPassword --silent" *> $null
        if ($LASTEXITCODE -eq 0) {
            Write-Host '[start:local] MySQL is ready at 127.0.0.1:3306/flipchess'
            return
        }
        Start-Sleep -Seconds 1
    }

    throw '[start:local] MySQL startup timed out. Check `docker logs flipchess-mysql`.'
}

Write-Host '[start:local] bootstrapping MySQL...'
Ensure-MySqlUp

if (-not $env:MYSQL_HOST) { $env:MYSQL_HOST = '127.0.0.1' }
if (-not $env:MYSQL_PORT) { $env:MYSQL_PORT = '3306' }
if (-not $env:MYSQL_USER) { $env:MYSQL_USER = 'root' }
if (-not $env:MYSQL_PASSWORD) { $env:MYSQL_PASSWORD = '123456' }
if (-not $env:MYSQL_DATABASE) { $env:MYSQL_DATABASE = 'flipchess' }
if (-not $env:PIKAFISH_JIEQI_PATH) { $env:PIKAFISH_JIEQI_PATH = $defaultEnginePath }
if (-not $env:PIKAFISH_EVALFILE_PATH) { $env:PIKAFISH_EVALFILE_PATH = $defaultNnuePath }
if (-not $env:PIKAFISH_THREADS) { $env:PIKAFISH_THREADS = '1' }
if (-not $env:PIKAFISH_HASH_MB) { $env:PIKAFISH_HASH_MB = '64' }
if (-not $env:PORT) { $env:PORT = '3101' }

$backendPort = [int]$env:PORT
$frontendPort = 2222
$env:VITE_SERVER_API_BASE = "http://127.0.0.1:$backendPort/api"
$env:VITE_AI_HTTP_ENDPOINT = "$($env:VITE_SERVER_API_BASE)/ai/search"

if (Test-PortOpen -Port $backendPort) {
    Write-Host "[start:local] backend already running at http://127.0.0.1:$backendPort"
}
else {
    Write-Host '[start:local] starting backend...'
    $backendProc = Start-Process -FilePath 'npm.cmd' -ArgumentList @('run', 'server:start') -PassThru
    Write-Host "[start:local] backend PID=$($backendProc.Id)"
}

if (Test-PortOpen -Port $frontendPort) {
    Write-Host "[start:local] restarting frontend to apply API base $($env:VITE_SERVER_API_BASE)..."
    $viteTargets = Get-CimInstance Win32_Process | Where-Object {
        $_.Name -eq 'node.exe' -and $_.CommandLine -match 'vite' -and $_.CommandLine -match 'FlipChess'
    }
    foreach ($proc in $viteTargets) {
        try { Stop-Process -Id $proc.ProcessId -Force -ErrorAction Stop } catch {}
    }
}

Write-Host '[start:local] starting frontend...'
$frontendProc = Start-Process -FilePath 'npm.cmd' -ArgumentList @('run', 'dev', '--', '--host', '0.0.0.0', '--port', "$frontendPort") -PassThru
Write-Host "[start:local] frontend PID=$($frontendProc.Id)"

$healthOk = $false
for ($i = 0; $i -lt 40; $i++) {
    try {
        Invoke-RestMethod -Uri "http://127.0.0.1:$backendPort/api/health" -TimeoutSec 2 | Out-Null
        $healthOk = $true
        break
    }
    catch {
        Start-Sleep -Milliseconds 500
    }
}

if ($healthOk) {
    Write-Host "[start:local] backend health OK: http://127.0.0.1:$backendPort/api/health"
}
else {
    Write-Warning '[start:local] backend health check failed. Please inspect backend terminal logs.'
}

Write-Host "[start:local] frontend URL: http://127.0.0.1:$frontendPort"
Write-Host "[start:local] frontend API base: $($env:VITE_SERVER_API_BASE)"
