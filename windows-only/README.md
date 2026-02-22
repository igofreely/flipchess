# Windows 专用改动（本次会话）

本目录保存了本次会话中为 Windows 适配做的所有脚本与代码改动。
项目根目录已恢复为原始（mac）版本入口。

## 目录说明

- `package.windows.json`：包含 `start:local` / `stop:local` 的 Windows 版本 `package.json`
- `scripts/install-local-deps.ps1`：Windows 一键安装依赖（Docker + WSL Ubuntu + `jieqi_old`）
- `scripts/start-local.ps1`：Windows 一键启动（MySQL + 后端 + 前端）
- `scripts/stop-local.ps1`：Windows 一键停止
- `scripts/check-pikafish-direct.mjs`：Windows 下直接检查 AI HTTP 链路
- `scripts/check-pikafish.sh`：带 Windows 场景适配的版本
- `scripts/mysql-up.sh` / `scripts/mysql-down.sh` / `scripts/server-start-mysql.sh`：本次会话中的对应版本
- `server/src/pikafish-jieqi.ts`：包含 Windows 调用 `jieqi_old` 的桥接实现版本

## 使用方式（Windows）

如果你要使用这些 Windows 专用改动，请把需要的文件从 `windows-only` 覆盖回项目原路径后再运行。

## 新机器一键初始化（Windows）

在 **管理员 PowerShell** 执行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-local-deps.ps1
```

执行完成后，再运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-local.ps1
```

说明：

- 安装脚本会确保 `docker` 可用并拉起 Docker Desktop。
- 会安装/初始化 WSL Ubuntu，并在项目同级目录构建 `Pikafish-jieqi-old\src\PikaJieQi`。
- 若缺失 `pikafish.nnue`，会优先从 `server/data/pikafish-master.nnue` 复制，否则尝试联网下载。

## 新 Windows 电脑部署（推荐稳定版）

1. 用管理员 PowerShell 进入项目根目录，先跑依赖初始化：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\windows-only\scripts\install-local-deps.ps1
```

2. 脚本现在会自动处理 Node：优先 `winget/choco`，无包管理器时自动下载便携 Node（含国内镜像回退），通常不需要手工安装。

3. 启动本地环境（脚本已内置国内网络优化）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\windows-only\scripts\start-local.ps1
```

如果你想强制启用国内镜像模式（不依赖系统语言判断），可用：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\windows-only\scripts\start-local.ps1 -UseCnMirror
```

4. 成功标志：
- 后端健康检查：`http://127.0.0.1:3101/api/health`
- 前端地址：`http://127.0.0.1:2222`

## 内置引擎源码与模型（无需每次从 GitHub 拉取）

- 仓库已内置 `third_party/Pikafish-jieqi-old/src`（`jieqi_old` 源码）。
- 仓库已内置 `third_party/Pikafish-jieqi-old/src/pikafish.nnue`（NNUE 模型）。
- `install-local-deps.ps1` 会优先使用内置源码在 WSL 中编译，并将产物同步到 `../Pikafish-jieqi-old/src/PikaJieQi`。
- 若本地引擎目录缺少模型，会优先从 `third_party` 复制，避免重复联网下载。

## 国内网络适配说明

- `install-local-deps.ps1` 在 `zh-CN` 系统会自动启用国内镜像模式：
	- `npm registry` 设置为 `https://registry.npmmirror.com`
	- 自动设置用户环境变量 `MYSQL_IMAGE=docker.m.daocloud.io/library/mysql:8`
- `start-local.ps1` 会自动探测常见 Node 安装目录（含 `%LOCALAPPDATA%\node-v*-win-x64` 便携版），通常不再需要手工临时改 PATH。
- 也可手动强制启用：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\windows-only\scripts\install-local-deps.ps1 -UseCnMirror
```

- 可选参数：
	- `-SkipNode` 跳过 Node/npm 安装
	- `-SkipNpmInstall` 跳过 `npm install`
	- `-SkipDocker` / `-SkipEngine` 跳过对应依赖

## 仅在需要时手工安装 Node（兜底）

如果你希望手工安装便携 Node（当前验证通过版本），可执行：

```powershell
$ProgressPreference='SilentlyContinue'
$zip = Join-Path $env:TEMP 'node-v20.19.1-win-x64.zip'
Invoke-WebRequest -Uri 'https://nodejs.org/dist/v20.19.1/node-v20.19.1-win-x64.zip' -OutFile $zip -UseBasicParsing
Expand-Archive -Path $zip -DestinationPath $env:LOCALAPPDATA -Force
$env:Path = "$env:LOCALAPPDATA\node-v20.19.1-win-x64;$env:Path"
```

安装前后端依赖：

```powershell
npm install
```

启动本地环境（若 Docker Hub 受限，指定镜像源）：

```powershell
$env:MYSQL_IMAGE='docker.m.daocloud.io/library/mysql:8'
powershell -NoProfile -ExecutionPolicy Bypass -File .\windows-only\scripts\start-local.ps1
```

