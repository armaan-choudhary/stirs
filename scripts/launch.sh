#!/usr/bin/env bash
# ==============================================================================
# stirs - Unified One-Command Launcher (Multi-Linux Distribution Support)
#
# Automatically detects Linux distributions, verifies required system packages,
# prompts for automated installation if packages are missing, verifies or
# downloads the SAM 2 model weights, installs Python and Node dependencies,
# and boots both the backend API and frontend application.
# ==============================================================================
set -Eeuo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV_DIR="${PROJECT_DIR}/.venv"
CHECKPOINTS_DIR="${PROJECT_DIR}/checkpoints/sam2"

# Color formatting
BOLD='\033[1m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

log_info()    { echo -e "${CYAN}[INFO]${NC} $*"; }
log_success() { echo -e "${GREEN}[✓]${NC} $*"; }
log_warn()    { echo -e "${YELLOW}[!]${NC} $*"; }
log_error()   { echo -e "${RED}[ERROR]${NC} $*" >&2; }

# ------------------------------------------------------------------------------
# 1. Linux Distribution and Package Manager Detection
# ------------------------------------------------------------------------------
DISTRO_ID="unknown"
DISTRO_ID_LIKE=""
DISTRO_NAME="Linux"
PKG_MANAGER=""
UPDATE_CMD=""
INSTALL_CMD=""
SUDO=""

detect_distro() {
  if [[ -f /etc/os-release ]]; then
    # shellcheck disable=SC1091
    . /etc/os-release
    DISTRO_ID="${ID:-unknown}"
    DISTRO_ID_LIKE="${ID_LIKE:-}"
    DISTRO_NAME="${PRETTY_NAME:-${NAME:-$DISTRO_ID}}"
  elif [[ -f /usr/lib/os-release ]]; then
    # shellcheck disable=SC1091
    . /usr/lib/os-release
    DISTRO_ID="${ID:-unknown}"
    DISTRO_ID_LIKE="${ID_LIKE:-}"
    DISTRO_NAME="${PRETTY_NAME:-${NAME:-$DISTRO_ID}}"
  elif [[ -f /etc/lsb-release ]]; then
    # shellcheck disable=SC1091
    . /etc/lsb-release
    DISTRO_ID="${DISTRIB_ID:-unknown}"
    DISTRO_NAME="${DISTRIB_DESCRIPTION:-$DISTRO_ID}"
  elif [[ "$(uname -s)" == "Darwin" ]]; then
    DISTRO_ID="macos"
    DISTRO_NAME="macOS"
  fi
}

detect_pkg_manager() {
  detect_distro

  if [[ $EUID -ne 0 ]]; then
    if command -v sudo >/dev/null 2>&1; then
      SUDO="sudo"
    elif command -v doas >/dev/null 2>&1; then
      SUDO="doas"
    fi
  fi

  # Arch Linux and derivatives (Omarchy, Manjaro, EndeavourOS, Garuda, Artix, etc.)
  if { [[ "$DISTRO_ID" == "arch" || "$DISTRO_ID_LIKE" =~ arch || "$DISTRO_ID" == "omarchy" || "$DISTRO_ID" == "manjaro" || "$DISTRO_ID" == "endeavouros" || "$DISTRO_ID" == "garuda" || "$DISTRO_ID" == "artix" ]]; } && command -v pacman >/dev/null 2>&1; then
    PKG_MANAGER="pacman"
    UPDATE_CMD="${SUDO:+$SUDO }pacman -Sy"
    INSTALL_CMD="${SUDO:+$SUDO }pacman -S --noconfirm --needed"
  # Debian, Ubuntu, Linux Mint, Pop!_OS, Elementary, Kali, Raspberry Pi OS, etc.
  elif command -v apt-get >/dev/null 2>&1; then
    PKG_MANAGER="apt"
    UPDATE_CMD="${SUDO:+$SUDO }apt-get update"
    INSTALL_CMD="${SUDO:+$SUDO }apt-get install -y"
  # Fedora, RHEL 8+, CentOS Stream, Rocky, Alma
  elif command -v dnf >/dev/null 2>&1; then
    PKG_MANAGER="dnf"
    UPDATE_CMD=""
    INSTALL_CMD="${SUDO:+$SUDO }dnf install -y"
  # RHEL 7, CentOS 7, Amazon Linux
  elif command -v yum >/dev/null 2>&1; then
    PKG_MANAGER="yum"
    UPDATE_CMD=""
    INSTALL_CMD="${SUDO:+$SUDO }yum install -y"
  # openSUSE (Tumbleweed / Leap), SUSE
  elif command -v zypper >/dev/null 2>&1; then
    PKG_MANAGER="zypper"
    UPDATE_CMD=""
    INSTALL_CMD="${SUDO:+$SUDO }zypper install -y"
  # Alpine Linux
  elif command -v apk >/dev/null 2>&1; then
    PKG_MANAGER="apk"
    UPDATE_CMD="${SUDO:+$SUDO }apk update"
    INSTALL_CMD="${SUDO:+$SUDO }apk add"
  # Void Linux
  elif command -v xbps-install >/dev/null 2>&1; then
    PKG_MANAGER="xbps"
    UPDATE_CMD=""
    INSTALL_CMD="${SUDO:+$SUDO }xbps-install -Sy"
  # Solus
  elif command -v eopkg >/dev/null 2>&1; then
    PKG_MANAGER="eopkg"
    UPDATE_CMD=""
    INSTALL_CMD="${SUDO:+$SUDO }eopkg install -y"
  # macOS Homebrew fallback
  elif [[ "$DISTRO_ID" == "macos" ]] && command -v brew >/dev/null 2>&1; then
    PKG_MANAGER="brew"
    UPDATE_CMD="brew update"
    INSTALL_CMD="brew install"
  # Pacman fallback if installed on non-standard distro
  elif command -v pacman >/dev/null 2>&1; then
    PKG_MANAGER="pacman"
    UPDATE_CMD="${SUDO:+$SUDO }pacman -Sy"
    INSTALL_CMD="${SUDO:+$SUDO }pacman -S --noconfirm --needed"
  fi
}

# ------------------------------------------------------------------------------
# 2. System Dependency Verification & Interactive Installation
# ------------------------------------------------------------------------------
check_and_prompt_dependencies() {
  detect_pkg_manager

  local need_python=0
  local need_venv=0
  local need_node=0
  local need_npm=0
  local need_ffmpeg=0
  local need_downloader=0

  # Check python3
  if ! command -v python3 >/dev/null 2>&1; then
    need_python=1
  fi

  # Check venv support (crucial on Debian/Ubuntu where python3-venv is separate)
  if command -v python3 >/dev/null 2>&1; then
    if ! python3 -c "import venv" >/dev/null 2>&1; then
      need_venv=1
    fi
  else
    need_venv=1
  fi

  # Check node
  if ! command -v node >/dev/null 2>&1 && ! command -v nodejs >/dev/null 2>&1; then
    need_node=1
  fi

  # Check npm
  if ! command -v npm >/dev/null 2>&1; then
    need_npm=1
  fi

  # Check ffmpeg
  if ! command -v ffmpeg >/dev/null 2>&1; then
    need_ffmpeg=1
  fi

  # Check curl or wget for weights downloading
  if ! command -v curl >/dev/null 2>&1 && ! command -v wget >/dev/null 2>&1; then
    need_downloader=1
  fi

  # If everything is satisfied, proceed directly
  if [[ $need_python -eq 0 && $need_venv -eq 0 && $need_node -eq 0 && $need_npm -eq 0 && $need_ffmpeg -eq 0 && $need_downloader -eq 0 ]]; then
    log_success "All required system dependencies verified."
    return 0
  fi

  # Build list of missing tools for display
  local -a missing_labels=()
  [[ $need_python -eq 1 ]] && missing_labels+=("Python 3 (python3)")
  [[ $need_python -eq 0 && $need_venv -eq 1 ]] && missing_labels+=("Python 3 venv module (python3-venv)")
  [[ $need_node -eq 1 ]] && missing_labels+=("Node.js (node >= 18)")
  [[ $need_npm -eq 1 ]] && missing_labels+=("Node Package Manager (npm)")
  [[ $need_ffmpeg -eq 1 ]] && missing_labels+=("FFmpeg (ffmpeg)")
  [[ $need_downloader -eq 1 ]] && missing_labels+=("cURL or Wget (curl/wget)")

  # Map missing tools to distro package names
  local -a missing_pkgs=()
  case "$PKG_MANAGER" in
    apt)
      [[ $need_python -eq 1 ]] && missing_pkgs+=("python3" "python3-venv" "python3-pip")
      [[ $need_python -eq 0 && $need_venv -eq 1 ]] && missing_pkgs+=("python3-venv")
      [[ $need_node -eq 1 ]] && missing_pkgs+=("nodejs")
      [[ $need_npm -eq 1 ]] && missing_pkgs+=("npm")
      [[ $need_ffmpeg -eq 1 ]] && missing_pkgs+=("ffmpeg")
      [[ $need_downloader -eq 1 ]] && missing_pkgs+=("curl")
      ;;
    pacman)
      [[ $need_python -eq 1 ]] && missing_pkgs+=("python" "python-pip")
      [[ $need_python -eq 0 && $need_venv -eq 1 ]] && missing_pkgs+=("python")
      [[ $need_node -eq 1 ]] && missing_pkgs+=("nodejs")
      [[ $need_npm -eq 1 ]] && missing_pkgs+=("npm")
      [[ $need_ffmpeg -eq 1 ]] && missing_pkgs+=("ffmpeg")
      [[ $need_downloader -eq 1 ]] && missing_pkgs+=("curl")
      ;;
    dnf|yum)
      [[ $need_python -eq 1 ]] && missing_pkgs+=("python3" "python3-pip")
      [[ $need_python -eq 0 && $need_venv -eq 1 ]] && missing_pkgs+=("python3")
      [[ $need_node -eq 1 ]] && missing_pkgs+=("nodejs")
      [[ $need_npm -eq 1 ]] && missing_pkgs+=("npm")
      [[ $need_ffmpeg -eq 1 ]] && missing_pkgs+=("ffmpeg")
      [[ $need_downloader -eq 1 ]] && missing_pkgs+=("curl")
      ;;
    zypper)
      [[ $need_python -eq 1 ]] && missing_pkgs+=("python3" "python3-pip")
      [[ $need_python -eq 0 && $need_venv -eq 1 ]] && missing_pkgs+=("python3")
      [[ $need_node -eq 1 ]] && missing_pkgs+=("nodejs")
      [[ $need_npm -eq 1 ]] && missing_pkgs+=("npm")
      [[ $need_ffmpeg -eq 1 ]] && missing_pkgs+=("ffmpeg")
      [[ $need_downloader -eq 1 ]] && missing_pkgs+=("curl")
      ;;
    apk)
      [[ $need_python -eq 1 ]] && missing_pkgs+=("python3" "py3-virtualenv" "py3-pip")
      [[ $need_python -eq 0 && $need_venv -eq 1 ]] && missing_pkgs+=("py3-virtualenv")
      [[ $need_node -eq 1 ]] && missing_pkgs+=("nodejs")
      [[ $need_npm -eq 1 ]] && missing_pkgs+=("npm")
      [[ $need_ffmpeg -eq 1 ]] && missing_pkgs+=("ffmpeg")
      [[ $need_downloader -eq 1 ]] && missing_pkgs+=("curl")
      ;;
    xbps)
      [[ $need_python -eq 1 ]] && missing_pkgs+=("python3" "python3-pip")
      [[ $need_node -eq 1 ]] && missing_pkgs+=("nodejs")
      [[ $need_npm -eq 1 ]] && missing_pkgs+=("npm")
      [[ $need_ffmpeg -eq 1 ]] && missing_pkgs+=("ffmpeg")
      [[ $need_downloader -eq 1 ]] && missing_pkgs+=("curl")
      ;;
    eopkg)
      [[ $need_python -eq 1 ]] && missing_pkgs+=("python3" "pip")
      [[ $need_node -eq 1 ]] && missing_pkgs+=("nodejs")
      [[ $need_npm -eq 1 ]] && missing_pkgs+=("npm")
      [[ $need_ffmpeg -eq 1 ]] && missing_pkgs+=("ffmpeg")
      [[ $need_downloader -eq 1 ]] && missing_pkgs+=("curl")
      ;;
    brew)
      [[ $need_python -eq 1 ]] && missing_pkgs+=("python@3.11")
      [[ $need_node -eq 1 ]] && missing_pkgs+=("node")
      [[ $need_npm -eq 1 ]] && missing_pkgs+=("node")
      [[ $need_ffmpeg -eq 1 ]] && missing_pkgs+=("ffmpeg")
      [[ $need_downloader -eq 1 ]] && missing_pkgs+=("curl")
      ;;
    *)
      # Generic/unrecognized
      [[ $need_python -eq 1 ]] && missing_pkgs+=("python3")
      [[ $need_python -eq 0 && $need_venv -eq 1 ]] && missing_pkgs+=("python3-venv")
      [[ $need_node -eq 1 ]] && missing_pkgs+=("nodejs")
      [[ $need_npm -eq 1 ]] && missing_pkgs+=("npm")
      [[ $need_ffmpeg -eq 1 ]] && missing_pkgs+=("ffmpeg")
      [[ $need_downloader -eq 1 ]] && missing_pkgs+=("curl")
      ;;
  esac

  # Deduplicate package names
  local -a unique_pkgs=()
  local seen=" "
  for pkg in "${missing_pkgs[@]}"; do
    if [[ ! "$seen" =~ \ $pkg\  ]]; then
      unique_pkgs+=("$pkg")
      seen="$seen$pkg "
    fi
  done

  echo ""
  echo -e "${BOLD}========================================================================${NC}"
  echo -e "${YELLOW}${BOLD} stirs - Missing System Dependencies Detected${NC}"
  echo -e "${BOLD}========================================================================${NC}"
  echo -e "Detected OS      : ${DISTRO_NAME} (${DISTRO_ID})"
  echo -e "Package Manager  : ${PKG_MANAGER:-Unknown}"
  echo ""
  echo "The following required tools are missing on your system:"
  for label in "${missing_labels[@]}"; do
    echo -e "  ${RED}✗${NC} ${label}"
  done
  echo ""

  if [[ -n "$PKG_MANAGER" && -n "$INSTALL_CMD" && ${#unique_pkgs[@]} -gt 0 ]]; then
    local full_install_cmd="${INSTALL_CMD} ${unique_pkgs[*]}"
    echo "Recommended installation command:"
    echo -e "  ${BOLD}${full_install_cmd}${NC}"
    echo -e "${BOLD}========================================================================${NC}"
    echo ""

    # Prompt user for automated installation
    local should_install="no"
    local is_interactive=0
    if [[ -z "${CI:-}" && "${DEBIAN_FRONTEND:-}" != "noninteractive" ]]; then
      if [[ -t 0 ]] || [[ ! -t 0 && -t 1 ]] || [[ -r /dev/tty && -t 1 ]]; then
        is_interactive=1
      fi
    fi

    if [[ $is_interactive -eq 1 ]]; then
      local user_input="y"
      if [[ -t 0 ]]; then
        read -r -p "Would you like to install the missing packages now? [Y/n] " user_input 2>/dev/null || user_input="y"
      elif [[ -p /dev/stdin || -f /dev/stdin ]]; then
        # Piped or redirected input
        read -r user_input || user_input="y"
      elif [[ -r /dev/tty ]]; then
        read -r -p "Would you like to install the missing packages now? [Y/n] " user_input < /dev/tty 2>/dev/null || user_input="y"
      fi
      user_input="${user_input:-y}"
      if [[ "${user_input}" =~ ^[Yy]$ || "${user_input}" =~ ^[Yy][Ee][Ss]$ ]]; then
        should_install="yes"
      fi
    else
      log_warn "Non-interactive environment detected. Cannot prompt for automated installation."
      log_info "Please run the command manually:"
      echo "  ${full_install_cmd}"
      exit 1
    fi

    if [[ "$should_install" == "yes" ]]; then
      echo ""
      log_info "Executing package manager installation..."
      if [[ -n "$UPDATE_CMD" ]]; then
        log_info "Refreshing package indices (${UPDATE_CMD})..."
        ${UPDATE_CMD} || log_warn "Package index refresh reported warnings, proceeding with install..."
      fi
      if ${INSTALL_CMD} "${unique_pkgs[@]}"; then
        log_success "System packages installed successfully."
      else
        log_error "Package manager installation failed."
        log_info "Please install missing packages manually and re-run ./scripts/launch.sh"
        exit 1
      fi
    else
      echo ""
      log_warn "Package installation cancelled by user."
      log_info "Please install the missing packages and re-run ./scripts/launch.sh:"
      echo "  ${full_install_cmd}"
      exit 1
    fi
  else
    echo "Could not automatically determine package manager commands for this system."
    echo "Please install the following tools using your distribution's package manager:"
    for label in "${missing_labels[@]}"; do
      echo "  - ${label}"
    done
    echo -e "${BOLD}========================================================================${NC}"
    exit 1
  fi

  # Final re-verification
  if ! command -v python3 >/dev/null 2>&1 || \
     ! python3 -c "import venv" >/dev/null 2>&1 || \
     { ! command -v node >/dev/null 2>&1 && ! command -v nodejs >/dev/null 2>&1; } || \
     ! command -v npm >/dev/null 2>&1 || \
     ! command -v ffmpeg >/dev/null 2>&1; then
    log_error "System dependency verification failed after installation attempt."
    exit 1
  fi
  log_success "All system dependencies verified."
}

# ------------------------------------------------------------------------------
# 3. Model Weights Verification & Download Setup
# ------------------------------------------------------------------------------
setup_model_weights() {
  local sam2_small="${CHECKPOINTS_DIR}/sam2.1_hiera_small.pt"
  local sam2_large="${CHECKPOINTS_DIR}/sam2.1_hiera_large.pt"

  mkdir -p "${CHECKPOINTS_DIR}"

  if [[ -s "${sam2_small}" ]]; then
    log_success "SAM 2.1 Small model checkpoint found at ${sam2_small}"
  elif [[ -s "${sam2_large}" ]]; then
    log_success "SAM 2.1 Large model checkpoint found at ${sam2_large}"
  else
    log_info "SAM 2 model checkpoint not found in directory."
    log_info "Invoking automated weights setup to download sam2.1_hiera_small.pt..."
    if [[ -f "${PROJECT_DIR}/scripts/setup_weights.sh" ]]; then
      bash "${PROJECT_DIR}/scripts/setup_weights.sh"
    else
      log_error "Missing scripts/setup_weights.sh. Cannot auto-download checkpoint."
      exit 1
    fi
  fi
}

# ------------------------------------------------------------------------------
# 4. Main Startup Workflow
# ------------------------------------------------------------------------------
echo ""
echo -e "${BOLD}========================================================================${NC}"
echo -e "${CYAN}${BOLD} stirs - Video Mask Generator (SAM 2)${NC}"
echo -e "${BOLD}========================================================================${NC}"

# Step 1: Check system packages across Linux distributions
check_and_prompt_dependencies

# Step 2: Ensure virtual environment and backend dependencies
if [[ ! -d "${VENV_DIR}" ]]; then
  log_info "Creating Python virtual environment in .venv..."
  python3 -m venv "${VENV_DIR}"
fi

PYTHON="${VENV_DIR}/bin/python"
PIP="${VENV_DIR}/bin/pip"

log_info "Verifying backend Python dependencies..."
"${PIP}" install -r "${PROJECT_DIR}/backend/requirements.txt"

# Step 3: Check and auto-download model weights if not present
setup_model_weights

# Step 4: Ensure frontend dependencies
if [[ ! -d "${PROJECT_DIR}/frontend/node_modules" ]]; then
  log_info "Installing frontend dependencies (npm install)..."
  (cd "${PROJECT_DIR}/frontend" && npm install)
fi

mkdir -p "${PROJECT_DIR}/workspace" "${CHECKPOINTS_DIR}"

# ------------------------------------------------------------------------------
# 5. Process Supervisor & Clean Exit
# ------------------------------------------------------------------------------
backend_pid=""
frontend_pid=""

cleanup() {
  trap - EXIT INT TERM
  echo ""
  log_info "Shutting down stirs services..."
  [[ -z "${backend_pid}" ]] || kill "${backend_pid}" 2>/dev/null || true
  [[ -z "${frontend_pid}" ]] || kill "${frontend_pid}" 2>/dev/null || true
  [[ -z "${backend_pid}" ]] || wait "${backend_pid}" 2>/dev/null || true
  [[ -z "${frontend_pid}" ]] || wait "${frontend_pid}" 2>/dev/null || true
  log_success "All services stopped."
}
trap cleanup EXIT INT TERM

cd "${PROJECT_DIR}"
echo ""
log_info "Starting FastAPI backend at http://localhost:8000 ..."
PYTHONPATH="${PROJECT_DIR}/backend:${PROJECT_DIR}" "${PYTHON}" -m uvicorn backend.main:app --host 0.0.0.0 --port 8000 &
backend_pid=$!

log_info "Starting Vite frontend at http://localhost:3000 ..."
(cd "${PROJECT_DIR}/frontend" && npm run dev -- --host 0.0.0.0 --port 3000) &
frontend_pid=$!

echo ""
echo -e "${GREEN}${BOLD}========================================================================${NC}"
echo -e "${GREEN}${BOLD} stirs is up and running!${NC}"
echo -e " Backend API  : ${CYAN}http://localhost:8000${NC} (API docs: http://localhost:8000/docs)"
echo -e " Frontend UI  : ${CYAN}http://localhost:3000${NC}"
echo -e " Press ${BOLD}Ctrl+C${NC} anytime to stop both services."
echo -e "${GREEN}${BOLD}========================================================================${NC}"
echo ""

set +e
wait -n "${backend_pid}" "${frontend_pid}"
exit_code=$?
set -e
exit "${exit_code}"
