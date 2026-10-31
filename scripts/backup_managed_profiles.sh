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
SUCCEEDED_PROFILES=0
BACKUP_ERRORS=0

# Helper python script to safely backup a SQLite database with hard 1.5s timeout & fallback
backup_cookie_db() {
  local src="$1"
  local dst="$2"

  python3 - "$src" "$dst" << 'PY'
import sys, os, shutil, sqlite3, subprocess

src, dst = sys.argv[1], sys.argv[2]
os.makedirs(os.path.dirname(dst), exist_ok=True)

# Attempt 1: Online backup in a child process with a hard 1.5s OS wall-clock timeout
# Pass src and dst via sys.argv to preserve special characters / quotes safely
backup_ok = False
backup_mode = "unknown"
online_code = (
    "import sys, os, sqlite3\n"
    "src, dst = sys.argv[1], sys.argv[2]\n"
    "uri = 'file:' + os.path.abspath(src) + '?mode=ro'\n"
    "sconn = sqlite3.connect(uri, uri=True, timeout=0.5)\n"
    "dconn = sqlite3.connect(dst)\n"
    "sconn.backup(dconn)\n"
    "dconn.close()\n"
    "sconn.close()\n"
)
try:
    p = subprocess.run(
        [sys.executable, "-c", online_code, src, dst],
        capture_output=True,
        text=True,
        timeout=1.5
    )
    if p.returncode == 0:
        backup_ok = True
        backup_mode = "online"
    else:
        sys.stderr.write(f"WARN: Online backup failed (rc={p.returncode}): {p.stderr.strip()}; falling back to snapshot copy.\n")
except subprocess.TimeoutExpired:
    sys.stderr.write("WARN: Online backup timed out after 1.5s (exclusive lock held); falling back to snapshot copy.\n")
except Exception as e:
    sys.stderr.write(f"WARN: Online backup invocation failed: {e}; falling back to snapshot copy.\n")

# Attempt 2: Atomic snapshot copy of DB + WAL + Journal + SHM
if not backup_ok:
    try:
        shutil.copy2(src, dst)
        for ext in ['-wal', '-journal', '-shm']:
            aux = src + ext
            if os.path.exists(aux):
                shutil.copy2(aux, dst + ext)
        # Checkpoint WAL into the destination DB file
        try:
            conn = sqlite3.connect(dst, timeout=2.0)
            conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            conn.close()
        except Exception:
            pass
        # Clean up auxiliary WAL/journal files from destination after checkpoint
        for ext in ['-wal', '-journal', '-shm']:
            aux_dst = dst + ext
            if os.path.exists(aux_dst):
                try: os.remove(aux_dst)
                except Exception: pass
        backup_mode = "snapshot"
    except Exception as e:
        sys.stderr.write(f"ERROR: Snapshot copy failed: {e}\n")
        sys.exit(1)

# Integrity verification via PRAGMA integrity_check
try:
    conn = sqlite3.connect(dst, timeout=3.0)
    cur = conn.cursor()
    cur.execute("PRAGMA integrity_check")
    rows = cur.fetchall()
    if not rows or rows[0][0] != "ok":
        sys.stderr.write(f"ERROR: PRAGMA integrity_check failed on {dst}: {rows}\n")
        sys.exit(2)
    cur.execute("SELECT count(*) FROM cookies")
    count = cur.fetchone()[0]
    conn.close()
    sys.stdout.write(f"OK:{backup_mode}:{count}\n")
except Exception as e:
    sys.stderr.write(f"ERROR: Integrity verification exception on {dst}: {e}\n")
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
      if out=$(backup_cookie_db "$cookie_file" "$target_cookie"); then
        chmod 600 "$target_cookie"
        last_line="$(printf '%s\n' "$out" | tail -n 1)"
        mode="$(printf '%s\n' "$last_line" | cut -d: -f2)"
        count="$(printf '%s\n' "$last_line" | cut -d: -f3)"
        echo "     [Cookies OK] $(basename "$(dirname "$cookie_file")")/Cookies (mode=$mode, $count records)"
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
  else
    touch "$pstage/.verified_ok"
    chmod 600 "$pstage/.verified_ok"
    SUCCEEDED_PROFILES=$((SUCCEEDED_PROFILES + 1))
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

# 5. Retention: keep rolling 7 latest days across all date folders
echo "[INFO] Pruning old backups (keeping rolling 7 latest days) in $BACKUP_ROOT..."
find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d ! -name ".staging*" | sort -r | tail -n +8 | while read -r old_dir; do
  [ -d "$old_dir" ] || continue
  echo "  -> Removing old backup: $old_dir"
  rm -rf "$old_dir"
done

# 6. Final verification & exit status
if [ "$BACKUP_ERRORS" -eq 0 ] && [ "$SUCCEEDED_PROFILES" -gt 0 ]; then
  touch "$FINAL_DIR/.verified_ok"
  chmod 600 "$FINAL_DIR/.verified_ok"
  echo "[INFO] $(date '+%Y-%m-%d %H:%M:%S') Profile backup completed successfully. Total: $TOTAL_PROFILES, Succeeded: $SUCCEEDED_PROFILES, Errors: 0"
  exit 0
else
  echo "[ALERT] $(date '+%Y-%m-%d %H:%M:%S') Backup finished with $BACKUP_ERRORS failed profile(s) (Succeeded: $SUCCEEDED_PROFILES, Total: $TOTAL_PROFILES)!" >&2
  rm -f "$FINAL_DIR/.verified_ok" 2>/dev/null || true
  rmdir "$FINAL_DIR" 2>/dev/null || true
  exit 1
fi
