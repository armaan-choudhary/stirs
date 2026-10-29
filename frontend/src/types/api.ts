export interface Point2D {
  x: floatNumber;
  y: floatNumber;
}

// In TS, numbers are double precision floats
export type floatNumber = number;

export type StrokeMode = 'include' | 'exclude';

export interface StrokeInput {
  points: Point2D[];
  mode: StrokeMode;
}

export interface VideoMetadata {
  job_id: string;
  fps: number;
  frame_count: number;
  width: number;
  height: number;
  duration?: number;
  raw_video_url?: string;
  video_url?: string;
}

export interface PreviewMaskRequest {
  job_id: string;
  frame_idx: number;
  strokes: StrokeInput[];
  dilation_px?: number;
  capture_shadows?: boolean;
  temporal_motion_blur?: boolean;
}

export interface PreviewMaskResponse {
  job_id: string;
  frame_idx: number;
  mask_base64_png: string; // Base64 encoded RGBA PNG
  bbox?: [number, number, number, number] | null;
}

export interface KeyframeAnnotation {
  frame_idx: number;
  strokes: StrokeInput[];
}

export interface MaskJobRequest {
  job_id: string;
  annotated_frame_idx?: number;
  strokes?: StrokeInput[];
  keyframes?: KeyframeAnnotation[];
  dilation_px?: number;
  capture_shadows?: boolean;
  temporal_motion_blur?: boolean;
  accumulate_with_existing?: boolean;
}

// Backward compatibility alias
export type EraseJobRequest = MaskJobRequest;

export interface MaskJobResponse {
  job_id: string;
  run_id: string;
  status: string;
}

export type EraseJobResponse = MaskJobResponse;

export type PipelineStage =
  | 'queued'
  | 'sam2_forward'
  | 'sam2_backward'
  | 'packaging'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface JobProgressEvent {
  stage: PipelineStage;
  progress: number;
  run_id?: string;
  output_url?: string;
  error?: string;
  message?: string;
}

export interface CanvasDimensions {
  width: number;
  height: number;
}

export interface ActiveRenderRect {
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number;
}
