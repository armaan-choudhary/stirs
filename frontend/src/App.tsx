import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  UploadCloud,
  Sliders,
  AlertCircle,
  Loader2,
  CircleDot,
  Plus,
  Minus,
  Undo2,
  Redo2,
  Bookmark,
  Eye,
  EyeOff,
  HelpCircle,
  Video,
  Lasso,
  Square,
  Sparkles,
  Film,
  Trash2,
} from 'lucide-react';
import { VideoLassoCanvas, SelectionTool } from './components/VideoLassoCanvas';
import { MaskOverlay } from './components/MaskOverlay';
import { TimelineControls } from './components/TimelineControls';
import { LiveProgressTracker } from './components/LiveProgressTracker';
import { MaskPreviewPlayer } from './components/MaskPreviewPlayer';
import { ShortcutsModal } from './components/ShortcutsModal';
import {
  SAMPLE_VIDEOS,
  createSampleVideoFile,
  SampleVideoInfo,
} from './utils/sampleVideos';
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
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [videoSrc, setVideoSrc] = useState<string | null>(null);
  const [metadata, setMetadata] = useState<VideoMetadata | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [isDraggingFile, setIsDraggingFile] = useState<boolean>(false);
  const [isLoadingSample, setIsLoadingSample] = useState<string | null>(null);

  // Playback & Frame state
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const videoContainerRef = useRef<HTMLDivElement | null>(null);
  const [containerSize, setContainerSize] = useState<{ width: number; height: number }>({
    width: 0,
    height: 0,
  });
  const [currentFrame, setCurrentFrame] = useState<number>(0);
  const [isPlaying, setIsPlaying] = useState<boolean>(false);

  // Tool & Mode state
  const [activeTool, setActiveTool] = useState<SelectionTool>('lasso');
  const [strokeMode, setStrokeMode] = useState<StrokeMode>('include');
  const [dilationPx, setDilationPx] = useState<number>(7);
  const [isPeekHidden, setIsPeekHidden] = useState<boolean>(false);
  const [isShortcutsOpen, setIsShortcutsOpen] = useState<boolean>(false);
  const [activeNavTab, setActiveNavTab] = useState<'tools' | 'keyframes' | 'samples' | 'settings'>('tools');

  // Annotation & Mask state (supports multi-keyframe refinement)
  const [keyframeStrokes, setKeyframeStrokes] = useState<Record<number, StrokeInput[]>>({});
  const [strokeHistory, setStrokeHistory] = useState<StrokeHistoryMap>({});
  const [currentKeyframePreviews, setCurrentKeyframePreviews] = useState<Record<number, string>>({});
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

  // View mode: 'annotate' (canvas editor) or 'inspect' (split/wipe mask viewer)
  const [viewMode, setViewMode] = useState<'annotate' | 'inspect'>('annotate');

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

  // Check backend for existing mask output when video/metadata is loaded
  useEffect(() => {
    if (!metadata?.job_id) return;
    let isMounted = true;

    const checkExistingJobStatus = async () => {
      try {
        const res = await fetch(`/api/v1/jobs/${metadata.job_id}/status`);
        if (!res.ok) return;
        const data: JobProgressEvent = await res.json();
        if (!isMounted) return;

        if (data.stage === 'completed' && data.output_url) {
          setOutputUrl(data.output_url);
          if (data.run_id) setLatestRunId(data.run_id);
        }
      } catch (err) {
        console.debug('No existing output masks for job:', err);
      }
    };

    checkExistingJobStatus();
    return () => {
      isMounted = false;
    };
  }, [metadata?.job_id]);

  // Robust, reactive job tracking via SSE with synchronized polling fallback
  useEffect(() => {
    if (!isProcessing || !metadata?.job_id) return;

    let isMounted = true;
    const runId = currentRunId;
    const statusUrl = runId
      ? `/api/v1/jobs/${metadata.job_id}/status?run_id=${runId}`
      : `/api/v1/jobs/${metadata.job_id}/status`;
    const eventsUrl = runId
      ? `/api/v1/jobs/${metadata.job_id}/events?run_id=${runId}`
      : `/api/v1/jobs/${metadata.job_id}/events`;

    const handleTerminalState = (data: JobProgressEvent) => {
      setJobProgress(data);
      if (data.stage === 'completed') {
        setIsProcessing(false);
        setIsCancelling(false);
        if (data.output_url) {
          setOutputUrl(data.output_url);
        }
        if (data.run_id) {
          setLatestRunId(data.run_id);
        }
        setCurrentRunId(null);
        setViewMode('inspect');
      } else if (data.stage === 'failed' || data.stage === 'cancelled') {
        setIsProcessing(false);
        setIsCancelling(false);
        setCurrentRunId(null);
      }
    };

    // Immediate poll check on mount / trigger
    const fetchStatus = async () => {
      try {
        const res = await fetch(statusUrl);
        if (!res.ok || !isMounted) return;
        const data: JobProgressEvent = await res.json();
        if (!isMounted) return;

        if (data && data.stage) {
          if (runId && data.run_id && data.run_id !== runId) return;
          if (data.stage === 'completed' || data.stage === 'failed' || data.stage === 'cancelled') {
            handleTerminalState(data);
          } else {
            setJobProgress(data);
          }
        }
      } catch (err) {
        console.warn('Status poll error:', err);
      }
    };

    fetchStatus();
    const pollInterval = window.setInterval(fetchStatus, 750);

    // SSE connection
    let eventSource: EventSource | null = null;
    try {
      eventSource = new EventSource(eventsUrl);
      const onProgress = (event: MessageEvent) => {
        if (!isMounted) return;
        try {
          const data: JobProgressEvent = JSON.parse(event.data);
          if (data && data.stage) {
            if (runId && data.run_id && data.run_id !== runId) return;
            if (data.stage === 'completed' || data.stage === 'failed' || data.stage === 'cancelled') {
              handleTerminalState(data);
            } else {
              setJobProgress(data);
            }
          }
        } catch (e) {
          console.debug('SSE parse issue:', e);
        }
      };

      eventSource.addEventListener('progress', onProgress);
      eventSource.onmessage = onProgress;
      eventSource.onerror = () => {
        // SSE error or reconnecting; interval polling will ensure progress updates continue
      };
    } catch (e) {
      console.warn('EventSource connection error:', e);
    }

    return () => {
      isMounted = false;
      clearInterval(pollInterval);
      if (eventSource) {
        eventSource.close();
      }
    };
  }, [isProcessing, metadata?.job_id, currentRunId]);

  // Clean up timers on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
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
      if (timerRef.current) clearInterval(timerRef.current);
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

  // Core file upload handler
  const processUploadedFile = async (file: File) => {
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

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) processUploadedFile(file);
  };

  // Drag and drop handlers
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDraggingFile(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDraggingFile(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDraggingFile(false);
    const file = e.dataTransfer.files?.[0];
    if (file && (file.type.startsWith('video/') || file.name.endsWith('.mp4') || file.name.endsWith('.webm') || file.name.endsWith('.mov'))) {
      processUploadedFile(file);
    }
  };

  // Load sample procedural video
  const handleLoadSample = async (sample: SampleVideoInfo) => {
    try {
      setIsLoadingSample(sample.id);
      const file = await createSampleVideoFile(sample.type);
      await processUploadedFile(file);
    } catch (err) {
      console.error('Failed to generate sample video:', err);
    } finally {
      setIsLoadingSample(null);
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

  // Delete a specific keyframe's strokes
  const handleDeleteKeyframe = (fIdx: number) => {
    setKeyframeStrokes((prev) => {
      const next = { ...prev };
      delete next[fIdx];
      return next;
    });
    setCurrentKeyframePreviews((prev) => {
      const next = { ...prev };
      delete next[fIdx];
      return next;
    });
    if (fIdx === currentFrame) {
      setMaskBase64(null);
    }
  };

  // Global Keyboard Shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable)
      ) {
        return;
      }

      // '?' opens shortcuts modal
      if (e.key === '?') {
        e.preventDefault();
        setIsShortcutsOpen((prev) => !prev);
        return;
      }

      // 'Escape' closes modal or cancels preview
      if (e.key === 'Escape') {
        if (isShortcutsOpen) {
          setIsShortcutsOpen(false);
          return;
        }
      }

      // Space toggles Play / Pause
      if (e.code === 'Space') {
        e.preventDefault();
        handleTogglePlay();
        return;
      }

      // Check if in editor view
      if (!videoSrc || viewMode === 'inspect' || isProcessing) {
        return;
      }

      const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
      const isCmdOrCtrl = isMac ? e.metaKey : e.ctrlKey;

      // Undo / Redo
      if (isCmdOrCtrl && !e.shiftKey && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault();
        handleUndo();
        return;
      }
      if (
        (isCmdOrCtrl && e.shiftKey && (e.key === 'z' || e.key === 'Z')) ||
        (!isMac && e.ctrlKey && (e.key === 'y' || e.key === 'Y'))
      ) {
        e.preventDefault();
        handleRedo();
        return;
      }

      // Frame Stepping (Arrow keys)
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        handleStepFrame(e.shiftKey ? -10 : -1);
        return;
      }
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        handleStepFrame(e.shiftKey ? 10 : 1);
        return;
      }

      // Tool selection hotkeys: 1 (Lasso), 2 (Box), 3 (Point)
      if (e.key === '1') {
        setActiveTool('lasso');
        return;
      }
      if (e.key === '2') {
        setActiveTool('box');
        return;
      }
      if (e.key === '3') {
        setActiveTool('point');
        return;
      }

      // Mode toggles: I (include), E (exclude)
      if (e.key === 'i' || e.key === 'I') {
        setStrokeMode('include');
        return;
      }
      if (e.key === 'e' || e.key === 'E') {
        setStrokeMode('exclude');
        return;
      }

      // Peek toggle: H
      if (e.key === 'h' || e.key === 'H') {
        setIsPeekHidden((prev) => !prev);
        return;
      }

      // Keyframe navigation: [ and ]
      const allKf = Object.keys(keyframeStrokes).map((k) => parseInt(k, 10)).sort((a, b) => a - b);
      if (e.key === '[') {
        const prevs = allKf.filter((k) => k < currentFrame);
        if (prevs.length > 0) handleSeekFrame(prevs[prevs.length - 1]);
        return;
      }
      if (e.key === ']') {
        const nexts = allKf.filter((k) => k > currentFrame);
        if (nexts.length > 0) handleSeekFrame(nexts[0]);
        return;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [videoSrc, viewMode, isProcessing, isShortcutsOpen, currentFrame, keyframeStrokes, handleUndo, handleRedo]);

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
      setCurrentRunId(resData.run_id);
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
    setVideoFile(null);
    setVideoSrc(null);
    setMetadata(null);
    setKeyframeStrokes({});
    setStrokeHistory({});
    setCurrentKeyframePreviews({});
    setMaskBase64(null);
    setOutputUrl(null);
    setViewMode('annotate');
    setAccumulateMode(false);
    setJobProgress(null);
    setIsProcessing(false);
    setIsCancelling(false);
    setCurrentRunId(null);
    setLatestRunId(null);
  };

  const handleAddAnotherSubject = (frameToSeek: number) => {
    setViewMode('annotate');
    setAccumulateMode(true);
    setKeyframeStrokes({});
    setStrokeHistory({});
    setCurrentKeyframePreviews({});
    setMaskBase64(null);
    handleSeekFrame(frameToSeek);
  };

  const hasKeyframes = Object.keys(keyframeStrokes).length > 0;

  return (
    <div
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className="w-screen h-screen overflow-hidden flex flex-col bg-neutral-950 text-neutral-100 font-sans select-none"
    >
      {/* 1. Sleek Top Navigation Bar (VEED.IO Style) */}
      <header className="h-12 w-full flex-shrink-0 border-b border-neutral-800/80 bg-neutral-950/95 backdrop-blur px-4 flex items-center justify-between z-40">
        {/* Left: App Logo, Title, Undo / Redo */}
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-7 h-7 rounded-lg bg-lime-500 flex items-center justify-center text-neutral-950 font-bold text-sm shadow-sm flex-shrink-0">
            S
          </div>

          <div className="flex items-baseline gap-2 min-w-0 truncate">
            <span className="text-sm font-semibold text-neutral-100 tracking-tight flex-shrink-0">
              stirs
            </span>
            <span className="text-xs text-neutral-400 font-mono truncate hidden sm:inline">
              {videoFile ? videoFile.name : 'SAM 2 Video Mask Generator'}
            </span>
          </div>

          {/* Undo / Redo in top bar */}
          {videoSrc && viewMode === 'annotate' && (
            <div className="flex items-center gap-0.5 ml-2 pl-3 border-l border-neutral-800 flex-shrink-0">
              <button
                type="button"
                onClick={handleUndo}
                disabled={isProcessing || (!canUndo(strokeHistory, currentFrame) && currentStrokes.length === 0)}
                title="Undo (Ctrl+Z)"
                className="p-1.5 rounded-lg hover:bg-neutral-800 text-neutral-400 hover:text-white transition disabled:opacity-20"
              >
                <Undo2 className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                onClick={handleRedo}
                disabled={isProcessing || !canRedo(strokeHistory, currentFrame)}
                title="Redo (Ctrl+Shift+Z)"
                className="p-1.5 rounded-lg hover:bg-neutral-800 text-neutral-400 hover:text-white transition disabled:opacity-20"
              >
                <Redo2 className="w-3.5 h-3.5" />
              </button>
            </div>
          )}
        </div>

        {/* Center: Workspace Mode Pill */}
        <div className="hidden md:flex items-center bg-neutral-900 border border-neutral-800 rounded-lg p-0.5 text-xs font-medium flex-shrink-0">
          <button
            type="button"
            onClick={() => setViewMode('annotate')}
            className={`px-3 py-1 rounded-md transition ${
              viewMode === 'annotate' ? 'bg-neutral-800 text-white shadow-sm' : 'text-neutral-400 hover:text-neutral-200'
            }`}
          >
            Annotate
          </button>
          <button
            type="button"
            onClick={() => setViewMode('inspect')}
            disabled={!outputUrl}
            className={`px-3 py-1 rounded-md transition ${
              viewMode === 'inspect'
                ? 'bg-neutral-800 text-white shadow-sm'
                : outputUrl
                ? 'text-neutral-400 hover:text-neutral-200'
                : 'text-neutral-600 cursor-not-allowed'
            }`}
          >
            Inspect Masks
          </button>
        </div>

        {/* Right: Peek, Shortcuts, Action Button */}
        <div className="flex items-center gap-2 flex-shrink-0">
          {videoSrc && viewMode === 'annotate' && (
            <button
              type="button"
              onClick={() => setIsPeekHidden((prev) => !prev)}
              title="Peek original frame without mask (H)"
              className={`p-1.5 px-2.5 rounded-lg border text-xs font-mono flex items-center gap-1.5 transition ${
                isPeekHidden
                  ? 'border-amber-500 bg-amber-950/40 text-amber-300'
                  : 'border-neutral-800 hover:bg-neutral-800 text-neutral-300'
              }`}
            >
              {isPeekHidden ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
              <span className="hidden sm:inline">{isPeekHidden ? 'Mask Hidden' : 'Peek (H)'}</span>
            </button>
          )}

          <button
            type="button"
            onClick={() => setIsShortcutsOpen(true)}
            title="Keyboard shortcuts (?)"
            className="p-1.5 rounded-lg border border-neutral-800 hover:bg-neutral-800 text-neutral-400 hover:text-neutral-200 transition"
          >
            <HelpCircle className="w-4 h-4" />
          </button>

          {/* Primary Action Button (VEED Signature Lime) */}
          {videoSrc && viewMode === 'annotate' && (
            <button
              type="button"
              onClick={handleStartMaskJob}
              disabled={!hasKeyframes || isProcessing}
              className="px-4 py-1.5 rounded-lg bg-lime-500 hover:bg-lime-400 text-neutral-950 font-bold text-xs shadow-md transition active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5"
            >
              {isProcessing ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  <span>Tracking...</span>
                </>
              ) : (
                <>
                  <Sparkles className="w-3.5 h-3.5 fill-current" />
                  <span>Generate Masks</span>
                </>
              )}
            </button>
          )}
        </div>
      </header>

      {/* 2. Full-Page Studio Layout (Uses Entire Height & Width) */}
      <div className="flex-1 flex w-full min-h-0 overflow-hidden">
        {/* Left Vertical Icon Rail (VEED.IO style) */}
        {videoSrc && (
          <aside className="w-12 sm:w-14 flex-shrink-0 h-full bg-neutral-950 border-r border-neutral-800/80 flex flex-col items-center py-3 gap-2 z-20">
            <button
              type="button"
              onClick={() => setActiveNavTab('tools')}
              title="Selection Tools"
              className={`w-9 h-9 rounded-xl flex items-center justify-center transition ${
                activeNavTab === 'tools'
                  ? 'bg-neutral-800 text-lime-400 shadow-sm'
                  : 'text-neutral-400 hover:text-white hover:bg-neutral-900'
              }`}
            >
              <Lasso className="w-4 h-4" />
            </button>

            <button
              type="button"
              onClick={() => setActiveNavTab('keyframes')}
              title="Keyframes Manager"
              className={`w-9 h-9 rounded-xl flex items-center justify-center relative transition ${
                activeNavTab === 'keyframes'
                  ? 'bg-neutral-800 text-lime-400 shadow-sm'
                  : 'text-neutral-400 hover:text-white hover:bg-neutral-900'
              }`}
            >
              <Bookmark className="w-4 h-4" />
              {hasKeyframes && (
                <span className="absolute top-1.5 right-1.5 w-2 h-2 rounded-full bg-amber-400" />
              )}
            </button>

            <button
              type="button"
              onClick={() => setActiveNavTab('samples')}
              title="Demo Sample Videos"
              className={`w-9 h-9 rounded-xl flex items-center justify-center transition ${
                activeNavTab === 'samples'
                  ? 'bg-neutral-800 text-lime-400 shadow-sm'
                  : 'text-neutral-400 hover:text-white hover:bg-neutral-900'
              }`}
            >
              <Film className="w-4 h-4" />
            </button>

            <button
              type="button"
              onClick={() => setActiveNavTab('settings')}
              title="Dilation & Settings"
              className={`w-9 h-9 rounded-xl flex items-center justify-center transition ${
                activeNavTab === 'settings'
                  ? 'bg-neutral-800 text-lime-400 shadow-sm'
                  : 'text-neutral-400 hover:text-white hover:bg-neutral-900'
              }`}
            >
              <Sliders className="w-4 h-4" />
            </button>
          </aside>
        )}

        {/* Left Expanded Drawer Panel */}
        {videoSrc && (
          <aside className="w-60 sm:w-64 lg:w-72 flex-shrink-0 h-full bg-neutral-900/95 border-r border-neutral-800/80 p-3.5 flex flex-col gap-3.5 overflow-y-auto z-10">
            {/* Replace / Upload Video */}
            <div className="flex flex-col gap-2 flex-shrink-0">
              <input
                type="file"
                id="video-replace-input"
                accept="video/mp4,video/quicktime,video/webm"
                onChange={handleFileSelect}
                className="hidden"
              />
              <label
                htmlFor="video-replace-input"
                className="w-full py-2 px-3 rounded-xl bg-lime-500 hover:bg-lime-400 text-neutral-950 font-bold text-xs flex items-center justify-center gap-1.5 cursor-pointer shadow-sm active:scale-98 transition"
              >
                <Video className="w-3.5 h-3.5" />
                <span>Replace Video</span>
              </label>
            </div>

            {/* TAB: Tools */}
            {activeNavTab === 'tools' && (
              <div className="flex flex-col gap-3.5">
                <div className="flex flex-col gap-1.5">
                  <span className="text-[10px] font-mono uppercase tracking-wider text-neutral-400">
                    Selection Tool
                  </span>
                  <div className="grid grid-cols-3 gap-1 bg-neutral-950 p-1 rounded-xl border border-neutral-800">
                    <button
                      type="button"
                      onClick={() => setActiveTool('lasso')}
                      className={`flex flex-col items-center gap-1 py-1.5 rounded-lg text-[10px] font-medium transition ${
                        activeTool === 'lasso'
                          ? 'bg-neutral-800 text-lime-400 shadow-sm'
                          : 'text-neutral-400 hover:text-white'
                      }`}
                    >
                      <Lasso className="w-3.5 h-3.5" />
                      <span>Lasso (1)</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setActiveTool('box')}
                      className={`flex flex-col items-center gap-1 py-1.5 rounded-lg text-[10px] font-medium transition ${
                        activeTool === 'box'
                          ? 'bg-neutral-800 text-lime-400 shadow-sm'
                          : 'text-neutral-400 hover:text-white'
                      }`}
                    >
                      <Square className="w-3.5 h-3.5" />
                      <span>Box (2)</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setActiveTool('point')}
                      className={`flex flex-col items-center gap-1 py-1.5 rounded-lg text-[10px] font-medium transition ${
                        activeTool === 'point'
                          ? 'bg-neutral-800 text-lime-400 shadow-sm'
                          : 'text-neutral-400 hover:text-white'
                      }`}
                    >
                      <CircleDot className="w-3.5 h-3.5" />
                      <span>Point (3)</span>
                    </button>
                  </div>
                </div>

                <div className="flex flex-col gap-1.5">
                  <span className="text-[10px] font-mono uppercase tracking-wider text-neutral-400">
                    Prompt Mode
                  </span>
                  <div className="grid grid-cols-2 gap-1.5">
                    <button
                      type="button"
                      onClick={() => setStrokeMode('include')}
                      className={`flex items-center justify-center gap-1.5 py-1.5 px-2 rounded-xl text-xs font-semibold border transition ${
                        strokeMode === 'include'
                          ? 'border-cyan-500 bg-cyan-950/40 text-cyan-300 shadow-sm'
                          : 'border-neutral-800 bg-neutral-950 text-neutral-400 hover:border-neutral-700'
                      }`}
                    >
                      <Plus className="w-3.5 h-3.5" />
                      <span>Include (I)</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setStrokeMode('exclude')}
                      className={`flex items-center justify-center gap-1.5 py-1.5 px-2 rounded-xl text-xs font-semibold border transition ${
                        strokeMode === 'exclude'
                          ? 'border-rose-500 bg-rose-950/40 text-rose-300 shadow-sm'
                          : 'border-neutral-800 bg-neutral-950 text-neutral-400 hover:border-neutral-700'
                      }`}
                    >
                      <Minus className="w-3.5 h-3.5" />
                      <span>Exclude (E)</span>
                    </button>
                  </div>
                </div>

                {accumulateMode && (
                  <div className="p-2.5 rounded-xl bg-lime-950/30 border border-lime-800/60 text-lime-300 text-xs">
                    <span className="font-semibold block mb-0.5">Merging with Previous Masks</span>
                    New masks will be bitwise-OR combined with existing masks.
                  </div>
                )}

                {/* Instructions */}
                <div className="text-[11px] text-neutral-400 bg-neutral-950 p-3 rounded-xl border border-neutral-800/80 leading-relaxed font-mono">
                  <span className="text-lime-400 font-semibold block mb-1">Quick Workflow:</span>
                  1. Draw around your subject.<br />
                  2. Scrub to any drift frame & add guidance.<br />
                  3. Click <span className="text-white font-bold">Generate Masks</span>.
                </div>
              </div>
            )}

            {/* TAB: Keyframes */}
            {activeNavTab === 'keyframes' && (
              <div className="flex flex-col gap-2">
                <span className="text-[10px] font-mono uppercase tracking-wider text-neutral-400">
                  Annotated Keyframes ({Object.keys(keyframeStrokes).length})
                </span>

                {Object.keys(keyframeStrokes).length === 0 ? (
                  <p className="text-xs text-neutral-500 font-mono py-4 text-center">
                    No keyframes added yet.<br />Draw on any frame to pin a keyframe.
                  </p>
                ) : (
                  <div className="flex flex-col gap-1.5">
                    {Object.keys(keyframeStrokes).map((fStr) => {
                      const f = parseInt(fStr, 10);
                      const isCur = f === currentFrame;
                      const strokesCount = keyframeStrokes[f]?.length || 0;
                      return (
                        <div
                          key={f}
                          className={`flex items-center justify-between p-2 rounded-xl border text-xs font-mono transition ${
                            isCur
                              ? 'bg-neutral-800 border-lime-500/80 text-white shadow-sm'
                              : 'bg-neutral-950 border-neutral-800 text-neutral-300 hover:border-neutral-700'
                          }`}
                        >
                          <button
                            type="button"
                            onClick={() => handleSeekFrame(f)}
                            className="flex items-center gap-2 flex-1 text-left"
                          >
                            <Bookmark className="w-3.5 h-3.5 text-amber-400" />
                            <span>Frame {f} ({strokesCount} strokes)</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => handleDeleteKeyframe(f)}
                            title="Delete keyframe"
                            className="p-1 rounded hover:bg-neutral-800 text-neutral-400 hover:text-rose-400 transition"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {/* TAB: Samples */}
            {activeNavTab === 'samples' && (
              <div className="flex flex-col gap-2">
                <span className="text-[10px] font-mono uppercase tracking-wider text-neutral-400">
                  Demo Sample Videos
                </span>
                <p className="text-[11px] text-neutral-400">
                  Test SAM 2 tracking with built-in procedural test clips:
                </p>
                <div className="flex flex-col gap-2">
                  {SAMPLE_VIDEOS.map((sample) => (
                    <button
                      key={sample.id}
                      type="button"
                      onClick={() => handleLoadSample(sample)}
                      disabled={isLoadingSample !== null}
                      className="p-2.5 rounded-xl bg-neutral-950 hover:bg-neutral-800/80 border border-neutral-800 text-left transition flex flex-col gap-1 text-xs"
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-semibold text-neutral-200">{sample.title}</span>
                        <span className="font-mono text-[10px] text-lime-400">{sample.duration}</span>
                      </div>
                      <span className="text-[11px] text-neutral-500 leading-tight">
                        {sample.description}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* TAB: Settings */}
            {activeNavTab === 'settings' && (
              <div className="flex flex-col gap-4">
                <div className="flex flex-col gap-1.5">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-neutral-300">Mask Dilation</span>
                    <span className="font-mono text-lime-400 font-bold">{dilationPx}px</span>
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
                    className="w-full h-1.5 bg-neutral-800 rounded-lg appearance-none cursor-pointer accent-lime-400"
                  />
                  <span className="text-[10px] text-neutral-500 font-mono">
                    Expands mask boundaries to safely capture soft edges.
                  </span>
                </div>
              </div>
            )}
          </aside>
        )}

        {/* Main Central Viewport: Uses entire remaining width & height */}
        <main className="flex-1 flex flex-col min-w-0 h-full overflow-hidden bg-neutral-950 relative">
          {/* A. When NO video is loaded: VEED.IO Modal Upload Dropzone */}
          {!videoSrc && (
            <div className="flex-1 flex items-center justify-center p-4 sm:p-6 bg-neutral-950 overflow-y-auto">
              <div className="w-full max-w-3xl bg-neutral-900 border border-neutral-800 rounded-2xl p-6 sm:p-8 flex flex-col items-center gap-5 shadow-2xl my-auto">
                <div className="text-center flex flex-col gap-1">
                  <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-neutral-100">
                    Let's make a video mask
                  </h1>
                  <p className="text-xs text-neutral-400 font-mono">
                    High-performance temporal tracking powered by Meta SAM 2
                  </p>
                </div>

                {/* Dropzone container matching Screenshot 0 */}
                <div
                  className={`w-full border-2 border-dashed rounded-2xl p-8 sm:p-10 flex flex-col items-center justify-center gap-4 transition ${
                    isDraggingFile
                      ? 'border-lime-400 bg-lime-950/20'
                      : 'border-neutral-800 hover:border-neutral-700 bg-neutral-950/50'
                  }`}
                >
                  <input
                    type="file"
                    id="video-upload-main"
                    accept="video/mp4,video/quicktime,video/webm"
                    onChange={handleFileSelect}
                    className="hidden"
                  />

                  <div className="w-12 h-12 rounded-xl bg-neutral-800 flex items-center justify-center text-neutral-300 border border-neutral-700">
                    <UploadCloud className="w-6 h-6 text-lime-400" />
                  </div>

                  <div className="flex flex-col items-center gap-2 text-center">
                    <span className="text-xs text-neutral-400 font-mono">
                      Drop media here or
                    </span>
                    <label
                      htmlFor="video-upload-main"
                      className="px-5 py-2.5 rounded-xl bg-lime-500 hover:bg-lime-400 text-neutral-950 font-bold text-xs flex items-center gap-2 cursor-pointer shadow-md active:scale-95 transition"
                    >
                      <UploadCloud className="w-4 h-4 stroke-[2.5]" />
                      <span>Upload from computer</span>
                    </label>
                    <span className="text-[10px] text-neutral-500 font-mono">
                      MP4, MOV, WEBM • Up to 2GB supported
                    </span>
                  </div>

                  {isUploading && (
                    <div className="flex items-center gap-2 text-xs font-mono text-lime-400 mt-2">
                      <Loader2 className="w-4 h-4 animate-spin" />
                      <span>Extracting frames & initializing SAM 2...</span>
                    </div>
                  )}

                  {uploadError && (
                    <div className="flex items-center gap-2 text-xs text-rose-300 bg-rose-950/40 border border-rose-900/80 px-3 py-1.5 rounded-lg mt-2">
                      <AlertCircle className="w-4 h-4 text-rose-400" />
                      <span>{uploadError}</span>
                    </div>
                  )}
                </div>

                {/* Bottom Sample Video Quick Cards matching Screenshot 0 */}
                <div className="w-full flex flex-col gap-2">
                  <span className="text-[10px] font-mono uppercase tracking-wider text-neutral-400">
                    Or try instant sample video:
                  </span>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                    {SAMPLE_VIDEOS.map((sample) => (
                      <button
                        key={sample.id}
                        type="button"
                        onClick={() => handleLoadSample(sample)}
                        disabled={isLoadingSample !== null}
                        className="p-3 rounded-xl bg-neutral-950 hover:bg-neutral-800 border border-neutral-800 hover:border-neutral-700 text-left transition flex flex-col gap-1 group active:scale-98"
                      >
                        <div className="flex items-center justify-between">
                          <span className="text-xs font-semibold text-neutral-200 group-hover:text-white">
                            {sample.title}
                          </span>
                          <span className="font-mono text-[10px] text-lime-400 bg-lime-950/60 px-1.5 py-0.5 rounded border border-lime-800/60">
                            {sample.duration}
                          </span>
                        </div>
                        <span className="text-[10px] text-neutral-400 leading-tight">
                          {sample.description}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* B. When video IS loaded: Results Player OR Editor Canvas filling 100% height */}
          {videoSrc && (
            <div className="flex-1 flex flex-col min-h-0 w-full overflow-hidden p-2 sm:p-3 gap-2">
              {/* Output Player View */}
              {viewMode === 'inspect' && outputUrl && metadata ? (
                <div className="flex-1 w-full h-full min-h-0 overflow-hidden">
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
                </div>
              ) : (
                /* Interactive Editor Canvas: Scales to available screen height & width */
                <div className="flex-1 flex flex-col min-h-0 w-full overflow-hidden gap-2">
                  {/* Canvas Viewport: Expands responsively */}
                  <div
                    ref={videoContainerRef}
                    className="flex-1 relative w-full min-h-0 bg-neutral-950 rounded-2xl overflow-hidden border border-neutral-800 select-none shadow-2xl flex items-center justify-center"
                  >
                    {/* HTML5 Video Element */}
                    <video
                      ref={videoRef}
                      src={videoSrc}
                      playsInline
                      onTimeUpdate={handleTimeUpdate}
                      onPlay={() => setIsPlaying(true)}
                      onPause={() => setIsPlaying(false)}
                      className="absolute inset-0 w-full h-full object-contain pointer-events-none"
                    />

                    {/* Instant Mask Preview Overlay (hidden if peek is active) */}
                    {metadata && !isPeekHidden && (
                      <MaskOverlay
                        maskBase64={maskBase64}
                        videoWidth={metadata.width}
                        videoHeight={metadata.height}
                        containerWidth={containerSize.width}
                        containerHeight={containerSize.height}
                      />
                    )}

                    {/* Interactive Lasso Canvas supporting Point, Box, Lasso */}
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
                        activeTool={activeTool}
                        onToolChange={setActiveTool}
                        canUndo={canUndo(strokeHistory, currentFrame)}
                        canRedo={canRedo(strokeHistory, currentFrame)}
                        onUndo={handleUndo}
                        onRedo={handleRedo}
                        onClearAll={handleClearStrokes}
                        disabled={isProcessing}
                      />
                    )}

                    {/* Live Preview Predicting Spinner */}
                    {isPreviewLoading && (
                      <div className="absolute top-3 right-3 z-30 flex items-center gap-1.5 bg-neutral-950/90 backdrop-blur px-3 py-1.5 rounded-lg text-xs font-mono text-lime-400 border border-neutral-800 shadow-md">
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        <span>Predicting Mask...</span>
                      </div>
                    )}
                  </div>

                  {/* Canvas Info Strip matching VEED.IO */}
                  <div className="flex-shrink-0 flex items-center justify-between text-[11px] font-mono text-neutral-400 px-2 py-0.5">
                    <div className="flex items-center gap-2">
                      <span className="px-2 py-0.5 rounded bg-neutral-900 border border-neutral-800">
                        {metadata?.width && metadata?.height
                          ? `${metadata.width}×${metadata.height}`
                          : '16:9'}
                      </span>
                      <span>
                        {metadata?.frame_count || 0} Frames @ {metadata?.fps.toFixed(1) || 30} FPS
                      </span>
                    </div>

                    <div className="flex items-center gap-2 text-neutral-500">
                      <span>Tool: <strong className="text-neutral-200 capitalize">{activeTool}</strong></span>
                      <span>•</span>
                      <span>Mode: <strong className={strokeMode === 'include' ? 'text-cyan-400' : 'text-rose-400'}>{strokeMode}</strong></span>
                    </div>
                  </div>

                  {/* Professional Bottom Timeline docked at bottom */}
                  <div className="flex-shrink-0 w-full">
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
                </div>
              )}
            </div>
          )}

          {/* Floating In-Flight Propagation Modal / Drawer */}
          {isProcessing && jobProgress && (
            <div className="fixed inset-x-0 bottom-4 z-50 max-w-2xl mx-auto px-4 animate-in slide-in-from-bottom-6 duration-200">
              <div className="shadow-2xl">
                <LiveProgressTracker
                  progress={jobProgress}
                  elapsedSeconds={elapsedSeconds}
                  totalFrames={metadata?.frame_count}
                  annotatedFrameIdx={currentFrame}
                  onCancel={handleCancelJob}
                  isCancelling={isCancelling}
                  onViewMasks={() => {
                    setIsProcessing(false);
                    setViewMode('inspect');
                  }}
                />
              </div>
            </div>
          )}
        </main>
      </div>

      {/* Keyboard Shortcuts Modal */}
      <ShortcutsModal
        isOpen={isShortcutsOpen}
        onClose={() => setIsShortcutsOpen(false)}
      />
    </div>
  );
};

export default App;
