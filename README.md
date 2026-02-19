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

## 服务器部署（Debian 12，完整命令）

以下示例从**本地电脑**执行，把项目打包上传到服务器后自动部署。

### 1) 本地打包

```bash
cd /path/to/FlipChess
tar --exclude='node_modules' --exclude='.git' --exclude='dist' --exclude='.DS_Store' -czf /tmp/flipchess-deploy.tar.gz .
```

### 2) 上传到服务器

```bash
scp /tmp/flipchess-deploy.tar.gz root@YOUR_SERVER_IP:/root/flipchess-deploy.tar.gz
scp scripts/deploy-debian12.sh root@YOUR_SERVER_IP:/root/deploy-debian12.sh
scp scripts/enable-https-debian12.sh root@YOUR_SERVER_IP:/root/enable-https-debian12.sh
```

### 3) 服务器执行基础部署

```bash
ssh root@YOUR_SERVER_IP
chmod +x /root/deploy-debian12.sh /root/enable-https-debian12.sh

# 可按需覆盖应用数据库账号密码
export MYSQL_APP_USER=flipchess
export MYSQL_APP_PASSWORD=ChangeToStrongPassword
export MYSQL_APP_DB=flipchess

bash /root/deploy-debian12.sh
```

部署完成后默认：

- 前端：`http://YOUR_SERVER_IP:33333`
- 后端健康检查：`http://127.0.0.1:3001/api/health`（在服务器内执行）

### 4) 配置 HTTPS（域名需先解析到服务器）

```bash
export DOMAIN=your.domain.com
bash /root/enable-https-debian12.sh
```

验证：

```bash
curl -I https://your.domain.com
curl -sS https://your.domain.com/api/health
```

### 5) PM2 常用运维命令

```bash
pm2 list
pm2 logs flipchess-server --lines 200
pm2 restart flipchess-server
pm2 save
```

---

## 证书自动续期与失败告警（可选）

如果你已经按线上方式创建了 `/usr/local/bin/flipchess-cert-renew`，可以用以下方式配置失败告警邮箱：

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
