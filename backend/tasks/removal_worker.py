import asyncio
import threading
import time
import shutil
import uuid
import logging
from pathlib import Path
from typing import Dict, Any, Optional, Set, Tuple
from fastapi import HTTPException

import config
from schemas import RemovalJobRequest

logger = logging.getLogger("stirs.removal")


class JobCancelledException(Exception):
    """Raised when a removal job is cancelled."""
    pass


# Fallback exception & adapter classes in case core.effect_erase_adapter is loaded dynamically
class EffectEraseException(Exception):
    pass


class EffectEraseUnavailableException(EffectEraseException):
    pass


class EffectEraseAdapter:
    def check_availability(self) -> Tuple[bool, Optional[str]]:
        return False, "EffectErase adapter is not configured."

    def run_removal(
        self,
        job_id: str,
        erase_run_id: str,
        source_video_path: Path,
        masks_dir: Path,
        staging_dir: Path,
        progress_cb: Optional[Any] = None,
        cancel_check: Optional[Any] = None,
    ) -> Path:
        raise EffectEraseUnavailableException("EffectErase adapter is not configured.")


def _get_adapter_classes():
    """Dynamically imports the adapter and exception classes from core.effect_erase_adapter."""
    try:
        import core.effect_erase_adapter as adapter_mod
        cls = getattr(adapter_mod, "EffectEraseAdapter", EffectEraseAdapter)
        exc = getattr(adapter_mod, "EffectEraseException", EffectEraseException)
        unavail = getattr(adapter_mod, "EffectEraseUnavailableException", EffectEraseUnavailableException)
        return cls, exc, unavail
    except ImportError:
        return EffectEraseAdapter, EffectEraseException, EffectEraseUnavailableException


# Run-scoped tracking for video removal
REMOVAL_RUN_STATUS: Dict[str, Dict[str, Any]] = {}
REMOVAL_EVENT_QUEUES: Dict[str, asyncio.Queue] = {}
JOB_LATEST_REMOVAL_RUN: Dict[str, str] = {}
ACTIVE_REMOVAL_RUNS: Dict[str, str] = {}  # job_id -> erase_run_id
REMOVAL_CANCELLATION_EVENTS: Dict[str, threading.Event] = {}  # erase_run_id -> Event
REMOVAL_LAST_PROGRESS: Dict[str, int] = {}


def is_removal_active(job_id: str) -> bool:
    """Returns True if the job currently has an active removal task running."""
    return job_id in ACTIVE_REMOVAL_RUNS


def get_removal_queue(job_id: str, erase_run_id: Optional[str] = None) -> asyncio.Queue:
    """Returns the event queue for a specific erase_run_id or job fallback."""
    if erase_run_id:
        if erase_run_id not in REMOVAL_EVENT_QUEUES:
            REMOVAL_EVENT_QUEUES[erase_run_id] = asyncio.Queue()
        return REMOVAL_EVENT_QUEUES[erase_run_id]

    latest = JOB_LATEST_REMOVAL_RUN.get(job_id)
    if latest:
        if latest not in REMOVAL_EVENT_QUEUES:
            REMOVAL_EVENT_QUEUES[latest] = asyncio.Queue()
        return REMOVAL_EVENT_QUEUES[latest]

    fallback_key = f"job_removal_{job_id}"
    if fallback_key not in REMOVAL_EVENT_QUEUES:
        REMOVAL_EVENT_QUEUES[fallback_key] = asyncio.Queue()
    return REMOVAL_EVENT_QUEUES[fallback_key]


def cancel_removal(job_id: str, erase_run_id: Optional[str] = None) -> bool:
    """Signals cancellation for a running removal task. Returns True if actively running."""
    if erase_run_id:
        event = REMOVAL_CANCELLATION_EVENTS.get(erase_run_id)
        if event:
            event.set()
            return True
        return False

    active_run = ACTIVE_REMOVAL_RUNS.get(job_id)
    if active_run:
        event = REMOVAL_CANCELLATION_EVENTS.get(active_run)
        if event:
            event.set()
            return True
    return False


def get_removal_status(job_id: str, erase_run_id: Optional[str] = None) -> Optional[Dict[str, Any]]:
    """Returns the latest status payload for a removal run or job."""
    if erase_run_id == "latest":
        erase_run_id = JOB_LATEST_REMOVAL_RUN.get(job_id)

    if erase_run_id:
        if erase_run_id in REMOVAL_RUN_STATUS:
            return REMOVAL_RUN_STATUS[erase_run_id]

        # Check if the run-scoped cleaned file exists on disk
        job_dir = config.WORKSPACE_DIR / job_id
        run_cleaned = job_dir / f"cleaned_{erase_run_id}.mp4"
        if run_cleaned.exists():
            return {
                "job_id": job_id,
                "erase_run_id": erase_run_id,
                "status": "completed",
                "stage": "completed",
                "progress": 100,
                "output_url": f"/api/v1/jobs/{job_id}/removal/{erase_run_id}/result",
                "result_url": f"/api/v1/jobs/{job_id}/removal/{erase_run_id}/result",
            }
        return None

    latest = JOB_LATEST_REMOVAL_RUN.get(job_id)
    if latest and latest in REMOVAL_RUN_STATUS:
        return REMOVAL_RUN_STATUS[latest]

    job_dir = config.WORKSPACE_DIR / job_id
    stable_cleaned = job_dir / "cleaned.mp4"
    if stable_cleaned.exists():
        run_id = latest or "latest"
        return {
            "job_id": job_id,
            "erase_run_id": run_id,
            "status": "completed",
            "stage": "completed",
            "progress": 100,
            "output_url": f"/api/v1/jobs/{job_id}/removal/{run_id}/result",
            "result_url": f"/api/v1/jobs/{job_id}/removal/{run_id}/result",
        }
    return None


async def emit_removal_progress(
    job_id: str,
    erase_run_id: str,
    stage: str,
    progress: int,
    output_url: Optional[str] = None,
    message: Optional[str] = None,
    error: Optional[str] = None
):
    """Pushes a progress event to run-scoped status and event queues."""
    REMOVAL_LAST_PROGRESS[erase_run_id] = progress
    payload = {
        "job_id": job_id,
        "erase_run_id": erase_run_id,
        "status": stage,
        "stage": stage,
        "progress": progress,
        "output_url": output_url,
        "result_url": output_url,
        "message": message,
        "error": error
    }
    REMOVAL_RUN_STATUS[erase_run_id] = payload
    if erase_run_id in REMOVAL_EVENT_QUEUES:
        await REMOVAL_EVENT_QUEUES[erase_run_id].put(payload)
    fallback_key = f"job_removal_{job_id}"
    if fallback_key in REMOVAL_EVENT_QUEUES:
        await REMOVAL_EVENT_QUEUES[fallback_key].put(payload)


def run_removal_pipeline(
    job_id: str,
    erase_run_id: str,
    request: Optional[RemovalJobRequest] = None,
    loop: Optional[asyncio.AbstractEventLoop] = None
):
    """
    Synchronous removal pipeline execution:
    1. Preflight validation & staging preparation
    2. Adapter invocation (mask video encoding, out-of-process inference, audio muxing)
    3. Output validation & atomic publication
    4. Cooperative cancellation & cleanup
    """
    cancel_event = REMOVAL_CANCELLATION_EVENTS.get(erase_run_id)

    def send_event(
        stage: str,
        progress: int,
        output_url: Optional[str] = None,
        message: Optional[str] = None,
        error: Optional[str] = None
    ):
        payload = {
            "job_id": job_id,
            "erase_run_id": erase_run_id,
            "status": stage,
            "stage": stage,
            "progress": progress,
            "output_url": output_url,
            "result_url": output_url,
            "message": message,
            "error": error
        }
        REMOVAL_LAST_PROGRESS[erase_run_id] = progress
        REMOVAL_RUN_STATUS[erase_run_id] = payload
        if loop and loop.is_running():
            asyncio.run_coroutine_threadsafe(
                emit_removal_progress(
                    job_id,
                    erase_run_id,
                    stage,
                    progress,
                    output_url=output_url,
                    message=message,
                    error=error
                ),
                loop
            )

    job_dir = config.WORKSPACE_DIR / job_id
    staging_dir = job_dir / f"removal_staging_{erase_run_id}"
    published_run_video = job_dir / f"cleaned_{erase_run_id}.mp4"
    published_stable_video = job_dir / "cleaned.mp4"
    masks_dir = job_dir / "masks"
    masks_zip = job_dir / "output_masks.zip"
    raw_video_path = job_dir / "raw_video.mp4"

    adapter_cls, eff_exc, eff_unavail = _get_adapter_classes()

    try:
        if cancel_event and cancel_event.is_set():
            raise JobCancelledException("Removal was cancelled before execution started.")

        # Ensure staging directory is clean
        if staging_dir.exists():
            shutil.rmtree(staging_dir, ignore_errors=True)
        staging_dir.mkdir(parents=True, exist_ok=True)

        # Ensure masks exist (extract from output_masks.zip if directory missing)
        has_masks = masks_dir.exists() and any(masks_dir.glob("*.png"))
        if not has_masks and masks_zip.exists():
            import zipfile
            masks_dir.mkdir(parents=True, exist_ok=True)
            with zipfile.ZipFile(masks_zip, "r") as z:
                z.extractall(masks_dir)
            has_masks = any(masks_dir.glob("*.png"))

        if not has_masks:
            raise ValueError("No masks found for this job. Mask generation must be completed before removal.")

        if not raw_video_path.exists():
            raise FileNotFoundError(f"Source video not found at {raw_video_path}")

        # Step 1: Preflight checks
        send_event("preparing_input", 5, message="Validating inputs and environment")
        adapter = adapter_cls()

        if hasattr(adapter, "check_availability"):
            available, reason = adapter.check_availability()
            if not available:
                raise eff_unavail(reason or "EffectErase runtime or weights are unavailable.")

        if cancel_event and cancel_event.is_set():
            raise JobCancelledException("Removal was cancelled before inference.")

        # Step 2: Adapter invocation with progress and cancellation hooks
        def progress_adapter_cb(stage_or_pct: Any, pct: Optional[int] = None):
            if pct is None and isinstance(stage_or_pct, int):
                send_event("inference", stage_or_pct)
            else:
                send_event(str(stage_or_pct), int(pct if pct is not None else 0))

        def cancel_check() -> bool:
            return bool(cancel_event and cancel_event.is_set())

        staged_output = adapter.run_removal(
            job_id=job_id,
            erase_run_id=erase_run_id,
            source_video_path=raw_video_path,
            masks_dir=masks_dir,
            staging_dir=staging_dir,
            progress_cb=progress_adapter_cb,
            cancel_check=cancel_check,
        )

        if cancel_check():
            raise JobCancelledException("Removal was cancelled during execution.")

        staged_file = Path(staged_output) if staged_output else None
        if not staged_file or not staged_file.exists():
            # Search staging dir for output
            candidates = list(staging_dir.glob("*.mp4"))
            if candidates:
                staged_file = candidates[0]
            else:
                raise FileNotFoundError("EffectErase finished without producing an output video.")

        # Step 3: Validating output
        send_event("validating_output", 90, message="Validating generated video output")
        if staged_file.stat().st_size == 0:
            raise ValueError("Generated output video is 0 bytes.")

        # Step 4: Atomic Publication
        send_event("publishing", 95, message="Publishing cleaned video")

        # Atomically update stable cleaned.mp4
        temp_stable = job_dir / f"cleaned_temp_{erase_run_id}.mp4"
        shutil.copy2(staged_file, temp_stable)
        temp_stable.replace(published_stable_video)

        # Move to run-scoped published video
        staged_file.replace(published_run_video)

        # Clean staging directory
        if staging_dir.exists():
            shutil.rmtree(staging_dir, ignore_errors=True)

        result_url = f"/api/v1/jobs/{job_id}/removal/{erase_run_id}/result"
        send_event("completed", 100, output_url=result_url, message="Object removed successfully.")

    except JobCancelledException as e:
        curr_progress = REMOVAL_LAST_PROGRESS.get(erase_run_id, 0)
        if staging_dir.exists():
            shutil.rmtree(staging_dir, ignore_errors=True)
        send_event("cancelled", curr_progress, error=str(e))

    except (eff_unavail, eff_exc) as e:
        if staging_dir.exists():
            shutil.rmtree(staging_dir, ignore_errors=True)
        send_event("failed", 100, error=str(e))

    except Exception as e:
        logger.exception(f"Removal pipeline failed for run {erase_run_id}: {e}")
        if staging_dir.exists():
            shutil.rmtree(staging_dir, ignore_errors=True)
        send_event("failed", 100, error=str(e))

    finally:
        ACTIVE_REMOVAL_RUNS.pop(job_id, None)
        REMOVAL_CANCELLATION_EVENTS.pop(erase_run_id, None)


async def start_removal_task(
    job_id: str,
    request: Optional[RemovalJobRequest] = None,
    erase_run_id: Optional[str] = None
) -> str:
    """
    Enqueues a video removal task for job_id with a dedicated erase_run_id.
    Validates job workspace, source video, and mask completion.
    Rejects duplicate active removal runs for the same job.
    """
    job_dir = config.WORKSPACE_DIR / job_id
    if not job_dir.exists():
        raise HTTPException(status_code=404, detail="Job workspace not found")

    raw_video_path = job_dir / "raw_video.mp4"
    if not raw_video_path.exists():
        raise HTTPException(status_code=404, detail="Source video not found for this job")

    masks_dir = job_dir / "masks"
    masks_zip = job_dir / "output_masks.zip"
    has_masks = (masks_dir.exists() and any(masks_dir.glob("*.png"))) or masks_zip.exists()
    if not has_masks:
        raise HTTPException(
            status_code=400,
            detail="Mask generation must be completed before starting video removal."
        )

    if is_removal_active(job_id):
        raise HTTPException(
            status_code=409,
            detail="A video removal run is already active for this job"
        )

    if erase_run_id is None:
        erase_run_id = f"erase_{uuid.uuid4().hex[:12]}"

    cancel_event = threading.Event()
    REMOVAL_CANCELLATION_EVENTS[erase_run_id] = cancel_event
    ACTIVE_REMOVAL_RUNS[job_id] = erase_run_id
    JOB_LATEST_REMOVAL_RUN[job_id] = erase_run_id

    if erase_run_id not in REMOVAL_EVENT_QUEUES:
        REMOVAL_EVENT_QUEUES[erase_run_id] = asyncio.Queue()

    initial_payload = {
        "job_id": job_id,
        "erase_run_id": erase_run_id,
        "stage": "queued",
        "status": "queued",
        "progress": 0,
        "message": "Removal job queued"
    }
    REMOVAL_RUN_STATUS[erase_run_id] = initial_payload
    REMOVAL_LAST_PROGRESS[erase_run_id] = 0
    await REMOVAL_EVENT_QUEUES[erase_run_id].put(initial_payload)

    loop = asyncio.get_running_loop()
    loop.run_in_executor(None, run_removal_pipeline, job_id, erase_run_id, request, loop)
    return erase_run_id
