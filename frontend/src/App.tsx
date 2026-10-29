import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  UploadCloud,
  Sliders,
  AlertCircle,
  Loader2,
  CircleDot,
} from 'lucide-react';
import { VideoLassoCanvas } from './components/VideoLassoCanvas';
import { MaskOverlay } from './components/MaskOverlay';
import { TimelineControls } from './components/TimelineControls';
import { LiveProgressTracker } from './components/LiveProgressTracker';
import { MaskPreviewPlayer } from './components/MaskPreviewPlayer';
import {
  StrokeInput,
  StrokeMode,
  VideoMetadata,
  PreviewMaskResponse,
  JobProgressEvent,
  MaskJobRequest,
  MaskJobResponse,
} from './types/api';
import {
  StrokeHistoryMap,
  recordStrokeAction,
  performUndo,
  performRedo,
  canUndo,
  canRedo,
} from './utils/strokeHistory';

export const App: React.FC = () => {
  // Video & File state
  const [_videoFile, setVideoFile] = useState<File | null>(null);
  const [videoSrc, setVideoSrc] = useState<string | null>(null);
  const [metadata, setMetadata] = useState<VideoMetadata | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  // Playback & Frame state
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const videoContainerRef = useRef<HTMLDivElement | null>(null);
  const [containerSize, setContainerSize] = useState<{ width: number; height: number }>({
    width: 0,
    height: 0,
  });
  const [currentFrame, setCurrentFrame] = useState<number>(0);
  const [isPlaying, setIsPlaying] = useState<boolean>(false);

  // Annotation & Mask state (supports multi-keyframe refinement)
  const [keyframeStrokes, setKeyframeStrokes] = useState<Record<number, StrokeInput[]>>({});
  const [strokeHistory, setStrokeHistory] = useState<StrokeHistoryMap>({});
  const [currentKeyframePreviews, setCurrentKeyframePreviews] = useState<Record<number, string>>({});
  const [strokeMode, setStrokeMode] = useState<StrokeMode>('include');
  const [dilationPx, setDilationPx] = useState<number>(7);
  const [maskBase64, setMaskBase64] = useState<string | null>(null);
  const [isPreviewLoading, setIsPreviewLoading] = useState<boolean>(false);

  // Current frame's strokes
  const currentStrokes = keyframeStrokes[currentFrame] || [];

  // When seeking to a different frame, update the visible mask preview
  useEffect(() => {
    if (currentKeyframePreviews[currentFrame]) {
      setMaskBase64(currentKeyframePreviews[currentFrame]);
    } else if (!keyframeStrokes[currentFrame] || keyframeStrokes[currentFrame].length === 0) {
      setMaskBase64(null);
    }
  }, [currentFrame, currentKeyframePreviews, keyframeStrokes]);

  // Processing & SSE state
  const [isProcessing, setIsProcessing] = useState<boolean>(false);
  const [accumulateMode, setAccumulateMode] = useState<boolean>(false);
  const [jobProgress, setJobProgress] = useState<JobProgressEvent | null>(null);
  const [outputUrl, setOutputUrl] = useState<string | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState<number>(0);
  const [currentRunId, setCurrentRunId] = useState<string | null>(null);
  const [latestRunId, setLatestRunId] = useState<string | null>(null);
  const [isCancelling, setIsCancelling] = useState<boolean>(false);
  const timerRef = useRef<number | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const pollIntervalRef = useRef<number | null>(null);

  // Clean up timers and SSE connections on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
      }
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
      }
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
      }
    };
  }, []);

  // Live timer during job execution
  useEffect(() => {
    if (isProcessing) {
      setElapsedSeconds(0);
      const start = Date.now();
      timerRef.current = window.setInterval(() => {
        setElapsedSeconds(Math.floor((Date.now() - start) / 1000));
      }, 1000);
    } else {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    }
    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
      }
    };
  }, [isProcessing]);

  // Measure container dimensions for letterbox math
  useEffect(() => {
    const container = videoContainerRef.current;
    if (!container) return;

    const updateSize = () => {
      const rect = container.getBoundingClientRect();
      setContainerSize({ width: rect.width, height: rect.height });
    };

    const resizeObserver = new ResizeObserver(updateSize);
    resizeObserver.observe(container);
    updateSize();

    return () => resizeObserver.disconnect();
  }, [videoSrc]);

  // Handle Video file upload
  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setVideoFile(file);
    const localUrl = URL.createObjectURL(file);
    setVideoSrc(localUrl);
    setUploadError(null);
    setIsUploading(true);

    try {
      const formData = new FormData();
      formData.append('file', file);

      const res = await fetch('/api/v1/videos/upload', {
        method: 'POST',
        body: formData,
      });

      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(errJson.detail || 'Upload failed');
      }

      const data: VideoMetadata = await res.json();
      setMetadata(data);
    } catch (err: unknown) {
      console.error(err);
      const msg = err instanceof Error ? err.message : 'Failed to upload video to backend';
      setUploadError(msg);
      if (videoRef.current) {
        const v = videoRef.current;
        v.onloadedmetadata = () => {
          setMetadata({
            job_id: `local-${Date.now()}`,
            fps: 30,
            frame_count: Math.round(v.duration * 30),
            width: v.videoWidth,
            height: v.videoHeight,
            duration: v.duration,
          });
        };
      }
    } finally {
      setIsUploading(false);
    }
  };

  // Video time update -> frame index synchronization
  const handleTimeUpdate = () => {
    const v = videoRef.current;
    if (!v) return;
    const fps = metadata?.fps || 30;
    const frame = Math.min(
      Math.floor(v.currentTime * fps),
      (metadata?.frame_count || 1) - 1
    );
    setCurrentFrame(frame);
  };

  const handleTogglePlay = () => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) {
      v.play();
      setIsPlaying(true);
    } else {
      v.pause();
      setIsPlaying(false);
    }
  };

  const handleSeekFrame = (targetFrame: number) => {
    const v = videoRef.current;
    if (!v) return;
    const fps = metadata?.fps || 30;
    v.currentTime = Math.max(0, targetFrame / fps);
    setCurrentFrame(targetFrame);
  };

  const handleStepFrame = (delta: number) => {
    const total = metadata?.frame_count || 1;
    const next = Math.max(0, Math.min(total - 1, currentFrame + delta));
    handleSeekFrame(next);
  };

  // Request single-frame preview mask from backend
  const requestMaskPreview = useCallback(
    async (frameStrokes: StrokeInput[]) => {
      if (frameStrokes.length === 0) {
        setMaskBase64(null);
        setCurrentKeyframePreviews((prev) => {
          const next = { ...prev };
          delete next[currentFrame];
          return next;
        });
        return;
      }
      if (!metadata) return;

      setIsPreviewLoading(true);
      try {
        const payload = {
          job_id: metadata.job_id,
          frame_idx: currentFrame,
          strokes: frameStrokes,
          dilation_px: dilationPx,
        };

        const res = await fetch('/api/v1/masks/preview', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });

        if (!res.ok) {
          throw new Error('Preview request failed');
        }

        const data: PreviewMaskResponse = await res.json();
        setMaskBase64(data.mask_base64_png);
        setCurrentKeyframePreviews((prev) => ({
          ...prev,
          [currentFrame]: data.mask_base64_png,
        }));
      } catch (err) {
        console.warn('Backend mask preview unavailable or failed:', err);
      } finally {
        setIsPreviewLoading(false);
      }
    },
    [metadata, currentFrame, dilationPx]
  );

  const handleStrokesChange = (updatedStrokes: StrokeInput[]) => {
    setKeyframeStrokes((prev) => {
      if (updatedStrokes.length === 0) {
        const next = { ...prev };
        delete next[currentFrame];
        return next;
      }
      return {
        ...prev,
        [currentFrame]: updatedStrokes,
      };
    });
  };

  const handleStrokeCompleted = (updatedStrokes: StrokeInput[]) => {
    // Record stroke action in history: push previous strokes to past, invalidate redo
    const prevStrokes = keyframeStrokes[currentFrame] || [];
    setStrokeHistory((prevHistory) =>
      recordStrokeAction(prevHistory, currentFrame, prevStrokes)
    );
    handleStrokesChange(updatedStrokes);
    requestMaskPreview(updatedStrokes);
  };

  const handleUndo = useCallback(() => {
    const curStrokes = keyframeStrokes[currentFrame] || [];
    const result = performUndo(strokeHistory, currentFrame, curStrokes);
    if (!result) return;

    setStrokeHistory(result.newHistoryMap);
    handleStrokesChange(result.restoredStrokes);
    requestMaskPreview(result.restoredStrokes);
  }, [keyframeStrokes, currentFrame, strokeHistory, requestMaskPreview]);

  const handleRedo = useCallback(() => {
    const curStrokes = keyframeStrokes[currentFrame] || [];
    const result = performRedo(strokeHistory, currentFrame, curStrokes);
    if (!result) return;

    setStrokeHistory(result.newHistoryMap);
    handleStrokesChange(result.restoredStrokes);
    requestMaskPreview(result.restoredStrokes);
  }, [keyframeStrokes, currentFrame, strokeHistory, requestMaskPreview]);

  const handleClearStrokes = useCallback(() => {
    const curStrokes = keyframeStrokes[currentFrame] || [];
    if (curStrokes.length === 0) return;

    setStrokeHistory((prevHistory) =>
      recordStrokeAction(prevHistory, currentFrame, curStrokes)
    );
    handleStrokesChange([]);
    requestMaskPreview([]);
  }, [keyframeStrokes, currentFrame, requestMaskPreview]);

  // Keyboard shortcuts for Undo and Redo
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Do not capture shortcuts while focus is in text-entry controls
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable)
      ) {
        return;
      }

      // Check if editor is active (video loaded and not currently processing or showing output)
      if (!videoSrc || outputUrl || isProcessing) {
        return;
      }

      const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
      const isUndo =
        (isMac ? e.metaKey : e.ctrlKey) &&
        !e.shiftKey &&
        (e.key === 'z' || e.key === 'Z');
      const isRedo =
        ((isMac ? e.metaKey : e.ctrlKey) &&
          e.shiftKey &&
          (e.key === 'z' || e.key === 'Z')) ||
        (!isMac && e.ctrlKey && (e.key === 'y' || e.key === 'Y'));

      if (isUndo) {
        e.preventDefault();
        handleUndo();
      } else if (isRedo) {
        e.preventDefault();
        handleRedo();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [videoSrc, outputUrl, isProcessing, handleUndo, handleRedo]);
  const handleCancelJob = async () => {
    if (!metadata || !currentRunId) return;
    setIsCancelling(true);
    try {
      await fetch(`/api/v1/jobs/${metadata.job_id}/cancel?run_id=${currentRunId}`, {
        method: 'POST',
      });
    } catch (err) {
      console.error('Failed to cancel job:', err);
    }
  };

  const handleStartMaskJob = async () => {
    // Gather all keyframes that have strokes
    const keyframesList = Object.entries(keyframeStrokes)
      .filter(([_, s]) => s && s.length > 0)
      .map(([fIdxStr, s]) => ({
        frame_idx: parseInt(fIdxStr, 10),
        strokes: s,
      }));

    if (!metadata || keyframesList.length === 0) return;

    setIsProcessing(true);
    setIsCancelling(false);
    setJobProgress({
      stage: 'queued',
      progress: 0,
      message: 'Submitting job to pipeline...',
    });

    try {
      const payload: MaskJobRequest = {
        job_id: metadata.job_id,
        keyframes: keyframesList,
        dilation_px: dilationPx,
        accumulate_with_existing: accumulateMode,
      };

      const res = await fetch('/api/v1/jobs/mask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(errJson.detail || 'Failed to initiate mask generation job');
      }

      const resData: MaskJobResponse = await res.json();
      const runId = resData.run_id;
      setCurrentRunId(runId);

      // Clean up any existing listeners
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
      }
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
      }

      // Connect to SSE stream scoped to run_id
      const eventSource = new EventSource(`/api/v1/jobs/${metadata.job_id}/events?run_id=${runId}`);
      eventSourceRef.current = eventSource;

      const handleEventData = (rawData: string) => {
        try {
          const data: JobProgressEvent = JSON.parse(rawData);
          if (data && data.stage) {
            // Ignore events belonging to other runs
            if (data.run_id && data.run_id !== runId) {
              return;
            }
            setJobProgress(data);
            if (data.stage === 'completed') {
              if (eventSourceRef.current) {
                eventSourceRef.current.close();
                eventSourceRef.current = null;
              }
              if (pollIntervalRef.current) {
                clearInterval(pollIntervalRef.current);
                pollIntervalRef.current = null;
              }
              setIsProcessing(false);
              setIsCancelling(false);
              if (data.output_url) {
                setOutputUrl(data.output_url);
              }
              setLatestRunId(runId);
              setCurrentRunId(null);
            } else if (data.stage === 'failed' || data.stage === 'cancelled') {
              if (eventSourceRef.current) {
                eventSourceRef.current.close();
                eventSourceRef.current = null;
              }
              if (pollIntervalRef.current) {
                clearInterval(pollIntervalRef.current);
                pollIntervalRef.current = null;
              }
              setIsProcessing(false);
              setIsCancelling(false);
              setCurrentRunId(null);
            }
          }
        } catch (e) {
          console.error('SSE parse error:', e);
        }
      };

      eventSource.addEventListener('progress', (e: MessageEvent) => {
        handleEventData(e.data);
      });

      eventSource.onmessage = (event) => {
        handleEventData(event.data);
      };

      // Poll fallback with run_id parameter to ensure real-time UI synchronization
      const pollInterval = window.setInterval(async () => {
        try {
          const pollRes = await fetch(`/api/v1/jobs/${metadata.job_id}/status?run_id=${runId}`);
          if (pollRes.ok) {
            const statusData: JobProgressEvent = await pollRes.json();
            if (statusData && statusData.stage) {
              if (statusData.run_id && statusData.run_id !== runId) {
                return;
              }
              setJobProgress(statusData);
              if (statusData.stage === 'completed') {
                if (pollIntervalRef.current) {
                  clearInterval(pollIntervalRef.current);
                  pollIntervalRef.current = null;
                }
                if (eventSourceRef.current) {
                  eventSourceRef.current.close();
                  eventSourceRef.current = null;
                }
                setIsProcessing(false);
                setIsCancelling(false);
                if (statusData.output_url) {
                  setOutputUrl(statusData.output_url);
                }
                setLatestRunId(runId);
                setCurrentRunId(null);
              } else if (statusData.stage === 'failed' || statusData.stage === 'cancelled') {
                if (pollIntervalRef.current) {
                  clearInterval(pollIntervalRef.current);
                  pollIntervalRef.current = null;
                }
                if (eventSourceRef.current) {
                  eventSourceRef.current.close();
                  eventSourceRef.current = null;
                }
                setIsProcessing(false);
                setIsCancelling(false);
                setCurrentRunId(null);
              }
            }
          }
        } catch (err) {
          console.warn('Status poll failed:', err);
        }
      }, 1000);
      pollIntervalRef.current = pollInterval;
    } catch (err: unknown) {
      console.error(err);
      setIsProcessing(false);
      setIsCancelling(false);
      setCurrentRunId(null);
      const msg = err instanceof Error ? err.message : 'Job failed';
      setJobProgress({
        stage: 'failed',
        progress: 0,
        message: msg,
      });
    }
  };

  const handleReset = () => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }
    setVideoFile(null);
    setVideoSrc(null);
    setMetadata(null);
    setKeyframeStrokes({});
    setStrokeHistory({});
    setCurrentKeyframePreviews({});
    setMaskBase64(null);
    setOutputUrl(null);
    setAccumulateMode(false);
    setJobProgress(null);
    setIsProcessing(false);
    setIsCancelling(false);
    setCurrentRunId(null);
    setLatestRunId(null);
  };

  const handleAddAnotherSubject = (frameToSeek: number) => {
    // Keep existing masks on disk, switch to accumulation mode
    setOutputUrl(null);
    setAccumulateMode(true);
    setKeyframeStrokes({});
    setStrokeHistory({});
    setCurrentKeyframePreviews({});
    setMaskBase64(null);
    handleSeekFrame(frameToSeek);
  };

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100 flex flex-col font-sans">
      {/* Monochromatic Minimal Header */}
      <header className="border-b border-neutral-800 bg-neutral-950 sticky top-0 z-30 px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div className="w-6 h-6 rounded bg-neutral-100 flex items-center justify-center text-neutral-950 font-mono font-bold text-xs">
            S
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-sm font-semibold text-neutral-100 tracking-tight">
              stirs
            </span>
            <span className="text-[11px] font-mono text-neutral-500">
              SAM 2 Video Mask Generator
            </span>
          </div>
        </div>

        {metadata && (
          <div className="flex items-center gap-4 text-[11px] font-mono text-neutral-400">
            <div>
              {metadata.width}x{metadata.height}
            </div>
            <div>
              {metadata.frame_count} frames
            </div>
            <div>
              {metadata.fps.toFixed(1)} fps
            </div>
          </div>
        )}
      </header>

      {/* Main Body */}
      <main className="flex-1 max-w-6xl w-full mx-auto p-4 sm:p-6 flex flex-col gap-6">
        {/* Upload State */}
        {!videoSrc && (
          <div className="flex-1 flex flex-col items-center justify-center border border-dashed border-neutral-800 hover:border-neutral-600 rounded-xl p-16 transition bg-neutral-900/40">
            <input
              type="file"
              id="video-upload"
              accept="video/mp4,video/quicktime,video/webm"
              onChange={handleFileSelect}
              className="hidden"
            />
            <label
              htmlFor="video-upload"
              className="flex flex-col items-center gap-3 cursor-pointer text-center group"
            >
              <div className="w-12 h-12 rounded-lg bg-neutral-800 group-hover:bg-neutral-700 flex items-center justify-center text-neutral-300 transition border border-neutral-700">
                <UploadCloud className="w-6 h-6" />
              </div>
              <div className="flex flex-col gap-0.5">
                <span className="text-sm font-medium text-neutral-200 group-hover:text-white transition">
                  Upload video file
                </span>
                <span className="text-xs text-neutral-500 font-mono">
                  MP4, MOV, WEBM
                </span>
              </div>
            </label>

            {isUploading && (
              <div className="mt-4 flex items-center gap-2 text-xs text-neutral-400 font-mono">
                <Loader2 className="w-3.5 h-3.5 animate-spin text-neutral-100" />
                <span>Extracting frames...</span>
              </div>
            )}
            {uploadError && (
              <div className="mt-4 flex items-center gap-2 text-xs text-neutral-300 bg-neutral-900 border border-neutral-700 px-3 py-1.5 rounded">
                <AlertCircle className="w-3.5 h-3.5 text-neutral-100" />
                <span>{uploadError}</span>
              </div>
            )}
          </div>
        )}

        {/* Live Progress Tracker during active pipeline execution */}
        {isProcessing && jobProgress && (
          <LiveProgressTracker
            progress={jobProgress}
            elapsedSeconds={elapsedSeconds}
            totalFrames={metadata?.frame_count}
            annotatedFrameIdx={currentFrame}
            onCancel={handleCancelJob}
            isCancelling={isCancelling}
          />
        )}

        {/* Results View: Interactive Mask Preview Player */}
        {outputUrl && videoSrc && metadata && (
          <MaskPreviewPlayer
            jobId={metadata.job_id}
            revision={latestRunId || undefined}
            videoSrc={videoSrc}
            outputZipUrl={outputUrl}
            totalFrames={metadata.frame_count}
            fps={metadata.fps}
            videoWidth={metadata.width}
            videoHeight={metadata.height}
            onReset={handleReset}
            onAddAnotherSubject={handleAddAnotherSubject}
          />
        )}

        {/* Interactive Editor State */}
        {videoSrc && !outputUrl && (
          <div className="grid grid-cols-1 lg:grid-cols-4 gap-6 items-start">
            {/* Left 3 cols: Video Viewport & Scrubber */}
            <div className="lg:col-span-3 flex flex-col gap-3">
              {/* Video and Overlay Stack */}
              <div
                ref={videoContainerRef}
                className="relative w-full aspect-video bg-neutral-950 rounded-xl overflow-hidden border border-neutral-800 select-none"
              >
                {/* HTML5 Video Element */}
                <video
                  ref={videoRef}
                  src={videoSrc}
                  playsInline
                  onTimeUpdate={handleTimeUpdate}
                  onPlay={() => setIsPlaying(true)}
                  onPause={() => setIsPlaying(false)}
                  onLoadedMetadata={(e) => {
                    const target = e.currentTarget;
                    if (!metadata) {
                      setMetadata({
                        job_id: `local-${Date.now()}`,
                        fps: 30,
                        frame_count: Math.round(target.duration * 30),
                        width: target.videoWidth,
                        height: target.videoHeight,
                        duration: target.duration,
                      });
                    }
                  }}
                  className="absolute inset-0 w-full h-full object-contain pointer-events-none"
                />

                {/* Instant Mask Preview Overlay */}
                {metadata && (
                  <MaskOverlay
                    maskBase64={maskBase64}
                    videoWidth={metadata.width}
                    videoHeight={metadata.height}
                    containerWidth={containerSize.width}
                    containerHeight={containerSize.height}
                  />
                )}

                {/* Interactive Lasso Canvas */}
                {metadata && (
                  <VideoLassoCanvas
                    videoRef={videoRef}
                    videoWidth={metadata.width}
                    videoHeight={metadata.height}
                    currentFrameIdx={currentFrame}
                    strokes={currentStrokes}
                    onStrokesChange={handleStrokesChange}
                    onStrokeCompleted={handleStrokeCompleted}
                    strokeMode={strokeMode}
                    onStrokeModeChange={setStrokeMode}
                    canUndo={canUndo(strokeHistory, currentFrame)}
                    canRedo={canRedo(strokeHistory, currentFrame)}
                    onUndo={handleUndo}
                    onRedo={handleRedo}
                    onClearAll={handleClearStrokes}
                    disabled={isProcessing}
                  />
                )}

                {/* Live Preview Spinner */}
                {isPreviewLoading && (
                  <div className="absolute top-3 right-3 z-20 flex items-center gap-1.5 bg-neutral-950/90 backdrop-blur px-2.5 py-1 rounded text-[11px] font-mono text-neutral-300 border border-neutral-800">
                    <Loader2 className="w-3 h-3 animate-spin text-neutral-100" />
                    <span>Predicting Mask...</span>
                  </div>
                )}
              </div>

              {/* Timeline Scrubber */}
              <TimelineControls
                currentFrame={currentFrame}
                totalFrames={metadata?.frame_count || 100}
                fps={metadata?.fps || 30}
                isPlaying={isPlaying}
                onTogglePlay={handleTogglePlay}
                onSeekFrame={handleSeekFrame}
                onStepFrame={handleStepFrame}
                keyframeIndices={Object.keys(keyframeStrokes).map((k) => parseInt(k, 10))}
                disabled={isProcessing}
              />
            </div>

            {/* Right 1 col: Minimal Settings Sidebar */}
            <div className="flex flex-col gap-4 bg-neutral-900 border border-neutral-800 rounded-xl p-4">
              <div className="flex items-center justify-between border-b border-neutral-800 pb-2.5">
                <span className="text-xs font-semibold text-neutral-200 flex items-center gap-1.5">
                  <Sliders className="w-3.5 h-3.5 text-neutral-400" />
                  Settings
                </span>
                <span className="font-mono text-[11px] text-neutral-400">
                  {currentStrokes.length} stroke{currentStrokes.length !== 1 ? 's' : ''} (Frame {currentFrame})
                </span>
              </div>

              {/* Mode indicator if accumulating masks */}
              {accumulateMode && (
                <div className="flex items-center justify-between bg-emerald-950/40 border border-emerald-800/80 p-2 rounded-lg text-emerald-300 text-xs font-mono">
                  <span>Merging with existing masks</span>
                  <button
                    type="button"
                    onClick={() => setAccumulateMode(false)}
                    className="text-[10px] text-neutral-400 hover:text-white underline ml-2"
                  >
                    Replace instead
                  </button>
                </div>
              )}

              {/* Instructions */}
              <div className="text-[11px] text-neutral-400 bg-neutral-950 p-2.5 rounded-lg border border-neutral-800/80 leading-relaxed font-mono">
                • Draw around any subject or reflection.<br/>
                • Scrub to any frame where elements enter or slip to add keyframe guidance.<br/>
                {accumulateMode && <span className="text-emerald-400 font-semibold">• New masks will merge on top of your previous masks.</span>}
              </div>

              {/* Keyframes badge list */}
              {Object.keys(keyframeStrokes).length > 0 && (
                <div className="flex flex-col gap-1.5 bg-neutral-950/60 p-2 rounded-lg border border-neutral-800">
                  <span className="text-[10px] uppercase font-mono text-neutral-400">
                    Keyframes ({Object.keys(keyframeStrokes).length})
                  </span>
                  <div className="flex flex-wrap gap-1">
                    {Object.keys(keyframeStrokes).map((fStr) => {
                      const f = parseInt(fStr, 10);
                      const isCur = f === currentFrame;
                      return (
                        <button
                          key={f}
                          type="button"
                          onClick={() => handleSeekFrame(f)}
                          className={`px-1.5 py-0.5 rounded text-[10px] font-mono transition ${
                            isCur
                              ? 'bg-neutral-100 text-neutral-950 font-bold'
                              : 'bg-neutral-800 text-neutral-300 hover:bg-neutral-700'
                          }`}
                        >
                          F{f}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Dilation Slider */}
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-neutral-300 text-xs">Mask Dilation</span>
                  <span className="font-mono text-neutral-100 font-semibold text-xs">{dilationPx}px</span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={50}
                  value={dilationPx}
                  onChange={(e) => {
                    const val = parseInt(e.target.value, 10);
                    setDilationPx(val);
                    if (currentStrokes.length > 0) {
                      requestMaskPreview(currentStrokes);
                    }
                  }}
                  disabled={isProcessing}
                  className="w-full h-1.5 bg-neutral-800 rounded-lg appearance-none cursor-pointer accent-neutral-100"
                />
              </div>

              {/* Mask generation action */}
              <button
                type="button"
                onClick={handleStartMaskJob}
                disabled={Object.keys(keyframeStrokes).length === 0 || isProcessing}
                className="w-full mt-2 py-2 px-3 rounded-lg bg-neutral-100 hover:bg-white text-neutral-950 font-semibold text-xs transition active:scale-[0.98] disabled:opacity-30 disabled:cursor-not-allowed flex items-center justify-center gap-1.5"
              >
                {isProcessing ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    <span>Processing...</span>
                  </>
                ) : (
                  <>
                    <CircleDot className="w-3.5 h-3.5" />
                    <span>Generate Masks</span>
                  </>
                )}
              </button>
            </div>
          </div>
        )}
      </main>
    </div>
  );
};

export default App;
