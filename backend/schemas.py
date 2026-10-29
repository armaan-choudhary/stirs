from pydantic import BaseModel, Field
from typing import List, Optional, Literal

class Point2D(BaseModel):
    x: float
    y: float

class StrokeInput(BaseModel):
    points: List[Point2D] = Field(..., min_length=3)
    mode: Literal["include", "exclude"] = "include"

class PreviewMaskRequest(BaseModel):
    job_id: str
    frame_idx: int
    strokes: List[StrokeInput]
    dilation_px: int = Field(default=7, ge=0, le=50)
    capture_shadows: bool = Field(default=True)
    temporal_motion_blur: bool = Field(default=True)

class PreviewMaskResponse(BaseModel):
    job_id: str
    frame_idx: int
    mask_base64_png: str  # RGBA overlay for instant frontend rendering
    bbox: Optional[List[float]] = None

class KeyframeAnnotation(BaseModel):
    frame_idx: int
    strokes: List[StrokeInput]

class MaskJobRequest(BaseModel):
    job_id: str
    annotated_frame_idx: Optional[int] = None
    strokes: Optional[List[StrokeInput]] = None
    keyframes: Optional[List[KeyframeAnnotation]] = None
    dilation_px: int = Field(default=7, ge=0, le=50)
    capture_shadows: bool = Field(default=True)
    temporal_motion_blur: bool = Field(default=True)
    accumulate_with_existing: bool = Field(default=False)

# Retain EraseJobRequest as an alias for backward compatibility
EraseJobRequest = MaskJobRequest

class MaskJobResponse(BaseModel):
    job_id: str
    run_id: str
    status: str

EraseJobResponse = MaskJobResponse

class VideoMetadata(BaseModel):
    job_id: str
    fps: float
    frame_count: int
    width: int
    height: int
    raw_video_url: str

class JobProgressEvent(BaseModel):
    stage: Literal["queued", "sam2_forward", "sam2_backward", "packaging", "completed", "failed", "cancelled"]
    progress: int = Field(..., ge=0, le=100)
    run_id: Optional[str] = None
    output_url: Optional[str] = None
    error: Optional[str] = None

class WorkspaceCleanupRequest(BaseModel):
    max_age_hours: Optional[int] = Field(default=None, gt=0, description="Optional positive retention threshold in hours")

class WorkspaceCleanupResponse(BaseModel):
    status: str
    cleaned_count: int
    retention_hours: int

