param(
    [switch]$SkipDocker,
    [switch]$SkipNode,
    [switch]$SkipNpmInstall,
    [switch]$SkipEngine,
    [switch]$UseCnMirror,
    [switch]$ForceRebuild,
    [string]$EngineRepoUrl = 'https://github.com/official-pikafish/Pikafish.git',
    [string]$EngineBranch = 'jieqi_old',
    [string]$NodeVersion = '20.19.1'
)

$ErrorActionPreference = 'Stop'
$script:UbuntuDistroName = $null
$script:EnableCnMirror = $false

function Write-Step {
    param([string]$Message)
    Write-Host "[setup:local] $Message"
}

function Test-IsAdmin {
    $currentUser = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($currentUser)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Convert-ToWslPath {
    param([string]$WindowsPath)

    $normalized = $WindowsPath.Replace('\', '/')
    if ($normalized -match '^([a-zA-Z]):(.*)$') {
        $drive = $matches[1].ToLower()
        $suffix = $matches[2]
        return "/mnt/$drive$suffix"
    }
    return $normalized
}

function Invoke-External {
    param(
        [string]$FilePath,
        [string[]]$ArgumentList,
        [string]$FailureMessage
    )

    & $FilePath @ArgumentList
    if ($LASTEXITCODE -ne 0) {
        throw "$FailureMessage (exitCode=$LASTEXITCODE)"
    }
}

function Try-DownloadFile {
    param(
        [string[]]$Urls,
        [string]$OutFile,
        [long]$MinBytes = 1048576
    )

    foreach ($url in $Urls) {
        try {
            Invoke-WebRequest -Uri $url -OutFile $OutFile -UseBasicParsing
            if ((Test-Path $OutFile) -and (Get-Item $OutFile).Length -ge $MinBytes) {
                return $true
            }
        }
        catch {
        }
    }

    return $false
}

function Get-DockerCliPath {
    if (Get-Command docker -ErrorAction SilentlyContinue) {
        return 'docker'
    }

    $candidates = @(
        (Join-Path $env:ProgramFiles 'Docker\Docker\resources\bin\docker.exe'),
        (Join-Path ${env:ProgramFiles(x86)} 'Docker\Docker\resources\bin\docker.exe')
    )

    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path $candidate)) {
            return $candidate
        }
    }

    return $null
}

function Resolve-NpmCommand {
    if (Get-Command npm.cmd -ErrorAction SilentlyContinue) {
        return 'npm.cmd'
    }

    if (Get-Command npm -ErrorAction SilentlyContinue) {
        return 'npm'
    }

    return $null
}

function Ensure-NodeInstalled {
    $npmCommand = Resolve-NpmCommand
    if ($npmCommand) {
        Write-Step "Node.js already installed via command: $npmCommand"
        return
    }

    if (Get-Command winget -ErrorAction SilentlyContinue) {
        Write-Step 'installing Node.js LTS via winget...'
        Invoke-External -FilePath 'winget' -ArgumentList @(
            'install', '--id', 'OpenJS.NodeJS.LTS', '--exact', '--silent',
            '--accept-package-agreements', '--accept-source-agreements'
        ) -FailureMessage 'Node.js installation failed (winget)'
    }
    elseif (Get-Command choco -ErrorAction SilentlyContinue) {
        Write-Step 'winget not found, installing Node.js via choco...'
        Invoke-External -FilePath 'choco' -ArgumentList @('install', 'nodejs-lts', '-y') -FailureMessage 'Node.js installation failed (choco)'
    }
    else {
        Write-Step 'winget/choco not found, downloading portable Node.js zip...'
        $zipName = "node-v$NodeVersion-win-x64.zip"
        $tmpZip = Join-Path $env:TEMP $zipName
        $targetRoot = Join-Path $env:LOCALAPPDATA "node-v$NodeVersion-win-x64"
        $downloadUrls = @(
            "https://npmmirror.com/mirrors/node/v$NodeVersion/$zipName",
            "https://nodejs.org/dist/v$NodeVersion/$zipName"
        )

        $downloaded = Try-DownloadFile -Urls $downloadUrls -OutFile $tmpZip -MinBytes 10485760
        if (-not $downloaded) {
            throw "[setup:local] failed to download Node.js zip (v$NodeVersion)."
        }

        if (Test-Path $targetRoot) {
            Remove-Item -Path $targetRoot -Recurse -Force
        }

        Expand-Archive -Path $tmpZip -DestinationPath $env:LOCALAPPDATA -Force
        $env:Path = "$targetRoot;$env:Path"
        [Environment]::SetEnvironmentVariable('Path', "$targetRoot;" + [Environment]::GetEnvironmentVariable('Path', 'User'), 'User')
        Write-Step "portable Node.js installed at: $targetRoot"
    }

    if (-not (Resolve-NpmCommand)) {
        throw '[setup:local] npm still not found after Node.js installation. Please restart PowerShell and retry.'
    }
}

function Configure-NpmRegistry {
    if (-not $script:EnableCnMirror) {
        return
    }

    $npmCommand = Resolve-NpmCommand
    if (-not $npmCommand) {
        throw '[setup:local] npm not found while configuring npm registry.'
    }

    Write-Step 'configuring npm registry to https://registry.npmmirror.com ...'
    & $npmCommand config set registry 'https://registry.npmmirror.com'
    if ($LASTEXITCODE -ne 0) {
        Write-Warning '[setup:local] failed to set npm registry mirror. You can run manually: npm config set registry https://registry.npmmirror.com'
    }
}

function Install-NpmDependencies {
    if ($SkipNpmInstall) {
        Write-Step 'skip npm install by parameter.'
        return
    }

    $npmCommand = Resolve-NpmCommand
    if (-not $npmCommand) {
        throw '[setup:local] npm not found before npm install.'
    }

    Write-Step 'running npm install...'
    & $npmCommand install
    if ($LASTEXITCODE -ne 0) {
        throw '[setup:local] npm install failed.'
    }
}

function Configure-CnDockerDefaults {
    if (-not $script:EnableCnMirror) {
        return
    }

    Write-Step 'setting default MYSQL_IMAGE mirror in user environment...'
    [Environment]::SetEnvironmentVariable('MYSQL_IMAGE', 'docker.m.daocloud.io/library/mysql:8', 'User')
    $env:MYSQL_IMAGE = 'docker.m.daocloud.io/library/mysql:8'
}

function Ensure-DockerInstalled {
    $dockerCliPath = Get-DockerCliPath
    $dockerDesktopExe = Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe'
    if ($dockerCliPath -or (Test-Path $dockerDesktopExe)) {
        Write-Step 'Docker Desktop already installed, skip Docker installation.'
        return
    }

    if (Get-Command winget -ErrorAction SilentlyContinue) {
        Write-Step 'installing Docker Desktop via winget...'
        Invoke-External -FilePath 'winget' -ArgumentList @(
            'install', '--id', 'Docker.DockerDesktop', '--exact', '--silent',
            '--accept-package-agreements', '--accept-source-agreements'
        ) -FailureMessage 'Docker Desktop installation failed'
        return
    }

    if (Get-Command choco -ErrorAction SilentlyContinue) {
        Write-Step 'winget not found, installing Docker Desktop via choco...'
        Invoke-External -FilePath 'choco' -ArgumentList @('install', 'docker-desktop', '-y') -FailureMessage 'Docker Desktop installation failed (choco)'
        return
    }

    Write-Step 'winget/choco not found, downloading Docker Desktop installer directly...'
    $tmpInstaller = Join-Path $env:TEMP 'DockerDesktopInstaller.exe'
    $downloadCandidates = @(
        'https://desktop.docker.com/win/main/amd64/Docker%20Desktop%20Installer.exe',
        'https://desktop.docker.com/win/stable/amd64/Docker%20Desktop%20Installer.exe'
    )

    $downloaded = $false
    foreach ($url in $downloadCandidates) {
        try {
            Invoke-WebRequest -Uri $url -OutFile $tmpInstaller -UseBasicParsing
            if ((Test-Path $tmpInstaller) -and (Get-Item $tmpInstaller).Length -gt 10MB) {
                $downloaded = $true
                break
            }
        }
        catch {
        }
    }

    if (-not $downloaded) {
        throw '[setup:local] Docker installer download failed. Please install Docker Desktop manually, then rerun this script.'
    }

    Write-Step 'running Docker Desktop installer silently...'
    $process = Start-Process -FilePath $tmpInstaller -ArgumentList @('install', '--quiet', '--accept-license') -Wait -PassThru
    if ($process.ExitCode -ne 0) {
        throw "[setup:local] Docker Desktop installer failed (exitCode=$($process.ExitCode))."
    }
}

function Ensure-DockerReady {
    Write-Step 'ensuring Docker Desktop is running...'

    $dockerDesktopExe = Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe'
    if (Test-Path $dockerDesktopExe) {
        Start-Process -FilePath $dockerDesktopExe | Out-Null
    }

    $dockerCliPath = Get-DockerCliPath
    if (-not $dockerCliPath) {
        throw '[setup:local] docker cli not found after installation. Please restart PowerShell or reinstall Docker Desktop.'
    }

    for ($i = 0; $i -lt 120; $i++) {
        & $dockerCliPath info *> $null
        if ($LASTEXITCODE -eq 0) {
            Write-Step 'docker is ready.'
            return
        }
        Start-Sleep -Seconds 2
    }

    throw '[setup:local] Docker not ready after timeout. Please open Docker Desktop manually and rerun.'
}

function Ensure-UbuntuWsl {
    if (-not (Get-Command wsl -ErrorAction SilentlyContinue)) {
        throw '[setup:local] wsl command not found. Please enable WSL on Windows first.'
    }

    $listText = (& wsl -l -q 2>$null | Out-String)
    $distroNames = $listText -replace "`0", '' -split "`r?`n" |
        ForEach-Object { $_.Trim() } |
        Where-Object { -not [string]::IsNullOrWhiteSpace($_) }

    $ubuntuDistro = $distroNames | Where-Object { $_ -match '(?i)^ubuntu($|[-\s].*)' } | Select-Object -First 1

    if (-not $ubuntuDistro) {
        Write-Step 'Ubuntu distro not found, installing Ubuntu...'
        $installOutput = (& wsl --install -d Ubuntu 2>&1 | Out-String)
        $installExitCode = $LASTEXITCODE
        if ($installExitCode -ne 0 -and $installOutput -notmatch '(?i)(ERROR_ALREADY_EXISTS|already exists|已存在)') {
            throw "[setup:local] Ubuntu install failed. Reboot Windows and rerun this script as Administrator. details: $installOutput"
        }

        $listText = (& wsl -l -q 2>$null | Out-String)
        $distroNames = $listText -replace "`0", '' -split "`r?`n" |
            ForEach-Object { $_.Trim() } |
            Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
        $ubuntuDistro = $distroNames | Where-Object { $_ -match '(?i)^ubuntu($|[-\s].*)' } | Select-Object -First 1
    }

    if (-not $ubuntuDistro) {
        throw "[setup:local] Ubuntu distro still not found. Current distros: $($distroNames -join ', ')"
    }

    $script:UbuntuDistroName = [string]$ubuntuDistro
    Write-Step "using WSL distro: $script:UbuntuDistroName"

    Write-Step 'initializing Ubuntu packages (git/build-essential/make)...'
    Invoke-External -FilePath 'wsl' -ArgumentList @('-d', $script:UbuntuDistroName, '-u', 'root', '--', 'bash', '-lc', 'set -euo pipefail; apt-get update; DEBIAN_FRONTEND=noninteractive apt-get install -y git make g++ ca-certificates curl') -FailureMessage 'Failed to install WSL build dependencies'
}

function Ensure-JieqiOldEngine {
    param(
        [string]$ProjectRoot,
        [string]$ProjectParent
    )

    $engineRootWindows = Join-Path $ProjectParent 'Pikafish-jieqi-old'
    $engineSrcWindows = Join-Path $engineRootWindows 'src'
    $engineExeWindows = Join-Path $engineSrcWindows 'PikaJieQi'
    $engineNnueWindows = Join-Path $engineSrcWindows 'pikafish.nnue'
        $vendoredEngineSrcWindows = Join-Path $ProjectRoot 'third_party\Pikafish-jieqi-old\src'
        $vendoredEngineNnueWindows = Join-Path $vendoredEngineSrcWindows 'pikafish.nnue'
    $fallbackNnueWindows = Join-Path $ProjectRoot 'server\data\pikafish-master.nnue'

    $engineRootWsl = Convert-ToWslPath $engineRootWindows
    $engineSrcWsl = Convert-ToWslPath $engineSrcWindows
        $vendoredEngineSrcWsl = Convert-ToWslPath $vendoredEngineSrcWindows
        $engineRootWslBuild = '/tmp/flipchess/Pikafish-jieqi-old'
        $engineSrcWslBuild = "$engineRootWslBuild/src"

    $syncCmd = @"
set -euo pipefail
mkdir -p '$engineSrcWsl'
if [ -f '$vendoredEngineSrcWsl/Makefile' ]; then
    rm -rf '$engineRootWslBuild'
    mkdir -p '$engineSrcWslBuild'
    cp -a '$vendoredEngineSrcWsl/.' '$engineSrcWslBuild/'
elif [ ! -d '$engineRootWslBuild/.git' ]; then
    git clone -b '$EngineBranch' '$EngineRepoUrl' '$engineRootWslBuild'
else
    git -C '$engineRootWslBuild' fetch --all --tags
    git -C '$engineRootWslBuild' checkout '$EngineBranch'
    git -C '$engineRootWslBuild' pull --ff-only
fi
cd '$engineSrcWslBuild'
make -j"`$(nproc)" profile-build
if [ ! -x './PikaJieQi' ] && [ -x './pikafish' ]; then
  cp -f './pikafish' './PikaJieQi'
  chmod +x './PikaJieQi'
fi
cp -f './PikaJieQi' '$engineSrcWsl/PikaJieQi'
if [ -f './pikafish.nnue' ]; then
    cp -f './pikafish.nnue' '$engineSrcWsl/pikafish.nnue'
fi
chmod +x '$engineSrcWsl/PikaJieQi' || true
"@

    $syncCmdUnix = ($syncCmd -replace "`r`n", "`n") -replace "`r", "`n"

    if ($ForceRebuild -or -not (Test-Path $engineExeWindows)) {
        Write-Step "syncing and building jieqi_old engine ($EngineBranch)..."
        Invoke-External -FilePath 'wsl' -ArgumentList @('-d', $script:UbuntuDistroName, '--', 'bash', '-lc', $syncCmdUnix) -FailureMessage 'jieqi_old build failed'
    }
    else {
        Write-Step 'jieqi_old engine already exists, skip build. Use -ForceRebuild to rebuild.'
    }

    if (-not (Test-Path $engineExeWindows)) {
        throw "[setup:local] missing engine binary: $engineExeWindows"
    }

    if (-not (Test-Path $engineNnueWindows)) {
        if (Test-Path $vendoredEngineNnueWindows) {
            Write-Step 'copying NNUE from vendored third_party source...'
            Copy-Item -Path $vendoredEngineNnueWindows -Destination $engineNnueWindows -Force
        }
        elseif (Test-Path $fallbackNnueWindows) {
            Write-Step 'copying NNUE from project server/data...'
            Copy-Item -Path $fallbackNnueWindows -Destination $engineNnueWindows -Force
        }
        else {
            Write-Step 'downloading NNUE model...'
            $nnueUrls = @(
                'https://raw.githubusercontent.com/official-pikafish/Networks/master/pikafish.nnue',
                'https://raw.githubusercontent.com/official-pikafish/Pikafish/master/src/pikafish.nnue',
                'https://ghproxy.com/https://raw.githubusercontent.com/official-pikafish/Networks/master/pikafish.nnue',
                'https://ghproxy.com/https://raw.githubusercontent.com/official-pikafish/Pikafish/master/src/pikafish.nnue'
            )

            $downloaded = Try-DownloadFile -Urls $nnueUrls -OutFile $engineNnueWindows -MinBytes 1048576

            if (-not $downloaded) {
                $engineNnueWsl = Convert-ToWslPath $engineNnueWindows
                $downloadScriptTemplate = @'
set -euo pipefail
tmp_nnue='__ENGINE_NNUE_WSL__'
mkdir -p "$(dirname "$tmp_nnue")"
urls=(
    'https://raw.githubusercontent.com/official-pikafish/Networks/master/pikafish.nnue'
    'https://raw.githubusercontent.com/official-pikafish/Pikafish/master/src/pikafish.nnue'
    'https://ghproxy.com/https://raw.githubusercontent.com/official-pikafish/Networks/master/pikafish.nnue'
    'https://ghproxy.com/https://raw.githubusercontent.com/official-pikafish/Pikafish/master/src/pikafish.nnue'
)
for url in "${urls[@]}"; do
    if command -v curl >/dev/null 2>&1; then
        if curl -fsSL --connect-timeout 10 "$url" -o "$tmp_nnue"; then
            size=$(wc -c < "$tmp_nnue" || echo 0)
            if [ "${size:-0}" -ge 1048576 ]; then
                exit 0
            fi
        fi
    fi
done
exit 1
'@
                $downloadScript = $downloadScriptTemplate.Replace('__ENGINE_NNUE_WSL__', $engineNnueWsl)
                $downloadScriptUnix = ($downloadScript -replace "`r`n", "`n") -replace "`r", "`n"
                try {
                    & wsl -d $script:UbuntuDistroName -- bash -lc $downloadScriptUnix *> $null
                }
                catch {
                    Write-Warning "[setup:local] WSL NNUE download fallback failed: $($_.Exception.Message)"
                }
                $downloaded = ((Test-Path $engineNnueWindows) -and (Get-Item $engineNnueWindows).Length -ge 1048576)
            }

            if (-not $downloaded) {
                Write-Warning "[setup:local] NNUE download failed. You can still run project; AI may fallback. If needed, manually put pikafish.nnue into: $engineSrcWindows"
            }
        }
    }

    Write-Step "engine ready: $engineExeWindows"
    if (Test-Path $engineNnueWindows) {
        Write-Step "nnue ready: $engineNnueWindows"
    }
    else {
        Write-Warning "[setup:local] nnue missing: $engineNnueWindows"
    }
}

if (-not (Test-IsAdmin)) {
    throw '[setup:local] please run this script in an Administrator PowerShell.'
}

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
if (-not (Test-Path (Join-Path $projectRoot 'package.json'))) {
    throw "[setup:local] project root not found: $projectRoot"
}

$projectParent = Split-Path -Parent $projectRoot
Write-Step "project root: $projectRoot"
Write-Step "project parent: $projectParent"
Set-Location $projectRoot

$cnCultureMatched = (Get-Culture).Name -match '^zh-CN'
$cnEnvEnabled = ($env:FLIPCHESS_CN_MIRROR -eq '1')
$script:EnableCnMirror = $UseCnMirror -or $cnCultureMatched -or $cnEnvEnabled
if ($script:EnableCnMirror) {
    Write-Step 'CN mirror mode enabled (npm mirror + MYSQL_IMAGE preset).'
}

if (-not $SkipNode) {
    Ensure-NodeInstalled
    Configure-NpmRegistry
    Install-NpmDependencies
}
else {
    Write-Step 'skip Node.js/npm setup by parameter.'
}

Configure-CnDockerDefaults

if (-not $SkipDocker) {
    Ensure-DockerInstalled
    Ensure-DockerReady
}
else {
    Write-Step 'skip Docker by parameter.'
}

if (-not $SkipEngine) {
    Ensure-UbuntuWsl
    Ensure-JieqiOldEngine -ProjectRoot $projectRoot -ProjectParent $projectParent
}
else {
    Write-Step 'skip jieqi_old setup by parameter.'
}

Write-Step 'all prerequisites completed.'
Write-Host '[setup:local] next: run scripts/start-local.ps1'
