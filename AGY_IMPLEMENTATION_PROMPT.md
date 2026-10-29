# agy CLI task: implement and repair prioritized stirs improvements

You are working in the `stirs` repository, a FastAPI + SAM 2 video-mask backend and React/TypeScript frontend. Implement the improvements below as a coherent, production-minded change. Use multiple worker subagents for independent work, then integrate and review their changes. Do not stop after producing a plan.

## Repository context

- Backend entry point: `backend/main.py`
- Background propagation and job state: `backend/tasks/worker.py`
- SAM 2 geometry prompt conversion: `backend/core/geometry.py`
- Propagation engine: `backend/core/sam2_engine.py`
- Video upload/frame extraction: `backend/core/video_io.py`
- API models: `backend/schemas.py`
- Frontend app/state: `frontend/src/App.tsx`
- Lasso component: `frontend/src/components/VideoLassoCanvas.tsx`
- Timeline: `frontend/src/components/TimelineControls.tsx`
- Existing tests: `backend/tests/` and `frontend/src/utils/coordinateMap.test.ts`
- `master_agentic_workflow_specification.md` documents the intended product contract. Preserve its output contract: a ZIP containing numbered, binary, single-channel PNG masks, one per frame.

## New high-priority regression: repeated mask merge does not appear in the UI

The user reports this workflow: generate a good mask for a walking man, click **Add / Refine Mask**, draw a mask for his shadow, submit it, and the backend processes the run but the updated result never appears in the frontend. Investigate and fix this end-to-end before treating the other improvements as complete.

Initial code inspection found likely causes that must be confirmed against the current implementation:

- A repeated generation uses the same `job_id`, while `JOB_STATUS` and `JOB_EVENT_QUEUES` are keyed only by `job_id`. Starting a new run may leave a previous `completed` status or terminal SSE event visible. The frontend may stop polling/close SSE and return to the results view before the new run finishes.
- Mask PNGs are served from the same `/workspace/{job_id}/masks/{frame}.png` URLs after each run. Browser HTTP caching can show previous PNG contents even after the backend overwrites those files.
- In the no-checkpoint/CPU fallback path, `propagate_full_video` may ignore `keyframe_prompts` and use empty legacy `box`/`points`/`labels` arguments, yielding empty new masks that are then ORed with the old masks.

Do not assume all three causes apply. Trace the current code, reproduce or write deterministic regression tests for the failure modes, and report the confirmed root causes.

## Delegate work

Use at least three worker subagents, with separate ownership to minimize file conflicts:

1. **Preview parity worker (backend):** Align single-frame preview prompts with propagation's multi-object prompt handling. Inspect `convert_strokes_to_sam2_multi_obj_prompts`, the SAM 2 image-preview API, and multi-object propagation. A preview should represent the union of the separately prompted include objects; apply exclude guidance consistently to each applicable object. Keep the existing preview response contract and bbox behavior sensible for multiple objects. Do not silently regress the one-include-stroke case.
2. **Undo/redo worker (frontend):** Add per-keyframe stroke undo and redo, with visible controls and Ctrl/Cmd+Z and redo shortcut support when the canvas/editor is active. Preserve history across keyframe switching, clear history appropriately when a video/job is replaced, avoid intercepting shortcuts while typing in inputs, and keep the current stroke mode and preview behavior intact. Design history so a new stroke after undo invalidates the redo branch.
3. **Upload hardening worker (backend):** Replace whole-file `await file.read()` buffering with chunked streaming to the job's raw-video file. Add a configurable maximum upload size and enforce it while streaming; return a clear 413 response when exceeded. Ensure partial files and newly-created job directories are removed on upload/probe/extraction failure. Keep the successful response contract unchanged.
4. **Job lifecycle worker (backend):** Implement cooperative cancellation for running propagation and workspace retention/cleanup. Add an explicit job cancellation endpoint and connect it to the frontend reset/cancel flow if one exists. Cancellation must be checked between propagation steps/frames where feasible, surfaced as a distinct terminal status, and must not be reported as successful completion or package a misleading partial ZIP. Add a safe retention cleanup mechanism for old workspace jobs (default 24 hours, configurable), avoiding active jobs and preventing deletion outside `WORKSPACE_DIR`.
5. **Merge rerun worker (backend + frontend integration):** Own the repeated-generation state bug. Coordinate with the primary agent on a per-run identifier and event/status API before editing. Prevent prior run status/SSE events from completing a new run, make mask image URLs change for each completed run (cache-busting revision or equivalent), and fix fallback propagation to consume current keyframe prompts. Add regression coverage for sequential runs on one uploaded job.

If the CLI has a hard limit on worker count, combine workers 3 and 4 only if necessary, or combine workers 1 and 5 if needed. Workers must communicate expected shared interfaces early. The primary agent owns integration, conflict resolution, cross-component review, and final verification.

## Implementation requirements

### 1. Preview and propagation parity

- Current `preview_mask` uses `convert_strokes_to_sam2_prompts`, while `worker.py` uses `convert_strokes_to_sam2_multi_obj_prompts`.
- Inspect `SAM2MaskGenerator.preview_single_frame` before choosing an implementation. If it accepts only one prompt set, run each object's preview independently and combine masks with a pixelwise union. Reuse the cached generator and avoid unnecessary model reinitialization.
- Maintain consistent coordinate scaling, dilation, exclusions, and RGBA output behavior.
- Return a combined bbox enclosing all include objects, or `None` if no include geometry exists.
- Add focused tests for one include stroke, multiple include strokes, and exclude guidance. Prefer testing prompt/mask combination with a controllable fake generator over requiring model weights.

### 2. Stroke undo/redo

- History is scoped per frame/keyframe so switching frames does not discard edits.
- Undo removes the last committed stroke; redo restores the next stroke. Clearing annotations should be undoable if it fits cleanly into the history model.
- Add accessible buttons with disabled states and shortcut tooltips. Use Ctrl+Z / Cmd+Z for undo and Ctrl+Shift+Z or Cmd+Shift+Z (and optionally Ctrl+Y) for redo.
- Do not capture shortcuts while focus is in text-entry controls or editable content.
- Keep annotation history bounded if necessary to avoid unbounded memory growth; choose a documented reasonable cap.
- Add suitable frontend tests if the existing test setup supports them without introducing a heavyweight dependency.

### 3. Streaming upload and size limits

- Add a configurable limit (for example `MAX_UPLOAD_SIZE_BYTES`) in backend config, with a documented default appropriate for this local application.
- Read `UploadFile` in bounded chunks and count bytes while writing; do not trust `Content-Length` alone.
- On limit breach, close and remove the partial upload and remove the newly-created job directory; return HTTP 413 with a useful detail.
- Keep exceptions and cleanup robust for disconnects, disk errors, invalid videos, and ffmpeg failures. Always close the uploaded file.
- Add tests covering a successful upload, an upload over the configured limit, and cleanup on failure. Tests should override limits without depending on a large fixture.

### 4. Cooperative cancellation and retention

- Track each job's cancellation signal and lifecycle state. Reject or define behavior for duplicate starts and cancellation of unknown/already-terminal jobs.
- Inspect how `propagate_full_video` iterates. Add an optional cancellation callback/event in a backward-compatible way and check it at safe intervals. Do not claim instantaneous cancellation if the underlying SAM 2 call is not interruptible mid-call.
- Ensure cancellation cleans up temporary/incomplete outputs and reports a distinct `cancelled` stage/status through status polling and SSE. Update frontend progress types and controls as needed.
- Add `DELETE /api/v1/jobs/{job_id}` (or a clearly named cancel route) for cancellation. Preserve existing endpoints.
- Implement cleanup with a configurable retention age (default 24 hours). Never delete a currently running job. Resolve paths and verify they remain under the configured workspace root before deletion. Avoid racing active uploads/jobs; if startup/background scheduling is used, keep it simple and testable.
- Add focused tests for cancellation state transitions, retention age handling, active-job protection, and path containment.

### 5. Repeated mask generation, accumulation, and frontend refresh

- Model a **generation run** separately from the uploaded `job_id`. Give each mask generation a unique `run_id` (or equivalent monotonic generation token), and associate its queued/running/terminal status and SSE events with that run. Preserve existing upload/job identity and endpoint compatibility where practical.
- When a new run starts, initialize its own status to `queued` before returning from the start endpoint. A stale `completed` status from a previous run must never be interpreted as completion of the current run.
- Do not let a new SSE subscription drain terminal events left by a previous run. Use run-scoped queues/events or another design that handles reconnects and concurrent/duplicate starts safely. Reject a second active run for the same uploaded job unless concurrency is deliberately supported.
- In the frontend, only leave processing state and show the results player when the currently submitted `run_id` reports `completed`. Treat `failed` and `cancelled` as terminal states too; clean up the corresponding SSE connection and polling interval.
- Force refreshed mask resources after each successful run. Version each `/masks/{frame}.png` image URL using the `run_id` or a revision token, and ensure the player’s in-memory image cache is scoped to that same revision (a React `key` alone does not defeat the browser HTTP cache).
- Confirm that `accumulate_with_existing=true` performs a pixelwise OR of the prior per-frame masks and new masks, while replace mode has explicitly defined behavior. Keep the existing additive merge semantics unless the product contract is intentionally changed. Document that exclude strokes affect the newly generated mask and do not subtract pixels from an existing mask; if subtraction is desired, propose it as a separate explicit operation.
- Fix the no-model fallback so it derives prompts from `keyframe_prompts` rather than silently using `None` legacy prompt arguments. Produce a deterministic union of include-object masks and honor excludes to the extent supported by the fallback. Clearly label this as an approximation, not SAM 2 tracking.
- Make publication safe: do not expose a new run as completed until the merged masks and ZIP are ready. Prefer writing a staging mask set/ZIP and replacing the published result only after successful completion, so failure or cancellation preserves the last good result.
- Add tests for: prior-run `completed` status followed by a slower second run; stale queued SSE terminal events; unique mask URLs/revision refresh; accumulation of a disjoint new region with an existing region; replace mode; fallback processing of keyframe prompts; and failure/cancellation preserving the last successful output.

## Integration and quality bar

- Read applicable repository instructions (`AGENTS.md`, if present) before editing. Keep changes within the established architecture and avoid unrelated refactors.
- Coordinate worker API/schema assumptions before parallel edits. Do not let two workers independently edit the same file without an agreed integration owner.
- Preserve backward compatibility for existing mask and upload endpoints except for the intentional 413 size-limit response and new cancellation behavior.
- Treat the same uploaded video receiving multiple mask-generation runs as a primary supported workflow. Preserve the previous successful masks until the next run has completed and been published.
- Update documentation/configuration for the new upload and retention settings and cancellation endpoint.
- Run the existing backend and frontend test suites and add targeted tests for the new behavior. Report commands and results accurately; do not claim success for tests not run.
- Review the final diff for races, cleanup leaks, stale React state/closures, keyboard accessibility, and SAM 2 CPU/GPU behavior.
- Do not add MP4/WebM export, brush-size controls, or LRU mask-preview caching in this task; they are outside this prioritized scope.

## Completion report

When done, summarize:

1. What changed and the key design decisions.
2. Which worker handled each area and any integration adjustments.
3. Tests and validation run, with pass/fail results.
4. Any known limitation, especially the granularity of SAM 2 cancellation.
5. Confirmed cause of the repeated-merge UI failure and how the regression test proves it is fixed.
6. Files changed.
