import io
import time
import shutil
import zipfile
from pathlib import Path
from unittest.mock import patch, MagicMock
import pytest
from fastapi.testclient import TestClient
import numpy as np
import cv2

from main import app
import config
from tasks.removal_worker import (
    REMOVAL_RUN_STATUS,
    REMOVAL_EVENT_QUEUES,
    JOB_LATEST_REMOVAL_RUN,
    ACTIVE_REMOVAL_RUNS,
    REMOVAL_CANCELLATION_EVENTS,
    JobCancelledException,
)
from core.effect_erase_adapter import EffectEraseException

client = TestClient(app)


@pytest.fixture(autouse=True)
def clean_removal_state():
    """Cleans in-memory tracking dictionaries between test runs."""
    REMOVAL_RUN_STATUS.clear()
    REMOVAL_EVENT_QUEUES.clear()
    JOB_LATEST_REMOVAL_RUN.clear()
    ACTIVE_REMOVAL_RUNS.clear()
    REMOVAL_CANCELLATION_EVENTS.clear()
    yield
    REMOVAL_RUN_STATUS.clear()
    REMOVAL_EVENT_QUEUES.clear()
    JOB_LATEST_REMOVAL_RUN.clear()
    ACTIVE_REMOVAL_RUNS.clear()
    REMOVAL_CANCELLATION_EVENTS.clear()


@pytest.fixture
def mock_job_workspace():
    """Sets up a synthetic workspace for a job with raw_video.mp4 and 10 mask PNGs."""
    job_id = f"test_removal_job_{int(time.time() * 1000)}"
    job_dir = config.WORKSPACE_DIR / job_id
    job_dir.mkdir(parents=True, exist_ok=True)

    # 1. Create a dummy video file
    video_path = job_dir / "raw_video.mp4"
    w, h, fps, num_frames = 320, 240, 10.0, 10
    fourcc = cv2.VideoWriter_fourcc(*"mp4v")
    out = cv2.VideoWriter(str(video_path), fourcc, fps, (w, h))
    for i in range(num_frames):
        frame = np.full((h, w, 3), i * 20, dtype=np.uint8)
        out.write(frame)
    out.release()

    # 2. Create 10 mask files
    masks_dir = job_dir / "masks"
    masks_dir.mkdir(parents=True, exist_ok=True)
    for i in range(num_frames):
        mask = np.zeros((h, w), dtype=np.uint8)
        mask[40:100, 50:150] = 255
        cv2.imwrite(str(masks_dir / f"{i:05d}.png"), mask)

    # 3. Create output_masks.zip
    zip_path = job_dir / "output_masks.zip"
    with zipfile.ZipFile(zip_path, "w") as z:
        for mf in sorted(masks_dir.glob("*.png")):
            z.write(mf, arcname=mf.name)

    yield job_id, job_dir

    # Cleanup after test
    shutil.rmtree(job_dir, ignore_errors=True)


def test_removal_preflight():
    res = client.get("/api/v1/removal/preflight")
    assert res.status_code == 200
    data = res.json()
    assert "available" in data


def test_trigger_removal_job_not_found():
    res = client.post("/api/v1/jobs/nonexistent_job_123/removal", json={})
    assert res.status_code == 404
    assert "Job workspace not found" in res.json()["detail"]


def test_trigger_removal_missing_video():
    job_id = f"missing_video_{int(time.time() * 1000)}"
    job_dir = config.WORKSPACE_DIR / job_id
    job_dir.mkdir(parents=True, exist_ok=True)
    try:
        res = client.post(f"/api/v1/jobs/{job_id}/removal", json={})
        assert res.status_code == 404
        assert "Source video not found" in res.json()["detail"]
    finally:
        shutil.rmtree(job_dir, ignore_errors=True)


def test_trigger_removal_missing_masks():
    job_id = f"missing_masks_{int(time.time() * 1000)}"
    job_dir = config.WORKSPACE_DIR / job_id
    job_dir.mkdir(parents=True, exist_ok=True)
    (job_dir / "raw_video.mp4").write_bytes(b"dummy video data")
    try:
        res = client.post(f"/api/v1/jobs/{job_id}/removal", json={})
        assert res.status_code == 400
        assert "Mask generation must be completed" in res.json()["detail"]
    finally:
        shutil.rmtree(job_dir, ignore_errors=True)


def test_trigger_removal_success_lifecycle(mock_job_workspace):
    job_id, job_dir = mock_job_workspace

    # Mock EffectEraseAdapter.run_removal and check_availability
    def fake_run_removal(job_id, erase_run_id, source_video_path, masks_dir, staging_dir, progress_cb, cancel_check, **kwargs):
        # Create dummy output video in staging
        staged_mp4 = Path(staging_dir) / f"cleaned_{erase_run_id}.mp4"
        w, h, fps = 320, 240, 10.0
        fourcc = cv2.VideoWriter_fourcc(*"mp4v")
        writer = cv2.VideoWriter(str(staged_mp4), fourcc, fps, (w, h))
        for _ in range(10):
            writer.write(np.zeros((h, w, 3), dtype=np.uint8))
        writer.release()
        if progress_cb:
            progress_cb("inference", 50)
        return staged_mp4

    with patch("core.effect_erase_adapter.EffectEraseAdapter.run_removal", side_effect=fake_run_removal), \
         patch("core.effect_erase_adapter.EffectEraseAdapter.check_availability", return_value=(True, None)):

        # 1. Trigger removal
        res = client.post(f"/api/v1/jobs/{job_id}/removal", json={})
        assert res.status_code == 200
        data = res.json()
        assert data["job_id"] == job_id
        assert data["status"] == "queued"
        erase_run_id = data["erase_run_id"]
        assert erase_run_id.startswith("erase_")

        # 2. Poll status until completed
        max_wait = 10.0
        start = time.time()
        completed = False
        while time.time() - start < max_wait:
            status_res = client.get(f"/api/v1/jobs/{job_id}/removal/{erase_run_id}/status")
            assert status_res.status_code == 200
            sdata = status_res.json()
            if sdata["stage"] == "completed":
                completed = True
                assert sdata["progress"] == 100
                assert sdata["output_url"] == f"/api/v1/jobs/{job_id}/removal/{erase_run_id}/result"
                break
            time.sleep(0.1)

        assert completed, f"Removal did not complete in time: {status_res.json()}"

        # 3. Check published files
        assert (job_dir / f"cleaned_{erase_run_id}.mp4").exists()
        assert (job_dir / "cleaned.mp4").exists()

        # 4. Check result download endpoint
        result_res = client.get(f"/api/v1/jobs/{job_id}/removal/{erase_run_id}/result")
        assert result_res.status_code == 200
        assert result_res.headers["content-type"] == "video/mp4"
        assert "no-cache" in result_res.headers.get("cache-control", "")


def test_reject_duplicate_active_removal(mock_job_workspace):
    job_id, job_dir = mock_job_workspace

    import threading
    block_event = threading.Event()

    def slow_removal(*args, **kwargs):
        erase_run_id = kwargs.get("erase_run_id", "test_run")
        staging_dir = Path(kwargs.get("staging_dir", job_dir))
        block_event.wait(timeout=5.0)
        staged_mp4 = staging_dir / f"cleaned_{erase_run_id}.mp4"
        staged_mp4.write_bytes(b"dummy")
        return staged_mp4

    with patch("core.effect_erase_adapter.EffectEraseAdapter.run_removal", side_effect=slow_removal), \
         patch("core.effect_erase_adapter.EffectEraseAdapter.check_availability", return_value=(True, None)):

        with TestClient(app) as test_client:
            try:
                # 1. Start first removal run
                res1 = test_client.post(f"/api/v1/jobs/{job_id}/removal", json={})
                assert res1.status_code == 200
                run1 = res1.json()["erase_run_id"]

                # 2. Try starting a second removal run immediately -> must return 409 Conflict
                res2 = test_client.post(f"/api/v1/jobs/{job_id}/removal", json={})
                assert res2.status_code == 409
                assert "already active" in res2.json()["detail"]

            finally:
                block_event.set()
                time.sleep(0.2)


def test_removal_cancellation(mock_job_workspace):
    job_id, job_dir = mock_job_workspace

    cancel_seen = False
    def interruptible_removal(*args, **kwargs):
        nonlocal cancel_seen
        cancel_check = kwargs.get("cancel_check")
        staging_dir = Path(kwargs.get("staging_dir", job_dir))
        for _ in range(50):
            if cancel_check and cancel_check():
                cancel_seen = True
                raise JobCancelledException("Cancelled in test")
            time.sleep(0.05)
        staged_mp4 = staging_dir / "dummy.mp4"
        staged_mp4.write_bytes(b"dummy")
        return staged_mp4

    with patch("core.effect_erase_adapter.EffectEraseAdapter.run_removal", side_effect=interruptible_removal), \
         patch("core.effect_erase_adapter.EffectEraseAdapter.check_availability", return_value=(True, None)):

        with TestClient(app) as test_client:
            res = test_client.post(f"/api/v1/jobs/{job_id}/removal", json={})
            assert res.status_code == 200
            erase_run_id = res.json()["erase_run_id"]

            time.sleep(0.1)

            # Cancel the removal run
            cancel_res = test_client.post(f"/api/v1/jobs/{job_id}/removal/{erase_run_id}/cancel")
            assert cancel_res.status_code == 200
            cdata = cancel_res.json()
            assert cdata["status"] in ("cancelling", "cancelled")

            # Verify terminal status becomes cancelled
            max_wait = 5.0
            start = time.time()
            cancelled = False
            while time.time() - start < max_wait:
                status_res = test_client.get(f"/api/v1/jobs/{job_id}/removal/{erase_run_id}/status")
                assert status_res.status_code == 200
                if status_res.json()["stage"] == "cancelled":
                    cancelled = True
                    break
                time.sleep(0.05)

            assert cancelled, f"Removal run did not settle to cancelled: {status_res.json()}"


def test_failed_run_preserves_previous_cleaned_video(mock_job_workspace):
    job_id, job_dir = mock_job_workspace

    # 1. Establish an existing previously successful cleaned.mp4
    prev_cleaned = job_dir / "cleaned.mp4"
    prev_cleaned.write_bytes(b"ORIGINAL_CLEANED_VIDEO_CONTENT")

    # 2. Trigger a second run that fails in the adapter
    def failing_removal(*args, **kwargs):
        raise EffectEraseException("Simulated inference failure (e.g. OOM)")

    with patch("core.effect_erase_adapter.EffectEraseAdapter.run_removal", side_effect=failing_removal), \
         patch("core.effect_erase_adapter.EffectEraseAdapter.check_availability", return_value=(True, None)):

        res = client.post(f"/api/v1/jobs/{job_id}/removal", json={})
        assert res.status_code == 200
        erase_run_id = res.json()["erase_run_id"]

        # Poll status until failed
        max_wait = 5.0
        start = time.time()
        failed = False
        while time.time() - start < max_wait:
            s_res = client.get(f"/api/v1/jobs/{job_id}/removal/{erase_run_id}/status")
            if s_res.json().get("stage") == "failed":
                failed = True
                assert "Simulated inference failure" in s_res.json().get("error", "")
                break
            time.sleep(0.1)

        assert failed, "Run did not fail as expected"

        # 3. Assert previous cleaned.mp4 was preserved undamaged
        assert prev_cleaned.exists()
        assert prev_cleaned.read_bytes() == b"ORIGINAL_CLEANED_VIDEO_CONTENT"

        # 4. Assert staging was cleaned up
        staging_dir = job_dir / f"removal_staging_{erase_run_id}"
        assert not staging_dir.exists()


def test_removal_result_not_found(mock_job_workspace):
    job_id, _ = mock_job_workspace
    res = client.get(f"/api/v1/jobs/{job_id}/removal/nonexistent_erase/result")
    assert res.status_code == 404


def test_removal_path_traversal_protection():
    # Attempt path traversal in job_id
    res = client.get("/api/v1/jobs/../../etc/removal/some_run/result")
    # FastAPI path routing or containment check rejects invalid/traversal job IDs
    assert res.status_code in (400, 404)
