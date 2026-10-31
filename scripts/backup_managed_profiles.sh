#!/usr/bin/env bash
# ==============================================================================
# backup_managed_profiles.sh — Daily Safe SQLite & Config Backup for Managed Profiles
# ==============================================================================
# Backs up Cookies (via sqlite3 .backup to avoid WAL/journal locks while Chrome runs),
# Local State, Preferences, and .webmcp-meta.json for all managed profiles.
# Keeps rolling 7 latest days of backups under ~/.webmcp/backups/profiles/YYYY-MM-DD.
# ==============================================================================
set -euo pipefail

BACKUP_ROOT="/home/hieunq/.webmcp/backups/profiles"
TODAY="$(date +%Y-%m-%d)"
DEST_DIR="$BACKUP_ROOT/$TODAY"
PROFILES_DIR="/home/hieunq/.webmcp/managed-profiles"

echo "[INFO] $(date '+%Y-%m-%d %H:%M:%S') Starting managed profiles backup to $DEST_DIR..."
mkdir -p "$DEST_DIR"

for pdir in "$PROFILES_DIR"/*; do
  [ -d "$pdir" ] || continue
  pname="$(basename "$pdir")"
  pdest="$DEST_DIR/$pname"
  mkdir -p "$pdest"

  echo "  -> Backing up profile: $pname"

  # 1. Root configs
  [ -f "$pdir/.webmcp-meta.json" ] && cp -p "$pdir/.webmcp-meta.json" "$pdest/"
  [ -f "$pdir/Local State" ] && cp -p "$pdir/Local State" "$pdest/"

  # 2. Preferences files
  while IFS= read -r -d '' pref_file; do
    rel_path="${pref_file#$pdir/}"
    target_dir="$pdest/$(dirname "$rel_path")"
    mkdir -p "$target_dir"
    cp -p "$pref_file" "$target_dir/"
  done < <(find "$pdir" -maxdepth 3 -type f -name 'Preferences' -print0)

  # 3. Cookies SQLite databases (safe backup via sqlite3 .backup)
  while IFS= read -r -d '' cookie_file; do
    rel_path="${cookie_file#$pdir/}"
    target_dir="$pdest/$(dirname "$rel_path")"
    mkdir -p "$target_dir"
    target_cookie="$target_dir/Cookies"

    if [ -s "$cookie_file" ]; then
      if sqlite3 "$cookie_file" ".backup '$target_cookie'" 2>/dev/null; then
        :
      else
        python3 -c "
import sqlite3, sys
src, dst = sys.argv[1], sys.argv[2]
sconn = sqlite3.connect(src)
dconn = sqlite3.connect(dst)
sconn.backup(dconn)
dconn.close()
sconn.close()
" "$cookie_file" "$target_cookie" 2>/dev/null || cp -p "$cookie_file" "$target_cookie"
      fi
    fi
  done < <(find "$pdir" -maxdepth 3 -type f -name 'Cookies' -print0)

done

# 4. Prune old backups, keep rolling 7 latest days
echo "[INFO] Pruning backups older than 7 days in $BACKUP_ROOT..."
find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d | sort -r | tail -n +8 | while read -r old_dir; do
  [ -d "$old_dir" ] || continue
  echo "  -> Removing old backup: $old_dir"
  rm -rf "$old_dir"
done

echo "[INFO] $(date '+%Y-%m-%d %H:%M:%S') Profile backup completed successfully."
