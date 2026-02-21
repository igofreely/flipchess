$ErrorActionPreference = 'Continue'

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

Write-Host '[stop:local] 停止 FlipChess 相关 Node 进程...'
$targets = Get-CimInstance Win32_Process | Where-Object {
    $_.Name -eq 'node.exe' -and (
        $_.CommandLine -match 'E:\\Workspace\\gitlab\\Code\\game\\FlipChess' -or
        $_.CommandLine -match 'vite --host 0.0.0.0 --port 2222' -or
        $_.CommandLine -match 'server/src/index.ts'
    )
}

if ($targets) {
    foreach ($proc in $targets) {
        try {
            Stop-Process -Id $proc.ProcessId -Force -ErrorAction Stop
            Write-Host "[stop:local] 已停止 PID=$($proc.ProcessId)"
        }
        catch {
            Write-Warning "[stop:local] 停止 PID=$($proc.ProcessId) 失败: $($_.Exception.Message)"
        }
    }
}
else {
    Write-Host '[stop:local] 未发现需停止的 FlipChess Node 进程'
}

Write-Host '[stop:local] 停止 MySQL...'
npm run mysql:down

Write-Host '[stop:local] 完成'
