#!/usr/bin/env bash
# The one wrapper every scheduled job goes through.
#
#   pipeline/cron.sh <job> <command...>
#   pipeline/cron.sh nightly node pipeline/run.js pacevector
#
# cron hands a job almost nothing: a PATH of /usr/bin:/bin, no shell profile, no
# environment, and $HOME as the working directory. Everything a job needs is set
# here, once, so that a command which works in a terminal also works at 02:00.
#
# It never exits non-zero for its own reasons. The exit status belongs to the
# command, because that status is what says whether the night worked.
set -uo pipefail

JOB="${1:-}"
if [ -z "$JOB" ] || [ "$#" -lt 2 ]; then
  echo "usage: cron.sh <job> <command...>   e.g. cron.sh nightly node pipeline/run.js pacevector" >&2
  exit 2
fi
shift

# --- 1. PATH, set here and never inherited ---------------------------------
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH

# --- 2. The repo, by absolute path -----------------------------------------
# Resolved from this script's own location rather than written in, so a checkout
# that lives somewhere else still runs. cron starts every job in $HOME.
REPO="$(cd -- "$(dirname -- "$(readlink -f -- "$0")")/.." && pwd)"
cd "$REPO" || { echo "cannot cd to $REPO" >&2; exit 2; }

# --- 3. .env, by absolute path ---------------------------------------------
# The credentials config.md documents: the bot token, the provider key. cron
# reads no profile, so nothing else brings them in.
ENV_FILE="$REPO/.env"
if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi

# node and the claude CLI often live outside the system path (nvm, fnm,
# ~/.local/bin). PATH_EXTRA in .env is where the box says where, so this file
# stays the same on every box. It extends the explicit PATH, never replaces it.
if [ -n "${PATH_EXTRA:-}" ]; then
  PATH="$PATH:$PATH_EXTRA"
  export PATH
fi

# --- 4. The log ------------------------------------------------------------
LOG_DIR="${CRON_LOG_DIR:-$HOME/logs}"
mkdir -p "$LOG_DIR" || { echo "cannot create $LOG_DIR" >&2; exit 2; }
LOG="$LOG_DIR/$JOB-$(date +%F).log"
# Everything from here, the wrapper's own lines included, goes to the log:
# whatever the alert quotes has to be in the file it names.
exec >>"$LOG" 2>&1

echo "=== $JOB  $(date -Is)  $* ==="
echo "    repo $REPO"
echo "    path $PATH"

# --- Telegram --------------------------------------------------------------
# With the variables unset the message goes to the log instead, which is the
# same bargain the rest of the pipeline strikes: a missing notifier is never
# the reason a job fails.
notify() {
  if [ -z "${TELEGRAM_BOT_TOKEN:-}" ] || [ -z "${TELEGRAM_CHAT_ID:-}" ]; then
    echo "[telegram: TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID unset, not sent]"
    echo "$1"
    return 0
  fi
  curl -sS --max-time 15 -o /dev/null \
    --data-urlencode "chat_id=${TELEGRAM_CHAT_ID}" \
    --data-urlencode "text=$1" \
    --data-urlencode "disable_web_page_preview=true" \
    "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
    || echo "[telegram failed to send]"
}

# --- 5. The lock -----------------------------------------------------------
# One lock for every job, not one per job: the point is that the nightly and
# the packet can never run at the same time, whatever the clock says. A job that
# cannot take it says so and leaves, rather than queueing behind a run that may
# be stuck.
LOCK="${CRON_LOCK:-$HOME/.cache/content-machine/cron.lock}"
mkdir -p "$(dirname "$LOCK")"
exec 200>"$LOCK"
if ! flock -n 200; then
  echo "another content-machine job holds $LOCK; skipping this $JOB"
  notify "cron $JOB skipped on $(hostname): another job was still running."
  exit 0
fi

# --- 6. The job ------------------------------------------------------------
STARTED=$(date +%s)
"$@"
STATUS=$?
ELAPSED=$(( $(date +%s) - STARTED ))
echo "=== $JOB exit $STATUS after ${ELAPSED}s ==="

if [ "$STATUS" -ne 0 ]; then
  notify "$(printf '%s\n' \
    "cron $JOB FAILED on $(hostname): exit $STATUS after ${ELAPSED}s" \
    "$*" \
    "$LOG" \
    "" \
    "$(tail -n 20 "$LOG")")"
fi

exit "$STATUS"
