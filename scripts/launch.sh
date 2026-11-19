#!/usr/bin/env bash
# Install project dependencies, then run the FastAPI backend and Vite frontend.
set -Eeuo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SETUP_SCRIPT="${PROJECT_DIR}/scripts/setup.sh"

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  bash "$SETUP_SCRIPT" --help
  exit 0
fi

if [[ ! -x "$SETUP_SCRIPT" ]]; then
  chmod +x "$SETUP_SCRIPT"
fi
bash "$SETUP_SCRIPT" "$@"

# The adapter reads these when the backend imports its configuration.
export EFFECT_ERASE_REPO_DIR="${EFFECT_ERASE_REPO_DIR:-${PROJECT_DIR}/external/EffectErase}"
export EFFECT_ERASE_PYTHON="${EFFECT_ERASE_PYTHON:-${PROJECT_DIR}/.venv-effecterase/bin/python}"
export EFFECT_ERASE_CHECKPOINTS_DIR="${EFFECT_ERASE_CHECKPOINTS_DIR:-${PROJECT_DIR}/checkpoints/effect_erase}"
export EFFECT_ERASE_DEVICE="${EFFECT_ERASE_DEVICE:-cuda}"

backend_pid=""
frontend_pid=""

cleanup() {
  trap - EXIT INT TERM
  printf '\n[stirs] Stopping services...\n'
  [[ -z "$backend_pid" ]] || kill "$backend_pid" 2>/dev/null || true
  [[ -z "$frontend_pid" ]] || kill "$frontend_pid" 2>/dev/null || true
  [[ -z "$backend_pid" ]] || wait "$backend_pid" 2>/dev/null || true
  [[ -z "$frontend_pid" ]] || wait "$frontend_pid" 2>/dev/null || true
  printf '[stirs] Services stopped.\n'
}
trap cleanup EXIT INT TERM

cd "$PROJECT_DIR"
printf '[stirs] Backend:  http://localhost:8000 (API docs: /docs)\n'
PYTHONPATH="${PROJECT_DIR}/backend:${PROJECT_DIR}" \
  "${PROJECT_DIR}/.venv/bin/python" -m uvicorn backend.main:app --host 0.0.0.0 --port 8000 &
backend_pid=$!

printf '[stirs] Frontend: http://localhost:3000\n'
(cd "${PROJECT_DIR}/frontend" && npm run dev -- --host 0.0.0.0 --port 3000) &
frontend_pid=$!

printf '[stirs] Press Ctrl+C to stop both services.\n'
set +e
wait -n "$backend_pid" "$frontend_pid"
exit_code=$?
set -e
exit "$exit_code"
