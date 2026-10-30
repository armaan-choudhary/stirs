# stirs - Video Mask Generator: Implementation Specification

## Objective

Build an interactive application that accepts a video, lets a user select an object and secondary elements (cast shadows, water/floor reflections) on one or more keyframes, propagates the selection through the video with SAM 2 (primary SAM 2 Large with automatic fallback to SAM 2 Small), and returns one downloadable ZIP containing a binary PNG mask for each frame. The final artifact is `output_masks.zip`. Object removal, diffusion inpainting, and modified video rendering are outside the application workflow.

## User Flow

1. **Upload & Sample Clips**: The backend streams the video in 1MB chunks to `workspace/{job_id}/raw_video.mp4` with size limit enforcement (returning HTTP 413 if exceeded), extracts numbered frames into `frames/`, and returns metadata (dimensions, frame count, FPS). Alternatively, users can instantly load built-in procedural demo sample videos directly in the browser.
2. **Annotation & Smart Tools**: Use Freehand Lasso (`1`), Bounding Box (`2`), or Point Prompts (`3`) in Include (`I`) or Exclude (`E`) mode. The system assigns distinct object IDs (`obj_id=1`, `obj_id=2`) to the main subject and reflection/shadow strokes so that high-contrast subjects do not suppress subtle reflections over time.
3. **Single-Frame Preview & Peek Mode**: Interactive single-frame mask preview (<150ms) via cached singleton SAM 2 image predictor, outputting a pixelwise union of all include objects and combined enclosing bounding box. Peek toggle (`H`) allows temporarily hiding annotations to inspect the raw video frame.
4. **Keyframe Refinement & Timeline**: Scrub to any frame where tracking drifts or elements enter to add secondary guidance strokes. The full-width timeline features time ruler ticks, zoom control, hover time preview, and clickable diamond keyframe markers with `[` / `]` quick navigation.
5. **Bidirectional Propagation & Staging**: Propagate forward and backward across the video using SAM 2 Large (or Small fallback) with `bfloat16` AMP and CPU state offloading. Each run executes in isolated staging directories (`masks_staging_{run_id}` and `output_masks_staging_{run_id}.zip`).
6. **Publication & Zero-Stall Reactive Tracking**: Upon successful completion, staging masks and ZIP archives are atomically published to `masks/` and `output_masks.zip`. Cancelling or failing a rerun preserves previously published mask archives intact. Frontend reactive polling and EventSource subscription ensure seamless recovery across HMR updates or reconnects.
7. **Mask Inspection Player**: Inspect results with frame-accurate synchronized video playback (`requestVideoFrameCallback`), cache-busting revision tokens (`?v={run_id}`), configurable color tints (Cyan, Red, Lime), opacity slider, split curtain wipe with draggable divider, side-by-side split view, mask-only view, and variable playback speeds (0.25x - 2x).
8. **Post-Processing Accumulation**: Add additional subjects or missed elements non-destructively; newly tracked regions are bitwise-OR merged with previous masks.
9. **Package & Export**: Package numbered 8-bit binary PNG masks into `output_masks.zip` for direct download.

## Output Contract

- Archive: `workspace/{job_id}/output_masks.zip` (versioned via `?v={run_id}`)
- Archive members: zero-based, zero-padded PNG names (`00000.png`, `00001.png`, ...)
- Each mask: 8-bit single-channel binary image at source frame dimensions; background is 0 and target pixels are 255.
- Includes one mask per input frame. Morphological dilation is applied before saving.
- The app must not generate an erased MP4 or invoke the EffectErase diffusion pipeline.

## Backend Contracts

- `POST /api/v1/videos/upload`: streams video, enforces `MAX_UPLOAD_SIZE_BYTES` (returns 413 on breach), cleans up on failure, and returns job ID and video metadata.
- `POST /api/v1/masks/preview`: accepts job ID, frame index, strokes, and dilation; returns a base64 PNG mask overlay (union of objects) and combined bounding box.
- `POST /api/v1/jobs/mask` (and alias `/api/v1/jobs/erase`): queues full-video mask generation; returns `{"job_id": job_id, "run_id": run_id, "status": "queued"}`; rejects duplicate active runs with HTTP 409 Conflict.
- `GET /api/v1/jobs/{job_id}/events`: SSE stream reporting stages (`queued`, `sam2_forward`, `sam2_backward`, `packaging`, `completed`, `failed`, `cancelled`), scoped to optional `?run_id=...`.
- `GET /api/v1/jobs/{job_id}/status`: returns current stage and final archive URL, scoped to optional `?run_id=...`. Synchronous updates in worker ensure zero-latency response.
- `POST /api/v1/jobs/{job_id}/cancel` & `DELETE /api/v1/jobs/{job_id}`: cooperatively cancels an in-flight or queued run.
- `POST /api/v1/workspace/cleanup`: triggers workspace retention cleanup for expired directories older than `max_age_hours`.

## Frontend Requirements

- Full-screen responsive studio UI (`w-screen h-screen overflow-hidden`) with VEED.IO inspired styling.
- Keep the video, annotation canvas, preview overlay, and frame timeline synchronized.
- Support Freehand Lasso, Bounding Box, and Point Prompt selection tools.
- Decoupled `viewMode: 'annotate' | 'inspect'` from output URL, with automatic backend mask detection on load.
- Map pointer positions through the active `object-fit: contain` video rectangle and clamp to valid source pixel coordinates.
- Support keyframe indicators on the timeline scrubber with click-to-seek and hotkeys (`[`, `]`).
- Provide per-keyframe stroke undo and redo with keyboard shortcuts (`Ctrl+Z`, `Cmd+Z`, `Ctrl+Shift+Z`, `Cmd+Shift+Z`, `Ctrl+Y`).
- In-flight cancellation button and completion "View Masks" action during pipeline execution.
- Provide a synchronized mask visualizer player with interactive curtain wipe, overlay, split, and mask-only modes.
- Clear in-memory decoded mask cache upon revision change to defeat HTTP browser caching.
- Allow adding and accumulating new subjects post-generation.

## Hardware & Performance Constraints

- GPU: Uses **SAM 2.1 Hiera Large** (`sam2.1_hiera_large.pt`) as primary model with automatic fallback to **SAM 2.1 Hiera Small** (`sam2.1_hiera_small.pt`) on VRAM pressure (< 1.2 GB free) or CUDA OOM. Native `bfloat16` AMP, `vos_optimized=True`, and frame/state CPU offloading enable smooth execution on 4GB VRAM (e.g. RTX 2050).
- Fallback: Multi-keyframe, multi-object deterministic geometric approximation for local environments without GPU or model weights.
