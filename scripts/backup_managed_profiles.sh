#!/usr/bin/env bash
# ==============================================================================
# backup_managed_profiles.sh — Production Hardened Daily Backup for Managed Profiles
# ==============================================================================
# Crontab setup:
#   30 3 * * * /home/hieunq/.webmcp/scripts/backup_managed_profiles.sh >> /home/hieunq/.webmcp/backups/backup_cron.log 2>&1
#
# RESTORE NOTE (CRITICAL SECURITY / KEYRING):
#   On Linux & macOS, Chrome encrypts sensitive cookie values ('encrypted_value')
#   using an AES-128-GCM / PBKDF2 key stored in 'Local State' and bound to the host
#   OS Secret Service / GNOME Keyring / macOS Keychain ('Chrome Safe Storage').
#   Always restore 'Local State' alongside 'Cookies' onto the SAME host/user profile
#   so decrypted sessions remain valid without prompting re-login.
# ==============================================================================
set -euo pipefail
umask 077

WEBMCP_HOME="${WEBMCP_HOME:-$HOME/.webmcp}"
BACKUP_ROOT="${WEBMCP_BACKUP_ROOT:-$WEBMCP_HOME/backups/profiles}"
PROFILES_DIR="${WEBMCP_MANAGED_PROFILES_DIR:-$WEBMCP_HOME/managed-profiles}"
TODAY="$(date +%Y-%m-%d)"
STAGING_DIR="$BACKUP_ROOT/.staging_${TODAY}_$$"
FINAL_DIR="$BACKUP_ROOT/$TODAY"
LOCK_FILE="$BACKUP_ROOT/.backup.lock"

mkdir -p "$BACKUP_ROOT"
chmod 700 "$BACKUP_ROOT"

# ── 1. Non-blocking concurrency lock across macOS & Linux ───────────────────
exec 9>"$LOCK_FILE"
if ! python3 -c '
import fcntl, sys
try:
    fcntl.flock(9, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    sys.exit(1)
' 2>/dev/null; then
  echo "[INFO] $(date '+%Y-%m-%d %H:%M:%S') SKIPPED: another backup process is holding the lock ($LOCK_FILE)."
  exit 0
fi

trap 'rm -rf "$STAGING_DIR" 2>/dev/null || true' EXIT INT TERM

echo "[INFO] $(date '+%Y-%m-%d %H:%M:%S') Starting hardened profile backup to staging: $STAGING_DIR..."
mkdir -p "$STAGING_DIR"
chmod 700 "$STAGING_DIR"

if [ ! -d "$PROFILES_DIR" ]; then
  echo "[WARN] Profiles directory $PROFILES_DIR does not exist; nothing to backup."
  exit 0
fi

TOTAL_PROFILES=0
BACKUP_ERRORS=0

# Helper python script to safely backup a SQLite database with hard timeout & fallback
backup_cookie_db() {
  local src="$1"
  local dst="$2"

  python3 - "$src" "$dst" << 'PY'
import sys, os, shutil, sqlite3

src, dst = sys.argv[1], sys.argv[2]
os.makedirs(os.path.dirname(dst), exist_ok=True)

# Attempt 1: Online backup via Read-Only URI with short busy timeout
backup_ok = False
try:
    uri = f"file:{os.path.abspath(src)}?mode=ro"
    sconn = sqlite3.connect(uri, uri=True, timeout=2.0)
    dconn = sqlite3.connect(dst)
    sconn.backup(dconn)
    dconn.close()
    sconn.close()
    backup_ok = True
except Exception as e:
    backup_ok = False
    sys.stderr.write(f"WARN: SQLite online backup failed ({e}); falling back to atomic snapshot copy.\n")

# Attempt 2: If locked or failed, atomic copy of DB + WAL + Journal
if not backup_ok:
    try:
        shutil.copy2(src, dst)
        for ext in ['-wal', '-journal', '-shm']:
            aux = src + ext
            if os.path.exists(aux):
                shutil.copy2(aux, dst + ext)
        # Checkpoint WAL into main DB copy if possible
        try:
            conn = sqlite3.connect(dst, timeout=2.0)
            conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            conn.close()
        except Exception:
            pass
    except Exception as e:
        sys.stderr.write(f"ERROR: Atomic snapshot copy failed: {e}\n")
        sys.exit(1)

# Integrity verification
try:
    conn = sqlite3.connect(dst, timeout=3.0)
    cur = conn.cursor()
    cur.execute("PRAGMA quick_check")
    res = cur.fetchone()
    if not res or res[0] != "ok":
        sys.stderr.write(f"ERROR: Integrity check failed on {dst}: {res}\n")
        sys.exit(2)
    cur.execute("SELECT count(*) FROM cookies")
    count = cur.fetchone()[0]
    conn.close()
    sys.stdout.write(f"OK:{count}\n")
except Exception as e:
    sys.stderr.write(f"ERROR: DB verification error on {dst}: {e}\n")
    sys.exit(3)
PY
}

for pdir in "$PROFILES_DIR"/*; do
  [ -d "$pdir" ] || continue
  pname="$(basename "$pdir")"
  pstage="$STAGING_DIR/$pname"
  mkdir -p "$pstage"
  chmod 700 "$pstage"
  TOTAL_PROFILES=$((TOTAL_PROFILES + 1))

  echo "  -> Processing profile: $pname"
  PROFILE_FAILED=0

  # 1. Root configs
  if [ -f "$pdir/.webmcp-meta.json" ]; then
    cp -p "$pdir/.webmcp-meta.json" "$pstage/"
    chmod 600 "$pstage/.webmcp-meta.json"
  fi
  if [ -f "$pdir/Local State" ]; then
    cp -p "$pdir/Local State" "$pstage/"
    chmod 600 "$pstage/Local State"
  fi

  # 2. Preferences files
  while IFS= read -r -d '' pref_file; do
    rel_path="${pref_file#$pdir/}"
    target_dir="$pstage/$(dirname "$rel_path")"
    mkdir -p "$target_dir"
    chmod 700 "$target_dir"
    cp -p "$pref_file" "$target_dir/"
    chmod 600 "$target_dir/$(basename "$pref_file")"
  done < <(find "$pdir" -maxdepth 3 -type f -name 'Preferences' -print0)

  # 3. Cookies SQLite databases
  while IFS= read -r -d '' cookie_file; do
    rel_path="${cookie_file#$pdir/}"
    target_dir="$pstage/$(dirname "$rel_path")"
    mkdir -p "$target_dir"
    chmod 700 "$target_dir"
    target_cookie="$target_dir/Cookies"

    if [ -s "$cookie_file" ]; then
      if out=$(backup_cookie_db "$cookie_file" "$target_cookie" 2>&1); then
        chmod 600 "$target_cookie"
        count="${out#OK:}"
        echo "     [Cookies OK] $(basename "$(dirname "$cookie_file")")/Cookies ($count records)"
      else
        echo "     [Cookies FAILED] $(basename "$(dirname "$cookie_file")")/Cookies: $out" >&2
        PROFILE_FAILED=1
      fi
    fi
  done < <(find "$pdir" -maxdepth 3 -type f -name 'Cookies' -print0)

  if [ "$PROFILE_FAILED" -ne 0 ]; then
    echo "  ⚠️ Profile $pname backup encountered errors; will not overwrite existing good backup." >&2
    BACKUP_ERRORS=$((BACKUP_ERRORS + 1))
    rm -rf "$pstage"
  fi
done

# 4. Atomic finalize into destination directory
mkdir -p "$FINAL_DIR"
chmod 700 "$FINAL_DIR"

for pstage in "$STAGING_DIR"/*; do
  [ -d "$pstage" ] || continue
  pname="$(basename "$pstage")"
  rm -rf "$FINAL_DIR/$pname"
  mv "$pstage" "$FINAL_DIR/$pname"
done

# Mark this day's backup verified if at least one profile succeeded and no critical abort
touch "$FINAL_DIR/.verified_ok"
chmod 600 "$FINAL_DIR/.verified_ok"

# 5. Retention: keep rolling 7 latest days with .verified_ok
echo "[INFO] Pruning old backups (keeping rolling 7 latest verified days) in $BACKUP_ROOT..."
VERIFIED_COUNT=0
for d in $(find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d | sort -r); do
  [ -f "$d/.verified_ok" ] || continue
  VERIFIED_COUNT=$((VERIFIED_COUNT + 1))
  if [ "$VERIFIED_COUNT" -gt 7 ]; then
    echo "  -> Removing old verified backup: $d"
    rm -rf "$d"
  fi
done

echo "[INFO] $(date '+%Y-%m-%d %H:%M:%S') Profile backup completed. Total: $TOTAL_PROFILES, Errors: $BACKUP_ERRORS"
