import os
from pathlib import Path

# Paths
BASE_DIR = Path(__file__).resolve().parent.parent
WORKSPACE_DIR = BASE_DIR / "workspace"
CHECKPOINTS_DIR = BASE_DIR / "checkpoints"
SAM2_CHECKPOINTS_DIR = CHECKPOINTS_DIR / "sam2"

# Ensure directories exist
WORKSPACE_DIR.mkdir(parents=True, exist_ok=True)
SAM2_CHECKPOINTS_DIR.mkdir(parents=True, exist_ok=True)

# Device Configuration
DEVICE = "cpu"
USE_AMP = False
AMP_DTYPE = None

try:
    import torch
    if torch.cuda.is_available():
        DEVICE = "cuda"
        USE_AMP = True
        # RTX 2050 (Ampere architecture) natively accelerates bfloat16
        AMP_DTYPE = torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float16
except ImportError:
    pass

# Engine defaults
DEFAULT_DILATION_PX = 7
MAX_VIDEO_DIMENSION = 1920  # Native video resolution (keeps coordinates 1:1 with video)

# Upload and lifecycle limits
# Default: 2GB (2 * 1024 * 1024 * 1024 bytes)
MAX_UPLOAD_SIZE_BYTES = int(os.environ.get("MAX_UPLOAD_SIZE_BYTES", 2 * 1024 * 1024 * 1024))
# Default: 24 hours workspace retention
WORKSPACE_RETENTION_HOURS = int(os.environ.get("WORKSPACE_RETENTION_HOURS", 24))
# Default: 3600 seconds (1 hour) between automatic cleanup runs
WORKSPACE_CLEANUP_INTERVAL_SECONDS = float(os.environ.get("WORKSPACE_CLEANUP_INTERVAL_SECONDS", 3600.0))
# Flag to enable/disable background automatic cleanup loop (enabled by default)
ENABLE_AUTO_WORKSPACE_CLEANUP = os.environ.get("ENABLE_AUTO_WORKSPACE_CLEANUP", "true").lower() in ("true", "1", "yes")


# Available model variants
SAM2_VARIANTS = {
    "small": {
        "config": "configs/sam2.1/sam2.1_hiera_s.yaml",
        "checkpoint": str(SAM2_CHECKPOINTS_DIR / "sam2.1_hiera_small.pt"),
    },
    "large": {
        "config": "configs/sam2.1/sam2.1_hiera_l.yaml",
        "checkpoint": str(SAM2_CHECKPOINTS_DIR / "sam2.1_hiera_large.pt"),
    }
}

# Auto-select small if present for lightning fast inference, otherwise fallback to large
if (SAM2_CHECKPOINTS_DIR / "sam2.1_hiera_small.pt").exists():
    ACTIVE_VARIANT = "small"
else:
    ACTIVE_VARIANT = "large"

DEFAULT_SAM2_CONFIG = SAM2_VARIANTS[ACTIVE_VARIANT]["config"]
DEFAULT_SAM2_CHECKPOINT = SAM2_VARIANTS[ACTIVE_VARIANT]["checkpoint"]
