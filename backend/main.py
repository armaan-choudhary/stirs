import os
import uuid
import base64
import json
import asyncio
import shutil
import time
import logging
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional

import cv2
import numpy as np
from fastapi import FastAPI, UploadFile, File, HTTPException, Query, Body
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import JSONResponse
from sse_starlette.sse import EventSourceResponse

import config
from schemas import (
    Point2D,
    StrokeInput,
    PreviewMaskRequest,
    PreviewMaskResponse,
    MaskJobRequest,
    MaskJobResponse,
    EraseJobRequest,
    EraseJobResponse,
    VideoMetadata,
    JobProgressEvent,
    WorkspaceCleanupRequest,
    WorkspaceCleanupResponse,
)
from core.geometry import (
    convert_strokes_to_sam2_prompts,
    convert_strokes_to_sam2_multi_obj_prompts
)
from core.video_io import probe_video, extract_frames
from core.sam2_engine import SAM2MaskGenerator
from tasks.worker import (
    start_mask_task,
    start_erase_task,
    get_job_queue,
    JOB_STATUS,
    RUN_STATUS,
    JOB_LATEST_RUN,
    ACTIVE_RUNS,
    cancel_job,
    is_job_active
)

logger = logging.getLogger("stirs.workspace")


def cleanup_old_workspaces(max_age_hours: Optional[int] = None) -> int:
    """
    Cleans up workspace job directories that are older than max_age_hours.
    Safety checks:
    - Rejects invalid cleanup ages: max_age_hours must be a positive integer (> 0).
    - Path must resolve strictly inside config.WORKSPACE_DIR.
    - Never deletes an active/running job.
    Returns the count of removed directories.
    """
    if max_age_hours is None:
        max_age_hours = config.WORKSPACE_RETENTION_HOURS

    if not isinstance(max_age_hours, int) or isinstance(max_age_hours, bool) or max_age_hours <= 0:
        raise ValueError(f"max_age_hours must be a positive integer, got: {max_age_hours!r}")

    now = time.time()
    max_age_seconds = max_age_hours * 3600
    cleaned_count = 0
    workspace_root = config.WORKSPACE_DIR.resolve()

    if not workspace_root.exists():
        return 0

    try:
        entries = list(workspace_root.iterdir())
    except OSError as e:
        logger.error(f"Failed to list workspace directory {workspace_root}: {e}")
        return 0

    for item in entries:
        try:
            if not item.is_dir():
                continue

            resolved_item = item.resolve()
            # Path safety check: ensure resolved path is strictly within workspace_root
            if workspace_root not in resolved_item.parents:
                logger.warning(f"Skipping directory outside workspace root: {resolved_item}")
                continue

            job_id = resolved_item.name
            # Active job safety check: never delete active running jobs
            if is_job_active(job_id):
                continue

            # Check modification time
            mtime = resolved_item.stat().st_mtime
            if (now - mtime) >= max_age_seconds:
                shutil.rmtree(resolved_item, ignore_errors=False)
                cleaned_count += 1
                logger.info(f"Cleaned up expired workspace directory for job: {job_id}")
        except Exception as e:
            logger.error(f"Failed to inspect or remove workspace directory {item}: {e}")

    if cleaned_count > 0:
        logger.info(f"Workspace retention cleanup finished: removed {cleaned_count} directories older than {max_age_hours}h")

    return cleaned_count


# Global background task reference to prevent premature garbage collection
_cleanup_task: Optional[asyncio.Task] = None


async def _run_periodic_workspace_cleanup(
    interval_seconds: float = config.WORKSPACE_CLEANUP_INTERVAL_SECONDS,
    max_age_hours: Optional[int] = None
):
    """
    Background loop that runs workspace cleanup periodically without blocking
    request handling or application startup.
    """
    logger.info(f"Automatic workspace retention task started (interval: {interval_seconds}s)")
    try:
        while True:
            await asyncio.sleep(interval_seconds)
            try:
                # Run the blocking filesystem operations in a thread executor
                count = await asyncio.to_thread(cleanup_old_workspaces, max_age_hours)
                if count > 0:
                    logger.info(f"Automatic workspace cleanup removed {count} expired directories")
            except asyncio.CancelledError:
                raise
            except Exception as e:
                logger.error(f"Error during automatic workspace cleanup run: {e}")
    except asyncio.CancelledError:
        logger.info("Automatic workspace retention task cancelled cleanly")
        raise


def start_auto_cleanup_task(
    interval_seconds: Optional[float] = None,
    max_age_hours: Optional[int] = None
) -> Optional[asyncio.Task]:
    """
    Starts the automatic cleanup background task if not already running.
    Avoids launching duplicate cleanup loops.
    """
    global _cleanup_task
    if _cleanup_task is not None and not _cleanup_task.done():
        return _cleanup_task

    interval = interval_seconds if interval_seconds is not None else config.WORKSPACE_CLEANUP_INTERVAL_SECONDS
    _cleanup_task = asyncio.create_task(
        _run_periodic_workspace_cleanup(interval_seconds=interval, max_age_hours=max_age_hours)
    )
    return _cleanup_task


async def stop_auto_cleanup_task():
    """
    Cancels and resets the automatic cleanup background task.
    """
    global _cleanup_task
    if _cleanup_task is not None:
        _cleanup_task.cancel()
        try:
            await _cleanup_task
        except asyncio.CancelledError:
            pass
        except Exception as e:
            logger.error(f"Error while stopping auto cleanup task: {e}")
        finally:
            _cleanup_task = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    """
    FastAPI lifespan manager for background services.
    Starts automatic workspace retention cleanup if enabled, and cleans up on shutdown.
    """
    if config.ENABLE_AUTO_WORKSPACE_CLEANUP:
        start_auto_cleanup_task()
    yield
    await stop_auto_cleanup_task()


app = FastAPI(
    title="stirs - Video Mask Generator API",
    version="1.0.0",
    description="Interactive video object mask generation with SAM 2",
    lifespan=lifespan
)

# CORS configuration
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Mount workspace for static asset serving (frames, output masks)
app.mount("/workspace", StaticFiles(directory=str(config.WORKSPACE_DIR)), name="workspace")



@app.post("/api/v1/videos/upload", response_model=VideoMetadata)
async def upload_video(file: UploadFile = File(...)):
    """
    Accepts video upload via streaming chunks with size limits, saves raw_video.mp4 to job directory,
    probes metadata, and extracts all frames to /frames as JPEGs.
    """
    job_id = str(uuid.uuid4())
    job_dir = config.WORKSPACE_DIR / job_id
    job_dir.mkdir(parents=True, exist_ok=True)

    raw_video_path = job_dir / "raw_video.mp4"
    frames_dir = job_dir / "frames"

    CHUNK_SIZE = 1024 * 1024  # 1MB chunks
    total_bytes = 0

    try:
        # Stream file in chunks while counting bytes to enforce MAX_UPLOAD_SIZE_BYTES
        with open(raw_video_path, "wb") as f:
            while True:
                chunk = await file.read(CHUNK_SIZE)
                if not chunk:
                    break
                total_bytes += len(chunk)
                if total_bytes > config.MAX_UPLOAD_SIZE_BYTES:
                    # Exceeded maximum upload size
                    raise HTTPException(
                        status_code=413,
                        detail=f"File exceeds maximum upload size of {config.MAX_UPLOAD_SIZE_BYTES} bytes"
                    )
                f.write(chunk)

        # Probe video metadata
        try:
            meta = probe_video(str(raw_video_path))
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"Failed to probe video: {str(e)}")

        # Extract frames
        try:
            frame_count = extract_frames(
                str(raw_video_path),
                str(frames_dir),
                max_dimension=config.MAX_VIDEO_DIMENSION
            )
            meta["frame_count"] = frame_count
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Frame extraction failed: {str(e)}")

    except HTTPException:
        # Re-raise HTTPExceptions (e.g. 413, 400, 500) after cleaning up job directory
        shutil.rmtree(job_dir, ignore_errors=True)
        raise
    except Exception as e:
        # Clean up job directory on unexpected exceptions
        shutil.rmtree(job_dir, ignore_errors=True)
        raise HTTPException(status_code=500, detail=f"Failed to process video upload: {str(e)}")
    finally:
        await file.close()

    raw_video_url = f"/workspace/{job_id}/raw_video.mp4"
    return VideoMetadata(
        job_id=job_id,
        fps=meta["fps"],
        frame_count=meta["frame_count"],
        width=meta["width"],
        height=meta["height"],
        raw_video_url=raw_video_url
    )


@app.post("/api/v1/masks/preview", response_model=PreviewMaskResponse)
async def preview_mask(req: PreviewMaskRequest):
    """
    Instant preview: Runs SAM 2 image segmentation on the single frame using the provided
    lasso strokes. Returns a transparent RGBA PNG mask overlay as base64.
    """
    job_dir = config.WORKSPACE_DIR / req.job_id
    if not job_dir.exists():
        raise HTTPException(status_code=404, detail="Job workspace not found")

    frame_path = job_dir / "frames" / f"{req.frame_idx:05d}.jpg"
    if not frame_path.exists():
        raise HTTPException(status_code=404, detail=f"Frame {req.frame_idx} not found")

    # Read image to obtain actual extracted frame dimensions
    img_bgr = cv2.imread(str(frame_path))
    if img_bgr is None:
        raise HTTPException(status_code=500, detail="Could not read frame image")
    frame_h, frame_w = img_bgr.shape[:2]

    # Normalize stroke coordinates if extracted frames differ from raw video dimensions
    scale_x = frame_w / float(req.strokes[0].points[0].x) if False else 1.0  # fallback
    # Get metadata for raw video dimensions
    raw_video_path = job_dir / "raw_video.mp4"
    if raw_video_path.exists():
        try:
            meta = probe_video(str(raw_video_path))
            raw_w, raw_h = meta["width"], meta["height"]
            scale_x = frame_w / float(raw_w)
            scale_y = frame_h / float(raw_h)
        except Exception:
            scale_x, scale_y = 1.0, 1.0
    else:
        scale_x, scale_y = 1.0, 1.0

    scaled_strokes = []
    for stroke in req.strokes:
        scaled_pts = [
            Point2D(x=p.x * scale_x, y=p.y * scale_y) for p in stroke.points
        ]
        scaled_strokes.append(StrokeInput(points=scaled_pts, mode=stroke.mode))

    # Convert strokes to SAM 2 multi-object prompts in frame coordinate space
    obj_prompts = convert_strokes_to_sam2_multi_obj_prompts(
        scaled_strokes,
        frame_w=frame_w,
        frame_h=frame_h
    )

    # Compute enclosing bbox across all include objects (if any)
    boxes = [b for _, b, _, _ in obj_prompts if b is not None]
    if boxes:
        boxes_np = np.array(boxes, dtype=np.float32)
        combined_box = [
            float(np.min(boxes_np[:, 0])),
            float(np.min(boxes_np[:, 1])),
            float(np.max(boxes_np[:, 2])),
            float(np.max(boxes_np[:, 3]))
        ]
    else:
        combined_box = None

    # Run SAM 2 preview inference (via cached singleton with small fallback)
    sam2_generator = SAM2MaskGenerator.get_instance(
        config_path=config.DEFAULT_SAM2_CONFIG,
        checkpoint_path=config.DEFAULT_SAM2_CHECKPOINT,
        device=config.DEVICE,
        fallback_config_path=config.FALLBACK_SAM2_CONFIG,
        fallback_checkpoint_path=config.FALLBACK_SAM2_CHECKPOINT,
    )

    frames_dir = job_dir / "frames"
    try:
        mask_uint8 = sam2_generator.preview_single_frame(
            frames_dir=str(frames_dir),
            frame_idx=req.frame_idx,
            multi_objects=obj_prompts,
            dilation_px=req.dilation_px
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Preview generation failed: {str(e)}")

    # Create translucent RGBA overlay (Red tint with 50% opacity where mask == 255)
    rgba = np.zeros((frame_h, frame_w, 4), dtype=np.uint8)
    selected = (mask_uint8 == 255)
    # Highlight with red/orange overlay
    rgba[selected] = [239, 68, 68, 140]

    # If extracted frames were downscaled, rescale overlay back to original raw video dimensions
    if scale_x != 1.0 or scale_y != 1.0:
        rgba = cv2.resize(rgba, (raw_w, raw_h), interpolation=cv2.INTER_NEAREST)

    success, buffer = cv2.imencode(".png", rgba)
    if not success:
        raise HTTPException(status_code=500, detail="Failed to encode mask PNG")

    base64_str = "data:image/png;base64," + base64.b64encode(buffer).decode("utf-8")

    return PreviewMaskResponse(
        job_id=req.job_id,
        frame_idx=req.frame_idx,
        mask_base64_png=base64_str,
        bbox=combined_box
    )


@app.post("/api/v1/jobs/mask", response_model=MaskJobResponse)
@app.post("/api/v1/jobs/erase", response_model=MaskJobResponse)
async def trigger_mask_job(req: MaskJobRequest):
    """
    Enqueues SAM 2 bidirectional mask propagation and packages the resulting PNG masks as output_masks.zip.
    """
    job_dir = config.WORKSPACE_DIR / req.job_id
    if not job_dir.exists():
        raise HTTPException(status_code=404, detail="Job workspace not found")

    run_id = str(uuid.uuid4())
    await start_mask_task(req.job_id, req, run_id=run_id)
    return MaskJobResponse(job_id=req.job_id, run_id=run_id, status="queued")


@app.get("/api/v1/jobs/{job_id}/status")
async def get_job_status(job_id: str, run_id: Optional[str] = Query(default=None)):
    """
    Returns the latest known status for the given job or specific run.
    """
    if run_id:
        if run_id in RUN_STATUS:
            return RUN_STATUS[run_id]
        raise HTTPException(status_code=404, detail="Run not found")

    latest_run_id = JOB_LATEST_RUN.get(job_id)
    if latest_run_id and latest_run_id in RUN_STATUS:
        return RUN_STATUS[latest_run_id]

    if job_id in JOB_STATUS:
        return JOB_STATUS[job_id]

    # Check if final output exists on disk
    output_masks = config.WORKSPACE_DIR / job_id / "output_masks.zip"
    if output_masks.exists():
        return {
            "stage": "completed",
            "progress": 100,
            "output_url": f"/workspace/{job_id}/output_masks.zip"
        }

    return {"stage": "pending", "progress": 0}


@app.post("/api/v1/jobs/{job_id}/cancel")
@app.delete("/api/v1/jobs/{job_id}")
async def cancel_job_endpoint(job_id: str, run_id: Optional[str] = Query(default=None)):
    """
    Cooperatively cancels an ongoing job or marks a queued job as cancelled.
    """
    job_dir = config.WORKSPACE_DIR / job_id
    if not job_dir.exists() and job_id not in JOB_STATUS and not is_job_active(job_id):
        raise HTTPException(status_code=404, detail="Job not found")

    target_run_id = run_id or ACTIVE_RUNS.get(job_id) or JOB_LATEST_RUN.get(job_id)

    current_status = RUN_STATUS.get(target_run_id, {}) if target_run_id else JOB_STATUS.get(job_id, {})
    current_stage = current_status.get("stage")

    if current_stage in ("completed", "failed", "cancelled"):
        return {
            "job_id": job_id,
            "run_id": target_run_id,
            "status": current_stage,
            "message": f"Job is already in terminal state: {current_stage}"
        }

    # Signal cancellation
    was_active = cancel_job(job_id, run_id=target_run_id)

    if not was_active and current_stage in ("queued", "pending", None):
        # Job hadn't started yet or was queued
        queue = get_job_queue(job_id, run_id=target_run_id)
        payload = {
            "stage": "cancelled",
            "progress": 0,
            "run_id": target_run_id,
            "error": "Job was cancelled before execution."
        }
        if target_run_id:
            RUN_STATUS[target_run_id] = payload
        JOB_STATUS[job_id] = payload
        await queue.put(payload)
        return {"job_id": job_id, "run_id": target_run_id, "status": "cancelled"}

    return {"job_id": job_id, "run_id": target_run_id, "status": "cancelling"}


@app.post("/api/v1/workspace/cleanup", response_model=WorkspaceCleanupResponse)
async def trigger_workspace_cleanup(
    req: Optional[WorkspaceCleanupRequest] = Body(default=None),
    max_age_hours: Optional[int] = Query(default=None, gt=0, description="Optional positive retention threshold in hours")
):
    """
    Triggers retention cleanup of workspace directories older than max_age_hours (default from config).
    Validates input to ensure positive integer hours (rejects <= 0 with 422).
    Never deletes actively running jobs or outside config.WORKSPACE_DIR.
    """
    effective_max_age = max_age_hours if max_age_hours is not None else (req.max_age_hours if req else None)
    if effective_max_age is None:
        effective_max_age = config.WORKSPACE_RETENTION_HOURS

    try:
        cleaned_count = cleanup_old_workspaces(max_age_hours=effective_max_age)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))

    return WorkspaceCleanupResponse(
        status="success",
        cleaned_count=cleaned_count,
        retention_hours=effective_max_age
    )


@app.get("/api/v1/jobs/{job_id}/events")
async def stream_job_events(job_id: str, run_id: Optional[str] = Query(default=None)):
    """
    Server-Sent Events (SSE) stream reporting real-time pipeline stages:
    {"stage": "sam2_forward" | "sam2_backward" | "packaging" | "completed" | "cancelled" | "failed", "progress": 0-100, "output_url": "..."}
    """
    queue = get_job_queue(job_id, run_id=run_id)

    async def event_generator():
        while True:
            try:
                # Wait for next event with a timeout for keepalive
                event_data = await asyncio.wait_for(queue.get(), timeout=20.0)
                yield {
                    "event": "progress",
                    "data": json.dumps(event_data)
                }
                if event_data.get("stage") in ("completed", "failed", "cancelled"):
                    break
            except asyncio.TimeoutError:
                # Send keepalive comment
                yield {
                    "event": "ping",
                    "data": json.dumps({"type": "keepalive"})
                }

    return EventSourceResponse(event_generator())
