#!/usr/bin/env bash
# One-command setup and start.
#   ./scripts/setup.sh                    # plain HTTP on port 80
#   ./scripts/setup.sh tv.example.com     # automatic HTTPS for your domain
#   ./scripts/setup.sh --no-start         # only create .env
set -euo pipefail
cd "$(dirname "$0")/.."

start=1
domain=""
for arg in "$@"; do
  case "$arg" in
    --no-start) start=0 ;;
    *) domain="$arg" ;;
  esac
done

if [ ! -f .env ]; then
  command -v openssl >/dev/null || { echo "openssl is required to generate secrets" >&2; exit 1; }
  umask 077
  {
    echo "POSTGRES_PASSWORD=$(openssl rand -hex 24)"
    echo "SECRET_KEY=$(openssl rand -base64 32)"
    echo "SITE_ADDRESS=${domain:-:80}"
  } > .env
  echo "Created .env with fresh random secrets (keep a private copy: it holds your encryption key)."
elif [ -n "$domain" ]; then
  if grep -q '^SITE_ADDRESS=' .env; then sed -i.bak "s|^SITE_ADDRESS=.*|SITE_ADDRESS=$domain|" .env && rm -f .env.bak; else echo "SITE_ADDRESS=$domain" >> .env; fi
fi

[ "$start" = 1 ] || exit 0
command -v docker >/dev/null || { echo "Docker is not installed. See docs/DEPLOYMENT.md" >&2; exit 1; }
docker compose up -d --build --wait
site="$(grep '^SITE_ADDRESS=' .env | cut -d= -f2-)"
case "$site" in :*) url="http://localhost${site#:80}" ;; *) url="https://$site" ;; esac
echo
echo "Smart Receiver is running: $url"
echo "The free-channel catalog loads in the background (about a minute): docker compose logs -f worker"
