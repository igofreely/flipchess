#!/usr/bin/env bash
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive
MYSQL_APP_USER="${MYSQL_APP_USER:-flipchess}"
MYSQL_APP_PASSWORD="${MYSQL_APP_PASSWORD:-hook499A}"
MYSQL_APP_DB="${MYSQL_APP_DB:-flipchess}"

apt-get update -y
apt-get install -y curl ca-certificates gnupg lsb-release

if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

npm i -g pm2
apt-get install -y nginx
if ! apt-get install -y default-mysql-server; then
  apt-get install -y mariadb-server
fi

if systemctl list-unit-files | grep -q '^mariadb.service'; then
  systemctl enable mariadb
  systemctl start mariadb
else
  systemctl enable mysql
  systemctl start mysql
fi

mysql -uroot <<SQL
CREATE DATABASE IF NOT EXISTS \`${MYSQL_APP_DB}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS '${MYSQL_APP_USER}'@'127.0.0.1' IDENTIFIED BY '${MYSQL_APP_PASSWORD}';
ALTER USER '${MYSQL_APP_USER}'@'127.0.0.1' IDENTIFIED BY '${MYSQL_APP_PASSWORD}';
GRANT ALL PRIVILEGES ON \`${MYSQL_APP_DB}\`.* TO '${MYSQL_APP_USER}'@'127.0.0.1';
FLUSH PRIVILEGES;
SQL

rm -rf /opt/flipchess
mkdir -p /opt/flipchess

tar -xzf /root/flipchess-deploy.tar.gz -C /opt/flipchess
cd /opt/flipchess

npm install
VITE_SERVER_API_BASE=/api npm run build

pm2 delete flipchess-server >/dev/null 2>&1 || true
pm2 delete flipchess-web >/dev/null 2>&1 || true

MYSQL_HOST=127.0.0.1 MYSQL_PORT=3306 MYSQL_USER="${MYSQL_APP_USER}" MYSQL_PASSWORD="${MYSQL_APP_PASSWORD}" MYSQL_DATABASE="${MYSQL_APP_DB}" \
  pm2 start npm --name flipchess-server -- run server:start

cat >/etc/nginx/sites-available/flipchess.conf <<'NGINX'
server {
  listen 33333;
  server_name _;

  root /opt/flipchess/dist;
  index index.html;

  location /api/ {
    proxy_pass http://127.0.0.1:3001/api/;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }

  location / {
    try_files $uri $uri/ /index.html;
  }
}
NGINX

ln -sf /etc/nginx/sites-available/flipchess.conf /etc/nginx/sites-enabled/flipchess.conf
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl enable nginx
systemctl restart nginx

pm2 save
pm2 startup systemd -u root --hp /root >/tmp/pm2-startup.txt 2>&1 || true

echo '---HEALTH---'
sleep 2
curl -sS http://127.0.0.1:3001/api/health
echo

echo '---WEB---'
curl -I -sS http://127.0.0.1:33333 | head -n 1

echo '---PM2---'
pm2 list
