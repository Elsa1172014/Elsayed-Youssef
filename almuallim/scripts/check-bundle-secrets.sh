#!/usr/bin/env bash
# Fails if a server-only secret name or an OpenAI-style key appears in the client bundle. Run after `npm run build`.
set -euo pipefail
if grep -rEl "SUPABASE_SERVICE_ROLE_KEY|OPENAI_API_KEY|CRON_SECRET|sk-[A-Za-z0-9_-]{20,}" .next/static 2>/dev/null; then
  echo "SECRET LEAK in client bundle" >&2; exit 1
fi
echo "client bundle clean"
