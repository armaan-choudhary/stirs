import io
import time
import zipfile
import pytest
from fastapi.testclient import TestClient
import numpy as np
import cv2

from main import app
import config

client = TestClient(app)

@pytest.fixture
def sample_video_bytes():
    """Generates an in-memory MP4 video for testing."""
    import tempfile
    with tempfile.NamedTemporaryFile(suffix=".mp4", delete=False) as tf:
        tmp_name = tf.name

    w, h, fps, num_frames = 320, 240, 30.0, 15
    fourcc = cv2.VideoWriter_fourcc(*"mp4v")
    out = cv2.VideoWriter(tmp_name, fourcc, fps, (w, h))

    # Draw a moving square across frames to give SAM 2 something distinct
    for i in range(num_frames):
        frame = np.zeros((h, w, 3), dtype=np.uint8)
        # Moving bright rectangle
        x1 = 100 + i * 5
        y1 = 80
        x2 = x1 + 60
        y2 = y1 + 60
        cv2.rectangle(frame, (x1, y1), (x2, y2), (255, 255, 255), -1)
        out.write(frame)
    out.release()

    with open(tmp_name, "rb") as f:
        data = f.read()

    import os
    try:
        os.remove(tmp_name)
    except OSError:
        pass

    return data


def test_upload_preview_mask_flow(sample_video_bytes):
    # 1. Test Upload
    files = {"file": ("test_clip.mp4", io.BytesIO(sample_video_bytes), "video/mp4")}
    upload_res = client.post("/api/v1/videos/upload", files=files)
    assert upload_res.status_code == 200
    upload_data = upload_res.json()
    job_id = upload_data["job_id"]
    assert upload_data["frame_count"] == 15
    assert upload_data["width"] == 320
    assert upload_data["height"] == 240

    # 2. Test Preview Mask
    preview_req = {
        "job_id": job_id,
        "frame_idx": 5,
        "dilation_px": 7,
        "strokes": [
            {
                "points": [
                    {"x": 130, "y": 90},
                    {"x": 190, "y": 90},
                    {"x": 190, "y": 150},
                    {"x": 130, "y": 150},
                    {"x": 130, "y": 90}
                ],
                "mode": "include"
            }
        ]
    }
    preview_res = client.post("/api/v1/masks/preview", json=preview_req)
    assert preview_res.status_code == 200
    preview_data = preview_res.json()
    assert preview_data["job_id"] == job_id
    assert preview_data["frame_idx"] == 5
    assert preview_data["mask_base64_png"].startswith("data:image/png;base64,")
    assert preview_data["bbox"] is not None

    # 3. Test Trigger Mask Job
    mask_req = {
        "job_id": job_id,
        "annotated_frame_idx": 5,
        "dilation_px": 7,
        "strokes": preview_req["strokes"]
    }
    job_res = client.post("/api/v1/jobs/mask", json=mask_req)
    assert job_res.status_code == 200
    assert job_res.json()["status"] == "queued"

    # 4. Wait for job completion and test status
    max_wait = 20
    start_time = time.time()
    completed = False
    while time.time() - start_time < max_wait:
        status_res = client.get(f"/api/v1/jobs/{job_id}/status")
        assert status_res.status_code == 200
        data = status_res.json()
        if data.get("stage") == "completed":
            completed = True
            assert data.get("progress") == 100
            assert "output_url" in data
            break
        time.sleep(0.5)

    assert completed, f"Job did not complete within {max_wait}s: {status_res.json()}"

    # Verify final output masks archive exists and can be served statically
    final_output_path = config.WORKSPACE_DIR / job_id / "output_masks.zip"
    assert final_output_path.exists()
    static_res = client.get(f"/workspace/{job_id}/output_masks.zip")
    assert static_res.status_code == 200

    # Verify zip file content structure
    with zipfile.ZipFile(final_output_path, "r") as archive:
        namelist = archive.namelist()
        assert len(namelist) == upload_data["frame_count"]
        assert "00000.png" in namelist
