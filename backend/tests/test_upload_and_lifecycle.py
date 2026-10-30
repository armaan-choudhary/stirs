import io
import os
import time
import pytest
from pathlib import Path
from fastapi.testclient import TestClient
import numpy as np
import cv2

from main import app, cleanup_old_workspaces
import config
from tasks.worker import ACTIVE_JOB_IDS, JOB_STATUS

client = TestClient(app)


@pytest.fixture
def sample_video_bytes():
    """Generates a small in-memory MP4 video for testing."""
    import tempfile
    with tempfile.NamedTemporaryFile(suffix=".mp4", delete=False) as tf:
        tmp_name = tf.name

    w, h, fps, num_frames = 160, 120, 10.0, 5
    fourcc = cv2.VideoWriter_fourcc(*"mp4v")
    out = cv2.VideoWriter(tmp_name, fourcc, fps, (w, h))

    for i in range(num_frames):
        frame = np.zeros((h, w, 3), dtype=np.uint8)
        cv2.rectangle(frame, (20, 20), (60, 60), (255, 255, 255), -1)
        out.write(frame)
    out.release()

    with open(tmp_name, "rb") as f:
        data = f.read()

    try:
        os.remove(tmp_name)
    except OSError:
        pass

    return data


def test_upload_success_and_metadata(sample_video_bytes):
    """Test successful streaming upload within size limit."""
    files = {"file": ("test_valid.mp4", io.BytesIO(sample_video_bytes), "video/mp4")}
    res = client.post("/api/v1/videos/upload", files=files)
    assert res.status_code == 200
    data = res.json()
    assert "job_id" in data
    assert data["frame_count"] == 5
    assert data["width"] == 160
    assert data["height"] == 120
    assert data["raw_video_url"].startswith("/workspace/")

    job_dir = config.WORKSPACE_DIR / data["job_id"]
    assert job_dir.exists()
    assert (job_dir / "raw_video.mp4").exists()
    assert (job_dir / "frames").exists()


def test_upload_exceeds_size_limit(monkeypatch, sample_video_bytes):
    """Test that upload exceeding MAX_UPLOAD_SIZE_BYTES returns 413 and cleans up directory."""
    # Set limit to 100 bytes (video is much larger)
    monkeypatch.setattr(config, "MAX_UPLOAD_SIZE_BYTES", 100)

    # Count directories before
    existing_dirs = set(config.WORKSPACE_DIR.iterdir()) if config.WORKSPACE_DIR.exists() else set()

    files = {"file": ("oversized.mp4", io.BytesIO(sample_video_bytes), "video/mp4")}
    res = client.post("/api/v1/videos/upload", files=files)
    assert res.status_code == 413
    assert "File exceeds maximum upload size" in res.json()["detail"]

    # Verify no leaked directory
    current_dirs = set(config.WORKSPACE_DIR.iterdir()) if config.WORKSPACE_DIR.exists() else set()
    new_dirs = current_dirs - existing_dirs
    assert len(new_dirs) == 0, f"Leaked directories: {new_dirs}"


def test_upload_invalid_video_cleanup(monkeypatch):
    """Test that an invalid video file fails during probe and cleans up job_dir."""
    existing_dirs = set(config.WORKSPACE_DIR.iterdir()) if config.WORKSPACE_DIR.exists() else set()

    corrupt_bytes = b"This is not a real video content"
    files = {"file": ("corrupt.mp4", io.BytesIO(corrupt_bytes), "video/mp4")}
    res = client.post("/api/v1/videos/upload", files=files)
    assert res.status_code == 400

    current_dirs = set(config.WORKSPACE_DIR.iterdir()) if config.WORKSPACE_DIR.exists() else set()
    new_dirs = current_dirs - existing_dirs
    assert len(new_dirs) == 0, f"Leaked directories: {new_dirs}"


def test_job_cancellation_unknown():
    """Test cancellation of unknown job returns 404."""
    res = client.post("/api/v1/jobs/unknown-uuid-1234/cancel")
    assert res.status_code == 404


def test_job_cancellation_flow(monkeypatch, sample_video_bytes):
    """Test cancellation of an active/running or queued job."""
    import tasks.worker as worker_module

    # Mock propagate_full_video to simulate propagation with cancel_check
    def slow_propagate(self, *args, **kwargs):
        cancel_check = kwargs.get("cancel_check")
        for _ in range(50):
            time.sleep(0.05)
            if cancel_check and cancel_check():
                from core.sam2_engine import JobCancelledException
                raise JobCancelledException("Cancelled in test")
        return "/tmp"

    monkeypatch.setattr(worker_module.SAM2MaskGenerator, "propagate_full_video", slow_propagate)

    with TestClient(app) as test_client:
        files = {"file": ("cancel_test.mp4", io.BytesIO(sample_video_bytes), "video/mp4")}
        res = test_client.post("/api/v1/videos/upload", files=files)
        assert res.status_code == 200
        job_id = res.json()["job_id"]

        # Trigger job
        mask_req = {
            "job_id": job_id,
            "annotated_frame_idx": 0,
            "dilation_px": 5,
            "strokes": [
                {
                    "points": [
                        {"x": 20, "y": 20},
                        {"x": 60, "y": 20},
                        {"x": 60, "y": 60},
                        {"x": 20, "y": 60},
                        {"x": 20, "y": 20}
                    ],
                    "mode": "include"
                }
            ]
        }
        trigger_res = test_client.post("/api/v1/jobs/mask", json=mask_req)
        assert trigger_res.status_code == 200

        # Cancel the running job
        cancel_res = test_client.post(f"/api/v1/jobs/{job_id}/cancel")
        assert cancel_res.status_code == 200
        cancel_status = cancel_res.json()["status"]
        assert cancel_status in ("cancelling", "cancelled")

        # Wait briefly and verify status settles to cancelled
        max_wait = 5.0
        start = time.time()
        final_stage = None
        while time.time() - start < max_wait:
            st = test_client.get(f"/api/v1/jobs/{job_id}/status").json()
            final_stage = st.get("stage")
            if final_stage in ("cancelled", "completed", "failed"):
                break
            time.sleep(0.05)

        assert final_stage == "cancelled"
        # Ensure partial output_masks.zip does not exist
        assert not (config.WORKSPACE_DIR / job_id / "output_masks.zip").exists()

        # Cancelling an already cancelled job returns terminal state response
        cancel_res2 = test_client.delete(f"/api/v1/jobs/{job_id}")
        assert cancel_res2.status_code == 200
        assert cancel_res2.json()["status"] == "cancelled"


def test_workspace_retention_cleanup():
    """Test workspace retention cleanup logic with valid positive age."""
    import shutil

    # 1. Create a dummy old job directory
    old_job_id = "test-old-job-to-clean"
    old_dir = config.WORKSPACE_DIR / old_job_id
    old_dir.mkdir(parents=True, exist_ok=True)
    (old_dir / "raw_video.mp4").write_text("old")

    # Set mtime to 48 hours ago
    past_time = time.time() - (48 * 3600)
    os.utime(old_dir, (past_time, past_time))

    # 2. Create a dummy recent job directory
    recent_job_id = "test-recent-job-to-keep"
    recent_dir = config.WORKSPACE_DIR / recent_job_id
    recent_dir.mkdir(parents=True, exist_ok=True)
    (recent_dir / "raw_video.mp4").write_text("recent")

    # 3. Create a dummy old job that is ACTIVE
    active_job_id = "test-active-job-old"
    active_dir = config.WORKSPACE_DIR / active_job_id
    active_dir.mkdir(parents=True, exist_ok=True)
    os.utime(active_dir, (past_time, past_time))
    ACTIVE_JOB_IDS.add(active_job_id)

    try:
        # Run cleanup with 24 hours retention
        cleaned = cleanup_old_workspaces(max_age_hours=24)
        assert cleaned >= 1
        assert not old_dir.exists(), "Old job directory should have been cleaned"
        assert recent_dir.exists(), "Recent job directory should be retained"
        assert active_dir.exists(), "Active job directory must NOT be deleted even if old"

        # Test endpoint with query param
        endpoint_res = client.post("/api/v1/workspace/cleanup?max_age_hours=24")
        assert endpoint_res.status_code == 200
        assert "cleaned_count" in endpoint_res.json()
        assert endpoint_res.json()["retention_hours"] == 24

        # Test endpoint with JSON body
        endpoint_body_res = client.post("/api/v1/workspace/cleanup", json={"max_age_hours": 24})
        assert endpoint_body_res.status_code == 200
        assert "cleaned_count" in endpoint_body_res.json()
        assert endpoint_body_res.json()["retention_hours"] == 24

        # Test endpoint with omitted age (uses default)
        endpoint_default_res = client.post("/api/v1/workspace/cleanup")
        assert endpoint_default_res.status_code == 200
        assert endpoint_default_res.json()["retention_hours"] == config.WORKSPACE_RETENTION_HOURS
    finally:
        ACTIVE_JOB_IDS.discard(active_job_id)
        if old_dir.exists():
            shutil.rmtree(old_dir, ignore_errors=True)
        if recent_dir.exists():
            shutil.rmtree(recent_dir, ignore_errors=True)
        if active_dir.exists():
            shutil.rmtree(active_dir, ignore_errors=True)


def test_cleanup_age_validation():
    """Test that non-positive, zero, and negative ages are rejected by helper and endpoint."""
    import shutil

    # Create dummy recent directory that should never be deleted by bad negative age
    safe_job_id = "test-safe-dir-validation"
    safe_dir = config.WORKSPACE_DIR / safe_job_id
    safe_dir.mkdir(parents=True, exist_ok=True)
    (safe_dir / "raw_video.mp4").write_text("safe")

    try:
        # 1. Direct helper raises ValueError
        with pytest.raises(ValueError, match="positive integer"):
            cleanup_old_workspaces(max_age_hours=0)

        with pytest.raises(ValueError, match="positive integer"):
            cleanup_old_workspaces(max_age_hours=-1)

        with pytest.raises(ValueError, match="positive integer"):
            cleanup_old_workspaces(max_age_hours=-24)

        with pytest.raises(ValueError, match="positive integer"):
            cleanup_old_workspaces(max_age_hours="24")  # type: ignore

        with pytest.raises(ValueError, match="positive integer"):
            cleanup_old_workspaces(max_age_hours=True)  # type: ignore

        # Ensure safe_dir was NOT deleted by any invalid call
        assert safe_dir.exists(), "Safe dir must not be deleted when invalid ages are passed"

        # 2. Endpoint validation returns 422 for non-positive or invalid query parameters
        res_zero = client.post("/api/v1/workspace/cleanup?max_age_hours=0")
        assert res_zero.status_code == 422

        res_neg = client.post("/api/v1/workspace/cleanup?max_age_hours=-5")
        assert res_neg.status_code == 422

        res_str = client.post("/api/v1/workspace/cleanup?max_age_hours=invalid")
        assert res_str.status_code == 422

        # 3. Endpoint validation returns 422 for non-positive or invalid JSON body
        res_body_zero = client.post("/api/v1/workspace/cleanup", json={"max_age_hours": 0})
        assert res_body_zero.status_code == 422

        res_body_neg = client.post("/api/v1/workspace/cleanup", json={"max_age_hours": -10})
        assert res_body_neg.status_code == 422

        # Ensure directory is still intact after 422s
        assert safe_dir.exists()
    finally:
        if safe_dir.exists():
            shutil.rmtree(safe_dir, ignore_errors=True)


def test_cleanup_path_containment_and_safety(tmp_path, monkeypatch):
    """Test that cleanup ignores or skips any paths outside WORKSPACE_DIR."""
    # Create an outside directory
    outside_dir = tmp_path / "outside_dir"
    outside_dir.mkdir(parents=True, exist_ok=True)
    past_time = time.time() - (100 * 3600)
    os.utime(outside_dir, (past_time, past_time))

    # Try running cleanup pointing to WORKSPACE_DIR
    cleaned = cleanup_old_workspaces(max_age_hours=24)
    # Outside directory must remain untouched
    assert outside_dir.exists(), "Outside directory must not be modified or deleted"


def test_auto_cleanup_lifecycle(monkeypatch):
    """Test automatic cleanup task starting, avoiding duplicates, and cleanly cancelling."""
    import asyncio
    from main import (
        start_auto_cleanup_task,
        stop_auto_cleanup_task,
        lifespan,
        app
    )
    import main as main_module

    async def _async_test():
        # Stop any existing task
        await stop_auto_cleanup_task()
        assert main_module._cleanup_task is None

        # Start auto cleanup task with very large interval to prevent unnecessary ticks
        task1 = start_auto_cleanup_task(interval_seconds=9999.0, max_age_hours=24)
        assert task1 is not None
        assert not task1.done()

        # Calling start again returns the same task without creating a duplicate
        task2 = start_auto_cleanup_task(interval_seconds=9999.0, max_age_hours=24)
        assert task1 is task2

        # Stop auto cleanup task and verify it's cancelled and awaited
        await stop_auto_cleanup_task()
        assert task1.cancelled() or task1.done()
        assert main_module._cleanup_task is None

        # Test lifespan context manager
        async with lifespan(app):
            # When enabled, lifespan starts the task
            if config.ENABLE_AUTO_WORKSPACE_CLEANUP:
                assert main_module._cleanup_task is not None
                assert not main_module._cleanup_task.done()

        # After lifespan exits, task should be stopped
        assert main_module._cleanup_task is None

    asyncio.run(_async_test())


def test_sequential_runs_same_job(sample_video_bytes):
    """
    Test sequential runs on the same job:
    Prior run completed, then second run starts queued and completes with new run_id.
    """
    with TestClient(app) as test_client:
        files = {"file": ("seq_test.mp4", io.BytesIO(sample_video_bytes), "video/mp4")}
        res = test_client.post("/api/v1/videos/upload", files=files)
        assert res.status_code == 200
        job_id = res.json()["job_id"]

        mask_req = {
            "job_id": job_id,
            "annotated_frame_idx": 0,
            "dilation_px": 5,
            "strokes": [
                {
                    "points": [{"x": 20, "y": 20}, {"x": 60, "y": 20}, {"x": 60, "y": 60}, {"x": 20, "y": 60}, {"x": 20, "y": 20}],
                    "mode": "include"
                }
            ]
        }

        # Run 1
        res1 = test_client.post("/api/v1/jobs/mask", json=mask_req)
        assert res1.status_code == 200
        data1 = res1.json()
        assert "run_id" in data1
        run1_id = data1["run_id"]
        assert data1["status"] == "queued"

        # Wait for run 1 to complete
        start = time.time()
        final1 = None
        while time.time() - start < 25.0:
            st = test_client.get(f"/api/v1/jobs/{job_id}/status?run_id={run1_id}").json()
            if st.get("stage") == "completed":
                final1 = st
                break
            time.sleep(0.05)

        assert final1 is not None
        assert final1["stage"] == "completed"
        assert f"?v={run1_id}" in final1["output_url"]

        # Run 2 on same job
        mask_req["accumulate_with_existing"] = True
        res2 = test_client.post("/api/v1/jobs/mask", json=mask_req)
        assert res2.status_code == 200
        data2 = res2.json()
        run2_id = data2["run_id"]
        assert run2_id != run1_id
        assert data2["status"] == "queued"

        # Check that run 2 starts with queued or progresses
        st2_initial = test_client.get(f"/api/v1/jobs/{job_id}/status?run_id={run2_id}").json()
        assert st2_initial["stage"] in ("queued", "sam2_forward", "sam2_backward", "packaging", "completed")

        # Wait for run 2 to complete
        start = time.time()
        final2 = None
        while time.time() - start < 25.0:
            st2 = test_client.get(f"/api/v1/jobs/{job_id}/status?run_id={run2_id}").json()
            if st2.get("stage") == "completed":
                final2 = st2
                break
            time.sleep(0.05)

        assert final2 is not None
        assert final2["stage"] == "completed"
        assert f"?v={run2_id}" in final2["output_url"]

        # Status without run_id returns latest run (run 2)
        st_latest = test_client.get(f"/api/v1/jobs/{job_id}/status").json()
        assert st_latest["stage"] == "completed"
        assert st_latest["run_id"] == run2_id
        assert f"?v={run2_id}" in st_latest["output_url"]

        # Run 1 status is still queryable with ?run_id={run1_id}
        st1_after = test_client.get(f"/api/v1/jobs/{job_id}/status?run_id={run1_id}").json()
        assert st1_after["stage"] == "completed"
        assert st1_after["run_id"] == run1_id


def test_reject_duplicate_active_runs(monkeypatch, sample_video_bytes):
    """
    Test that starting a second run while a run is actively executing returns 409 Conflict.
    """
    import threading
    import tasks.worker as worker_module

    proceed_event = threading.Event()
    orig_propagate = worker_module.SAM2MaskGenerator.propagate_full_video

    def blocking_propagate(self, *args, **kwargs):
        # Wait until test signals to proceed
        proceed_event.wait(timeout=5.0)
        return orig_propagate(self, *args, **kwargs)

    monkeypatch.setattr(worker_module.SAM2MaskGenerator, "propagate_full_video", blocking_propagate)

    with TestClient(app) as test_client:
        files = {"file": ("dup_test.mp4", io.BytesIO(sample_video_bytes), "video/mp4")}
        res = test_client.post("/api/v1/videos/upload", files=files)
        assert res.status_code == 200
        job_id = res.json()["job_id"]

        mask_req = {
            "job_id": job_id,
            "annotated_frame_idx": 0,
            "dilation_px": 5,
            "strokes": [
                {
                    "points": [{"x": 20, "y": 20}, {"x": 60, "y": 20}, {"x": 60, "y": 60}, {"x": 20, "y": 60}, {"x": 20, "y": 20}],
                    "mode": "include"
                }
            ]
        }

        # Start Run 1
        res1 = test_client.post("/api/v1/jobs/mask", json=mask_req)
        assert res1.status_code == 200
        run1_id = res1.json()["run_id"]

        try:
            # Attempt duplicate run immediately while run 1 is active
            res2 = test_client.post("/api/v1/jobs/mask", json=mask_req)
            assert res2.status_code == 409
            assert "Job is already actively running a generation task" in res2.json()["detail"]
        finally:
            proceed_event.set()

        # Wait for run 1 to finish
        start = time.time()
        while time.time() - start < 25.0:
            st = test_client.get(f"/api/v1/jobs/{job_id}/status?run_id={run1_id}").json()
            if st.get("stage") in ("completed", "failed"):
                break
            time.sleep(0.05)


def test_failure_or_cancellation_of_second_run_preserves_first_run(monkeypatch, sample_video_bytes):
    """
    Test that cancellation or failure of a second run preserves the first run's published output masks and zip.
    """
    import threading
    import tasks.worker as worker_module
    from core.sam2_engine import JobCancelledException

    with TestClient(app) as test_client:
        files = {"file": ("preserve_test.mp4", io.BytesIO(sample_video_bytes), "video/mp4")}
        res = test_client.post("/api/v1/videos/upload", files=files)
        assert res.status_code == 200
        job_id = res.json()["job_id"]

        mask_req = {
            "job_id": job_id,
            "annotated_frame_idx": 0,
            "dilation_px": 5,
            "strokes": [
                {
                    "points": [{"x": 20, "y": 20}, {"x": 60, "y": 20}, {"x": 60, "y": 60}, {"x": 20, "y": 60}, {"x": 20, "y": 20}],
                    "mode": "include"
                }
            ]
        }

        # Run 1: let it complete normally
        res1 = test_client.post("/api/v1/jobs/mask", json=mask_req)
        assert res1.status_code == 200
        run1_id = res1.json()["run_id"]

        start = time.time()
        while time.time() - start < 25.0:
            st = test_client.get(f"/api/v1/jobs/{job_id}/status?run_id={run1_id}").json()
            if st.get("stage") in ("completed", "failed"):
                break
            time.sleep(0.05)
        assert st.get("stage") == "completed", f"Run 1 did not complete: {st}"

        job_dir = config.WORKSPACE_DIR / job_id
        published_zip = job_dir / "output_masks.zip"
        published_masks = job_dir / "masks"

        assert published_zip.exists()
        assert published_masks.exists()
        run1_zip_bytes = published_zip.read_bytes()
        run1_mask_files = set(f.name for f in published_masks.glob("*.png"))
        assert len(run1_mask_files) > 0

        # Run 2: simulate cancellation
        def cancellable_propagate(self, *args, **kwargs):
            cancel_check = kwargs.get("cancel_check")
            for _ in range(50):
                time.sleep(0.05)
                if cancel_check and cancel_check():
                    raise JobCancelledException("Cancelled in test")
            return "/tmp"

        monkeypatch.setattr(worker_module.SAM2MaskGenerator, "propagate_full_video", cancellable_propagate)

        res2 = test_client.post("/api/v1/jobs/mask", json=mask_req)
        assert res2.status_code == 200
        run2_id = res2.json()["run_id"]

        # Cancel run 2 specifically
        cancel_res = test_client.post(f"/api/v1/jobs/{job_id}/cancel?run_id={run2_id}")
        assert cancel_res.status_code == 200

        # Wait until run 2 reaches cancelled
        start = time.time()
        while time.time() - start < 5.0:
            st2 = test_client.get(f"/api/v1/jobs/{job_id}/status?run_id={run2_id}").json()
            if st2.get("stage") == "cancelled":
                break
            time.sleep(0.05)

        # Assert staging cleaned up
        assert not (job_dir / f"masks_staging_{run2_id}").exists()
        assert not (job_dir / f"output_masks_staging_{run2_id}.zip").exists()

        # Assert first run's published output is 100% intact!
        assert published_zip.exists()
        assert published_zip.read_bytes() == run1_zip_bytes
        assert published_masks.exists()
        assert set(f.name for f in published_masks.glob("*.png")) == run1_mask_files

        # Run 3: simulate unexpected failure
        def failing_propagate(self, *args, **kwargs):
            raise RuntimeError("Unexpected neural network crash")

        monkeypatch.setattr(worker_module.SAM2MaskGenerator, "propagate_full_video", failing_propagate)

        res3 = test_client.post("/api/v1/jobs/mask", json=mask_req)
        assert res3.status_code == 200
        run3_id = res3.json()["run_id"]

        start = time.time()
        while time.time() - start < 5.0:
            st3 = test_client.get(f"/api/v1/jobs/{job_id}/status?run_id={run3_id}").json()
            if st3.get("stage") == "failed":
                break
            time.sleep(0.05)

        # Assert staging cleaned up
        assert not (job_dir / f"masks_staging_{run3_id}").exists()
        assert not (job_dir / f"output_masks_staging_{run3_id}.zip").exists()

        # Assert first run's published output remains completely undamaged!
        assert published_zip.exists()
        assert published_zip.read_bytes() == run1_zip_bytes
        assert set(f.name for f in published_masks.glob("*.png")) == run1_mask_files


def test_run_scoped_event_queues_prevent_stale_terminal_events(sample_video_bytes):
    """
    Test that run-scoped event queues prevent stale terminal events from closing a new run.
    """
    import tasks.worker as worker_module

    with TestClient(app) as test_client:
        files = {"file": ("queue_test.mp4", io.BytesIO(sample_video_bytes), "video/mp4")}
        res = test_client.post("/api/v1/videos/upload", files=files)
        assert res.status_code == 200
        job_id = res.json()["job_id"]

        mask_req = {
            "job_id": job_id,
            "annotated_frame_idx": 0,
            "dilation_px": 5,
            "strokes": [
                {
                    "points": [{"x": 20, "y": 20}, {"x": 60, "y": 20}, {"x": 60, "y": 60}, {"x": 20, "y": 60}, {"x": 20, "y": 20}],
                    "mode": "include"
                }
            ]
        }

        # Run 1: let it complete
        res1 = test_client.post("/api/v1/jobs/mask", json=mask_req)
        assert res1.status_code == 200
        run1_id = res1.json()["run_id"]

        start = time.time()
        while time.time() - start < 25.0:
            st = test_client.get(f"/api/v1/jobs/{job_id}/status?run_id={run1_id}").json()
            if st.get("stage") in ("completed", "failed"):
                break
            time.sleep(0.05)
        assert st.get("stage") == "completed", f"Run 1 did not complete: {st}"

        # Ensure run 1 has queued events
        assert run1_id in worker_module.RUN_EVENT_QUEUES

        # Trigger Run 2
        res2 = test_client.post("/api/v1/jobs/mask", json=mask_req)
        assert res2.status_code == 200
        run2_id = res2.json()["run_id"]
        assert run2_id != run1_id

        # Run 2 has its own separate queue
        assert run2_id in worker_module.RUN_EVENT_QUEUES
        run2_q = worker_module.RUN_EVENT_QUEUES[run2_id]

        # The first item in run 2's queue must be queued, not completed from run 1
        first_event = run2_q.get_nowait()
        assert first_event["stage"] == "queued"
        assert first_event["run_id"] == run2_id

        # Wait for run 2 to finish cleanly
        start = time.time()
        while time.time() - start < 25.0:
            st2 = test_client.get(f"/api/v1/jobs/{job_id}/status?run_id={run2_id}").json()
            if st2.get("stage") == "completed":
                break
            time.sleep(0.05)


