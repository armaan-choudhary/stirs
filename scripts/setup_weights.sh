#!/usr/bin/env bash
set -e

# Setup directories
BASE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHECKPOINTS_DIR="${BASE_DIR}/checkpoints"
SAM2_DIR="${CHECKPOINTS_DIR}/sam2"

mkdir -p "${SAM2_DIR}"
mkdir -p "${BASE_DIR}/workspace"

echo "=== stirs: Video Mask Generator (SAM 2) Weights Setup ==="
echo "Checkpoints root: ${CHECKPOINTS_DIR}"

# 1. SAM 2.1 Small Checkpoint (Fast default, optimized for 4GB-8GB GPUs)
SAM2_SMALL="${SAM2_DIR}/sam2.1_hiera_small.pt"
if [ -f "${SAM2_SMALL}" ]; then
    echo "[✓] SAM 2.1 Small checkpoint found at ${SAM2_SMALL}"
else
    echo "[!] Downloading SAM 2.1 Hiera Small (176MB) from official Meta repository..."
    SMALL_URL="https://dl.fbaipublicfiles.com/segment_anything_2/092824/sam2.1_hiera_small.pt"
    curl -L "${SMALL_URL}" -o "${SAM2_SMALL}" || echo "[!] Failed to download small checkpoint."
fi

# 2. SAM 2.1 Large Checkpoint (Optional high-tier)
SAM2_LARGE="${SAM2_DIR}/sam2.1_hiera_large.pt"
if [ -f "${SAM2_LARGE}" ]; then
    echo "[✓] SAM 2.1 Large checkpoint found at ${SAM2_LARGE}"
fi

echo "=== Setup complete ==="
