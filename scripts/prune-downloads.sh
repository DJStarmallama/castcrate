#!/usr/bin/env bash
#
# prune-downloads.sh — Nightly retention prune for CastCrate downloads.
#
# Replaces the inline `find` command that castcrate-prune.service used to run
# (see docs/features/castcrate/media-mac-deploy/tasks.md Phase 7). Adds
# awareness of ~/.castcrate/library.json's pinned entries so Watch Later
# titles the user has explicitly kept survive the retention window.
#
# ENV:
#   DOWNLOAD_PATH   — root directory to prune (default /home/castcrate/castcrate-downloads)
#   HISTORY_DIR     — directory holding library.json (default /home/castcrate/.castcrate)
#   RETENTION_DAYS  — mtime threshold; files older than N days are deleted (default 14)
#
# FAIL-SAFE contract (inviolable — see watch-later Phase 5):
# - Manifest missing entirely: prune runs normally (clean-install case).
# - Manifest present but unreadable / malformed: EXIT NON-ZERO WITHOUT DELETING
#   ANYTHING. Never destroy user files when we cannot verify the pin list.
#
# Runbook: deploy to /opt/castcrate/scripts/ ; chmod 755 ; the
# castcrate-prune.service unit's ExecStart= points here.
#
# Depends on: jq (for pinned-path extraction). apt install -y jq.

set -euo pipefail

DOWNLOAD_PATH="${DOWNLOAD_PATH:-/home/castcrate/castcrate-downloads}"
LIBRARY_JSON="${HISTORY_DIR:-/home/castcrate/.castcrate}/library.json"
RETENTION_DAYS="${RETENTION_DAYS:-14}"

echo "[prune] download-path=${DOWNLOAD_PATH} library-json=${LIBRARY_JSON} retention=${RETENTION_DAYS}d"

if [ ! -d "${DOWNLOAD_PATH}" ]; then
  echo "[prune] download-path does not exist — nothing to do"
  exit 0
fi

# -----------------------------------------------------------------------------
# Build the pinned-path exclusion list.
# -----------------------------------------------------------------------------
# We stash pinned paths in a temp file so `find` can compare each candidate
# path via a fixed-string grep. This avoids the fragility of a long
# `-not -path` chain (which requires exact literal matches — including any
# glob-metacharacter quirks — and blows out the argv when the pin count
# grows). grep -F -x -f handles the "is this exact absolute path in the
# pinned set?" question cleanly and portably.
#
# Fail-safe: if jq fails on a present manifest, we log and exit non-zero
# WITHOUT deleting anything. The systemd unit will report the failure via
# journalctl; the operator investigates before the next run.
PINNED_LIST_FILE=$(mktemp -t castcrate-pinned.XXXXXX)
trap 'rm -f "${PINNED_LIST_FILE}"' EXIT

if [ -f "${LIBRARY_JSON}" ]; then
  if ! jq -r '.[] | select(.pinned == true and .filePath != null) | .filePath' \
      "${LIBRARY_JSON}" > "${PINNED_LIST_FILE}" 2>/dev/null; then
    echo "[prune] ERROR: ${LIBRARY_JSON} is unreadable or malformed — skipping prune (fail-safe). No files deleted."
    exit 1
  fi
  pinned_count=$(grep -c . "${PINNED_LIST_FILE}" || true)
  echo "[prune] pinned files loaded: ${pinned_count}"
else
  # No manifest → treat as empty pinned list. Clean-install case; safe.
  : > "${PINNED_LIST_FILE}"
  echo "[prune] no library.json — pruning without exclusions (clean-install case)"
fi

# -----------------------------------------------------------------------------
# Enumerate + filter + delete.
# -----------------------------------------------------------------------------
# Two-pass so we can log a summary. Pass 1 gathers candidates. Pass 2 checks
# each against the pinned list. Pass 3 deletes.
CANDIDATES_FILE=$(mktemp -t castcrate-candidates.XXXXXX)
trap 'rm -f "${PINNED_LIST_FILE}" "${CANDIDATES_FILE}"' EXIT

# -print0 + read -d '' → newline-safe. Not strictly necessary for our
# torrent-download paths (rare to see \n in filenames) but cheap insurance.
find "${DOWNLOAD_PATH}" -type f -mtime "+${RETENTION_DAYS}" -print0 \
  > "${CANDIDATES_FILE}"

found=0
skipped=0
deleted=0

while IFS= read -r -d '' path; do
  found=$((found + 1))
  # Only compare when we have a non-empty pinned list — grep with empty -f
  # pattern file exits 1, which under `set -e` would abort the loop.
  if [ -s "${PINNED_LIST_FILE}" ] && \
      grep -Fxq -- "${path}" "${PINNED_LIST_FILE}"; then
    skipped=$((skipped + 1))
    echo "[prune] SKIP (pinned) ${path}"
    continue
  fi
  if rm -- "${path}"; then
    deleted=$((deleted + 1))
    echo "[prune] DELETE ${path}"
  else
    echo "[prune] WARN failed to delete ${path}"
  fi
done < "${CANDIDATES_FILE}"

echo "[prune] summary: found=${found} skipped=${skipped} deleted=${deleted}"

# -----------------------------------------------------------------------------
# Empty-dir sweep — matches the pre-feature behaviour.
# -----------------------------------------------------------------------------
find "${DOWNLOAD_PATH}" -type d -empty -delete 2>/dev/null || true

echo "[prune] done"
