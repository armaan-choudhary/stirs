import os
import io
import cv2
import numpy as np
import pytest
from fastapi.testclient import TestClient

from main import app
import config
from core.geometry import convert_strokes_to_sam2_multi_obj_prompts
from core.sam2_engine import SAM2MaskGenerator, JobCancelledException
from schemas import StrokeInput, Point2D, PreviewMaskRequest

client = TestClient(app)

@pytest.fixture
def dummy_job_workspace(tmp_path, monkeypatch):
    """
    Creates a temporary workspace with extracted frames to test preview without full video upload.
    """
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    monkeypatch.setattr(config, "WORKSPACE_DIR", workspace)

    job_id = "test-job-preview-parity"
    job_dir = workspace / job_id
    frames_dir = job_dir / "frames"
    frames_dir.mkdir(parents=True)

    # Create dummy 320x240 frame (frame 00000.jpg)
    img = np.zeros((240, 320, 3), dtype=np.uint8)
    # Target 1 (include 1) at (50, 50) to (100, 100)
    cv2.rectangle(img, (50, 50), (100, 100), (255, 255, 255), -1)
    # Target 2 (include 2) at (200, 150) to (260, 210)
    cv2.rectangle(img, (200, 150), (260, 210), (255, 255, 255), -1)
    cv2.imwrite(str(frames_dir / "00000.jpg"), img)

    return job_id, frames_dir, workspace


def test_geometry_multi_obj_strokes():
    """Verify convert_strokes_to_sam2_multi_obj_prompts splits multiple includes and attaches excludes."""
    # Stroke 1: large include (>2.5% of 320x240 = 1920 px)
    stroke1 = StrokeInput(
        points=[
            Point2D(x=50, y=50),
            Point2D(x=120, y=50),
            Point2D(x=120, y=120),
            Point2D(x=50, y=120)
        ],
        mode="include"
    )
    # Stroke 2: large include
    stroke2 = StrokeInput(
        points=[
            Point2D(x=200, y=140),
            Point2D(x=270, y=140),
            Point2D(x=270, y=210),
            Point2D(x=200, y=210)
        ],
        mode="include"
    )
    # Stroke 3: exclude
    stroke_exclude = StrokeInput(
        points=[
            Point2D(x=80, y=80),
            Point2D(x=90, y=90),
            Point2D(x=85, y=95)
        ],
        mode="exclude"
    )

    # 1. Single include stroke
    prompts_single = convert_strokes_to_sam2_multi_obj_prompts([stroke1, stroke_exclude], 320, 240)
    assert len(prompts_single) == 1
    obj_id, box, pts, lbls = prompts_single[0]
    assert obj_id == 1
    assert box is not None
    # Exclude points should have label 0
    assert 0 in lbls
    assert 1 in lbls

    # 2. Multiple include strokes
    prompts_multi = convert_strokes_to_sam2_multi_obj_prompts([stroke1, stroke2, stroke_exclude], 320, 240)
    assert len(prompts_multi) == 2
    assert prompts_multi[0][0] == 1
    assert prompts_multi[1][0] == 2
    # Both objects should receive the exclude guidance
    assert 0 in prompts_multi[0][3]
    assert 0 in prompts_multi[1][3]


def test_preview_single_frame_generator_multi_objects(tmp_path):
    """Directly test SAM2MaskGenerator.preview_single_frame with multi_objects."""
    frames_dir = tmp_path / "frames"
    frames_dir.mkdir()
    img = np.zeros((240, 320, 3), dtype=np.uint8)
    cv2.imwrite(str(frames_dir / "00000.jpg"), img)

    gen = SAM2MaskGenerator.get_instance("nonexistent.yaml", "nonexistent.pt", device="cpu")

    # Pass 2 mock objects (fallback will render ellipses/circles)
    obj1 = (1, np.array([50, 50, 100, 100], dtype=np.float32), None, None)
    obj2 = (2, np.array([200, 150, 250, 200], dtype=np.float32), None, None)

    mask = gen.preview_single_frame(
        frames_dir=str(frames_dir),
        frame_idx=0,
        multi_objects=[obj1, obj2],
        dilation_px=0
    )

    assert mask.shape == (240, 320)
    # Check that both regions have positive mask values
    # Center of obj 1: (75, 75)
    assert mask[75, 75] == 255
    # Center of obj 2: (175, 225) -> y=175, x=225
    assert mask[175, 225] == 255
    # Background should be 0
    assert mask[10, 10] == 0


def test_preview_api_single_vs_multi_include(dummy_job_workspace):
    """Test preview API endpoint with 1 include stroke, multiple include strokes, and combined bbox."""
    job_id, frames_dir, _ = dummy_job_workspace

    # 1. Single include stroke
    single_req = {
        "job_id": job_id,
        "frame_idx": 0,
        "dilation_px": 3,
        "strokes": [
            {
                "points": [
                    {"x": 50, "y": 50},
                    {"x": 100, "y": 50},
                    {"x": 100, "y": 100},
                    {"x": 50, "y": 100}
                ],
                "mode": "include"
            }
        ]
    }
    res_single = client.post("/api/v1/masks/preview", json=single_req)
    assert res_single.status_code == 200
    data_single = res_single.json()
    assert data_single["bbox"] is not None
    assert len(data_single["bbox"]) == 4
    # Check bbox covers the stroke
    b_single = data_single["bbox"]
    assert b_single[0] == pytest.approx(50, abs=1)
    assert b_single[1] == pytest.approx(50, abs=1)
    assert b_single[2] == pytest.approx(100, abs=1)
    assert b_single[3] == pytest.approx(100, abs=1)

    # 2. Multi include strokes (2 separate objects)
    multi_req = {
        "job_id": job_id,
        "frame_idx": 0,
        "dilation_px": 3,
        "strokes": [
            {
                "points": [
                    {"x": 50, "y": 50},
                    {"x": 100, "y": 50},
                    {"x": 100, "y": 100},
                    {"x": 50, "y": 100}
                ],
                "mode": "include"
            },
            {
                "points": [
                    {"x": 200, "y": 150},
                    {"x": 260, "y": 150},
                    {"x": 260, "y": 210},
                    {"x": 200, "y": 210}
                ],
                "mode": "include"
            },
            {
                "points": [
                    {"x": 70, "y": 70},
                    {"x": 75, "y": 75},
                    {"x": 70, "y": 80}
                ],
                "mode": "exclude"
            }
        ]
    }
    res_multi = client.post("/api/v1/masks/preview", json=multi_req)
    assert res_multi.status_code == 200
    data_multi = res_multi.json()
    assert data_multi["mask_base64_png"].startswith("data:image/png;base64,")
    assert data_multi["bbox"] is not None
    # Combined bbox should span min(50, 200)=50 to max(100, 260)=260
    b_multi = data_multi["bbox"]
    assert b_multi[0] == pytest.approx(50, abs=1)
    assert b_multi[1] == pytest.approx(50, abs=1)
    assert b_multi[2] == pytest.approx(260, abs=1)
    assert b_multi[3] == pytest.approx(210, abs=1)


def test_preview_api_no_include_strokes(dummy_job_workspace):
    """Test preview API when only exclude stroke is provided or strokes without include."""
    job_id, _, _ = dummy_job_workspace

    req = {
        "job_id": job_id,
        "frame_idx": 0,
        "dilation_px": 3,
        "strokes": [
            {
                "points": [
                    {"x": 10, "y": 10},
                    {"x": 20, "y": 10},
                    {"x": 20, "y": 20}
                ],
                "mode": "exclude"
            }
        ]
    }
    res = client.post("/api/v1/masks/preview", json=req)
    assert res.status_code == 200
    data = res.json()
    assert data["bbox"] is None
    assert data["mask_base64_png"].startswith("data:image/png;base64,")


def test_preview_single_frame_dict_format(tmp_path):
    """Test SAM2MaskGenerator.preview_single_frame accepting objects formatted as dicts."""
    frames_dir = tmp_path / "frames"
    frames_dir.mkdir()
    img = np.zeros((240, 320, 3), dtype=np.uint8)
    cv2.imwrite(str(frames_dir / "00000.jpg"), img)

    gen = SAM2MaskGenerator.get_instance("nonexistent.yaml", "nonexistent.pt", device="cpu")

    dict_objects = [
        {"obj_id": 1, "box": [50, 50, 100, 100]},
        {"id": 2, "bbox": [200, 150, 250, 200], "points": [[225, 175]], "labels": [1]}
    ]

    mask = gen.preview_single_frame(
        frames_dir=str(frames_dir),
        frame_idx=0,
        multi_objects=dict_objects,
        dilation_px=0
    )

    assert mask.shape == (240, 320)
    assert mask[75, 75] == 255
    assert mask[175, 225] == 255
    assert mask[10, 10] == 0


def test_propagate_fallback_keyframe_prompts_multi_objects(tmp_path):
    """
    Verify fallback propagation consuming keyframe_prompts with multiple objects
    produces non-empty, correctly located masks across video frames.
    """
    frames_dir = tmp_path / "frames"
    frames_dir.mkdir()
    out_masks_dir = tmp_path / "output_masks"

    # Create 5 frames
    for i in range(5):
        img = np.zeros((240, 320, 3), dtype=np.uint8)
        cv2.imwrite(str(frames_dir / f"{i:05d}.jpg"), img)

    gen = SAM2MaskGenerator.get_instance("nonexistent.yaml", "nonexistent.pt", device="cpu")

    # Define keyframe_prompts: frame 1 (tuples) and frame 3 (dicts)
    keyframe_prompts = [
        {
            "frame_idx": 1,
            "objects": [
                (1, np.array([50, 50, 100, 100], dtype=np.float32), None, None),
                (2, np.array([200, 150, 250, 200], dtype=np.float32), None, None)
            ]
        },
        {
            "frame_idx": 3,
            "objects": [
                {"obj_id": 1, "box": [60, 60, 110, 110]},
                {"obj_id": 2, "box": [210, 160, 260, 210]}
            ]
        }
    ]

    out_dir = gen.propagate_full_video(
        frames_dir=str(frames_dir),
        output_mask_dir=str(out_masks_dir),
        annotated_frame_idx=1,
        keyframe_prompts=keyframe_prompts,
        dilation_px=0
    )

    assert os.path.exists(out_dir)
    mask_files = sorted([f for f in os.listdir(out_dir) if f.endswith(".png")])
    assert len(mask_files) == 5

    # Check that each frame produces a non-empty mask
    for fname in mask_files:
        mask = cv2.imread(os.path.join(out_dir, fname), cv2.IMREAD_GRAYSCALE)
        assert mask is not None
        assert mask.shape == (240, 320)
        assert cv2.countNonZero(mask) > 0

    # At keyframe 1, exact object centers: (75, 75) and (175, 225)
    mask_kf1 = cv2.imread(os.path.join(out_dir, "00001.png"), cv2.IMREAD_GRAYSCALE)
    assert mask_kf1[75, 75] == 255
    assert mask_kf1[175, 225] == 255

    # At keyframe 3, exact object centers: (85, 85) and (185, 235)
    mask_kf3 = cv2.imread(os.path.join(out_dir, "00003.png"), cv2.IMREAD_GRAYSCALE)
    assert mask_kf3[85, 85] == 255
    assert mask_kf3[185, 235] == 255


def test_propagate_fallback_accumulate_with_existing_mask_dir(tmp_path):
    """
    Verify fallback propagation with accumulate=True and existing_mask_dir
    unions existing masks with newly generated masks.
    """
    frames_dir = tmp_path / "frames"
    frames_dir.mkdir()
    existing_dir = tmp_path / "existing_masks"
    existing_dir.mkdir()
    out_dir = tmp_path / "output_masks"

    # 3 frames
    for i in range(3):
        img = np.zeros((240, 320, 3), dtype=np.uint8)
        cv2.imwrite(str(frames_dir / f"{i:05d}.jpg"), img)

    # In existing_mask_dir, create pre-existing mask at frame 0: white rectangle at (10, 10)-(30, 30)
    pre_mask = np.zeros((240, 320), dtype=np.uint8)
    cv2.rectangle(pre_mask, (10, 10), (30, 30), 255, -1)
    cv2.imwrite(str(existing_dir / "00000.png"), pre_mask)

    gen = SAM2MaskGenerator.get_instance("nonexistent.yaml", "nonexistent.pt", device="cpu")

    # Propagate new box at (100, 100)-(160, 160) (center at (130, 130)) with accumulate=True
    gen.propagate_full_video(
        frames_dir=str(frames_dir),
        output_mask_dir=str(out_dir),
        annotated_frame_idx=0,
        box=np.array([100, 100, 160, 160], dtype=np.float32),
        accumulate=True,
        existing_mask_dir=str(existing_dir),
        dilation_px=0
    )

    # Frame 0 in out_dir should retain the existing rectangle at (20, 20) AND new box at (130, 130)
    f0_mask = cv2.imread(str(out_dir / "00000.png"), cv2.IMREAD_GRAYSCALE)
    assert f0_mask is not None
    assert f0_mask[20, 20] == 255      # from existing_mask_dir
    assert f0_mask[130, 130] == 255    # from new propagation
    assert f0_mask[5, 5] == 0          # background untouched


def test_propagate_fallback_accumulate_with_existing_output_dir(tmp_path):
    """
    Verify fallback propagation with accumulate=True reads from output_mask_dir
    when existing_mask_dir is None.
    """
    frames_dir = tmp_path / "frames"
    frames_dir.mkdir()
    out_dir = tmp_path / "output_masks"
    out_dir.mkdir()

    for i in range(3):
        img = np.zeros((240, 320, 3), dtype=np.uint8)
        cv2.imwrite(str(frames_dir / f"{i:05d}.jpg"), img)

    # In out_dir, create existing mask at frame 0
    pre_mask = np.zeros((240, 320), dtype=np.uint8)
    cv2.circle(pre_mask, (25, 25), 10, 255, -1)
    cv2.imwrite(str(out_dir / "00000.png"), pre_mask)

    gen = SAM2MaskGenerator.get_instance("nonexistent.yaml", "nonexistent.pt", device="cpu")

    gen.propagate_full_video(
        frames_dir=str(frames_dir),
        output_mask_dir=str(out_dir),
        annotated_frame_idx=0,
        box=np.array([100, 100, 160, 160], dtype=np.float32),
        accumulate=True,
        existing_mask_dir=None,
        dilation_px=0
    )

    f0_mask = cv2.imread(str(out_dir / "00000.png"), cv2.IMREAD_GRAYSCALE)
    assert f0_mask is not None
    assert f0_mask[25, 25] == 255      # from pre-existing mask in output_mask_dir
    assert f0_mask[130, 130] == 255    # from new propagation


def test_propagate_cooperative_cancellation(tmp_path):
    """Verify JobCancelledException is raised if cancel_check triggers during fallback propagation."""
    frames_dir = tmp_path / "frames"
    frames_dir.mkdir()
    out_dir = tmp_path / "output_masks"

    for i in range(3):
        img = np.zeros((240, 320, 3), dtype=np.uint8)
        cv2.imwrite(str(frames_dir / f"{i:05d}.jpg"), img)

    gen = SAM2MaskGenerator.get_instance("nonexistent.yaml", "nonexistent.pt", device="cpu")

    with pytest.raises(JobCancelledException):
        gen.propagate_full_video(
            frames_dir=str(frames_dir),
            output_mask_dir=str(out_dir),
            annotated_frame_idx=0,
            box=np.array([50, 50, 100, 100], dtype=np.float32),
            cancel_check=lambda: True
        )

