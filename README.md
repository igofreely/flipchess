# FlipChess（揭棋）

基于 `React + TypeScript + Vite + PWA + Express + MySQL` 的揭棋项目，支持本地客户端与服务器联机模式。

## 主要功能

- 客户端揭棋对局（AI、音效、复盘、FEN 导入导出）
- 服务器账号体系（注册/登录/JWT）
- 服务器对局管理（PVP / VS AI / AI VS AI）
- 平台统计与排行榜

## 运行要求

- Node.js 20+
- npm 10+
- MySQL 8+（Debian 也可使用 MariaDB）

---

## 本地部署（完整命令）

### 1) 拉取后安装依赖

```bash
cd /path/to/FlipChess
npm install
```

### 2) 启动本地 MySQL（推荐脚本）

```bash
npm run mysql:up
```

> 说明：优先使用 Docker；若 Docker 不可用且本机安装了 Homebrew MySQL，会自动回退到本机 MySQL 服务。

### 3) 配置后端数据库环境变量（可选，脚本已有默认值）

```bash
export MYSQL_HOST=127.0.0.1
export MYSQL_PORT=3306
export MYSQL_USER=root
export MYSQL_PASSWORD=your_password
export MYSQL_DATABASE=flipchess
```

### 4) 启动后端

```bash
npm run server:start:mysql
```

后端默认监听：`http://127.0.0.1:3001`

### 5) 启动前端开发服务（新开一个终端）

```bash
npm run dev -- --host 0.0.0.0 --port 2222
```

前端开发地址：`http://127.0.0.1:2222`

### 6) 前端对接后端（项目根目录 `.env`）

```bash
cat > .env <<'EOF'
VITE_SERVER_API_BASE=http://127.0.0.1:3001/api
EOF
```

### 7) 本地健康检查

```bash
curl -sS http://127.0.0.1:3001/api/health
```

### 8) 本地停止 MySQL（可选）

```bash
npm run mysql:down
```

### 一条命令快速联调（阻塞前台）

```bash
npm run test:local
```

---

## 编译、提交与部署

日常开发的完整流程：**编辑代码 → 本地构建验证 → Git 提交推送 → 一键部署到服务器**。

### 1) 本地编译（构建前端产物）

```bash
npm run build
```

- 使用 Vite 将 `src/` 下的 TypeScript + React 代码编译为 `dist/` 静态资源。
- 构建前会自动做类型检查，有报错则终止。
- 构建产物用于服务器的 nginx 静态托管。

### 2) Git 提交与推送

```bash
# 查看改动
git status
git diff

# 暂存 → 提交 → 推送
git add -A
git commit -m "描述本次改动"
git push
```

- 仓库远程地址：`ssh://c.f22.fun:2222/root/Code.git`（master 分支）。
- 提交前建议先 `npm run build` 确认编译无误。

### 3) 一键部署到服务器

使用 `scripts/deploy.sh` 在本地一键完成：构建 → 上传 → 远程重启服务 → 健康检查。

> 所有文件均从本地上传，**不依赖服务器访问 GitHub**。

#### 增量部署（默认，推荐）

```bash
# 密码登录（需 sshpass）
DEPLOY_PASSWORD=your_password bash scripts/deploy.sh

# 已配置 SSH 密钥则无需密码
bash scripts/deploy.sh
```

**流程**（4 步）：
1. 本地 `npm run build` 编译前端
2. **rsync 增量同步** — 只上传有变化的文件，跳过 `node_modules`、`.git`、NNUE 模型等大文件
3. 远程重启 — 智能检测 `package.json` 是否变化，无变化则跳过 `npm install`；PM2 重启后端
4. 健康检查 — 验证 API / HTTP / HTTPS 均正常

增量部署通常只传几百 KB，耗时数秒（相比全量的 ~113 MB）。

#### 全量部署（首次部署或大幅变更时）

```bash
DEPLOY_PASSWORD=your_password bash scripts/deploy.sh --full
```

**流程**（6 步）：
1. 本地 `npm run build` 编译前端
2. `tar.gz` 打包整个项目（排除 `node_modules`、`.git`）
3. scp 上传 tar 包 + Pikafish 源码 + NNUE 模型 + nginx 配置
4. 远程解压 → `npm install` → 编译 Pikafish → PM2 重启
5. 配置 nginx（80/443/33333 三端口）
6. 健康检查

#### 自定义主机

```bash
DEPLOY_HOST=1.2.3.4 DEPLOY_PASSWORD=xxx bash scripts/deploy.sh
```

#### 典型日常工作流（一行命令）

```bash
# 改完代码，一条命令搞定：提交 + 推送 + 部署
git add -A && git commit -m "fix: 修复xxx" && git push && DEPLOY_PASSWORD=your_password bash scripts/deploy.sh
```

### 部署可配置环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `DEPLOY_HOST` | `ds.hookapp.top` | 目标服务器地址 |
| `DEPLOY_USER` | `root` | SSH 用户名 |
| `DEPLOY_PASSWORD` | _(空)_ | SSH 密码（需安装 sshpass） |
| `DEPLOY_DIR` | `/opt/flipchess` | 远程部署目录 |
| `DOMAIN` | `ds.hookapp.top` | 域名（用于 nginx 配置） |
| `MYSQL_APP_USER` | `flipchess` | MySQL 应用用户 |
| `MYSQL_APP_PASSWORD` | `hook499A` | MySQL 应用密码 |
| `LOCAL_PIKAFISH_SRC` | `../Pikafish-jieqi-old/src` | 本地 Pikafish 源码路径 |
| `LOCAL_NNUE` | `server/data/pikafish-master.nnue` | 本地 NNUE 模型文件 |

### 前置条件

- 服务器：Debian 12+、Node.js 20+、nginx、MySQL/MariaDB、PM2
- 域名已解析到服务器，端口 80/443/33333 已放行
- HTTPS 证书已配置（首次可用 `scripts/enable-https-debian12.sh`）
- macOS 使用密码登录需安装 sshpass：`brew install hudochenkov/sshpass/sshpass`

### 安装 sshpass（macOS）

```bash
brew install hudochenkov/sshpass/sshpass
```

---

## 服务器部署（Debian 12：发布 + 443 证书 + 自动续签）

> **推荐使用上面的一键部署脚本。** 以下为手动步骤，仅供参考或首次初始化服务器环境使用。

以下流程是“完整上线命令”，包含：发版、HTTPS（443）与续签。

### 0) 前置条件

- 域名已解析到服务器公网 IP（例如 `ds.hookapp.top`）
- 服务器已放行端口：`80`、`443`、`33333`

### 1) 本地打包并上传

```bash
cd /path/to/FlipChess

tar --exclude='node_modules' --exclude='.git' --exclude='dist' --exclude='.DS_Store' \
	-czf /tmp/flipchess-deploy.tar.gz .

scp /tmp/flipchess-deploy.tar.gz root@YOUR_SERVER_IP:/root/flipchess-deploy.tar.gz
scp scripts/deploy-debian12.sh root@YOUR_SERVER_IP:/root/deploy-debian12.sh
scp scripts/enable-https-debian12.sh root@YOUR_SERVER_IP:/root/enable-https-debian12.sh
scp scripts/flipchess.nginx.conf root@YOUR_SERVER_IP:/root/flipchess.nginx.conf
```

### 2) 服务器执行发布（HTTP + PM2 + MySQL）

```bash
ssh root@YOUR_SERVER_IP

chmod +x /root/deploy-debian12.sh /root/enable-https-debian12.sh

# 可按需覆盖应用数据库账号密码
export MYSQL_APP_USER=flipchess
export MYSQL_APP_PASSWORD=ChangeToStrongPassword
export MYSQL_APP_DB=flipchess

bash /root/deploy-debian12.sh
```

### 3) 安装/更新 443 证书

```bash
export DOMAIN=your.domain.com
bash /root/enable-https-debian12.sh
```

### 4) 覆盖为三端口统一 Nginx（80/443/33333）

> 说明：发布脚本会写入 33333-only 配置，因此每次发布后建议执行一次这步，确保 HTTPS 一直存在。

```bash
cp /root/flipchess.nginx.conf /etc/nginx/sites-available/flipchess.conf
ln -sf /etc/nginx/sites-available/flipchess.conf /etc/nginx/sites-enabled/flipchess.conf
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl restart nginx
```

### 5) 线上健康检查（HTTP + HTTPS）

```bash
curl -I -sS http://your.domain.com:33333 | head -n 1
curl -sS http://your.domain.com:33333/api/health

curl -I -sS https://your.domain.com | head -n 1
curl -sS https://your.domain.com/api/health
```

### 6) PM2 常用运维命令

```bash
pm2 list
pm2 logs flipchess-server --lines 200
pm2 restart flipchess-server
pm2 save
```

---

## 证书自动续期与失败告警（可选）

### 1) 续签任务（cron）

```bash
cat >/usr/local/bin/flipchess-cert-renew <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
LOG_DIR="/var/log/flipchess"
LOG_FILE="$LOG_DIR/cert-renew.log"
mkdir -p "$LOG_DIR"
{
	echo "===== $(date -u +%Y-%m-%dT%H:%M:%SZ) cert renew start ====="
	/root/.acme.sh/acme.sh --cron --home /root/.acme.sh
	echo "===== $(date -u +%Y-%m-%dT%H:%M:%SZ) cert renew end ====="
} >>"$LOG_FILE" 2>&1
EOF

chmod 755 /usr/local/bin/flipchess-cert-renew

cat >/etc/cron.d/flipchess-cert-renew <<'EOF'
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
MAILTO=""
26 20 * * * root /usr/local/bin/flipchess-cert-renew
EOF

chmod 644 /etc/cron.d/flipchess-cert-renew
```

### 2) 续签失败告警邮箱配置

如果你已使用增强版 `/usr/local/bin/flipchess-cert-renew`（支持失败发信），可用以下配置：

```bash
mkdir -p /etc/flipchess
cat >/etc/flipchess/cert-alert.env <<'EOF'
ALERT_SMTP_HOST=smtp.163.com
ALERT_SMTP_PORT=465
ALERT_USE_SSL=1
ALERT_USE_STARTTLS=0
ALERT_SENDER_EMAIL=your_sender@163.com
ALERT_SENDER_PASSWORD=your_smtp_auth_code
ALERT_RECEIVER_EMAIL=your_receiver@163.com
EOF
chmod 700 /etc/flipchess
chmod 600 /etc/flipchess/cert-alert.env
```

模拟失败测试（会触发告警邮件）：

```bash
/usr/local/bin/flipchess-cert-renew --simulate-fail
tail -n 50 /var/log/flipchess/cert-renew.log
```

### 3) 续签状态检查

```bash
grep -E 'Le_NextRenewTime(Str)?=' /root/.acme.sh/your.domain.com_ecc/your.domain.com.conf
tail -n 100 /var/log/flipchess/cert-renew.log
```

---

## 代码检查与本地预览

```bash
npm run lint && npm run build
npm run preview -- --host 0.0.0.0 --port 2222
```

---

## 文档

- 服务器 API：`docs/server-api.md`
- AI 接入规范：`docs/ai-integration.md`

## Pikafish(jieqi) 接入（服务端）

可按 JieqiBox 的思路，把 `official-pikafish/Pikafish` 的 `jieqi` 分支作为服务端 AI 引擎：

1. 编译引擎（示例）：

```bash
git clone -b jieqi https://github.com/official-pikafish/Pikafish.git
cd Pikafish/src
make -j profile-build
```

2. 启动后端前设置环境变量：

```bash
export PIKAFISH_JIEQI_PATH=/absolute/path/to/Pikafish/src/pikafish
export PIKAFISH_EVALFILE_PATH=/absolute/path/to/pikafish.nnue
export PIKAFISH_THREADS=1
export PIKAFISH_HASH_MB=64
export PIKAFISH_MAX_THINK_MS=12000
npm run server:start:mysql
```

说明：

- 配置 `PIKAFISH_JIEQI_PATH` 后，服务器 AI 回合会优先走 Pikafish。
- 若默认网络文件加载失败，可配置 `PIKAFISH_EVALFILE_PATH` 指定 NNUE 文件绝对路径。
- 可通过 `PIKAFISH_MAX_THINK_MS` 限制 Pikafish 单次思考最长时间（毫秒）。
- 未配置该变量时，自动使用项目内置 AI。
- 若 Pikafish 调用异常，会自动回退到内置 AI，避免对局中断。

补充（当前仓库脚本默认行为）：

- `npm run server:start:mysql` 调用的 `scripts/server-start-mysql.sh` 已支持自动探测 Pikafish：
	- 优先 `../Pikafish-jieqi-old/src/PikaJieQi`
	- 其次 `../Pikafish-jieqi/src/pikafish`
- 若未手动设置 `PIKAFISH_EVALFILE_PATH`，脚本会自动尝试使用引擎同目录下的 `pikafish.nnue`。
- 启动前会做一次引擎预检；若官方 `jieqi` 因 NNUE 加载失败不可用，会自动回退到 `jieqi-old` 并在日志打印 `[server-start] ... fallback to jieqi-old`。

### 兼容性说明（2026-02）

当前已验证结论：

| 引擎分支 | 可执行文件 | 与公开 `master-net/pikafish.nnue` 兼容性 | 在本项目中的状态 |
|---|---|---|---|
| `jieqi` | `pikafish` | ✅ 已验证可用（需正确 NNUE） | 可正常由 Pikafish 落子 |
| `jieqi_old` | `PikaJieQi` | ✅ 已验证可用 | 可正常由 Pikafish 落子 |

建议始终以 `npm run check:pikafish` 的 `firstMoveEngine` 结果为准。

### 一键切换命令

1. 使用 `jieqi_old`：

```bash
export PIKAFISH_JIEQI_PATH=/tmp/Pikafish-jieqi-old-test/src/PikaJieQi
npm run check:pikafish
```

2. 使用 `jieqi`（推荐显式配置 `PIKAFISH_EVALFILE_PATH`）：

```bash
export PIKAFISH_JIEQI_PATH=/absolute/path/to/Pikafish-jieqi/src/pikafish
export PIKAFISH_EVALFILE_PATH=/absolute/path/to/pikafish.nnue
npm run check:pikafish
```

3. 通过标准：自检输出里 `firstMoveEngine` 必须是 `pikafish`。

### 一键自检（推荐）

```bash
PIKAFISH_JIEQI_PATH=/absolute/path/to/Pikafish/src/pikafish npm run check:pikafish

# 或显式指定网络文件（推荐）
PIKAFISH_JIEQI_PATH=/absolute/path/to/Pikafish/src/pikafish \
PIKAFISH_EVALFILE_PATH=/absolute/path/to/pikafish.nnue \
npm run check:pikafish
```

该命令会自动：

- 拉起 MySQL（若未启动）
- 在独立端口启动后端并注入 `PIKAFISH_JIEQI_PATH`
- 走通注册/建局/轮询流程并校验 AI 首步来自 `pikafish`（不是回退内置 AI）
