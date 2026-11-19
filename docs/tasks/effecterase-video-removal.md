# AGY implementation plan: EffectErase video removal pipeline

## AGY CLI instructions

Implement this task in the `stirs` repository. Use **swarm mode** and delegate the independent workstreams below. Do not stop after planning: implement, integrate, review, and validate the complete feature. Read this plan, `AGY_IMPLEMENTATION_PROMPT.md`, `master_agentic_workflow_specification.md`, and applicable `AGENTS.md` instructions first.

The project currently generates SAM 2 masks and exports `output_masks.zip`. Add the next pipeline stage: run EffectErase with the uploaded source video and the selected-object masks, then make the cleaned video available in the app. Preserve mask generation and its ZIP download as a supported workflow. Keep the integration testable without downloading model weights or requiring a GPU.

### Swarm ownership

Use separate file ownership and agree on the API/data contracts before parallel edits. The primary agent owns shared interfaces, final integration, and review.

1. **EffectErase runtime/research agent — isolated runtime and adapter.** Inspect and pin the official [FudanCVL/EffectErase implementation](https://github.com/FudanCVL/EffectErase), including its actual removal script, input format, output format, model loading, frame limits, and audio behavior. Implement a thin adapter in `backend/core/` that invokes or communicates with the official inference runtime, prepares the required inputs, validates output, reports progress where feasible, and cleans temporary artifacts. Keep inference dependencies isolated from the FastAPI/SAM 2 environment (separate environment or service/process); do not add Wan/DiffSynth dependencies to the normal backend requirements.
2. **Backend pipeline agent — API, lifecycle, persistence.** Add a distinct video-removal run lifecycle and API, using existing workspace/job infrastructure and run-scoped status/SSE patterns where practical. Coordinate the adapter signature with agent 1 before editing. Do not repurpose the existing `POST /api/v1/jobs/erase` mask-generation compatibility alias. Persist outputs via staging and publish only on success.
3. **Frontend agent — user flow and result player.** Add an explicit “Remove object” action after masks are ready, show removal progress/cancel/error states, and present/download the cleaned video on completion. Keep existing mask inspection and ZIP export usable. Coordinate endpoint and status schemas with agent 2 before editing.
4. **Integration/QA agent — contracts and focused coverage.** Add mocked adapter/API lifecycle tests, frontend tests if the current setup supports them, and review mask/video alignment and failure behavior. Avoid tests that require downloaded weights or CUDA. Report any hardware-dependent smoke test as optional and distinct from automated validation.

Agents must not independently edit the same files. The primary agent resolves overlaps and integrates shared schemas before final validation.

## Current project context

- `backend/main.py`: FastAPI upload, mask preview, mask-run endpoints, status and SSE.
- `backend/tasks/worker.py`: run-scoped SAM 2 mask generation, cancellation, staging, atomic publication, and ZIP packaging.
- `backend/core/video_io.py`: ffprobe/OpenCV probing and ffmpeg frame extraction.
- `backend/config.py`: workspace, device, SAM 2 and retention configuration.
- `backend/schemas.py`: API request and response types.
- `frontend/src/App.tsx`: upload, annotation, mask-run state and view flow.
- `frontend/src/components/MaskPreviewPlayer.tsx` and `LiveProgressTracker.tsx`: mask inspection and progress UI.
- Existing mask output contract: numbered, 8-bit, single-channel binary PNGs, one per source frame, in `output_masks.zip`.

The mask pipeline already provides a stable handoff point: a completed mask run publishes masks under `workspace/{job_id}/masks/` and the corresponding ZIP at `workspace/{job_id}/output_masks.zip`. Reuse those masks; do not rerun SAM 2 as part of video removal.

## Research and upstream constraints

EffectErase is the CVPR 2026 method by Fu et al., built on Wan2.1. It jointly learns video removal and insertion, with task-aware region guidance and an effect-consistency objective intended to remove object-induced effects (such as shadows, reflections, lighting changes, and deformation) alongside the object. At inference its removal task consumes a source video and an aligned mask video and produces a removed video. The official repository documents the base Wan2.1-Fun-1.3B-InP weights, an EffectErase checkpoint, and a SAM2.1-generated aligned mask video as inputs. See the [paper](https://arxiv.org/abs/2603.19224), [project/method page](https://henghuiding.com/EffectErase/), and [official repository setup](https://github.com/FudanCVL/EffectErase).

Before implementation, inspect the upstream scripts and code at a pinned commit. Treat upstream CLI details as versioned integration facts, not assumptions. The upstream model weights are large (the base model alone is about 19 GB in a verified setup), require substantial GPU memory and inference time, and must be installed/downloaded separately from this repository. The upstream repository states **CC BY-NC 4.0**: surface the noncommercial restriction in developer/setup documentation and do not imply commercial-use permission.

## Required product flow

1. User uploads a real video and generates/refines masks as today.
2. The UI offers **Remove object** only when there is a completed mask set for that uploaded video. Confirm that generated masks correspond to the current video and a successful mask run.
3. Backend creates a unique `erase_run_id` distinct from the upload `job_id` and any SAM 2 `run_id`.
4. An integration adapter validates the selected source video and mask set, then converts the PNG sequence to the mask-video format expected by the pinned upstream EffectErase revision.
5. The adapter invokes the official removal inference runtime with the original uploaded video and aligned mask video. It must not pass the downscaled JPEG preview frames as the source unless upstream explicitly requires and documents that behavior.
6. The adapter validates the generated video, writes it to run-specific staging, and publishes it atomically only after success. Failure/cancellation preserves any prior successful removal output.
7. The UI shows the erase run's progress and, when complete, plays and downloads the cleaned video. Existing mask preview, mask refinement, and ZIP download remain available.

## Architecture and boundaries

### Inference adapter

Create an EffectErase adapter behind a small Python interface (exact name/signature chosen during implementation), responsible for:

- Checking runtime availability and configured paths before starting; return actionable errors when EffectErase, weights, ffmpeg, or the requested device are unavailable.
- Reading source metadata from the original upload and mask metadata from the successful mask output.
- Validating frame count, dimensions, order, and timing. Explicitly account for `MAX_VIDEO_DIMENSION` downscaled SAM 2 frames: upscale each mask to the original video dimensions with nearest-neighbor interpolation before encoding. Preserve binary 0/255 values and use a lossless mask-video encoding or the exact upstream-supported format.
- Matching the upstream script's expected mask polarity (white means remove only after verifying upstream implementation), color format, codec/container, FPS, and temporal window behavior. Reject mismatches rather than silently feeding misaligned data.
- Invoking upstream through a subprocess or isolated service boundary with argument arrays (no shell interpolation), bounded logs, timeout/cancellation handling where feasible, and controlled environment/configuration. Do not vendor or silently modify upstream source as part of the app integration.
- Verifying that the output exists, is readable, contains expected frames, and has valid dimensions/duration before publication.
- Handling audio intentionally: inspect whether upstream preserves audio. If it does not, mux the original audio back into the rendered video with ffmpeg when technically valid; document behavior for unsupported audio/codecs. Never silently discard audio.
- Removing temporary mask videos and per-run temporary files on success, failure, and cancellation, without deleting user uploads or the last published result.

Keep heavyweight EffectErase/Wan/DiffSynth packages out of `backend/requirements.txt`. Configure an explicit runtime command or isolated environment path in documented configuration. Mock the adapter in ordinary backend tests.

### Backend API and run lifecycle

Add separate removal endpoints rather than changing the existing mask endpoint contract. Suggested routes (final names may follow local API conventions):

- `POST /api/v1/jobs/{job_id}/removal`: queue removal; require a completed mask set; return `job_id`, `erase_run_id`, and `status: queued`.
- `GET /api/v1/jobs/{job_id}/removal/{erase_run_id}/status`: get run-scoped lifecycle/status/output metadata.
- `GET /api/v1/jobs/{job_id}/removal/{erase_run_id}/events`: run-scoped SSE.
- `POST /api/v1/jobs/{job_id}/removal/{erase_run_id}/cancel`: request cooperative cancellation.
- A stable download/stream route for the published result, versioned by `erase_run_id` to prevent browser cache staleness.

Use distinct removal state from mask generation state. Reject a second active removal run for the same source unless the implementation explicitly supports it. Status stages should distinguish at least `queued`, `preparing_input`, `loading_model`, `inference`, `validating_output`, `publishing`, `completed`, `failed`, and `cancelled`; progress may be coarse if upstream does not expose step progress. Never report fake fine-grained progress. On disconnect/cancel, terminate the child process where safe and clean staging. A worker restart should not expose a stale `running` state forever; define recoverable run state and stale-run handling.

Stage outputs under a run-specific path, e.g. `workspace/{job_id}/removal_staging_{erase_run_id}/`, and publish to a stable result path only after validation. Keep the previous successful video until the new one is fully ready. Guard all paths under `WORKSPACE_DIR`. Do not package the erased video into the existing `output_masks.zip`.

### Frontend flow

- Add a removal action after mask completion, not at upload time.
- Clearly distinguish mask-generation progress from EffectErase progress and retain the user's ability to inspect/download masks during removal.
- Show missing-runtime/weights/GPU errors as useful setup errors; do not submit an inference job that cannot start if preflight can determine this.
- Add cancel and retry behavior. A failed or cancelled run must not replace a previous successful cleaned video.
- On completion, show a video player plus download link. Version media URLs with `erase_run_id`; reset any in-memory media/player state on result revision changes.
- Preserve the uploaded source and mask outputs. Do not automatically overwrite or download the original.

## Interface contracts to agree before parallel implementation

1. `erase_run_id` is separate from mask `run_id` and upload `job_id`.
2. Removal requests point to the existing uploaded source video and latest successfully published masks; do not accept arbitrary filesystem paths from the browser.
3. Adapter input is explicit and testable: source video path, ordered mask frames/path, output staging path, configuration, progress callback, and cancellation callback/event.
4. Adapter output is the validated staged video path plus probed metadata; adapter does not publish/replace user-facing files.
5. Backend owns authorization/path containment, run state, cancellation, atomic publication, and API responses. Frontend consumes only API paths and status schemas.
6. SSE and polling are scoped to the exact `erase_run_id`; stale events from prior removal runs cannot finish the current run.

## Acceptance criteria

### Mask-to-model integration

- An existing successful SAM 2 output can be consumed without changing or re-running mask propagation.
- Adapter uses the raw uploaded video and makes the per-frame masks match its original dimensions, frame sequence, and timing. Resizing uses nearest neighbor and preserves binary values.
- Empty/missing/incomplete/corrupt mask sets and source/mask metadata mismatches fail clearly before model inference.
- Integration honors the exact pinned upstream mask polarity and required mask-video encoding.
- EffectErase executes out of process or in a separately configured runtime; normal API import/start and existing mask generation do not require Wan/DiffSynth dependencies or weights.

### Lifecycle and persistence

- Removal has distinct run IDs, status, SSE, cancellation, and output URLs; the mask-generation `/jobs/erase` alias remains unchanged.
- Duplicate active requests are handled deterministically.
- A successful run produces a playable/downloadable cleaned video with validated metadata.
- A failed/cancelled rerun preserves the last successful output; incomplete staging is cleaned safely.
- Cancellation is best effort during a non-interruptible inference call and is reported accurately.
- Output URLs/cache revisions change per completed erase run.

### UI and compatibility

- UI action is enabled only with masks from the current video and exposes status, errors, cancel/retry, and completed playback/download.
- Mask inspection, add/refine mask accumulation, and `output_masks.zip` download continue to work.
- Source audio behavior is verified and documented; audio is preserved when possible.
- README and configuration docs explain the separately installed runtime, model-weight paths, hardware expectations, and upstream noncommercial license.

## Validation plan

Automated validation must use a fake executable/adapter and small generated videos; it must not download weights or need CUDA:

- Unit-test ordered PNG loading, binary normalization, nearest-neighbor scaling, mask video dimensions/frame count/FPS, and rejection of missing or mismatched frames.
- Unit-test adapter command construction, timeout/cancellation, bad exit code, missing/corrupt output, metadata validation, and cleanup.
- API-test unavailable runtime, no masks, queue/status/SSE lifecycle, duplicate starts, cancellation, failed rerun preserving prior output, successful publication, and versioned result URL.
- Frontend-test action availability, run-scoped progress/terminal state, failure/cancel states, playback/download URL revision, and continued mask access.
- Run existing backend and frontend checks after integration; report exact commands and results. Do not claim an actual EffectErase visual result unless a separate smoke run with the pinned weights and supported hardware was completed.

## Documentation updates

Update README user flow/API/configuration sections to describe two stages: **Generate masks** and **Remove object**. Clearly say the EffectErase runtime and checkpoints are separately installed and optional for mask-only use. Include official paper/code links and the CC BY-NC 4.0 restriction. Document that EffectErase may remove related effects beyond the annotated object mask, but results remain generative and can fail for ambiguous object/effect attribution.

## Completion report

When implementation is done, report:

1. The adapter/runtime boundary and how mask alignment/encoding is guaranteed.
2. New removal endpoints and lifecycle behavior.
3. Frontend flow and output/audio behavior.
4. Swarm ownership and any integration decisions.
5. Automated validation commands/results and whether a real model smoke test ran.
6. Files changed and known limitations, including hardware, inference runtime, cancellation granularity, and license constraints.
