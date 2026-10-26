#!/usr/bin/env bash
# One-time setup of the API server on a fresh AWS Lightsail Ubuntu 24.04 instance.
# Run on the server as the default `ubuntu` user:
#   curl -fsSL https://raw.githubusercontent.com/sujalappa/Tender-Intelligence/main/deploy/aws/setup-server.sh | bash -s -- <PUBLIC_IP>
# or copy this file up and run:  bash setup-server.sh <PUBLIC_IP>
#
# Installs Node 24, git, PM2 (keeps the API running, restarts it on crash/reboot)
# and Caddy (HTTPS in front of the API, certificate issued automatically for
# <ip-with-dashes>.sslip.io — no domain needed). Uploaded tender files live in
# /var/data/uploads, on the instance's own disk, so deploys never delete them.
set -euo pipefail

IP="${1:?usage: setup-server.sh <PUBLIC_STATIC_IP>}"
HOST="${IP//./-}.sslip.io"
APP_DIR="$HOME/Tender-Intelligence"
REPO="https://github.com/sujalappa/Tender-Intelligence.git"

echo "==> System packages"
sudo apt-get update -y
sudo apt-get install -y git curl ca-certificates gnupg debian-keyring debian-archive-keyring apt-transport-https

echo "==> Node.js 24"
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs

echo "==> PM2"
sudo npm install -g pm2

echo "==> Caddy"
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
sudo apt-get update -y
sudo apt-get install -y caddy

echo "==> Swap (2 GB) — headroom for parsing very large PDFs"
if ! swapon --show | grep -q /swapfile; then
  sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
  echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
fi

echo "==> Upload folder"
sudo mkdir -p /var/data/uploads
sudo chown -R "$USER":"$USER" /var/data

echo "==> Code"
if [ ! -d "$APP_DIR" ]; then git clone "$REPO" "$APP_DIR"; fi
cd "$APP_DIR/server"
npm ci --omit=dev

echo "==> Caddy config for https://$HOST"
sed "s/__HOST__/$HOST/" "$APP_DIR/deploy/aws/Caddyfile.template" | sudo tee /etc/caddy/Caddyfile >/dev/null
sudo systemctl reload caddy || sudo systemctl restart caddy

cat <<EOF

==> Done. Remaining steps:
  1. Create $APP_DIR/server/.env (copy from your local server/.env — never via git), and add/set:
       UPLOAD_DIR=/var/data/uploads
       COOKIE_SECURE=true
       COOKIE_CROSS_SITE=true
       ALLOWED_ORIGINS=https://<your-distribution>.cloudfront.net
       OPENROUTER_SITE_URL=https://<your-distribution>.cloudfront.net
  2. Start the API:
       cd $APP_DIR && pm2 start deploy/aws/ecosystem.config.cjs && pm2 save
       pm2 startup systemd -u $USER --hp $HOME   # then run the sudo line it prints
  3. Check: curl https://$HOST/api/health
  API address for the client build (VITE_API_URL): https://$HOST
EOF
