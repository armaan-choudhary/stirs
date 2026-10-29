import numpy as np
import pytest
from schemas import StrokeInput, Point2D
from core.geometry import convert_strokes_to_sam2_prompts

def test_large_enclosing_circle_with_centroid_inside():
    """
    Case B: Circle area >= 2.5% of frame. Centroid inside polygon.
    Expects primary_box and 1 foreground centroid point (label=1).
    """
    frame_w, frame_h = 1000, 1000  # Frame area = 1,000,000
    # Create circular points covering approx 200x200 box -> area = 40,000 (4% of frame)
    center_x, center_y = 500.0, 500.0
    radius = 100.0
    num_pts = 30
    angles = np.linspace(0, 2 * np.pi, num_pts, endpoint=False)
    pts = [Point2D(x=center_x + radius * np.cos(a), y=center_y + radius * np.sin(a)) for a in angles]
    stroke = StrokeInput(points=pts, mode="include")

    box, points, labels = convert_strokes_to_sam2_prompts([stroke], frame_w, frame_h)

    assert box is not None
    # Box should span approx [400, 400, 600, 600]
    assert np.isclose(box[0], 400.0, atol=2.0)
    assert np.isclose(box[1], 400.0, atol=2.0)
    assert np.isclose(box[2], 600.0, atol=2.0)
    assert np.isclose(box[3], 600.0, atol=2.0)

    # Centroid (500, 500) should be inside circle
    assert points is not None
    assert len(points) == 1
    assert labels is not None
    assert labels[0] == 1
    assert np.isclose(points[0][0], center_x, atol=1.0)
    assert np.isclose(points[0][1], center_y, atol=1.0)


def test_concave_c_shaped_stroke_centroid_outside():
    """
    Case B: C-shaped stroke covering >= 2.5% frame area, but centroid lies outside polygon.
    Expects primary_box, but no centroid point included.
    """
    frame_w, frame_h = 1000, 1000
    # Build a thin C shape
    # Points running around 3 sides of a 200x200 rectangle
    pts = [
        Point2D(x=400, y=400),
        Point2D(x=600, y=400),
        Point2D(x=600, y=420),
        Point2D(x=420, y=420),
        Point2D(x=420, y=580),
        Point2D(x=600, y=580),
        Point2D(x=600, y=600),
        Point2D(x=400, y=600)
    ]
    stroke = StrokeInput(points=pts, mode="include")
    box, points, labels = convert_strokes_to_sam2_prompts([stroke], frame_w, frame_h)

    assert box is not None
    assert np.isclose(box[0], 400.0)
    assert np.isclose(box[1], 400.0)
    assert np.isclose(box[2], 600.0)
    assert np.isclose(box[3], 600.0)
    # Centroid is around (485, 500), which is in the hollow open bay of the C shape
    # cv2.pointPolygonTest should return < 0, so centroid is not added
    assert points is None
    assert labels is None


def test_micro_scribble_interior():
    """
    Case A: Micro-Circle / Interior Scribble (< 2.5% frame area).
    Box should be None, and 4 points sampled along the stroke with label=1.
    """
    frame_w, frame_h = 1000, 1000  # Frame area = 1,000,000. 2.5% is 25,000.
    # Scribble of 20x20 = 400 area << 25,000
    pts = [
        Point2D(x=100, y=100),
        Point2D(x=110, y=105),
        Point2D(x=120, y=110),
        Point2D(x=115, y=120),
        Point2D(x=105, y=115),
        Point2D(x=100, y=100)
    ]
    stroke = StrokeInput(points=pts, mode="include")
    box, points, labels = convert_strokes_to_sam2_prompts([stroke], frame_w, frame_h)

    assert box is None
    assert points is not None
    assert len(points) == 4
    assert labels is not None
    assert len(labels) == 4
    assert all(l == 1 for l in labels)


def test_negative_exclude_refinement():
    """
    Multi-stroke test: Primary include stroke + secondary exclude stroke.
    Negative stroke points must have label=0.
    """
    frame_w, frame_h = 1000, 1000
    # Primary circle
    center_x, center_y, radius = 500.0, 500.0, 100.0
    angles = np.linspace(0, 2 * np.pi, 20, endpoint=False)
    primary_pts = [Point2D(x=center_x + radius * np.cos(a), y=center_y + radius * np.sin(a)) for a in angles]
    stroke1 = StrokeInput(points=primary_pts, mode="include")

    # Secondary exclude stroke
    neg_pts = [
        Point2D(x=550, y=550),
        Point2D(x=560, y=560),
        Point2D(x=570, y=570),
        Point2D(x=550, y=550)
    ]
    stroke2 = StrokeInput(points=neg_pts, mode="exclude")

    box, points, labels = convert_strokes_to_sam2_prompts([stroke1, stroke2], frame_w, frame_h)

    assert box is not None
    assert points is not None
    assert labels is not None

    # Points must include the centroid (label=1) plus 4 points from exclude stroke (label=0)
    assert len(points) == 5
    assert labels[0] == 1
    assert all(l == 0 for l in labels[1:])
