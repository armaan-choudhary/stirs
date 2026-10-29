import os
import shutil
import pytest
import numpy as np
import cv2
from core.video_io import probe_video, extract_frames

@pytest.fixture
def temp_video_env(tmp_path):
    video_dir = str(tmp_path / "video_test")
    os.makedirs(video_dir, exist_ok=True)
    video_path = os.path.join(video_dir, "test.mp4")

    # Generate a small 10-frame synthetic mp4 video using OpenCV
    w, h, fps, num_frames = 160, 120, 25.0, 10
    fourcc = cv2.VideoWriter_fourcc(*"mp4v")
    out = cv2.VideoWriter(video_path, fourcc, fps, (w, h))

    for i in range(num_frames):
        frame = np.full((h, w, 3), i * 20, dtype=np.uint8)
        out.write(frame)
    out.release()

    yield {
        "video_path": video_path,
        "dir": video_dir,
        "width": w,
        "height": h,
        "fps": fps,
        "num_frames": num_frames
    }

    shutil.rmtree(video_dir, ignore_errors=True)


def test_probe_and_extract_frames(temp_video_env):
    video_path = temp_video_env["video_path"]
    meta = probe_video(video_path)

    assert meta["width"] == temp_video_env["width"]
    assert meta["height"] == temp_video_env["height"]
    assert meta["frame_count"] == temp_video_env["num_frames"]
    assert abs(meta["fps"] - temp_video_env["fps"]) < 1.0

    frames_dir = os.path.join(temp_video_env["dir"], "frames")
    extracted_count = extract_frames(video_path, frames_dir)
    assert extracted_count == temp_video_env["num_frames"]
    assert os.path.exists(os.path.join(frames_dir, "00000.jpg"))
    assert os.path.exists(os.path.join(frames_dir, f"{temp_video_env['num_frames'] - 1:05d}.jpg"))
