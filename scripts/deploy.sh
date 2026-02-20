#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
# FlipChess 一键部署脚本（本地 → 远程服务器）
#
# 用法：
#   bash scripts/deploy.sh                                    # 使用默认 ds.hookapp.top
#   DEPLOY_HOST=1.2.3.4 bash scripts/deploy.sh                # 自定义主机
#   DEPLOY_PASSWORD=xxx bash scripts/deploy.sh                 # 密码登录（需 sshpass）
#
# 此脚本在本地执行，完成以下步骤：
#   1. 本地构建前端（VITE_SERVER_API_BASE=/api）
#   2. 打包源码 + 构建产物
#   3. 上传到远程服务器
#   4. 远程安装依赖、编译 Pikafish-jieqi、重启服务
#   5. 恢复 HTTPS nginx 配置
#   6. 健康检查
# ─────────────────────────────────────────────────────────────
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

# ── 配置 ──
DEPLOY_HOST="${DEPLOY_HOST:-ds.hookapp.top}"
DEPLOY_USER="${DEPLOY_USER:-root}"
DEPLOY_DIR="${DEPLOY_DIR:-/opt/flipchess}"
DOMAIN="${DOMAIN:-ds.hookapp.top}"

MYSQL_APP_USER="${MYSQL_APP_USER:-flipchess}"
MYSQL_APP_PASSWORD="${MYSQL_APP_PASSWORD:-hook499A}"
MYSQL_APP_DB="${MYSQL_APP_DB:-flipchess}"

PIKAFISH_DIR="/opt/Pikafish-jieqi-old"

# 本地 Pikafish 源码目录（用于上传编译，避免服务器从 GitHub 下载）
LOCAL_PIKAFISH_SRC="${LOCAL_PIKAFISH_SRC:-$(cd "${ROOT_DIR}/../Pikafish-jieqi-old/src" 2>/dev/null && pwd || echo '')}"
# 本地 NNUE 文件
LOCAL_NNUE="${LOCAL_NNUE:-${ROOT_DIR}/server/data/pikafish-master.nnue}"

SSH_OPTS="-o StrictHostKeyChecking=no -o ConnectTimeout=10"
REMOTE="${DEPLOY_USER}@${DEPLOY_HOST}"
DEPLOY_PASSWORD="${DEPLOY_PASSWORD:-}"

if [[ -n "${DEPLOY_PASSWORD}" ]]; then
    if ! command -v sshpass >/dev/null 2>&1; then
        echo "错误: 设置了 DEPLOY_PASSWORD 但未安装 sshpass"
        echo "  macOS: brew install hudochenkov/sshpass/sshpass"
        echo "  Linux: apt-get install sshpass"
        exit 1
    fi
    _ssh()  { sshpass -p "${DEPLOY_PASSWORD}" ssh ${SSH_OPTS} "${REMOTE}" "$@"; }
    _scp()  { sshpass -p "${DEPLOY_PASSWORD}" scp ${SSH_OPTS} "$@"; }
else
    _ssh()  { ssh ${SSH_OPTS} "${REMOTE}" "$@"; }
    _scp()  { scp ${SSH_OPTS} "$@"; }
fi

TMP_TAR="/tmp/flipchess-deploy.tar.gz"

echo "╔════════════════════════════════════════════╗"
echo "║   FlipChess 一键部署                       ║"
echo "╠════════════════════════════════════════════╣"
echo "║  目标: ${REMOTE}:${DEPLOY_DIR}"
echo "║  域名: ${DOMAIN}"
echo "╚════════════════════════════════════════════╝"
echo

# ── 步骤 1: 本地构建 ──
echo "▶ [1/6] 本地构建..."
VITE_SERVER_API_BASE=/api npm run build
echo "  ✓ 构建完成"

# ── 步骤 2: 打包 ──
echo "▶ [2/6] 打包..."
tar --exclude='node_modules' \
    --exclude='.git' \
    --exclude='.DS_Store' \
    --exclude='.runlogs' \
    --exclude='*.profraw' \
    -czf "${TMP_TAR}" .
TAR_SIZE=$(du -h "${TMP_TAR}" | cut -f1)
echo "  ✓ 打包完成: ${TMP_TAR} (${TAR_SIZE})"

# ── 步骤 3: 上传 ──
echo "▶ [3/6] 上传到 ${REMOTE}..."

# 准备所有要上传的文件
UPLOAD_FILES=("${TMP_TAR}")

# 生成 nginx 配置到临时文件
TMP_NGINX="/tmp/flipchess-nginx.conf"
SSL_DIR="/etc/ssl/flipchess"
cat > "${TMP_NGINX}" <<NGINX_EOF
server {
    listen 80;
    server_name ${DOMAIN};
    return 301 https://\$host\$request_uri;
}

server {
    listen 33333;
    server_name ${DOMAIN};
    root ${DEPLOY_DIR}/dist;
    index index.html;

    location /api/ {
        proxy_pass http://127.0.0.1:3001/api/;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

    location / {
        try_files \$uri \$uri/ /index.html;
    }
}

server {
    listen 443 ssl http2;
    server_name ${DOMAIN};
    ssl_certificate ${SSL_DIR}/fullchain.pem;
    ssl_certificate_key ${SSL_DIR}/privkey.pem;
    root ${DEPLOY_DIR}/dist;
    index index.html;

    location /api/ {
        proxy_pass http://127.0.0.1:3001/api/;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

    location / {
        try_files \$uri \$uri/ /index.html;
    }
}
NGINX_EOF
UPLOAD_FILES+=("${TMP_NGINX}")

# 准备 Pikafish 源码（避免服务器从 GitHub 下载）
TMP_PIKA_TAR="/tmp/pikafish-src.tar.gz"
HAS_PIKAFISH_SRC=false
if [[ -n "${LOCAL_PIKAFISH_SRC}" && -f "${LOCAL_PIKAFISH_SRC}/Makefile" ]]; then
    echo "  准备 Pikafish 源码..."
    tar -czf "${TMP_PIKA_TAR}" -C "${LOCAL_PIKAFISH_SRC}/.." --exclude='.git' --exclude='*.o' --exclude='PikaJieQi' --exclude='pikafish' src/
    UPLOAD_FILES+=("${TMP_PIKA_TAR}")
    HAS_PIKAFISH_SRC=true
else
    echo "  ⚠ 本地 Pikafish 源码未找到 (${LOCAL_PIKAFISH_SRC})，将跳过 Pikafish"
fi

# 准备 NNUE 文件（复制为固定名称）
TMP_NNUE="/tmp/pikafish.nnue"
HAS_NNUE=false
if [[ -f "${LOCAL_NNUE}" ]]; then
    cp "${LOCAL_NNUE}" "${TMP_NNUE}"
    UPLOAD_FILES+=("${TMP_NNUE}")
    HAS_NNUE=true
else
    echo "  ⚠ 本地 NNUE 文件未找到 (${LOCAL_NNUE})，Pikafish 可能无法使用"
fi

# 一次性上传所有文件到服务器 /root/
echo "  上传 ${#UPLOAD_FILES[@]} 个文件..."
_scp "${UPLOAD_FILES[@]}" "${REMOTE}:/root/"

rm -f "${TMP_TAR}" "${TMP_NGINX}" "${TMP_PIKA_TAR}" "${TMP_NNUE}"
echo "  ✓ 上传完成"

# ── 步骤 4: 远程部署 ──
echo "▶ [4/6] 远程部署..."

_ssh bash -s "${DEPLOY_DIR}" "${MYSQL_APP_USER}" "${MYSQL_APP_PASSWORD}" "${MYSQL_APP_DB}" "${PIKAFISH_DIR}" "${DOMAIN}" <<'REMOTE_SCRIPT'
set -euo pipefail
DEPLOY_DIR="$1"
MYSQL_APP_USER="$2"
MYSQL_APP_PASSWORD="$3"
MYSQL_APP_DB="$4"
PIKAFISH_DIR="$5"
DOMAIN="$6"
export DEBIAN_FRONTEND=noninteractive

echo "  [remote] 解压代码..."
rm -rf "${DEPLOY_DIR}"
mkdir -p "${DEPLOY_DIR}"
tar -xzf /root/flipchess-deploy.tar.gz -C "${DEPLOY_DIR}"
rm -f /root/flipchess-deploy.tar.gz
cd "${DEPLOY_DIR}"

echo "  [remote] 安装 npm 依赖..."
npm install 2>&1 | tail -3

# ── MySQL 初始化 ──
echo "  [remote] 确保 MySQL 数据库存在..."
mysql -uroot <<SQL || true
CREATE DATABASE IF NOT EXISTS \`${MYSQL_APP_DB}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS '${MYSQL_APP_USER}'@'127.0.0.1' IDENTIFIED BY '${MYSQL_APP_PASSWORD}';
ALTER USER '${MYSQL_APP_USER}'@'127.0.0.1' IDENTIFIED BY '${MYSQL_APP_PASSWORD}';
GRANT ALL PRIVILEGES ON \`${MYSQL_APP_DB}\`.* TO '${MYSQL_APP_USER}'@'127.0.0.1';
FLUSH PRIVILEGES;
SQL

# ── 编译 Pikafish-jieqi（从本地上传的源码） ──
PIKAFISH_BIN="${PIKAFISH_DIR}/src/PikaJieQi"
PIKAFISH_NNUE="${PIKAFISH_DIR}/src/pikafish.nnue"

if [[ ! -x "${PIKAFISH_BIN}" ]]; then
    if [[ -f /root/pikafish-src.tar.gz ]]; then
        echo "  [remote] 编译 Pikafish-jieqi-old（从上传源码）..."
        apt-get install -y -qq g++ >/dev/null 2>&1 || true

        rm -rf "${PIKAFISH_DIR}"
        mkdir -p "${PIKAFISH_DIR}"
        tar -xzf /root/pikafish-src.tar.gz -C "${PIKAFISH_DIR}"
        rm -f /root/pikafish-src.tar.gz

        cd "${PIKAFISH_DIR}/src"
        make -j"$(nproc)" build ARCH=x86-64 2>&1 | tail -5
        mv pikafish PikaJieQi 2>/dev/null || true

        if [[ ! -x "PikaJieQi" ]]; then
            echo "  [remote] ⚠ Pikafish 编译失败，将使用内置 AI"
        else
            echo "  [remote] ✓ Pikafish 编译完成: ${PIKAFISH_BIN}"
        fi
    else
        echo "  [remote] ⚠ Pikafish 源码未上传，跳过编译"
    fi
else
    echo "  [remote] ✓ Pikafish 已存在: ${PIKAFISH_BIN}"
fi

# ── 安装 NNUE（从本地上传） ──
if [[ -x "${PIKAFISH_BIN}" && -f /root/pikafish.nnue ]]; then
    cp /root/pikafish.nnue "${PIKAFISH_NNUE}"
    rm -f /root/pikafish.nnue
    echo "  [remote] ✓ NNUE 已安装"
elif [[ -x "${PIKAFISH_BIN}" && ! -f "${PIKAFISH_NNUE}" ]]; then
    echo "  [remote] ⚠ NNUE 文件缺失，Pikafish 可能无法正常工作"
fi

# ── 重启 PM2 服务 ──
echo "  [remote] 重启服务..."
cd "${DEPLOY_DIR}"
pm2 delete flipchess-server >/dev/null 2>&1 || true

export MYSQL_HOST=127.0.0.1
export MYSQL_PORT=3306
export MYSQL_USER="${MYSQL_APP_USER}"
export MYSQL_PASSWORD="${MYSQL_APP_PASSWORD}"
export MYSQL_DATABASE="${MYSQL_APP_DB}"

if [[ -x "${PIKAFISH_BIN}" ]]; then
    export PIKAFISH_JIEQI_PATH="${PIKAFISH_BIN}"
    if [[ -f "${PIKAFISH_NNUE}" ]]; then
        export PIKAFISH_EVALFILE_PATH="${PIKAFISH_NNUE}"
    fi
    export PIKAFISH_THREADS=1
    export PIKAFISH_HASH_MB=64
    export PIKAFISH_MAX_THINK_MS=20000
    echo "  [remote] ✓ Pikafish 启用: ${PIKAFISH_BIN}"
fi

pm2 start npm --name flipchess-server -- run server:start
sleep 3
pm2 save

# ── 恢复 nginx HTTPS 配置 ──
echo "  [remote] 配置 nginx..."
if [[ -f /root/flipchess-nginx.conf ]]; then
    cp /root/flipchess-nginx.conf /etc/nginx/sites-available/flipchess.conf
    rm -f /root/flipchess-nginx.conf
fi
ln -sf /etc/nginx/sites-available/flipchess.conf /etc/nginx/sites-enabled/flipchess.conf
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl restart nginx

echo "  [remote] ✓ 部署完成"
REMOTE_SCRIPT

echo "  ✓ 远程部署完成"

# ── 步骤 5: 健康检查 ──
echo "▶ [5/6] 健康检查..."
sleep 2

HEALTH=$(_ssh "curl -sS -m 5 http://127.0.0.1:3001/api/health 2>/dev/null || echo '{}'")
echo "  API: ${HEALTH}"

WEB_STATUS=$(_ssh "curl -I -sS -m 5 http://127.0.0.1:33333 2>/dev/null | head -n1 || echo 'FAIL'")
echo "  Web: ${WEB_STATUS}"

HTTPS_STATUS=$(_ssh "curl -I -sS -m 5 https://${DOMAIN} 2>/dev/null | head -n1 || echo 'N/A'")
echo "  HTTPS: ${HTTPS_STATUS}"

# ── 步骤 6: PM2 状态 ──
echo "▶ [6/6] PM2 状态..."
_ssh "pm2 list" || true

echo
echo "════════════════════════════════════════════"
echo "  部署完成!"
echo "  HTTP:  http://${DOMAIN}:33333"
echo "  HTTPS: https://${DOMAIN}"
echo "════════════════════════════════════════════"
