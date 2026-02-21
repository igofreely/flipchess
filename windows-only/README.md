# Windows 专用改动（本次会话）

本目录保存了本次会话中为 Windows 适配做的所有脚本与代码改动。
项目根目录已恢复为原始（mac）版本入口。

## 目录说明

- `package.windows.json`：包含 `start:local` / `stop:local` 的 Windows 版本 `package.json`
- `scripts/start-local.ps1`：Windows 一键启动（MySQL + 后端 + 前端）
- `scripts/stop-local.ps1`：Windows 一键停止
- `scripts/check-pikafish-direct.mjs`：Windows 下直接检查 AI HTTP 链路
- `scripts/check-pikafish.sh`：带 Windows 场景适配的版本
- `scripts/mysql-up.sh` / `scripts/mysql-down.sh` / `scripts/server-start-mysql.sh`：本次会话中的对应版本
- `server/src/pikafish-jieqi.ts`：包含 Windows 调用 `jieqi_old` 的桥接实现版本

## 使用方式（Windows）

如果你要使用这些 Windows 专用改动，请把需要的文件从 `windows-only` 覆盖回项目原路径后再运行。
