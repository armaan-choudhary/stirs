import os
import re
import sys
import shutil
import queue
import logging
import threading
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Any, List, Optional, Tuple, Callable

import cv2
import numpy as np

try:
    import config
except ImportError:
    config = None

try:
    from core.video_io import probe_video
except ImportError:
    try:
        from backend.core.video_io import probe_video
    except ImportError:
        def probe_video(video_path: str) -> Dict[str, Any]:
            cap = cv2.VideoCapture(str(video_path))
            if not cap.isOpened():
                raise FileNotFoundError(f"Could not open video file: {video_path}")
            width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
            height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
            fps = float(cap.get(cv2.CAP_PROP_FPS)) or 30.0
            frame_count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
            cap.release()
            return {
                "fps": round(fps, 2),
                "frame_count": frame_count,
                "width": width,
                "height": height,
                "has_audio": False,
            }

try:
    from core.sam2_engine import JobCancelledException
except ImportError:
    try:
        from backend.core.sam2_engine import JobCancelledException
    except ImportError:
        class JobCancelledException(Exception):
            """Raised when a job is cancelled cooperatively."""
            pass

__all__ = [
    "EffectEraseAdapter",
    "EffectEraseConfig",
    "EffectEraseException",
    "EffectEraseUnavailableException",
    "JobCancelledException",
]

logger = logging.getLogger("stirs.effect_erase_adapter")


class EffectEraseException(Exception):
    """Base exception for EffectErase adapter errors."""
    pass


class EffectEraseUnavailableException(EffectEraseException):
    """Raised when runtime, dependencies, script, or model weights are missing or unavailable."""
    pass


@dataclass
class EffectEraseConfig:
    """Runtime configuration for EffectErase execution."""
    python_bin: Path
    script_path: Path
    text_encoder_path: Path
    vae_path: Path
    dit_path: Path
    image_encoder_path: Path
    lora_path: Path
    device: str = "cuda"
    num_inference_steps: int = 25
    cfg: float = 1.0
    lora_alpha: float = 1.0
    seed: int = 2025
    tiled: bool = False
    use_teacache: bool = False
    height: int = 480
    width: int = 832
    num_frames: Optional[int] = None
    frame_interval: int = 1

    @classmethod
    def from_environment(cls, base_dir: Optional[Path] = None) -> "EffectEraseConfig":
        if base_dir is None:
            if config is not None and hasattr(config, "BASE_DIR"):
                base_dir = config.BASE_DIR
            else:
                base_dir = Path(__file__).resolve().parent.parent.parent

        checkpoints_dir = (
            getattr(config, "EFFECT_ERASE_CHECKPOINTS_DIR", None)
            or getattr(config, "CHECKPOINTS_DIR", base_dir / "checkpoints")
            if config is not None
            else base_dir / "checkpoints"
        )

        ee_dir = Path(
            getattr(config, "EFFECT_ERASE_REPO_DIR", None)
            or getattr(config, "EFFECT_ERASE_DIR", None)
            or os.environ.get("EFFECT_ERASE_REPO_DIR")
            or os.environ.get("EFFECT_ERASE_DIR")
            or (base_dir / "external" / "EffectErase")
        )

        py_cfg = getattr(config, "EFFECT_ERASE_PYTHON", None) or os.environ.get("EFFECT_ERASE_PYTHON")
        python_bin = Path(py_cfg) if py_cfg else Path(sys.executable)

        script_cfg = getattr(config, "EFFECT_ERASE_SCRIPT", None) or os.environ.get("EFFECT_ERASE_SCRIPT")
        script_path = Path(script_cfg) if script_cfg else (ee_dir / "examples" / "remove_wan" / "infer_remove_wan.py")

        ckpt_dir = Path(
            getattr(config, "EFFECT_ERASE_CHECKPOINTS_DIR", None)
            or getattr(config, "EFFECT_ERASE_CKPT_DIR", None)
            or os.environ.get("EFFECT_ERASE_CHECKPOINTS_DIR")
            or os.environ.get("EFFECT_ERASE_CKPT_DIR")
            or (checkpoints_dir / "effect_erase")
        )

        # Fallback search path: base_dir / "Wan-AI/Wan2.1-Fun-1.3B-InP"
        wan_ai_dir = base_dir / "Wan-AI" / "Wan2.1-Fun-1.3B-InP"
        wan_weights_dir = ckpt_dir if ckpt_dir.exists() else (wan_ai_dir if wan_ai_dir.exists() else ckpt_dir)

        text_encoder = Path(
            getattr(
                config,
                "EFFECT_ERASE_TEXT_ENCODER_PATH",
                os.environ.get(
                    "EFFECT_ERASE_TEXT_ENCODER_PATH",
                    wan_weights_dir / "models_t5_umt5-xxl-enc-bf16.pth"
                )
            )
        )

        vae = Path(
            getattr(
                config,
                "EFFECT_ERASE_VAE_PATH",
                os.environ.get(
                    "EFFECT_ERASE_VAE_PATH",
                    wan_weights_dir / "Wan2.1_VAE.pth"
                )
            )
        )

        dit = Path(
            getattr(
                config,
                "EFFECT_ERASE_DIT_PATH",
                os.environ.get(
                    "EFFECT_ERASE_DIT_PATH",
                    wan_weights_dir / "diffusion_pytorch_model.safetensors"
                )
            )
        )

        image_encoder = Path(
            getattr(
                config,
                "EFFECT_ERASE_IMAGE_ENCODER_PATH",
                os.environ.get(
                    "EFFECT_ERASE_IMAGE_ENCODER_PATH",
                    wan_weights_dir / "models_clip_open-clip-xlm-roberta-large-vit-huge-14.pth"
                )
            )
        )

        lora = Path(
            getattr(
                config,
                "EFFECT_ERASE_LORA_PATH",
                os.environ.get(
                    "EFFECT_ERASE_LORA_PATH",
                    ckpt_dir / "EffectErase.ckpt"
                )
            )
        )
        if not lora.exists() and (ee_dir / "EffectErase.ckpt").exists():
            lora = ee_dir / "EffectErase.ckpt"

        device = getattr(
            config,
            "EFFECT_ERASE_DEVICE",
            os.environ.get("EFFECT_ERASE_DEVICE", "cuda" if getattr(config, "DEVICE", "cpu") == "cuda" else "cpu")
        )

        return cls(
            python_bin=python_bin,
            script_path=script_path,
            text_encoder_path=text_encoder,
            vae_path=vae,
            dit_path=dit,
            image_encoder_path=image_encoder,
            lora_path=lora,
            device=device,
            num_inference_steps=int(os.environ.get("EFFECT_ERASE_STEPS", 25)),
            cfg=float(os.environ.get("EFFECT_ERASE_CFG", 1.0)),
            lora_alpha=float(os.environ.get("EFFECT_ERASE_LORA_ALPHA", 1.0)),
            seed=int(os.environ.get("EFFECT_ERASE_SEED", 2025)),
            tiled=os.environ.get("EFFECT_ERASE_TILED", "false").lower() in ("true", "1", "yes"),
            use_teacache=os.environ.get("EFFECT_ERASE_USE_TEACACHE", "false").lower() in ("true", "1", "yes"),
            height=int(os.environ.get("EFFECT_ERASE_HEIGHT", 480)),
            width=int(os.environ.get("EFFECT_ERASE_WIDTH", 832)),
            num_frames=int(os.environ.get("EFFECT_ERASE_NUM_FRAMES")) if os.environ.get("EFFECT_ERASE_NUM_FRAMES") else None,
            frame_interval=int(os.environ.get("EFFECT_ERASE_FRAME_INTERVAL", 1)),
        )


class EffectEraseAdapter:
    """
    Adapter for FudanCVL/EffectErase video removal inference.
    Executes upstream inference out-of-process in an isolated environment.
    """

    def __init__(self, config_obj: Optional[EffectEraseConfig] = None, **overrides):
        self.config = config_obj or EffectEraseConfig.from_environment()
        for k, v in overrides.items():
            if hasattr(self.config, k):
                setattr(self.config, k, v)

    def check_availability(self, check_weights: bool = True) -> Tuple[bool, Optional[str]]:
        """
        Preflight check for binaries, upstream script, model weights, and compute device.
        Returns (True, None) if ready, or (False, detailed_actionable_error_message).
        """
        issues = []

        # 1. System ffmpeg / ffprobe
        if not shutil.which("ffmpeg"):
            issues.append(
                "ffmpeg executable not found in system PATH. Install ffmpeg to enable video and mask processing."
            )
        if not shutil.which("ffprobe"):
            issues.append(
                "ffprobe executable not found in system PATH. Install ffprobe to enable video metadata probing."
            )

        backend_mode = (
            getattr(config, "EFFECT_ERASE_BACKEND", None)
            or os.environ.get("EFFECT_ERASE_BACKEND", "local")
        ).lower()
        if backend_mode in ("remote", "modal"):
            remote_url = (
                getattr(config, "EFFECT_ERASE_REMOTE_URL", None)
                or os.environ.get("EFFECT_ERASE_REMOTE_URL", "")
            ).strip()
            if not remote_url:
                issues.append(
                    "EFFECT_ERASE_BACKEND=remote is set, but EFFECT_ERASE_REMOTE_URL is empty."
                )
            return (len(issues) == 0), ("\n".join(issues) if issues else None)

        # 2. Python binary
        py_bin = Path(self.config.python_bin)
        if not (py_bin.is_file() and os.access(py_bin, os.X_OK)):
            if not shutil.which(str(py_bin)):
                issues.append(
                    f"Configured Python binary '{py_bin}' does not exist or is not executable. "
                    "Ensure an external Python venv/conda environment is configured via EFFECT_ERASE_PYTHON."
                )

        # 3. EffectErase upstream script
        script_file = Path(self.config.script_path)
        if not script_file.is_file():
            issues.append(
                f"EffectErase inference script not found at '{script_file}'. "
                "Clone the official repository (https://github.com/FudanCVL/EffectErase) and configure EFFECT_ERASE_SCRIPT "
                "or EFFECT_ERASE_DIR."
            )

        # 4. Model checkpoints & weights
        if check_weights:
            missing_weights = []
            weight_files = [
                ("text_encoder", self.config.text_encoder_path),
                ("vae", self.config.vae_path),
                ("dit", self.config.dit_path),
                ("image_encoder", self.config.image_encoder_path),
                ("lora", self.config.lora_path),
            ]
            for name, path in weight_files:
                p = Path(path)
                if not (p.is_file() and p.stat().st_size > 0):
                    missing_weights.append(f"{name} ({p.name}) at {p}")

            if missing_weights:
                issues.append(
                    f"Missing required model weights ({len(missing_weights)} files):\n  - "
                    + "\n  - ".join(missing_weights)
                    + "\nDownload Wan2.1-Fun-1.3B-InP base weights (alibaba-pai/Wan2.1-Fun-1.3B-InP) and "
                    "EffectErase.ckpt (FudanCVL/EffectErase) to your checkpoints directory."
                )

        # 5. Device check
        if self.config.device == "cuda":
            cuda_available = False
            try:
                import torch
                cuda_available = torch.cuda.is_available()
            except ImportError:
                # Fallback: check nvidia-smi if torch is not in backend env
                cuda_available = shutil.which("nvidia-smi") is not None

            if not cuda_available:
                issues.append(
                    "CUDA device requested for EffectErase, but no CUDA GPU is detected. "
                    "EffectErase requires an NVIDIA GPU with CUDA support for diffusion video inference."
                )

        if issues:
            return False, "\n".join(issues)
        return True, None

    def validate_masks_sequence(
        self,
        masks_dir: Path,
        expected_frame_count: int,
        expected_width: int,
        expected_height: int,
    ) -> List[Path]:
        """
        Validates that mask files exist, form a complete sequential frame index,
        and contain at least one non-empty annotated region.
        """
        masks_dir = Path(masks_dir)
        if not masks_dir.is_dir():
            raise EffectEraseException(f"Masks directory not found or not a directory: {masks_dir}")

        mask_files = sorted(list(masks_dir.glob("*.png")))
        if not mask_files:
            raise EffectEraseException(f"No PNG mask files found in masks directory: {masks_dir}")

        if len(mask_files) != expected_frame_count:
            raise EffectEraseException(
                f"Mask sequence frame count mismatch: found {len(mask_files)} mask frames, "
                f"expected {expected_frame_count} frames to match source video."
            )

        # Validate sequential index naming (00000.png .. N.png or numerical sort)
        indexed_files = []
        for mf in mask_files:
            stem = mf.stem
            match = re.search(r"(\d+)$", stem)
            if match:
                indexed_files.append((int(match.group(1)), mf))
            else:
                # If cannot parse index, use alphabetical order
                indexed_files.append((len(indexed_files), mf))

        indexed_files.sort(key=lambda x: x[0])
        # Verify index range covers 0 to expected_frame_count - 1
        found_indices = [idx for idx, _ in indexed_files]
        expected_indices = list(range(expected_frame_count))
        if found_indices != expected_indices:
            raise EffectEraseException(
                f"Mask frames are not sequentially indexed from 0 to {expected_frame_count - 1}. "
                f"Missing indices: {set(expected_indices) - set(found_indices)}"
            )

        ordered_paths = [path for _, path in indexed_files]
        return ordered_paths

    def create_mask_video(
        self,
        mask_files: List[Path],
        output_mask_video_path: Path,
        fps: float,
        target_width: int,
        target_height: int,
        cancel_check: Optional[Callable[[], bool]] = None,
    ) -> Path:
        """
        Creates an aligned mask video from PNG frames matching the source video FPS and dimensions.
        Upscales masks with nearest-neighbor interpolation to original dimensions if downscaled.
        Preserves strict binary 0 (background) and 255 (object to erase).
        """
        output_mask_video_path = Path(output_mask_video_path)
        output_mask_video_path.parent.mkdir(parents=True, exist_ok=True)

        if output_mask_video_path.exists():
            try:
                output_mask_video_path.unlink()
            except OSError:
                pass

        ffmpeg_cmd = [
            "ffmpeg", "-y",
            "-f", "rawvideo",
            "-vcodec", "rawvideo",
            "-s", f"{target_width}x{target_height}",
            "-pix_fmt", "gray",
            "-r", str(fps),
            "-i", "-",
            "-c:v", "libx264",
            "-preset", "veryfast",
            "-crf", "0",
            "-pix_fmt", "yuv420p",
            str(output_mask_video_path),
        ]

        proc = subprocess.Popen(
            ffmpeg_cmd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )

        total_nonzero = 0
        first_frame_nonzero = 0

        try:
            for idx, mf in enumerate(mask_files):
                if cancel_check and cancel_check():
                    proc.kill()
                    proc.wait()
                    raise JobCancelledException("Mask video generation was cancelled.")

                mask = cv2.imread(str(mf), cv2.IMREAD_GRAYSCALE)
                if mask is None:
                    proc.kill()
                    proc.wait()
                    raise EffectEraseException(f"Failed to read mask image file: {mf}")

                # Upscale to target dimensions with nearest-neighbor interpolation if downscaled
                mh, mw = mask.shape[:2]
                if (mw, mh) != (target_width, target_height):
                    mask = cv2.resize(
                        mask,
                        (target_width, target_height),
                        interpolation=cv2.INTER_NEAREST,
                    )

                # Strict binary enforcement: 0 (background), 255 (object)
                mask = np.where(mask > 127, np.uint8(255), np.uint8(0))
                nonzero_count = int(np.count_nonzero(mask))
                total_nonzero += nonzero_count
                if idx == 0:
                    first_frame_nonzero = nonzero_count

                proc.stdin.write(mask.tobytes())

            proc.stdin.close()
            ret_code = proc.wait()
            stderr = proc.stderr.read() if proc.stderr else b""

            if ret_code != 0:
                err_msg = stderr.decode("utf-8", errors="replace") if stderr else f"Exit code {ret_code}"
                raise EffectEraseException(f"ffmpeg mask video encoding failed: {err_msg}")

        except Exception:
            if proc.poll() is None:
                proc.kill()
                proc.wait()
            if output_mask_video_path.exists():
                try:
                    output_mask_video_path.unlink()
                except OSError:
                    pass
            raise

        if total_nonzero == 0:
            if output_mask_video_path.exists():
                try:
                    output_mask_video_path.unlink()
                except OSError:
                    pass
            raise EffectEraseException("Mask sequence contains no marked object regions (all masks are empty).")

        if first_frame_nonzero == 0:
            logger.warning(
                "First mask frame is completely blank. Upstream EffectErase conditions on a square crop "
                "from the first frame (infer_remove_wan.py:crop_square_from_pil); ensure the target object "
                "is visible in frame 0 for optimal effect erasing."
            )

        return output_mask_video_path

    def mux_audio(
        self,
        video_without_audio_path: Path,
        source_with_audio_path: Path,
        output_path: Path,
    ) -> Path:
        """
        Muxes audio from source_with_audio_path into video_without_audio_path using ffmpeg.
        """
        video_without_audio_path = Path(video_without_audio_path)
        source_with_audio_path = Path(source_with_audio_path)
        output_path = Path(output_path)
        output_path.parent.mkdir(parents=True, exist_ok=True)

        mux_cmd = [
            "ffmpeg", "-y",
            "-i", str(video_without_audio_path),
            "-i", str(source_with_audio_path),
            "-map", "0:v:0",
            "-map", "1:a:0",
            "-c:v", "copy",
            "-c:a", "aac",
            "-shortest",
            str(output_path),
        ]

        result = subprocess.run(
            mux_cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )

        if result.returncode != 0:
            logger.warning(
                f"Audio muxing failed ({result.stderr}). Preserving video without audio."
            )
            shutil.copy2(str(video_without_audio_path), str(output_path))
        return output_path

    def _execute_subprocess(
        self,
        cmd: List[str],
        progress_cb: Optional[Callable[[str, int], None]],
        cancel_check: Optional[Callable[[], bool]],
    ) -> List[str]:
        """
        Executes inference command with argument list (no shell injection),
        real-time log capture, cancellation responsiveness, and stage detection.
        """
        env = os.environ.copy()

        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
            env=env,
        )

        log_queue: queue.Queue = queue.Queue()

        def reader():
            try:
                for line in iter(proc.stdout.readline, ""):
                    log_queue.put(line)
            except Exception:
                pass
            finally:
                if proc.stdout:
                    proc.stdout.close()

        t = threading.Thread(target=reader, daemon=True)
        t.start()

        logs: List[str] = []
        step_pattern = re.compile(r"(\d+)/(\d+)")

        while True:
            if cancel_check and cancel_check():
                proc.terminate()
                try:
                    proc.wait(timeout=3.0)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait()
                raise JobCancelledException("Removal was cancelled during model inference.")

            try:
                line = log_queue.get(timeout=0.2)
                line_str = line.strip()
                logs.append(line_str)
                logger.debug(f"[EffectErase] {line_str}")

                if progress_cb:
                    if "[INFO] Building model" in line_str or "loading_models" in line_str.lower():
                        progress_cb("loading_model", 25)
                    elif "[INFO] Running inference" in line_str:
                        progress_cb("inference", 40)
                    elif "[INFO] Saved video" in line_str:
                        progress_cb("validating_output", 90)
                    elif "step" in line_str.lower() or "it/s" in line_str or "s/it" in line_str:
                        m = step_pattern.search(line_str)
                        if m:
                            current_step = int(m.group(1))
                            total_steps = int(m.group(2))
                            if total_steps > 0:
                                frac = min(1.0, current_step / total_steps)
                                progress_cb("inference", 40 + int(frac * 45))

            except queue.Empty:
                if proc.poll() is not None:
                    # Drain remaining queue entries
                    while not log_queue.empty():
                        try:
                            remaining = log_queue.get_nowait().strip()
                            logs.append(remaining)
                        except queue.Empty:
                            break
                    break

        if proc.returncode != 0:
            err_snippet = "\n".join(logs[-25:]) if logs else f"Process exited with code {proc.returncode}"
            raise EffectEraseException(
                f"EffectErase subprocess failed with exit code {proc.returncode}:\n{err_snippet}"
            )

        return logs

    def _execute_modal(
        self,
        modal_url: str,
        source_video_path: Path,
        mask_video_path: Path,
        output_path: Path,
        params: Dict[str, Any],
        progress_cb: Optional[Callable[[str, int], None]] = None,
        cancel_check: Optional[Callable[[], bool]] = None,
    ) -> None:
        import httpx

        if cancel_check and cancel_check():
            raise JobCancelledException("Removal job was cancelled before Modal request.")

        if progress_cb:
            progress_cb("inference", 30)

        timeout_sec = float(
            getattr(config, "EFFECT_ERASE_TIMEOUT_SECONDS", 1800.0)
            if config is not None
            else 1800.0
        )

        with (
            open(source_video_path, "rb") as fg_f,
            open(mask_video_path, "rb") as mask_f,
        ):
            files = {
                "fg_bg_video": ("fg_bg.mp4", fg_f, "video/mp4"),
                "mask_video": ("mask.mp4", mask_f, "video/mp4"),
            }
            base_url = modal_url.rstrip("/")
            with httpx.Client(timeout=timeout_sec, follow_redirects=True) as client:
                resp = client.post(base_url, params=params, files=files)

                if resp.status_code != 200:
                    raise EffectEraseException(
                        f"Remote EffectErase endpoint returned HTTP {resp.status_code}: {resp.text[:500]}"
                    )

                content_type = resp.headers.get("content-type", "")
                if "application/json" in content_type:
                    import time

                    job_id = resp.json().get("job_id")
                    if not job_id:
                        raise EffectEraseException(f"Remote endpoint returned unexpected JSON: {resp.text[:500]}")

                    deadline = time.monotonic() + timeout_sec
                    while time.monotonic() < deadline:
                        if cancel_check and cancel_check():
                            raise JobCancelledException("Removal job was cancelled during remote inference.")
                        time.sleep(5)
                        st = client.get(f"{base_url}/jobs/{job_id}")
                        if st.status_code != 200:
                            raise EffectEraseException(f"Remote status check failed ({st.status_code}): {st.text[:300]}")
                        data = st.json()
                        if data.get("status") == "done":
                            res = client.get(f"{base_url}/jobs/{job_id}/result")
                            if res.status_code != 200:
                                raise EffectEraseException(f"Remote result download failed ({res.status_code})")
                            output_path.write_bytes(res.content)
                            break
                        if data.get("status") == "failed":
                            raise EffectEraseException(f"Remote EffectErase failed: {data.get('error', 'unknown error')}")
                    else:
                        raise EffectEraseException("Remote EffectErase timed out waiting for completion.")
                else:
                    output_path.write_bytes(resp.content)

        if cancel_check and cancel_check():
            raise JobCancelledException("Removal job was cancelled during remote inference.")

        if progress_cb:
            progress_cb("inference", 90)

    def run_removal(
        self,
        job_id: str,
        erase_run_id: str,
        source_video_path: Path | str,
        masks_dir: Path | str,
        staging_dir: Path | str,
        progress_cb: Optional[Callable[[str, int], None]] = None,
        cancel_check: Optional[Callable[[], bool]] = None,
        **kwargs,
    ) -> Path:
        """
        Runs the full EffectErase video object removal pipeline:
        1. Preflight validation & availability check
        2. Sequence verification & binary mask upscaling
        3. Aligned mask video generation via ffmpeg
        4. Out-of-process inference execution
        5. Source audio preservation / muxing
        6. Video output validation and scratch cleanup
        Returns Path to staged, validated output video file.
        """
        source_video_path = Path(source_video_path)
        masks_dir = Path(masks_dir)
        staging_dir = Path(staging_dir)
        staging_dir.mkdir(parents=True, exist_ok=True)

        mask_video_path = staging_dir / f"mask_{erase_run_id}.mp4"
        raw_output_path = staging_dir / f"raw_output_{erase_run_id}.mp4"
        final_output_path = staging_dir / f"cleaned_{erase_run_id}.mp4"

        def cleanup_temp_files():
            for p in (mask_video_path, raw_output_path):
                if p.exists():
                    try:
                        p.unlink()
                    except OSError:
                        pass

        try:
            if cancel_check and cancel_check():
                raise JobCancelledException("Removal job was cancelled before execution started.")

            # Stage 0: Availability check
            if not kwargs.get("skip_preflight", False):
                available, reason = self.check_availability(
                    check_weights=kwargs.get("check_weights", True)
                )
                if not available:
                    raise EffectEraseUnavailableException(
                        f"EffectErase runtime unavailable:\n{reason}"
                    )

            # Stage 1: Video metadata & mask preparation
            if progress_cb:
                progress_cb("preparing_input", 5)

            if not source_video_path.is_file():
                raise EffectEraseException(f"Source video file not found: {source_video_path}")

            video_meta = probe_video(str(source_video_path))
            raw_w = video_meta["width"]
            raw_h = video_meta["height"]
            raw_fps = video_meta["fps"]
            frame_count = video_meta["frame_count"]
            has_audio = video_meta.get("has_audio", False)

            ordered_mask_files = self.validate_masks_sequence(
                masks_dir=masks_dir,
                expected_frame_count=frame_count,
                expected_width=raw_w,
                expected_height=raw_h,
            )

            if cancel_check and cancel_check():
                raise JobCancelledException("Removal job was cancelled during input validation.")

            if progress_cb:
                progress_cb("preparing_input", 12)

            # Stage 2: Create aligned mask video
            self.create_mask_video(
                mask_files=ordered_mask_files,
                output_mask_video_path=mask_video_path,
                fps=raw_fps,
                target_width=raw_w,
                target_height=raw_h,
                cancel_check=cancel_check,
            )

            if cancel_check and cancel_check():
                raise JobCancelledException("Removal job was cancelled after mask video generation.")

            # Stage 3: Subprocess inference invocation
            if progress_cb:
                progress_cb("loading_model", 20)

            # Determine frame count (Wan2.1 supports 4k+1 frames, default 81)
            num_frames = kwargs.get("num_frames") or self.config.num_frames
            if num_frames is None:
                # Upstream default is 81 frames, clamp to video frame count
                if frame_count >= 81:
                    num_frames = 81
                else:
                    # Find highest 4k + 1 <= frame_count
                    k = (frame_count - 1) // 4
                    num_frames = max(1, 4 * k + 1) if k >= 1 else frame_count

            default_h = self.config.height
            default_w = self.config.width
            if raw_h > raw_w and default_w > default_h:
                default_h, default_w = default_w, default_h
            target_h = kwargs.get("height", default_h)
            target_w = kwargs.get("width", default_w)

            cmd = [
                str(self.config.python_bin),
                str(self.config.script_path),
                "--fg_bg_path", str(source_video_path),
                "--mask_path", str(mask_video_path),
                "--output_path", str(raw_output_path),
                "--text_encoder_path", str(self.config.text_encoder_path),
                "--vae_path", str(self.config.vae_path),
                "--dit_path", str(self.config.dit_path),
                "--image_encoder_path", str(self.config.image_encoder_path),
                "--pretrained_lora_path", str(self.config.lora_path),
                "--seed", str(kwargs.get("seed", self.config.seed)),
                "--cfg", str(kwargs.get("cfg", self.config.cfg)),
                "--lora_alpha", str(kwargs.get("lora_alpha", self.config.lora_alpha)),
                "--num_inference_steps", str(kwargs.get("num_inference_steps", self.config.num_inference_steps)),
                "--height", str(target_h),
                "--width", str(target_w),
                "--num_frames", str(num_frames),
                "--frame_interval", str(kwargs.get("frame_interval", self.config.frame_interval)),
            ]

            if kwargs.get("tiled", self.config.tiled):
                cmd.append("--tiled")
            if kwargs.get("use_teacache", self.config.use_teacache):
                cmd.append("--use_teacache")

            backend_mode = (
                getattr(config, "EFFECT_ERASE_BACKEND", None)
                or os.environ.get("EFFECT_ERASE_BACKEND", "local")
            ).lower()

            if backend_mode in ("remote", "modal"):
                remote_url = (
                    getattr(config, "EFFECT_ERASE_REMOTE_URL", None)
                    or os.environ.get("EFFECT_ERASE_REMOTE_URL", "")
                ).strip()
                self._execute_modal(
                    modal_url=remote_url,
                    source_video_path=source_video_path,
                    mask_video_path=mask_video_path,
                    output_path=raw_output_path,
                    params={
                        "seed": kwargs.get("seed", self.config.seed),
                        "cfg": kwargs.get("cfg", self.config.cfg),
                        "lora_alpha": kwargs.get("lora_alpha", self.config.lora_alpha),
                        "num_inference_steps": kwargs.get("num_inference_steps", self.config.num_inference_steps),
                        "height": target_h,
                        "width": target_w,
                        "num_frames": num_frames,
                        "frame_interval": kwargs.get("frame_interval", self.config.frame_interval),
                        "tiled": True,
                        "use_teacache": bool(kwargs.get("use_teacache", self.config.use_teacache)),
                    },
                    progress_cb=progress_cb,
                    cancel_check=cancel_check,
                )
            else:
                self._execute_subprocess(
                    cmd=cmd,
                    progress_cb=progress_cb,
                    cancel_check=cancel_check,
                )

            # Stage 4: Validate raw output
            if progress_cb:
                progress_cb("validating_output", 92)

            if not raw_output_path.is_file() or raw_output_path.stat().st_size == 0:
                raise EffectEraseException(
                    f"EffectErase completed without generating output video file at {raw_output_path}"
                )

            # Stage 5: Audio handling
            if has_audio:
                self.mux_audio(
                    video_without_audio_path=raw_output_path,
                    source_with_audio_path=source_video_path,
                    output_path=final_output_path,
                )
                try:
                    raw_output_path.unlink()
                except OSError:
                    pass
            else:
                shutil.move(str(raw_output_path), str(final_output_path))

            # Stage 6: Final output validation
            if progress_cb:
                progress_cb("validating_output", 98)

            if not final_output_path.is_file() or final_output_path.stat().st_size == 0:
                raise EffectEraseException(
                    f"Final validated video is missing or empty at {final_output_path}"
                )

            out_meta = probe_video(str(final_output_path))
            if out_meta["width"] <= 0 or out_meta["height"] <= 0 or out_meta["frame_count"] <= 0:
                raise EffectEraseException(
                    f"Final output video failed metadata validation: {out_meta}"
                )

            # Clean temporary mask video
            cleanup_temp_files()
            return final_output_path

        except Exception:
            cleanup_temp_files()
            if final_output_path.exists():
                try:
                    final_output_path.unlink()
                except OSError:
                    pass
            raise
