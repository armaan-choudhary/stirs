# stirs - Video Mask Generator: Implementation Specification

## Objective

Build an interactive application that accepts a video, lets a user select an object and secondary elements (cast shadows, water/floor reflections) on one or more keyframes, propagates the selection through the video with SAM 2, and returns one downloadable ZIP containing a binary PNG mask for each frame. The final artifact is `output_masks.zip`. Object removal, diffusion inpainting, and modified video rendering are outside the application workflow.

## User Flow

1. **Upload**: The backend stores the video in `workspace/{job_id}/raw_video.mp4`, extracts numbered frames into `frames/`, and returns metadata (dimensions, frame count, FPS).
2. **Annotation & Multi-Object Tracking**: Draw include or exclude lasso strokes over any frame. The system assigns distinct object IDs (`obj_id=1`, `obj_id=2`) to the main subject and reflection/shadow strokes so that high-contrast subjects do not suppress subtle reflections over time.
3. **Single-Frame Preview**: Interactive single-frame mask preview (<150ms) via cached singleton SAM 2 image predictor.
4. **Keyframe Refinement**: Scrub to any frame where tracking drifts or elements enter to add secondary guidance strokes.
5. **Bidirectional Propagation**: Propagate forward and backward across the video using SAM 2 with `bfloat16` AMP and CPU state offloading. All object masks are unioned frame-by-frame.
6. **Mask Preview Player**: Inspect results with frame-accurate synchronized video playback (`requestVideoFrameCallback`), configurable color tints (Cyan, Red, Lime), opacity slider, split view, and mask-only view.
7. **Post-Processing Accumulation**: Add additional subjects or missed elements non-destructively; newly tracked regions are bitwise-OR merged with previous masks.
8. **Package & Export**: Package numbered 8-bit binary PNG masks into `output_masks.zip` for direct download.

## Output Contract

- Archive: `workspace/{job_id}/output_masks.zip`
- Archive members: zero-based, zero-padded PNG names (`00000.png`, `00001.png`, ...)
- Each mask: 8-bit single-channel binary image at source frame dimensions; background is 0 and target pixels are 255.
- Includes one mask per input frame. Morphological dilation is applied before saving.
- The app must not generate an erased MP4 or invoke the EffectErase diffusion pipeline.

## Backend Contracts

- `POST /api/v1/videos/upload`: accepts a video and returns job ID and video metadata.
- `POST /api/v1/masks/preview`: accepts job ID, frame index, strokes, and dilation; returns a base64 PNG mask overlay.
- `POST /api/v1/jobs/mask` (and alias `/api/v1/jobs/erase`): queues full-video mask generation; accepts `keyframes`, `strokes`, `dilation_px`, and `accumulate_with_existing`.
- `GET /api/v1/jobs/{job_id}/events`: SSE stream reporting stages `sam2_forward`, `sam2_backward`, `packaging`, `completed`, or `failed`.
- `GET /api/v1/jobs/{job_id}/status`: returns current stage and final archive URL.

## Frontend Requirements

- Keep the video, lasso canvas, preview overlay, and frame timeline synchronized.
- Map pointer positions through the active `object-fit: contain` video rectangle and clamp to valid source pixel coordinates.
- Support keyframe indicators on the timeline scrubber.
- Provide a synchronized mask visualizer player with overlay, split, and mask-only modes.
- Allow adding and accumulating new subjects post-generation.

## Hardware & Performance Constraints

- GPU: Optimized for 4GB VRAM (e.g. RTX 2050) using `sam2.1_hiera_small` (or `sam2.1_hiera_large`), native `bfloat16` AMP, `vos_optimized=True`, and frame/state CPU offloading.
- Fallback: Synthetic mask generation for local environments without GPU or model weights.
