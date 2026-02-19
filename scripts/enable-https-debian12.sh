#!/usr/bin/env bash
set -euo pipefail

DOMAIN="${DOMAIN:-ds.hookapp.top}"
WEB_ROOT="/opt/flipchess/dist"
SSL_DIR="/etc/ssl/flipchess"

export DEBIAN_FRONTEND=noninteractive

apt-get update -y
apt-get install -y nginx socat curl

if [ ! -d "$WEB_ROOT" ]; then
  echo "[https] web root not found: $WEB_ROOT"
  exit 1
fi

echo "[https] issuing cert via acme.sh (ALPN on 443)..."
systemctl stop nginx || true
if [ ! -x /root/.acme.sh/acme.sh ]; then
    curl -fsSL https://get.acme.sh | sh -s email=admin@${DOMAIN}
fi
/root/.acme.sh/acme.sh --set-default-ca --server letsencrypt
/root/.acme.sh/acme.sh --issue --standalone --alpn -d "$DOMAIN" --keylength ec-256

mkdir -p "$SSL_DIR"
/root/.acme.sh/acme.sh --install-cert -d "$DOMAIN" --ecc \
    --fullchain-file "$SSL_DIR/fullchain.pem" \
    --key-file "$SSL_DIR/privkey.pem" \
    --reloadcmd "systemctl reload nginx"

cat >/etc/nginx/sites-available/flipchess.conf <<NGINX
server {
    listen 80;
    server_name ${DOMAIN};
    return 301 https://\$host\$request_uri;
}

server {
    listen 33333;
    server_name ${DOMAIN};

    root ${WEB_ROOT};
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

    root ${WEB_ROOT};
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
NGINX

ln -sf /etc/nginx/sites-available/flipchess.conf /etc/nginx/sites-enabled/flipchess.conf
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl enable nginx
systemctl restart nginx

mkdir -p /usr/local/bin
cat >/usr/local/bin/flipchess-renew-cert.sh <<'RENEW'
#!/usr/bin/env bash
set -euo pipefail
/root/.acme.sh/acme.sh --cron --home /root/.acme.sh
RENEW
chmod +x /usr/local/bin/flipchess-renew-cert.sh

cat >/etc/cron.d/flipchess-cert-renew <<'CRON'
17 4 * * * root /usr/local/bin/flipchess-renew-cert.sh >/var/log/flipchess-cert-renew.log 2>&1
CRON

echo "[https] done"
