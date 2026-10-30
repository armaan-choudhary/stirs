#!/usr/bin/env bash
# ==============================================================================
# stirs - SAM 2 Model Weights Setup
# Automated checkpoint downloader with multi-tool support (curl / wget),
# progress tracking, safe temporary staging, and atomic placement.
# ==============================================================================
set -Eeuo pipefail

BASE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHECKPOINTS_DIR="${BASE_DIR}/checkpoints"
SAM2_DIR="${CHECKPOINTS_DIR}/sam2"
WORKSPACE_DIR="${BASE_DIR}/workspace"

mkdir -p "${SAM2_DIR}" "${WORKSPACE_DIR}"

SAM2_SMALL="${SAM2_DIR}/sam2.1_hiera_small.pt"
SAM2_LARGE="${SAM2_DIR}/sam2.1_hiera_large.pt"

SMALL_URL="https://dl.fbaipublicfiles.com/segment_anything_2/092824/sam2.1_hiera_small.pt"
LARGE_URL="https://dl.fbaipublicfiles.com/segment_anything_2/092824/sam2.1_hiera_large.pt"

echo "=== stirs: SAM 2 Model Weights Setup ==="
echo "Checkpoints root: ${SAM2_DIR}"

download_checkpoint() {
  local url="$1"
  local target_path="$2"
  local label="$3"
  local tmp_path="${target_path}.tmp.$$"

  echo "--> Downloading ${label} from Meta CDN..."
  if command -v curl >/dev/null 2>&1; then
    if ! curl -L --fail --retry 3 --retry-delay 2 --progress-bar "${url}" -o "${tmp_path}"; then
      rm -f "${tmp_path}"
      echo "[!] Error: Failed to download ${label} using curl." >&2
      return 1
    fi
  elif command -v wget >/dev/null 2>&1; then
    if ! wget --tries=3 --show-progress -q -O "${tmp_path}" "${url}"; then
      rm -f "${tmp_path}"
      echo "[!] Error: Failed to download ${label} using wget." >&2
      return 1
    fi
  else
    echo "[!] Error: Neither 'curl' nor 'wget' was found in PATH." >&2
    return 1
  fi

  # Validate downloaded file size (must be at least 10MB to avoid HTML error pages)
  local file_size=0
  if [[ -f "${tmp_path}" ]]; then
    file_size=$(wc -c < "${tmp_path}" 2>/dev/null || stat -c%s "${tmp_path}" 2>/dev/null || echo 0)
  fi

  if [[ "${file_size}" -lt 10485760 ]]; then
    rm -f "${tmp_path}"
    echo "[!] Error: Downloaded file for ${label} is invalid or truncated (${file_size} bytes)." >&2
    return 1
  fi

  # Atomic replacement
  mv -f "${tmp_path}" "${target_path}"
  echo "[✓] Successfully downloaded and verified ${label} (${file_size} bytes)."
  return 0
}

# 1. SAM 2.1 Small Checkpoint (Fast default, optimized for 4GB-8GB GPUs and CPU)
if [[ -s "${SAM2_SMALL}" ]]; then
  echo "[✓] SAM 2.1 Small checkpoint verified: ${SAM2_SMALL}"
else
  echo "[!] SAM 2.1 Small checkpoint not found in ${SAM2_DIR}."
  download_checkpoint "${SMALL_URL}" "${SAM2_SMALL}" "sam2.1_hiera_small.pt (~176MB)"
fi

# 2. SAM 2.1 Large Checkpoint (Optional high-tier)
if [[ -s "${SAM2_LARGE}" ]]; then
  echo "[✓] SAM 2.1 Large checkpoint verified: ${SAM2_LARGE}"
elif [[ "${1:-}" == "--large" || "${1:-}" == "--all" ]]; then
  echo "[!] Downloading optional SAM 2.1 Large checkpoint..."
  download_checkpoint "${LARGE_URL}" "${SAM2_LARGE}" "sam2.1_hiera_large.pt (~857MB)"
fi

echo "=== Model setup complete ==="
