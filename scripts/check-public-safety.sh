#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

if git ls-files | rg -n '(^|/)(\.env|.*\.pem|.*\.key|.*\.p12|.*credentials?.*|.*api[_-]?key.*)$'; then
  echo "A secret-bearing filename is tracked" >&2
  exit 1
fi

mapfile -d '' tracked_files < <(git ls-files -z)

if rg -n -I \
  -g '!package-lock.json' \
  -e 'sk_live_[A-Za-z0-9]{12,}' \
  -e 'rk_live_[A-Za-z0-9]{12,}' \
  -e 'whsec_[A-Za-z0-9]{20,}' \
  -e '-----BEGIN ([A-Z ]+ )?PRIVATE KEY-----' \
  "${tracked_files[@]}"; then
  echo "A value resembling a live credential is tracked" >&2
  exit 1
fi

echo "Public-safety scan passed"
