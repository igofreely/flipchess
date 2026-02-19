# FlipChess（揭棋）

基于 `React + TypeScript + Vite + PWA + Express + MySQL` 的揭棋项目，支持本地客户端与服务器联机模式。

## 主要功能

- 客户端揭棋对局（AI、音效、复盘、PGN 导入导出）
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

## 服务器部署（Debian 12：发布 + 443 证书 + 自动续签）

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

## 构建与预览

```bash
npm run lint && npm run build
npm run preview -- --host 0.0.0.0 --port 2222
```

---

## 文档

- 服务器 API：`docs/server-api.md`
- AI 接入规范：`docs/ai-integration.md`
