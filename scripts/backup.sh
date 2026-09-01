#!/usr/bin/env bash
set -Eeuo pipefail

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "Error: DATABASE_URL is not set" >&2
  exit 1
fi

for required_command in pg_dump gzip sha256sum mktemp date find; do
  if ! command -v "$required_command" >/dev/null 2>&1; then
    echo "Error: required command '$required_command' is not available" >&2
    exit 1
  fi
done

retention_days="${SAUTA_BACKUP_RETENTION_DAYS:-30}"
if [[ ! "$retention_days" =~ ^[0-9]+$ ]]; then
  echo "Error: SAUTA_BACKUP_RETENTION_DAYS must be a non-negative integer" >&2
  exit 1
fi

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
backup_dir="${SAUTA_BACKUP_DIR:-"$script_dir/../backups"}"
clean_database_url="${DATABASE_URL%%\?*}"
timestamp="$(date -u +'%Y%m%dT%H%M%SZ')"
backup_name="sauta_${timestamp}_$$.sql.gz"
backup_file="$backup_dir/$backup_name"
checksum_file="$backup_file.sha256"

umask 077
mkdir -p -- "$backup_dir"
partial_file="$(mktemp "$backup_dir/.sauta_backup.XXXXXX")"

cleanup() {
  rm -f -- "$partial_file"
}
trap cleanup EXIT INT TERM

if ! PGDATABASE="$clean_database_url" pg_dump --no-owner --no-privileges | gzip -c >"$partial_file"; then
  echo "Error: pg_dump failed; no backup was published" >&2
  exit 1
fi

if [[ ! -s "$partial_file" ]] || ! gzip -t "$partial_file"; then
  echo "Error: generated backup is empty or invalid" >&2
  exit 1
fi

mv -- "$partial_file" "$backup_file"
if ! (
  cd -- "$backup_dir"
  sha256sum -- "$backup_name" >"$backup_name.sha256"
); then
  rm -f -- "$backup_file" "$checksum_file"
  echo "Error: checksum generation failed; backup was removed" >&2
  exit 1
fi

find "$backup_dir" -maxdepth 1 -type f \
  \( -name 'sauta_*.sql.gz' -o -name 'sauta_*.sql.gz.sha256' \) \
  -mtime "+$retention_days" -delete

trap - EXIT INT TERM
echo "Backup successful: $backup_file"
