import cv2
import numpy as np
from typing import List, Tuple, Optional
from schemas import StrokeInput

def convert_strokes_to_sam2_prompts(
    strokes: List[StrokeInput],
    frame_w: int,
    frame_h: int
) -> Tuple[Optional[np.ndarray], Optional[np.ndarray], Optional[np.ndarray]]:
    """
    Translates user circle/lasso strokes into unified SAM 2 prompts.
    Supports multi-region tracking:
    - Primary enclosing loop (defines bounding box + positive center guidance if inside polygon)
    - Additional positive strokes (e.g. shadow or reflection loops) are unioned into the tracking box
      and anchor positive prompts.
    - Exclude strokes place negative points (label 0) to carve out background.
    """
    all_points = []
    all_labels = []
    positive_boxes = []
    frame_area = float(frame_w * frame_h)

    for idx, stroke in enumerate(strokes):
        if not stroke.points:
            continue

        pts = np.array([[
            np.clip(p.x, 0, frame_w - 1),
            np.clip(p.y, 0, frame_h - 1)
        ] for p in stroke.points], dtype=np.float32)

        label_val = 1 if stroke.mode == "include" else 0

        x_min, y_min = np.min(pts, axis=0)
        x_max, y_max = np.max(pts, axis=0)
        box_area = (x_max - x_min) * (y_max - y_min)

        if stroke.mode == "include":
            # Significant include loop (>= 2.5% frame area)
            if (box_area / frame_area) >= 0.025:
                positive_boxes.append([x_min, y_min, x_max, y_max])
                centroid = np.mean(pts, axis=0).astype(np.float32)
                if cv2.pointPolygonTest(pts, (float(centroid[0]), float(centroid[1])), False) >= 0:
                    all_points.append(centroid)
                    all_labels.append(1)
            else:
                # Interior scribble (< 2.5% frame area) or secondary refinement stroke
                sample_count = min(4, len(pts))
                indices = np.linspace(0, len(pts) - 1, sample_count, dtype=int)
                for i in indices:
                    all_points.append(pts[i])
                    all_labels.append(1)
        else:
            # Exclude stroke: negative points
            sample_count = min(4, len(pts))
            indices = np.linspace(0, len(pts) - 1, sample_count, dtype=int)
            for i in indices:
                all_points.append(pts[i])
                all_labels.append(0)

    # Union bounding boxes across all include regions (e.g. person + cast shadow)
    if positive_boxes:
        boxes_np = np.array(positive_boxes, dtype=np.float32)
        primary_box = np.array([
            np.min(boxes_np[:, 0]),
            np.min(boxes_np[:, 1]),
            np.max(boxes_np[:, 2]),
            np.max(boxes_np[:, 3])
        ], dtype=np.float32)
    else:
        primary_box = None

    points_arr = np.array(all_points, dtype=np.float32) if all_points else None
    labels_arr = np.array(all_labels, dtype=np.int32) if all_labels else None

    return primary_box, points_arr, labels_arr


def convert_strokes_to_sam2_multi_obj_prompts(
    strokes: List[StrokeInput],
    frame_w: int,
    frame_h: int
) -> List[Tuple[int, Optional[np.ndarray], Optional[np.ndarray], Optional[np.ndarray]]]:
    """
    Parses strokes into separate objects for SAM 2 multi-object tracking.
    Each distinct include stroke gets its own obj_id (1, 2, ...), preventing dominant
    subject bodies from suppressing weaker reflections/shadows over temporal propagation.
    Exclude strokes are assigned to all active objects or the nearest object.
    
    Returns:
        List of (obj_id, box, points, labels)
    """
    include_strokes = [s for s in strokes if s.mode == "include" and s.points]
    exclude_strokes = [s for s in strokes if s.mode == "exclude" and s.points]

    if not include_strokes:
        return []

    # If only 1 include stroke, fallback to single object (obj_id=1)
    if len(include_strokes) == 1:
        box, pts, lbls = convert_strokes_to_sam2_prompts(strokes, frame_w, frame_h)
        return [(1, box, pts, lbls)]

    # Multiple include strokes: separate obj_id for each include stroke!
    multi_prompts = []
    for obj_idx, inc_stroke in enumerate(include_strokes, start=1):
        box, pts, lbls = convert_strokes_to_sam2_prompts([inc_stroke] + exclude_strokes, frame_w, frame_h)
        multi_prompts.append((obj_idx, box, pts, lbls))

    return multi_prompts
