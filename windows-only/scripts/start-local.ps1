param(
    [switch]$SkipMySql,
    [switch]$UseCnMirror
)

$ErrorActionPreference = 'Stop'

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
if (-not (Test-Path (Join-Path $projectRoot 'package.json'))) {
    throw "[start:local] project root not found: $projectRoot"
}
Set-Location $projectRoot

$projectParent = Split-Path -Parent $projectRoot
$defaultEnginePath = Join-Path $projectParent 'Pikafish-jieqi-old\src\PikaJieQi'
$defaultNnuePath = Join-Path $projectParent 'Pikafish-jieqi-old\src\pikafish.nnue'

$cnCultureMatched = (Get-Culture).Name -match '^zh-CN'
$cnEnvEnabled = ($env:FLIPCHESS_CN_MIRROR -eq '1')
$enableCnMirror = $UseCnMirror -or $cnCultureMatched -or $cnEnvEnabled
if ($enableCnMirror -and -not $env:MYSQL_IMAGE) {
    $env:MYSQL_IMAGE = 'docker.m.daocloud.io/library/mysql:8'
    Write-Host "[start:local] CN mirror mode enabled, MYSQL_IMAGE=$($env:MYSQL_IMAGE)"
}

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

function Resolve-NpmCommand {
    if (Get-Command npm.cmd -ErrorAction SilentlyContinue) {
        return 'npm.cmd'
    }
    if (Get-Command npm -ErrorAction SilentlyContinue) {
        return 'npm'
    }

    $candidateDirs = @()
    if ($env:LOCALAPPDATA) {
        $candidateDirs += (Join-Path $env:LOCALAPPDATA 'node-v20.19.1-win-x64')
        try {
            $portableNodes = Get-ChildItem -Path $env:LOCALAPPDATA -Directory -Filter 'node-v*-win-x64' -ErrorAction SilentlyContinue |
                Sort-Object -Property Name -Descending
            foreach ($dir in $portableNodes) {
                $candidateDirs += $dir.FullName
            }
        }
        catch {
        }
    }
    if ($env:ProgramFiles) { $candidateDirs += (Join-Path $env:ProgramFiles 'nodejs') }
    if (${env:ProgramFiles(x86)}) { $candidateDirs += (Join-Path ${env:ProgramFiles(x86)} 'nodejs') }
    $candidateDirs = $candidateDirs | Select-Object -Unique

    foreach ($dir in $candidateDirs) {
        if (-not $dir -or -not (Test-Path $dir)) { continue }
        $npmCmdPath = Join-Path $dir 'npm.cmd'
        $npmPath = Join-Path $dir 'npm'
        if ((Test-Path $npmCmdPath) -or (Test-Path $npmPath)) {
            $env:Path = "$dir;$env:Path"
            if (Get-Command npm.cmd -ErrorAction SilentlyContinue) {
                Write-Host "[start:local] detected npm from: $dir"
                return 'npm.cmd'
            }
            if (Get-Command npm -ErrorAction SilentlyContinue) {
                Write-Host "[start:local] detected npm from: $dir"
                return 'npm'
            }
        }
    }

    throw '[start:local] npm is not installed or not in PATH. Please install Node.js LTS first, or run scripts/install-local-deps.ps1.'
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
    $mysqlImageCandidates = @()
    if ($env:MYSQL_IMAGE) { $mysqlImageCandidates += $env:MYSQL_IMAGE }
    $mysqlImageCandidates += @(
        'mysql:8',
        'mysql/mysql-server:8.0',
        'registry.cn-hangzhou.aliyuncs.com/dockerhub_mirror/mysql:8'
    )
    $mysqlImageCandidates = $mysqlImageCandidates | Select-Object -Unique

    $exists = Invoke-DockerCapture "ps -a --format '{{.Names}}'" | Select-String -SimpleMatch $containerName
    if ($exists) {
        $running = Invoke-DockerCapture "ps --format '{{.Names}}'" | Select-String -SimpleMatch $containerName
        if (-not $running) {
            Write-Host '[start:local] starting existing MySQL container...'
            Invoke-DockerCapture "start $containerName" | Out-Null
            if ($LASTEXITCODE -ne 0) {
                throw '[start:local] failed to start existing MySQL container. Run `docker logs flipchess-mysql` for details.'
            }
        }
        else {
            Write-Host '[start:local] MySQL container already running.'
        }
    }
    else {
        $created = $false
        foreach ($image in $mysqlImageCandidates) {
            Write-Host "[start:local] creating MySQL container with image $image ..."
            Invoke-DockerCapture "run -d --name $containerName -e MYSQL_ROOT_PASSWORD=$rootPassword -e MYSQL_DATABASE=$dbName -p $mysqlPort`:3306 $image" | Out-Null
            if ($LASTEXITCODE -eq 0) {
                Write-Host "[start:local] MySQL container created by image: $image"
                $created = $true
                break
            }
            Write-Warning "[start:local] failed to start image $image, trying next candidate..."
        }

        if (-not $created) {
            throw '[start:local] failed to create MySQL container. Docker may not access image registry. You can set a custom mirror image via env MYSQL_IMAGE.'
        }
    }

    Write-Host '[start:local] waiting for MySQL readiness...'
    for ($i = 0; $i -lt 60; $i++) {
        $containerExists = Invoke-DockerCapture "ps -a --format '{{.Names}}'" | Select-String -SimpleMatch $containerName
        if (-not $containerExists) {
            throw '[start:local] MySQL container disappeared during startup. Check Docker Desktop status.'
        }

        $previousErrorAction = $ErrorActionPreference
        try {
            $ErrorActionPreference = 'Continue'
            Invoke-DockerCapture "exec $containerName mysqladmin ping -uroot -p$rootPassword --silent" *> $null
        }
        finally {
            $ErrorActionPreference = $previousErrorAction
        }
        if ($LASTEXITCODE -eq 0) {
            Write-Host '[start:local] MySQL is ready at 127.0.0.1:3306/flipchess'
            return
        }
        Start-Sleep -Seconds 1
    }

    throw '[start:local] MySQL startup timed out. Check `docker logs flipchess-mysql`.'
}

if ($SkipMySql) {
    Write-Host '[start:local] skip MySQL bootstrap by parameter -SkipMySql.'
}
else {
    Write-Host '[start:local] bootstrapping MySQL...'
    Ensure-MySqlUp
}

if (-not $env:MYSQL_HOST) { $env:MYSQL_HOST = '127.0.0.1' }
if (-not $env:MYSQL_PORT) { $env:MYSQL_PORT = '3306' }
if (-not $env:MYSQL_USER) { $env:MYSQL_USER = 'root' }
if (-not $env:MYSQL_PASSWORD) { $env:MYSQL_PASSWORD = '123456' }
if (-not $env:MYSQL_DATABASE) { $env:MYSQL_DATABASE = 'flipchess' }
if (-not $env:PIKAFISH_JIEQI_PATH -and (Test-Path $defaultEnginePath)) { $env:PIKAFISH_JIEQI_PATH = $defaultEnginePath }
if (-not $env:PIKAFISH_EVALFILE_PATH -and (Test-Path $defaultNnuePath)) { $env:PIKAFISH_EVALFILE_PATH = $defaultNnuePath }
if (-not $env:PIKAFISH_THREADS) { $env:PIKAFISH_THREADS = '1' }
if (-not $env:PIKAFISH_HASH_MB) { $env:PIKAFISH_HASH_MB = '64' }
if (-not $env:PORT) { $env:PORT = '3101' }

$backendPort = [int]$env:PORT
$frontendPort = 2222
$npmCommand = Resolve-NpmCommand
$env:VITE_SERVER_API_BASE = "http://127.0.0.1:$backendPort/api"
$env:VITE_AI_HTTP_ENDPOINT = "$($env:VITE_SERVER_API_BASE)/ai/search"

if (Test-PortOpen -Port $backendPort) {
    Write-Host "[start:local] backend already running at http://127.0.0.1:$backendPort"
}
else {
    Write-Host '[start:local] starting backend...'
    $backendProc = Start-Process -FilePath $npmCommand -ArgumentList @('run', 'server:start') -PassThru
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
$frontendProc = Start-Process -FilePath $npmCommand -ArgumentList @('run', 'dev', '--', '--host', '0.0.0.0', '--port', "$frontendPort") -PassThru
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
