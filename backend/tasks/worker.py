import asyncio
import threading
import time
import shutil
import zipfile
import uuid
import cv2
from pathlib import Path
from typing import Dict, Any, Optional, Set
from fastapi import HTTPException

import config
from schemas import MaskJobRequest, Point2D, StrokeInput
from core.geometry import convert_strokes_to_sam2_prompts, convert_strokes_to_sam2_multi_obj_prompts
from core.video_io import probe_video
from core.sam2_engine import SAM2MaskGenerator, JobCancelledException

# Run-scoped tracking
RUN_STATUS: Dict[str, Dict[str, Any]] = {}
RUN_EVENT_QUEUES: Dict[str, asyncio.Queue] = {}
JOB_LATEST_RUN: Dict[str, str] = {}
ACTIVE_RUNS: Dict[str, str] = {}

# Backward-compatible job-level tracking
JOB_EVENT_QUEUES: Dict[str, asyncio.Queue] = {}
JOB_STATUS: Dict[str, Dict[str, Any]] = {}
CANCELLATION_EVENTS: Dict[str, threading.Event] = {}
ACTIVE_JOB_IDS: Set[str] = set()
LAST_PROGRESS: Dict[str, int] = {}


def get_job_queue(job_id: str, run_id: Optional[str] = None) -> asyncio.Queue:
    """Returns the event queue for a specific run_id or falls back to the job's latest run / job queue."""
    if run_id:
        if run_id not in RUN_EVENT_QUEUES:
            RUN_EVENT_QUEUES[run_id] = asyncio.Queue()
        return RUN_EVENT_QUEUES[run_id]

    latest = JOB_LATEST_RUN.get(job_id)
    if latest and latest in RUN_EVENT_QUEUES:
        return RUN_EVENT_QUEUES[latest]

    if job_id not in JOB_EVENT_QUEUES:
        JOB_EVENT_QUEUES[job_id] = asyncio.Queue()
    return JOB_EVENT_QUEUES[job_id]


def cancel_job(job_id: str, run_id: Optional[str] = None) -> bool:
    """Signals cancellation for a running job / run. Returns True if was actively running."""
    if run_id:
        if run_id in CANCELLATION_EVENTS:
            CANCELLATION_EVENTS[run_id].set()
            return True
        return False

    was_active = False
    active_run = ACTIVE_RUNS.get(job_id)
    if active_run and active_run in CANCELLATION_EVENTS:
        CANCELLATION_EVENTS[active_run].set()
        was_active = True
    if job_id in CANCELLATION_EVENTS:
        CANCELLATION_EVENTS[job_id].set()
        was_active = True
    return was_active


def is_job_active(job_id: str) -> bool:
    """Returns True if the job is currently actively executing a generation task."""
    return job_id in ACTIVE_RUNS or job_id in ACTIVE_JOB_IDS


async def emit_progress(
    job_id: str,
    stage: str,
    progress: int,
    run_id: Optional[str] = None,
    output_url: Optional[str] = None,
    error: Optional[str] = None
):
    if run_id:
        LAST_PROGRESS[run_id] = progress
    LAST_PROGRESS[job_id] = progress

    payload = {
        "stage": stage,
        "progress": progress,
        "run_id": run_id,
        "output_url": output_url,
        "error": error
    }

    if run_id:
        RUN_STATUS[run_id] = payload
        if run_id in RUN_EVENT_QUEUES:
            await RUN_EVENT_QUEUES[run_id].put(payload)

    JOB_STATUS[job_id] = payload
    if job_id in JOB_EVENT_QUEUES:
        await JOB_EVENT_QUEUES[job_id].put(payload)


def run_sync_pipeline(
    job_id: str,
    run_id: Any,
    request: Optional[Any] = None,
    loop: Optional[asyncio.AbstractEventLoop] = None
):
    """
    Propagates SAM 2 masks across the video into run-scoped staging, packages to staging zip,
    and publishes atomically only upon successful completion.
    Supports cooperative cancellation and cleanup.
    """
    if isinstance(run_id, MaskJobRequest):
        # Backward-compatibility for (job_id, request, loop)
        actual_loop = request
        actual_request = run_id
        actual_run_id = JOB_LATEST_RUN.get(job_id) or str(uuid.uuid4())
    else:
        actual_run_id = str(run_id)
        actual_request = request
        actual_loop = loop

    cancel_event = CANCELLATION_EVENTS.get(actual_run_id) or CANCELLATION_EVENTS.get(job_id)

    def send_event(stage: str, progress: int, output_url: Optional[str] = None, error: Optional[str] = None):
        payload = {
            "stage": stage,
            "progress": progress,
            "run_id": actual_run_id,
            "output_url": output_url,
            "error": error
        }
        if actual_run_id:
            LAST_PROGRESS[actual_run_id] = progress
            RUN_STATUS[actual_run_id] = payload
        LAST_PROGRESS[job_id] = progress
        JOB_STATUS[job_id] = payload
        if actual_loop and actual_loop.is_running():
            asyncio.run_coroutine_threadsafe(
                emit_progress(job_id, stage, progress, run_id=actual_run_id, output_url=output_url, error=error),
                actual_loop
            )

    job_dir = config.WORKSPACE_DIR / job_id
    staging_masks_dir = job_dir / f"masks_staging_{actual_run_id}"
    staging_zip_path = job_dir / f"output_masks_staging_{actual_run_id}.zip"
    published_masks_dir = job_dir / "masks"
    published_zip_path = job_dir / "output_masks.zip"

    try:
        if cancel_event and cancel_event.is_set():
            raise JobCancelledException("Job was cancelled before processing started.")

        # Ensure staging directory is clean
        if staging_masks_dir.exists():
            shutil.rmtree(staging_masks_dir, ignore_errors=True)
        staging_masks_dir.mkdir(parents=True, exist_ok=True)

        if staging_zip_path.exists():
            try:
                staging_zip_path.unlink()
            except OSError:
                pass

        frames_dir = str(job_dir / "frames")
        raw_video_path = str(job_dir / "raw_video.mp4")

        meta = probe_video(raw_video_path)
        raw_w, raw_h = meta["width"], meta["height"]

        # Check actual extracted frame dimensions
        sample_frame = next(Path(frames_dir).glob("*.jpg"), None)
        if sample_frame:
            img = cv2.imread(str(sample_frame))
            frame_h, frame_w = img.shape[:2]
            scale_x = frame_w / float(raw_w)
            scale_y = frame_h / float(raw_h)
        else:
            frame_w, frame_h = raw_w, raw_h
            scale_x, scale_y = 1.0, 1.0

        # Step 1: Geometry prompts scaled to frame space (support multi-keyframe and multi-object)
        keyframe_prompts = []

        if actual_request.keyframes:
            for kf in actual_request.keyframes:
                kf_scaled_strokes = []
                for stroke in kf.strokes:
                    scaled_pts = [Point2D(x=p.x * scale_x, y=p.y * scale_y) for p in stroke.points]
                    kf_scaled_strokes.append(StrokeInput(points=scaled_pts, mode=stroke.mode))
                obj_prompts = convert_strokes_to_sam2_multi_obj_prompts(
                    kf_scaled_strokes,
                    frame_w=frame_w,
                    frame_h=frame_h
                )
                keyframe_prompts.append({
                    "frame_idx": kf.frame_idx,
                    "objects": obj_prompts
                })
        elif actual_request.strokes:
            annotated_idx = actual_request.annotated_frame_idx if actual_request.annotated_frame_idx is not None else 0
            scaled_strokes = []
            for stroke in actual_request.strokes:
                scaled_pts = [Point2D(x=p.x * scale_x, y=p.y * scale_y) for p in stroke.points]
                scaled_strokes.append(StrokeInput(points=scaled_pts, mode=stroke.mode))
            obj_prompts = convert_strokes_to_sam2_multi_obj_prompts(
                scaled_strokes,
                frame_w=frame_w,
                frame_h=frame_h
            )
            keyframe_prompts.append({
                "frame_idx": annotated_idx,
                "objects": obj_prompts
            })

        # Step 2: SAM 2 bidirectional propagation (via cached singleton with small fallback)
        sam2_generator = SAM2MaskGenerator.get_instance(
            config_path=config.DEFAULT_SAM2_CONFIG,
            checkpoint_path=config.DEFAULT_SAM2_CHECKPOINT,
            device=config.DEVICE,
            fallback_config_path=config.FALLBACK_SAM2_CONFIG,
            fallback_checkpoint_path=config.FALLBACK_SAM2_CHECKPOINT,
        )

        def sam_progress(stage: str, pct: int):
            send_event(stage, pct)

        first_kf_idx = keyframe_prompts[0]["frame_idx"] if keyframe_prompts else 0

        def cancel_check() -> bool:
            return bool(cancel_event and cancel_event.is_set())

        propagate_kwargs = {
            "frames_dir": frames_dir,
            "output_mask_dir": str(staging_masks_dir),
            "annotated_frame_idx": first_kf_idx,
            "keyframe_prompts": keyframe_prompts,
            "dilation_px": actual_request.dilation_px,
            "accumulate": actual_request.accumulate_with_existing,
            "progress_cb": sam_progress,
            "cancel_check": cancel_check,
        }
        if actual_request.accumulate_with_existing:
            propagate_kwargs["existing_mask_dir"] = str(published_masks_dir)

        sam2_generator.propagate_full_video(**propagate_kwargs)

        if cancel_check():
            raise JobCancelledException("Job was cancelled before packaging.")

        # Package the propagated binary PNG masks to staging zip
        send_event("packaging", 95)
        with zipfile.ZipFile(staging_zip_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            for mask_path in sorted(staging_masks_dir.glob("*.png")):
                archive.write(mask_path, arcname=mask_path.name)

        # Atomic / Safe Publication:
        # Only when propagation and ZIP packaging successfully finish:
        # 1. Safely replace published masks directory
        temp_backup_dir = job_dir / f"masks_backup_{actual_run_id}"
        if published_masks_dir.exists():
            published_masks_dir.rename(temp_backup_dir)
        try:
            staging_masks_dir.rename(published_masks_dir)
            if temp_backup_dir.exists():
                shutil.rmtree(temp_backup_dir, ignore_errors=True)
        except Exception:
            if temp_backup_dir.exists() and not published_masks_dir.exists():
                temp_backup_dir.rename(published_masks_dir)
            raise

        # 2. Atomically replace output_masks.zip
        staging_zip_path.replace(published_zip_path)

        output_url = f"/workspace/{job_id}/output_masks.zip?v={actual_run_id}"
        send_event("completed", 100, output_url=output_url)

    except JobCancelledException as e:
        curr_progress = LAST_PROGRESS.get(actual_run_id, LAST_PROGRESS.get(job_id, 0))
        # Clean up staging dir and staging zip
        if staging_masks_dir.exists():
            shutil.rmtree(staging_masks_dir, ignore_errors=True)
        if staging_zip_path.exists():
            try:
                staging_zip_path.unlink()
            except OSError:
                pass
        # Any existing masks and output_masks.zip from prior runs remain completely intact!
        send_event("cancelled", curr_progress, error=str(e))

    except Exception as e:
        import traceback
        traceback.print_exc()
        if staging_masks_dir.exists():
            shutil.rmtree(staging_masks_dir, ignore_errors=True)
        if staging_zip_path.exists():
            try:
                staging_zip_path.unlink()
            except OSError:
                pass
        send_event("failed", 100, error=str(e))

    finally:
        ACTIVE_JOB_IDS.discard(job_id)
        ACTIVE_RUNS.pop(job_id, None)
        CANCELLATION_EVENTS.pop(actual_run_id, None)
        CANCELLATION_EVENTS.pop(job_id, None)


async def start_mask_task(job_id: str, request: MaskJobRequest, run_id: Optional[str] = None) -> str:
    """
    Starts a new mask generation task with a dedicated run_id.
    Synchronously initializes status to queued and rejects duplicate active runs.
    """
    if run_id is None:
        run_id = str(uuid.uuid4())

    if is_job_active(job_id):
        raise HTTPException(
            status_code=409,
            detail="Job is already actively running a generation task"
        )

    cancel_event = threading.Event()
    CANCELLATION_EVENTS[run_id] = cancel_event
    CANCELLATION_EVENTS[job_id] = cancel_event
    ACTIVE_RUNS[job_id] = run_id
    ACTIVE_JOB_IDS.add(job_id)
    JOB_LATEST_RUN[job_id] = run_id

    if run_id not in RUN_EVENT_QUEUES:
        RUN_EVENT_QUEUES[run_id] = asyncio.Queue()

    # Synchronously initialize status to queued before returning from start endpoint
    initial_payload = {
        "stage": "queued",
        "progress": 0,
        "run_id": run_id
    }
    RUN_STATUS[run_id] = initial_payload
    JOB_STATUS[job_id] = initial_payload
    await RUN_EVENT_QUEUES[run_id].put(initial_payload)

    loop = asyncio.get_running_loop()
    loop.run_in_executor(None, run_sync_pipeline, job_id, run_id, request, loop)
    return run_id


# Backward-compatibility alias
start_erase_task = start_mask_task
