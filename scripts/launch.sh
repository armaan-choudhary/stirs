#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV_DIR="${PROJECT_DIR}/.venv"

for command_name in python3 node npm ffmpeg; do
  if ! command -v "${command_name}" >/dev/null 2>&1; then
    echo "Required command not found: ${command_name}" >&2
    exit 1
  fi
done

if [[ ! -d "${VENV_DIR}" ]]; then
  echo "Creating Python virtual environment..."
  python3 -m venv "${VENV_DIR}"
fi

PYTHON="${VENV_DIR}/bin/python"
PIP="${VENV_DIR}/bin/pip"

# pip install is idempotent and also picks up changed requirements.
echo "Preparing backend dependencies..."
"${PIP}" install -r "${PROJECT_DIR}/backend/requirements.txt"

if [[ ! -d "${PROJECT_DIR}/frontend/node_modules" ]]; then
  echo "Installing frontend dependencies..."
  (cd "${PROJECT_DIR}/frontend" && npm ci)
fi

mkdir -p "${PROJECT_DIR}/workspace" "${PROJECT_DIR}/checkpoints/sam2"

backend_pid=""
frontend_pid=""
cleanup() {
  trap - EXIT INT TERM
  [[ -z "${backend_pid}" ]] || kill "${backend_pid}" 2>/dev/null || true
  [[ -z "${frontend_pid}" ]] || kill "${frontend_pid}" 2>/dev/null || true
  [[ -z "${backend_pid}" ]] || wait "${backend_pid}" 2>/dev/null || true
  [[ -z "${frontend_pid}" ]] || wait "${frontend_pid}" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

cd "${PROJECT_DIR}"
echo "Starting backend at http://localhost:8000"
PYTHONPATH="${PROJECT_DIR}/backend" "${PYTHON}" -m uvicorn backend.main:app --host 0.0.0.0 --port 8000 &
backend_pid=$!

echo "Starting frontend at http://localhost:3000"
(cd "${PROJECT_DIR}/frontend" && npm run dev -- --host 0.0.0.0) &
frontend_pid=$!

echo "Press Ctrl+C to stop both services."
set +e
wait -n "${backend_pid}" "${frontend_pid}"
exit_code=$?
set -e
exit "${exit_code}"
