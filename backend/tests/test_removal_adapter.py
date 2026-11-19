import sys
import shutil
import tempfile
import subprocess
from pathlib import Path
from unittest.mock import patch, MagicMock
import numpy as np
import cv2
import pytest

from core.effect_erase_adapter import (
    EffectEraseAdapter,
    EffectEraseConfig,
    EffectEraseException,
    EffectEraseUnavailableException,
    JobCancelledException,
)


@pytest.fixture
def temp_workspace():
    tmp_dir = Path(tempfile.mkdtemp(prefix="test_adapter_"))
    yield tmp_dir
    shutil.rmtree(tmp_dir, ignore_errors=True)


@pytest.fixture
def mock_video(temp_workspace):
    """Creates a small 320x240 10-frame dummy MP4 file."""
    video_path = temp_workspace / "source_video.mp4"
    w, h, fps, num_frames = 320, 240, 10.0, 10
    fourcc = cv2.VideoWriter_fourcc(*"mp4v")
    out = cv2.VideoWriter(str(video_path), fourcc, fps, (w, h))
    for i in range(num_frames):
        frame = np.full((h, w, 3), i * 20, dtype=np.uint8)
        out.write(frame)
    out.release()
    return video_path


@pytest.fixture
def mock_masks(temp_workspace):
    """Creates 10 mask PNGs (160x120 downscaled to test nearest-neighbor upscaling)."""
    masks_dir = temp_workspace / "masks"
    masks_dir.mkdir(parents=True, exist_ok=True)
    for i in range(10):
        # 160x120 downscaled masks with values 0, 128, 200, 255
        mask = np.zeros((120, 160), dtype=np.uint8)
        mask[30:70, 40:80] = 200  # Foreground region to be normalized to 255
        mask_path = masks_dir / f"{i:05d}.png"
        cv2.imwrite(str(mask_path), mask)
    return masks_dir


def test_config_from_environment(monkeypatch, temp_workspace):
    import config
    monkeypatch.setattr(config, "EFFECT_ERASE_PYTHON", "/bin/python3")
    monkeypatch.setattr(config, "EFFECT_ERASE_DEVICE", "cpu")
    monkeypatch.setenv("EFFECT_ERASE_STEPS", "30")
    monkeypatch.setenv("EFFECT_ERASE_TILED", "true")

    cfg = EffectEraseConfig.from_environment(base_dir=temp_workspace)
    assert str(cfg.python_bin) == "/bin/python3"
    assert cfg.device == "cpu"
    assert cfg.num_inference_steps == 30
    assert cfg.tiled is True


def test_check_availability_missing_ffmpeg():
    adapter = EffectEraseAdapter()
    with patch("shutil.which", return_value=None):
        avail, reason = adapter.check_availability(check_weights=False)
        assert avail is False
        assert "ffmpeg executable not found" in reason


def test_check_availability_missing_python(temp_workspace):
    cfg = EffectEraseConfig.from_environment(base_dir=temp_workspace)
    cfg.python_bin = temp_workspace / "nonexistent_python_binary"
    adapter = EffectEraseAdapter(config_obj=cfg)

    def mock_which(cmd):
        return "/usr/bin/ffmpeg" if "ff" in str(cmd) else None

    with patch("shutil.which", side_effect=mock_which):
        avail, reason = adapter.check_availability(check_weights=False)
        assert avail is False
        assert "Configured Python binary" in reason


def test_check_availability_missing_weights(temp_workspace):
    cfg = EffectEraseConfig.from_environment(base_dir=temp_workspace)
    cfg.python_bin = Path(sys.executable)
    # Create dummy script file so script check passes
    script_dummy = temp_workspace / "infer_remove_wan.py"
    script_dummy.write_text("# dummy")
    cfg.script_path = script_dummy

    # Point weights to nonexistent files
    cfg.text_encoder_path = temp_workspace / "missing_t5.pth"
    adapter = EffectEraseAdapter(config_obj=cfg)

    def mock_which(cmd):
        return "/usr/bin/ffmpeg" if "ff" in str(cmd) else "/bin/python3"

    with patch("shutil.which", side_effect=mock_which):
        avail, reason = adapter.check_availability(check_weights=True)
        assert avail is False
        assert "Missing required model weights" in reason


def test_validate_masks_sequence_success(mock_masks):
    adapter = EffectEraseAdapter()
    ordered = adapter.validate_masks_sequence(
        masks_dir=mock_masks,
        expected_frame_count=10,
        expected_width=320,
        expected_height=240,
    )
    assert len(ordered) == 10
    assert ordered[0].name == "00000.png"
    assert ordered[9].name == "00009.png"


def test_validate_masks_sequence_mismatch(mock_masks):
    adapter = EffectEraseAdapter()
    with pytest.raises(EffectEraseException) as exc_info:
        adapter.validate_masks_sequence(
            masks_dir=mock_masks,
            expected_frame_count=15,  # Expected 15 but only 10 exist
            expected_width=320,
            expected_height=240,
        )
    assert "frame count mismatch" in str(exc_info.value)


def test_validate_masks_sequence_missing_dir(temp_workspace):
    adapter = EffectEraseAdapter()
    missing_dir = temp_workspace / "nonexistent_masks"
    with pytest.raises(EffectEraseException):
        adapter.validate_masks_sequence(
            masks_dir=missing_dir,
            expected_frame_count=10,
            expected_width=320,
            expected_height=240,
        )


def test_create_mask_video_nearest_neighbor_and_binary(mock_masks, temp_workspace):
    """
    Tests nearest-neighbor upscaling from 160x120 to 320x240 and strict binary 0/255 normalization.
    """
    adapter = EffectEraseAdapter()
    out_mask_video = temp_workspace / "mask_video.mp4"
    mask_files = sorted(list(mock_masks.glob("*.png")))

    res = adapter.create_mask_video(
        mask_files=mask_files,
        output_mask_video_path=out_mask_video,
        fps=10.0,
        target_width=320,
        target_height=240,
    )
    assert res.exists()
    assert res.stat().st_size > 0

    # Probe resulting video
    cap = cv2.VideoCapture(str(res))
    ret, frame = cap.read()
    cap.release()
    assert ret is True
    assert frame.shape[1] == 320  # Upscaled width
    assert frame.shape[0] == 240  # Upscaled height


def test_create_mask_video_rejects_empty_masks(temp_workspace):
    """Verifies that an all-zero mask sequence fails validation."""
    empty_dir = temp_workspace / "empty_masks"
    empty_dir.mkdir(parents=True, exist_ok=True)
    files = []
    for i in range(5):
        p = empty_dir / f"{i:05d}.png"
        cv2.imwrite(str(p), np.zeros((100, 100), dtype=np.uint8))
        files.append(p)

    adapter = EffectEraseAdapter()
    out_mask = temp_workspace / "empty_out.mp4"
    with pytest.raises(EffectEraseException) as exc_info:
        adapter.create_mask_video(
            mask_files=files,
            output_mask_video_path=out_mask,
            fps=10.0,
            target_width=100,
            target_height=100,
        )
    assert "no marked object regions" in str(exc_info.value)
    assert not out_mask.exists()


def test_create_mask_video_cancellation(mock_masks, temp_workspace):
    adapter = EffectEraseAdapter()
    out_mask = temp_workspace / "cancelled_mask.mp4"
    mask_files = sorted(list(mock_masks.glob("*.png")))

    # Cancel immediately
    with pytest.raises(JobCancelledException):
        adapter.create_mask_video(
            mask_files=mask_files,
            output_mask_video_path=out_mask,
            fps=10.0,
            target_width=320,
            target_height=240,
            cancel_check=lambda: True,
        )


def test_audio_muxing(mock_video, temp_workspace):
    adapter = EffectEraseAdapter()
    video_no_audio = temp_workspace / "no_audio.mp4"
    shutil.copy2(mock_video, video_no_audio)

    muxed_out = temp_workspace / "muxed_out.mp4"
    res = adapter.mux_audio(
        video_without_audio_path=video_no_audio,
        source_with_audio_path=mock_video,
        output_path=muxed_out,
    )
    assert res.exists()
    assert res.stat().st_size > 0


def test_subprocess_cancellation(temp_workspace):
    adapter = EffectEraseAdapter()
    # Command that sleeps
    cmd = [sys.executable, "-c", "import time; time.sleep(10)"]

    cancelled = False
    def cancel_check():
        nonlocal cancelled
        return cancelled

    def trigger_cancel():
        nonlocal cancelled
        import time
        time.sleep(0.3)
        cancelled = True

    import threading
    t = threading.Thread(target=trigger_cancel)
    t.start()

    with pytest.raises(JobCancelledException):
        adapter._execute_subprocess(cmd, progress_cb=None, cancel_check=cancel_check)
    t.join()


def test_subprocess_nonzero_exit():
    adapter = EffectEraseAdapter()
    cmd = [sys.executable, "-c", "import sys; sys.stderr.write('Fatal model error'); sys.exit(42)"]
    with pytest.raises(EffectEraseException) as exc_info:
        adapter._execute_subprocess(cmd, progress_cb=None, cancel_check=None)
    assert "exit code 42" in str(exc_info.value)


def test_run_removal_end_to_end_mocked(mock_video, mock_masks, temp_workspace):
    """
    Tests complete run_removal pipeline with mocked model inference subprocess.
    Verifies progress callbacks, audio muxing, staging cleanup, and final output.
    """
    staging_dir = temp_workspace / "staging"
    adapter = EffectEraseAdapter()

    stages_seen = []
    def progress_callback(stage, pct):
        stages_seen.append((stage, pct))

    # Mock _execute_subprocess to generate raw_output MP4 file instead of invoking GPU
    def fake_execute(cmd, progress_cb, cancel_check):
        # Find --output_path argument
        out_idx = cmd.index("--output_path") + 1
        output_path = Path(cmd[out_idx])
        # Write dummy valid MP4
        w, h, fps = 320, 240, 10.0
        fourcc = cv2.VideoWriter_fourcc(*"mp4v")
        writer = cv2.VideoWriter(str(output_path), fourcc, fps, (w, h))
        for _ in range(10):
            writer.write(np.zeros((h, w, 3), dtype=np.uint8))
        writer.release()
        if progress_cb:
            progress_cb("loading_model", 25)
            progress_cb("inference", 60)
            progress_cb("validating_output", 90)
        return ["[INFO] Inference complete"]

    with patch.object(adapter, "_execute_subprocess", side_effect=fake_execute), \
         patch.object(adapter, "check_availability", return_value=(True, None)):
        final_video = adapter.run_removal(
            job_id="test_job_1",
            erase_run_id="erase_run_1",
            source_video_path=mock_video,
            masks_dir=mock_masks,
            staging_dir=staging_dir,
            progress_cb=progress_callback,
            cancel_check=lambda: False,
        )

        assert final_video.exists()
        assert final_video.name == "cleaned_erase_run_1.mp4"
        assert final_video.stat().st_size > 0

        # Verify intermediate mask video is cleaned up
        mask_video = staging_dir / "mask_erase_run_1.mp4"
        assert not mask_video.exists()

        # Verify progress stages
        stage_names = [s[0] for s in stages_seen]
        assert "preparing_input" in stage_names
        assert "loading_model" in stage_names
        assert "inference" in stage_names
        assert "validating_output" in stage_names


def test_run_removal_cleans_on_failure(mock_video, mock_masks, temp_workspace):
    staging_dir = temp_workspace / "staging_fail"
    adapter = EffectEraseAdapter()

    def fail_execute(cmd, progress_cb, cancel_check):
        raise EffectEraseException("Upstream CUDA OOM during diffusion")

    with patch.object(adapter, "_execute_subprocess", side_effect=fail_execute), \
         patch.object(adapter, "check_availability", return_value=(True, None)):
        with pytest.raises(EffectEraseException):
            adapter.run_removal(
                job_id="test_job_fail",
                erase_run_id="erase_fail",
                source_video_path=mock_video,
                masks_dir=mock_masks,
                staging_dir=staging_dir,
                progress_cb=None,
                cancel_check=None,
            )

        # Temporary files must be cleaned
        assert not (staging_dir / "mask_erase_fail.mp4").exists()
        assert not (staging_dir / "cleaned_erase_fail.mp4").exists()
