$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Test-PortOpen {
    param(
        [int]$Port
    )

    try {
        $client = New-Object System.Net.Sockets.TcpClient
        $iar = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
        $ok = $iar.AsyncWaitHandle.WaitOne(300)
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

Write-Host '[start:local] 启动 MySQL...'
npm run mysql:up

if (-not $env:MYSQL_HOST) { $env:MYSQL_HOST = '127.0.0.1' }
if (-not $env:MYSQL_PORT) { $env:MYSQL_PORT = '3306' }
if (-not $env:MYSQL_USER) { $env:MYSQL_USER = 'root' }
if (-not $env:MYSQL_PASSWORD) { $env:MYSQL_PASSWORD = '123456' }
if (-not $env:MYSQL_DATABASE) { $env:MYSQL_DATABASE = 'flipchess' }
if (-not $env:PIKAFISH_JIEQI_PATH) { $env:PIKAFISH_JIEQI_PATH = 'E:\Workspace\gitlab\Code\game\Pikafish-jieqi-old\src\PikaJieQi' }
if (-not $env:PIKAFISH_EVALFILE_PATH) { $env:PIKAFISH_EVALFILE_PATH = 'E:\Workspace\gitlab\Code\game\Pikafish-jieqi-old\src\pikafish.nnue' }
if (-not $env:PIKAFISH_THREADS) { $env:PIKAFISH_THREADS = '1' }
if (-not $env:PIKAFISH_HASH_MB) { $env:PIKAFISH_HASH_MB = '64' }
if (-not $env:PORT) { $env:PORT = '3101' }

$backendPort = [int]$env:PORT
$frontendPort = 2222
$env:VITE_SERVER_API_BASE = "http://127.0.0.1:$backendPort/api"
$env:VITE_AI_HTTP_ENDPOINT = "$($env:VITE_SERVER_API_BASE)/ai/search"

if (Test-PortOpen -Port $backendPort) {
    Write-Host "[start:local] 后端已在运行: http://127.0.0.1:$backendPort"
}
else {
    Write-Host '[start:local] 启动后端服务...'
    $backendProc = Start-Process -FilePath 'npm.cmd' -ArgumentList @('run', 'server:start') -PassThru
    Write-Host "[start:local] 后端进程 PID=$($backendProc.Id)"
}

if (Test-PortOpen -Port $frontendPort) {
    Write-Host "[start:local] 前端已在运行，重启以应用 API 地址: $($env:VITE_SERVER_API_BASE)"
    $viteTargets = Get-CimInstance Win32_Process | Where-Object {
        $_.Name -eq 'node.exe' -and $_.CommandLine -match 'vite' -and $_.CommandLine -match 'FlipChess'
    }
    foreach ($proc in $viteTargets) {
        try {
            Stop-Process -Id $proc.ProcessId -Force -ErrorAction Stop
        }
        catch {
            Write-Warning "[start:local] 停止旧前端进程失败 PID=$($proc.ProcessId): $($_.Exception.Message)"
        }
    }
}

Write-Host '[start:local] 启动前端服务...'
$frontendProc = Start-Process -FilePath 'npm.cmd' -ArgumentList @('run', 'dev', '--', '--host', '0.0.0.0', '--port', "$frontendPort") -PassThru
Write-Host "[start:local] 前端进程 PID=$($frontendProc.Id)"

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
    Write-Host "[start:local] 后端健康检查通过: http://127.0.0.1:$backendPort/api/health"
}
else {
    Write-Warning "[start:local] 后端健康检查未通过，请查看运行中的终端日志"
}

Write-Host "[start:local] 前端地址: http://127.0.0.1:$frontendPort"
Write-Host "[start:local] 前端 API 基址: $($env:VITE_SERVER_API_BASE)"
