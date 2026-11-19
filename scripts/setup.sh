#!/usr/bin/env bash
# Prepare the stirs application. EffectErase and its large model weights are
# optional; pass --with-effecterase to install the complete removal runtime.
set -Eeuo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHECKPOINTS_DIR="${PROJECT_DIR}/checkpoints"
SAM2_DIR="${CHECKPOINTS_DIR}/sam2"
EFFECT_ERASE_DIR="${PROJECT_DIR}/external/EffectErase"
EFFECT_ERASE_CHECKPOINTS_DIR="${CHECKPOINTS_DIR}/effect_erase"
EFFECT_ERASE_COMMIT="bcee0a5da5ef387c2ba39390dc4d579503669fb8"
WITH_EFFECTERASE=false

log() { printf '[stirs setup] %s\n' "$*"; }
fail() { printf '[stirs setup] ERROR: %s\n' "$*" >&2; exit 1; }

for arg in "$@"; do
  case "$arg" in
    --with-effecterase) WITH_EFFECTERASE=true ;;
    --help|-h)
      cat <<'EOF'
Usage: bash scripts/setup.sh [--with-effecterase]

Install system and project requirements, SAM 2, frontend packages, and SAM 2
weights. --with-effecterase additionally installs the isolated EffectErase
runtime and downloads its large model weights (roughly 19 GB for the base model).
EOF
      exit 0
      ;;
    *) fail "Unknown option: $arg" ;;
  esac
done

install_missing_system_packages() {
  local missing=()
  command -v python3 >/dev/null 2>&1 || missing+=(python3)
  python3 -c 'import venv' >/dev/null 2>&1 || missing+=(python-venv)
  command -v node >/dev/null 2>&1 || command -v nodejs >/dev/null 2>&1 || missing+=(node)
  command -v npm >/dev/null 2>&1 || missing+=(npm)
  command -v ffmpeg >/dev/null 2>&1 || missing+=(ffmpeg)
  command -v curl >/dev/null 2>&1 || command -v wget >/dev/null 2>&1 || missing+=(curl)
  command -v git >/dev/null 2>&1 || missing+=(git)
  ((${#missing[@]} == 0)) && { log "System requirements are present."; return; }

  local distro="unknown" like=""
  if [[ -r /etc/os-release ]]; then
    # shellcheck disable=SC1091
    . /etc/os-release
    distro="${ID:-unknown}"
    like="${ID_LIKE:-}"
  elif [[ "$(uname -s)" == "Darwin" ]]; then
    distro="macos"
  fi

  printf 'Missing system tools: %s\n' "${missing[*]}"
  local answer="n"
  if [[ -r /dev/tty && -t 0 ]]; then
    read -r -p 'Install these with the system package manager now? [y/N] ' answer </dev/tty || true
  fi
  [[ "$answer" =~ ^[Yy]([Ee][Ss])?$ ]] || fail "Install the listed system packages, then rerun scripts/launch.sh."

  local sudo_cmd=()
  if [[ $EUID -ne 0 ]]; then
    command -v sudo >/dev/null 2>&1 || fail "sudo is required to install system packages."
    sudo_cmd=(sudo)
  fi
  if [[ "$distro" == "arch" || "$distro" == "omarchy" || "$like" == *arch* ]]; then
    "${sudo_cmd[@]}" pacman -Sy --needed --noconfirm python python-pip nodejs npm ffmpeg curl git
  elif [[ "$distro" == "debian" || "$distro" == "ubuntu" || "$like" == *debian* ]]; then
    "${sudo_cmd[@]}" apt-get update
    "${sudo_cmd[@]}" apt-get install -y python3 python3-venv python3-pip nodejs npm ffmpeg curl git
  elif [[ "$distro" == "fedora" || "$distro" == "rhel" || "$distro" == "centos" ]]; then
    "${sudo_cmd[@]}" dnf install -y python3 python3-pip nodejs npm ffmpeg curl git
  elif [[ "$distro" == "opensuse-tumbleweed" || "$distro" == "opensuse-leap" || "$distro" == "sles" ]]; then
    "${sudo_cmd[@]}" zypper install -y python3 python3-pip python3-venv nodejs npm ffmpeg curl git
  elif [[ "$distro" == "alpine" ]]; then
    "${sudo_cmd[@]}" apk add python3 py3-pip nodejs npm ffmpeg curl git
  elif [[ "$distro" == "macos" ]] && command -v brew >/dev/null 2>&1; then
    brew install python node ffmpeg curl git
  else
    fail "Automatic package installation is not configured for ${distro}; install Python 3.10+, venv, Node 18+, npm, FFmpeg, curl or wget, and git manually."
  fi
}

choose_python() {
  local candidate
  for candidate in python3.12 python3.11 python3.10 python3; do
    if command -v "$candidate" >/dev/null 2>&1 && "$candidate" -c 'import sys; raise SystemExit(sys.version_info < (3, 10) or sys.version_info >= (3, 14))' >/dev/null 2>&1; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  fail "Python 3.10, 3.11, or 3.12 is required for the ML dependencies."
}

download_file() {
  local url="$1" target="$2" label="$3" temp="${target}.tmp.$$" size=0
  mkdir -p "$(dirname "$target")"
  rm -f "$temp"
  log "Downloading ${label}..."
  if command -v curl >/dev/null 2>&1; then
    curl -fL --retry 3 --retry-delay 2 --progress-bar "$url" -o "$temp" || { rm -f "$temp"; return 1; }
  else
    wget --tries=3 --show-progress -O "$temp" "$url" || { rm -f "$temp"; return 1; }
  fi
  size=$(wc -c < "$temp")
  if ((size < 10485760)); then
    rm -f "$temp"
    log "Downloaded ${label} is too small (${size} bytes); refusing to keep it."
    return 1
  fi
  mv -f "$temp" "$target"
  log "Saved ${label} (${size} bytes)."
}

setup_sam2_weights() {
  local large="${SAM2_DIR}/sam2.1_hiera_large.pt"
  local small="${SAM2_DIR}/sam2.1_hiera_small.pt"
  mkdir -p "$SAM2_DIR"
  if [[ ! -s "$large" ]]; then
    if ! download_file "https://dl.fbaipublicfiles.com/segment_anything_2/092824/sam2.1_hiera_large.pt" "$large" 'SAM 2.1 Large checkpoint'; then
      log "Large checkpoint unavailable; trying SAM 2.1 Small."
    fi
  else
    log "Found SAM 2.1 Large checkpoint."
  fi
  if [[ ! -s "$large" && ! -s "$small" ]]; then
    download_file "https://dl.fbaipublicfiles.com/segment_anything_2/092824/sam2.1_hiera_small.pt" "$small" 'SAM 2.1 Small checkpoint' || fail "Could not download either SAM 2 checkpoint."
  fi
  [[ ! -s "$small" ]] || log "Found SAM 2.1 Small fallback checkpoint."
}

setup_effecterase() {
  local python="$1" ee_python="${PROJECT_DIR}/.venv-effecterase/bin/python"
  mkdir -p "$EFFECT_ERASE_CHECKPOINTS_DIR" "$(dirname "$EFFECT_ERASE_DIR")"
  if [[ ! -d "$EFFECT_ERASE_DIR/.git" ]]; then
    log "Cloning the official EffectErase repository."
    git clone https://github.com/FudanCVL/EffectErase.git "$EFFECT_ERASE_DIR"
  fi
  local current_commit
  current_commit="$(git -C "$EFFECT_ERASE_DIR" rev-parse HEAD)"
  if [[ "$current_commit" != "$EFFECT_ERASE_COMMIT" ]]; then
    [[ -z "$(git -C "$EFFECT_ERASE_DIR" status --porcelain)" ]] || fail "EffectErase checkout has local changes; preserve or remove them before switching to the adapter's pinned revision."
    log "Checking out adapter-tested EffectErase revision ${EFFECT_ERASE_COMMIT}."
    git -C "$EFFECT_ERASE_DIR" fetch origin "$EFFECT_ERASE_COMMIT"
    git -C "$EFFECT_ERASE_DIR" checkout --detach "$EFFECT_ERASE_COMMIT"
  fi

  if [[ ! -x "$ee_python" ]]; then
    log "Creating isolated EffectErase environment."
    "$python" -m venv "${PROJECT_DIR}/.venv-effecterase"
  fi
  if ! "$ee_python" -c 'import diffsynth, torch' >/dev/null 2>&1; then
    log "Installing EffectErase and its isolated inference dependencies."
    "$ee_python" -m pip install --upgrade pip
    "$ee_python" -m pip install -e "$EFFECT_ERASE_DIR"
  fi
  if [[ ! -x "${PROJECT_DIR}/.venv-effecterase/bin/hf" ]]; then
    "$ee_python" -m pip install 'huggingface_hub[cli]>=0.34,<1.0'
  fi

  if ! "$ee_python" -c 'import torch; print(torch.__version__)' >/dev/null 2>&1; then
    fail "EffectErase PyTorch did not install correctly."
  fi
  if ! "${PROJECT_DIR}/.venv-effecterase/bin/hf" --help >/dev/null 2>&1; then
    fail "Hugging Face CLI is unavailable in the EffectErase environment."
  fi

  local hf="${PROJECT_DIR}/.venv-effecterase/bin/hf"
  local required=(
    models_t5_umt5-xxl-enc-bf16.pth
    Wan2.1_VAE.pth
    diffusion_pytorch_model.safetensors
    models_clip_open-clip-xlm-roberta-large-vit-huge-14.pth
    EffectErase.ckpt
  )
  local all_present=true name
  for name in "${required[@]}"; do
    [[ -s "${EFFECT_ERASE_CHECKPOINTS_DIR}/${name}" ]] || all_present=false
  done
  if [[ "$all_present" != true ]]; then
    log "Downloading Wan2.1 and EffectErase checkpoints to ${EFFECT_ERASE_CHECKPOINTS_DIR}."
    "$hf" download alibaba-pai/Wan2.1-Fun-1.3B-InP --local-dir "$EFFECT_ERASE_CHECKPOINTS_DIR"
    "$hf" download FudanCVL/EffectErase EffectErase.ckpt --local-dir "$EFFECT_ERASE_CHECKPOINTS_DIR"
  else
    log "Found all required EffectErase model files."
  fi

  if ! "$ee_python" -c 'import sys, torch; sys.exit(0 if torch.cuda.is_available() else 1)' >/dev/null 2>&1; then
    log "EffectErase files are installed, but CUDA is unavailable; inference preflight will remain unavailable until a CUDA-capable GPU and working driver are available."
  fi
  log "EffectErase is research software under CC BY-NC 4.0; use is limited to noncommercial purposes."
}

install_missing_system_packages
PYTHON_COMMAND="$(choose_python)"
VENV_DIR="${PROJECT_DIR}/.venv"
if [[ ! -x "${VENV_DIR}/bin/python" ]]; then
  log "Creating application virtual environment with ${PYTHON_COMMAND}."
  "${PYTHON_COMMAND}" -m venv "$VENV_DIR"
fi
PYTHON="${VENV_DIR}/bin/python"
PIP="${VENV_DIR}/bin/pip"

log "Installing backend requirements."
"$PIP" install -r "${PROJECT_DIR}/backend/requirements.txt"
if ! "$PYTHON" -c 'import torch' >/dev/null 2>&1; then
  if command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi >/dev/null 2>&1; then
    "$PIP" install torch torchvision --index-url https://download.pytorch.org/whl/cu124 || "$PIP" install torch torchvision
  else
    "$PIP" install torch torchvision
  fi
fi
if ! "$PYTHON" -c 'import sam2' >/dev/null 2>&1; then
  log "Installing SAM 2."
  "$PIP" install git+https://github.com/facebookresearch/sam2.git || log "Warning: SAM 2 install failed; mask generation may use its fallback implementation."
fi

setup_sam2_weights

if [[ ! -d "${PROJECT_DIR}/frontend/node_modules" ]]; then
  log "Installing frontend dependencies."
  (cd "${PROJECT_DIR}/frontend" && npm ci)
else
  log "Frontend dependencies are already installed."
fi

if [[ "$WITH_EFFECTERASE" == true ]]; then
  setup_effecterase "$PYTHON_COMMAND"
else
  log "Skipping optional EffectErase runtime and large weights. Pass --with-effecterase to install them."
fi

mkdir -p "${PROJECT_DIR}/workspace" "$EFFECT_ERASE_CHECKPOINTS_DIR"
log "Setup complete. Start the app with: ./scripts/launch.sh"
