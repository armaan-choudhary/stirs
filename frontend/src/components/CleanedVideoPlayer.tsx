import React, { useState, useRef, useEffect } from 'react';
import {
  Play,
  Pause,
  Download,
  RotateCcw,
  Columns,
  Split,
  ChevronLeft,
  ChevronRight,
  Gauge,
  Volume2,
  VolumeX,
  Sparkles,
  Layers,
  ArrowLeft,
  Sliders,
} from 'lucide-react';

export interface CleanedVideoPlayerProps {
  jobId: string;
  eraseRunId: string;
  videoSrc: string;
  cleanedVideoUrl: string;
  totalFrames?: number;
  fps?: number;
  videoWidth?: number;
  videoHeight?: number;
  onViewMasks: () => void;
  onAddAnotherSubject?: (currentFrame: number) => void;
  onRerunRemoval?: () => void;
  onReset: () => void;
}

type CleanedViewMode = 'cleaned-only' | 'wipe' | 'split';

export const CleanedVideoPlayer: React.FC<CleanedVideoPlayerProps> = ({
  jobId,
  eraseRunId,
  videoSrc,
  cleanedVideoUrl,
  totalFrames = 100,
  fps = 30,
  videoWidth = 1920,
  videoHeight = 1080,
  onViewMasks,
  onAddAnotherSubject,
  onRerunRemoval,
  onReset,
}) => {
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [currentTime, setCurrentTime] = useState<number>(0);
  const [duration, setDuration] = useState<number>(0);
  const [currentFrame, setCurrentFrame] = useState<number>(0);
  const [viewMode, setViewMode] = useState<CleanedViewMode>('wipe');
  const [wipeSplitRatio, setWipeSplitRatio] = useState<number>(0.5);
  const [isDraggingWipe, setIsDraggingWipe] = useState<boolean>(false);
  const [playbackSpeed, setPlaybackSpeed] = useState<number>(1);
  const [isMuted, setIsMuted] = useState<boolean>(false);

  const cleanedVideoRef = useRef<HTMLVideoElement | null>(null);
  const sourceVideoRef = useRef<HTMLVideoElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Versioned download and playback URL to prevent browser cache staleness
  const versionedCleanedUrl = cleanedVideoUrl.includes('?v=')
    ? cleanedVideoUrl
    : `${cleanedVideoUrl}${cleanedVideoUrl.includes('?') ? '&' : '?'}v=${eraseRunId}`;

  // Download URL pointing to backend removal result endpoint
  const downloadUrl = `/api/v1/jobs/${jobId}/removal/${eraseRunId}/result?v=${eraseRunId}`;

  // Synchronize playback speed
  useEffect(() => {
    if (cleanedVideoRef.current) {
      cleanedVideoRef.current.playbackRate = playbackSpeed;
    }
    if (sourceVideoRef.current) {
      sourceVideoRef.current.playbackRate = playbackSpeed;
    }
  }, [playbackSpeed]);

  // Synchronize play / pause across both video elements
  const togglePlay = () => {
    const cleaned = cleanedVideoRef.current;
    const source = sourceVideoRef.current;
    if (!cleaned) return;

    if (cleaned.paused) {
      cleaned.play().catch(console.warn);
      source?.play().catch(console.warn);
      setIsPlaying(true);
    } else {
      cleaned.pause();
      source?.pause();
      setIsPlaying(false);
    }
  };

  const handleTimeUpdate = () => {
    const v = cleanedVideoRef.current;
    if (!v) return;
    setCurrentTime(v.currentTime);
    const computedFrame = Math.min(
      Math.max(0, totalFrames - 1),
      Math.floor(v.currentTime * fps)
    );
    setCurrentFrame(computedFrame);

    // Keep source video synchronized within 50ms drift
    if (sourceVideoRef.current && Math.abs(sourceVideoRef.current.currentTime - v.currentTime) > 0.05) {
      sourceVideoRef.current.currentTime = v.currentTime;
    }
  };

  const handleLoadedMetadata = () => {
    const v = cleanedVideoRef.current;
    if (v) {
      setDuration(v.duration);
    }
  };

  const seekToFrame = (frame: number) => {
    const clampedFrame = Math.max(0, Math.min(totalFrames - 1, frame));
    const targetTime = clampedFrame / fps;
    if (cleanedVideoRef.current) {
      cleanedVideoRef.current.currentTime = targetTime;
    }
    if (sourceVideoRef.current) {
      sourceVideoRef.current.currentTime = targetTime;
    }
    setCurrentTime(targetTime);
    setCurrentFrame(clampedFrame);
  };

  const stepFrame = (delta: number) => {
    seekToFrame(currentFrame + delta);
  };

  // Handle wipe slider drag
  const handleWipePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    setIsDraggingWipe(true);
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const handleWipePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isDraggingWipe || !containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const ratio = Math.max(0.02, Math.min(0.98, (e.clientX - rect.left) / rect.width));
    setWipeSplitRatio(ratio);
  };

  const handleWipePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    setIsDraggingWipe(false);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  };

  const toggleMute = () => {
    if (cleanedVideoRef.current) {
      cleanedVideoRef.current.muted = !isMuted;
    }
    setIsMuted(!isMuted);
  };

  return (
    <div className="flex flex-col gap-4 w-full h-full min-h-0 select-none overflow-y-auto">
      {/* Top Banner */}
      <div className="flex flex-wrap items-center justify-between gap-3 bg-neutral-900 border border-neutral-800 rounded-2xl p-4 shadow-sm flex-shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-violet-500/10 border border-violet-500/30 flex items-center justify-center text-violet-400">
            <Sparkles className="w-5 h-5 fill-violet-400/30" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-semibold text-neutral-100">
                Object Removal Completed
              </h2>
              <span className="text-[10px] font-mono font-normal px-2 py-0.5 rounded bg-violet-500/20 text-violet-300 border border-violet-500/30">
                EffectErase Result
              </span>
              <span className="text-[10px] font-mono font-normal px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">
                Audio Preserved
              </span>
            </div>
            <p className="text-xs text-neutral-400 font-mono mt-0.5">
              Run: {eraseRunId.slice(0, 8)} • {totalFrames} frames ({videoWidth}×{videoHeight} @ {fps.toFixed(1)}fps)
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2.5 flex-wrap">
          {/* Back to Mask Inspection */}
          <button
            type="button"
            onClick={onViewMasks}
            className="flex items-center gap-1.5 px-3 py-2 rounded-xl border border-neutral-700 bg-neutral-900 hover:bg-neutral-800 text-neutral-200 text-xs font-medium transition active:scale-95 shadow-sm"
            title="Inspect or download SAM 2 masks"
          >
            <Layers className="w-3.5 h-3.5 text-lime-400" />
            <span>Inspect Masks</span>
          </button>

          {onAddAnotherSubject && (
            <button
              type="button"
              onClick={() => onAddAnotherSubject(currentFrame)}
              className="flex items-center gap-1.5 px-3 py-2 rounded-xl border border-neutral-800 hover:bg-neutral-800 text-neutral-300 text-xs font-medium transition active:scale-95"
              title="Add or refine masks for this video"
            >
              <span>Add / Refine Mask</span>
            </button>
          )}

          {onRerunRemoval && (
            <button
              type="button"
              onClick={onRerunRemoval}
              className="flex items-center gap-1.5 px-3 py-2 rounded-xl border border-neutral-800 hover:bg-neutral-800 text-neutral-300 text-xs font-medium transition active:scale-95"
              title="Run EffectErase again"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>Re-run Removal</span>
            </button>
          )}

          {/* Download Cleaned Video Button */}
          <a
            href={downloadUrl}
            download={`cleaned_${eraseRunId.slice(0, 8)}.mp4`}
            className="flex items-center gap-2 px-4 py-2 rounded-xl bg-violet-600 hover:bg-violet-500 text-white text-xs font-bold transition active:scale-95 shadow-md shadow-violet-900/30"
          >
            <Download className="w-4 h-4 stroke-[2.5]" />
            <span>Download Video</span>
          </a>

          <button
            type="button"
            onClick={onReset}
            className="flex items-center gap-1.5 px-3 py-2 rounded-xl border border-neutral-800 hover:bg-neutral-800 text-neutral-400 hover:text-neutral-200 text-xs font-medium transition"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            <span>New Video</span>
          </button>
        </div>
      </div>

      {/* Main Viewport & Layout */}
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-4 items-start min-h-0">
        {/* Visualizer Player Viewport */}
        <div className="lg:col-span-3 flex flex-col gap-3 min-h-0">
          <div
            ref={containerRef}
            className={`relative w-full bg-neutral-950 rounded-2xl overflow-hidden border border-neutral-800 select-none shadow-2xl ${
              viewMode === 'split' ? 'grid grid-cols-2 gap-1 p-1' : 'aspect-video'
            }`}
          >
            {/* Split View Mode */}
            {viewMode === 'split' ? (
              <>
                {/* Left: Original Source Video */}
                <div className="relative aspect-video bg-neutral-900/60 rounded-xl overflow-hidden border border-neutral-800/80 flex flex-col items-center justify-center">
                  <span className="absolute top-2 left-2 z-10 px-2 py-0.5 rounded bg-neutral-950/80 text-[10px] font-mono text-neutral-300 border border-neutral-800">
                    Source Video
                  </span>
                  <video
                    ref={sourceVideoRef}
                    src={videoSrc}
                    playsInline
                    muted
                    className="w-full h-full object-contain pointer-events-none"
                  />
                </div>

                {/* Right: Cleaned Video */}
                <div className="relative aspect-video bg-neutral-900/60 rounded-xl overflow-hidden border border-neutral-800/80 flex flex-col items-center justify-center">
                  <span className="absolute top-2 left-2 z-10 px-2 py-0.5 rounded bg-violet-950/80 text-[10px] font-mono text-violet-300 border border-violet-800">
                    Cleaned (EffectErase)
                  </span>
                  <video
                    ref={cleanedVideoRef}
                    src={versionedCleanedUrl}
                    playsInline
                    muted={isMuted}
                    onTimeUpdate={handleTimeUpdate}
                    onLoadedMetadata={handleLoadedMetadata}
                    onPlay={() => setIsPlaying(true)}
                    onPause={() => setIsPlaying(false)}
                    className="w-full h-full object-contain pointer-events-none"
                  />
                </div>
              </>
            ) : viewMode === 'cleaned-only' ? (
              /* Cleaned Video Only Mode */
              <div className="relative w-full h-full flex items-center justify-center bg-black">
                <span className="absolute top-3 left-3 z-10 px-2.5 py-1 rounded-lg bg-neutral-950/80 backdrop-blur text-[10px] font-mono text-violet-300 border border-violet-800/80 flex items-center gap-1.5 shadow">
                  <Sparkles className="w-3 h-3 text-violet-400" />
                  <span>Cleaned Video</span>
                </span>
                <video
                  ref={cleanedVideoRef}
                  src={versionedCleanedUrl}
                  playsInline
                  muted={isMuted}
                  onTimeUpdate={handleTimeUpdate}
                  onLoadedMetadata={handleLoadedMetadata}
                  onPlay={() => setIsPlaying(true)}
                  onPause={() => setIsPlaying(false)}
                  className="w-full h-full object-contain"
                />
              </div>
            ) : (
              /* Interactive Curtain Wipe Mode (Before vs After) */
              <div className="relative w-full h-full overflow-hidden bg-black flex items-center justify-center">
                {/* Background: Source Video */}
                <video
                  ref={sourceVideoRef}
                  src={videoSrc}
                  playsInline
                  muted
                  className="absolute inset-0 w-full h-full object-contain pointer-events-none"
                />

                {/* Foreground: Cleaned Video clipped horizontally by wipeSplitRatio */}
                <div
                  className="absolute inset-0 w-full h-full overflow-hidden pointer-events-none"
                  style={{
                    clipPath: `inset(0 0 0 ${wipeSplitRatio * 100}%)`,
                  }}
                >
                  <video
                    ref={cleanedVideoRef}
                    src={versionedCleanedUrl}
                    playsInline
                    muted={isMuted}
                    onTimeUpdate={handleTimeUpdate}
                    onLoadedMetadata={handleLoadedMetadata}
                    onPlay={() => setIsPlaying(true)}
                    onPause={() => setIsPlaying(false)}
                    className="w-full h-full object-contain"
                  />
                </div>

                {/* Wipe Labels */}
                <span className="absolute top-3 left-3 z-10 px-2 py-0.5 rounded bg-neutral-950/80 backdrop-blur text-[10px] font-mono text-neutral-300 border border-neutral-800">
                  Original
                </span>
                <span className="absolute top-3 right-3 z-10 px-2 py-0.5 rounded bg-violet-950/80 backdrop-blur text-[10px] font-mono text-violet-300 border border-violet-800">
                  Cleaned
                </span>

                {/* Interactive Wipe Split Divider Handle */}
                <div
                  onPointerDown={handleWipePointerDown}
                  onPointerMove={handleWipePointerMove}
                  onPointerUp={handleWipePointerUp}
                  className="absolute top-0 bottom-0 z-20 w-8 -ml-4 flex items-center justify-center cursor-ew-resize group"
                  style={{ left: `${wipeSplitRatio * 100}%` }}
                >
                  <div className="w-0.5 h-full bg-violet-400 group-hover:bg-violet-300 shadow-md" />
                  <div className="absolute w-6 h-6 rounded-full bg-violet-500 text-neutral-950 font-bold flex items-center justify-center text-[10px] shadow-lg border border-white/20 active:scale-95 transition">
                    <Split className="w-3 h-3 text-white" />
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Playback Controls Strip */}
          <div className="flex flex-col gap-2 bg-neutral-900 border border-neutral-800 rounded-2xl p-3">
            <div className="flex items-center justify-between text-xs font-mono">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={togglePlay}
                  className="p-2 rounded-xl bg-violet-600 hover:bg-violet-500 text-white transition active:scale-95 shadow-sm"
                  title={isPlaying ? 'Pause (Space)' : 'Play (Space)'}
                >
                  {isPlaying ? <Pause className="w-4 h-4 fill-current" /> : <Play className="w-4 h-4 fill-current ml-0.5" />}
                </button>

                <button
                  type="button"
                  onClick={() => stepFrame(-1)}
                  className="p-1.5 rounded-lg hover:bg-neutral-800 text-neutral-400 hover:text-white transition"
                  title="Previous frame"
                >
                  <ChevronLeft className="w-4 h-4" />
                </button>
                <button
                  type="button"
                  onClick={() => stepFrame(1)}
                  className="p-1.5 rounded-lg hover:bg-neutral-800 text-neutral-400 hover:text-white transition"
                  title="Next frame"
                >
                  <ChevronRight className="w-4 h-4" />
                </button>

                <button
                  type="button"
                  onClick={toggleMute}
                  className="p-1.5 rounded-lg hover:bg-neutral-800 text-neutral-400 hover:text-white transition ml-1"
                  title={isMuted ? 'Unmute' : 'Mute'}
                >
                  {isMuted ? <VolumeX className="w-4 h-4 text-rose-400" /> : <Volume2 className="w-4 h-4" />}
                </button>
              </div>

              {/* Speed selector */}
              <div className="flex items-center gap-1 bg-neutral-950 p-1 rounded-lg border border-neutral-800 text-[10px]">
                <Gauge className="w-3 h-3 text-neutral-400 ml-1" />
                {[0.25, 0.5, 1, 2].map((speed) => (
                  <button
                    key={speed}
                    type="button"
                    onClick={() => setPlaybackSpeed(speed)}
                    className={`px-1.5 py-0.5 rounded transition ${
                      playbackSpeed === speed
                        ? 'bg-neutral-800 text-violet-400 font-bold'
                        : 'text-neutral-400 hover:text-white'
                    }`}
                  >
                    {speed}x
                  </button>
                ))}
              </div>

              <div className="flex items-center gap-3">
                <span className="text-neutral-200 font-semibold">
                  Frame {currentFrame} / {Math.max(0, totalFrames - 1)}
                </span>
                <span className="text-neutral-500">
                  {currentTime.toFixed(2)}s / {duration ? duration.toFixed(2) : (totalFrames / fps).toFixed(2)}s
                </span>
              </div>
            </div>

            {/* Scrubber slider */}
            <input
              type="range"
              min={0}
              max={Math.max(0, totalFrames - 1)}
              value={currentFrame}
              onChange={(e) => seekToFrame(parseInt(e.target.value, 10))}
              className="w-full h-1.5 bg-neutral-800 rounded-lg appearance-none cursor-pointer accent-violet-400"
            />
          </div>
        </div>

        {/* Sidebar Preview Controls */}
        <div className="flex flex-col gap-4 bg-neutral-900 border border-neutral-800 rounded-2xl p-4">
          <div className="flex items-center gap-1.5 border-b border-neutral-800 pb-2.5">
            <Sliders className="w-3.5 h-3.5 text-violet-400" />
            <span className="text-xs font-semibold text-neutral-200">Comparison Modes</span>
          </div>

          {/* Mode Selector */}
          <div className="flex flex-col gap-1.5">
            <label className="text-[10px] font-mono text-neutral-400 uppercase tracking-wider">
              Display Layout
            </label>
            <div className="grid grid-cols-1 gap-1.5 bg-neutral-950 p-1.5 rounded-xl border border-neutral-800">
              <button
                type="button"
                onClick={() => setViewMode('wipe')}
                className={`flex items-center gap-2 p-2 rounded-lg text-xs font-medium transition ${
                  viewMode === 'wipe'
                    ? 'bg-neutral-800 text-violet-300 font-semibold shadow-sm'
                    : 'text-neutral-400 hover:text-neutral-200'
                }`}
              >
                <Split className="w-3.5 h-3.5" />
                <span>Curtain Wipe (Before / After)</span>
              </button>
              <button
                type="button"
                onClick={() => setViewMode('split')}
                className={`flex items-center gap-2 p-2 rounded-lg text-xs font-medium transition ${
                  viewMode === 'split'
                    ? 'bg-neutral-800 text-violet-300 font-semibold shadow-sm'
                    : 'text-neutral-400 hover:text-neutral-200'
                }`}
              >
                <Columns className="w-3.5 h-3.5" />
                <span>Side-by-Side Comparison</span>
              </button>
              <button
                type="button"
                onClick={() => setViewMode('cleaned-only')}
                className={`flex items-center gap-2 p-2 rounded-lg text-xs font-medium transition ${
                  viewMode === 'cleaned-only'
                    ? 'bg-neutral-800 text-violet-300 font-semibold shadow-sm'
                    : 'text-neutral-400 hover:text-neutral-200'
                }`}
              >
                <Sparkles className="w-3.5 h-3.5" />
                <span>Cleaned Video Only</span>
              </button>
            </div>
          </div>

          {/* EffectErase Architecture Info */}
          <div className="text-[11px] text-neutral-400 bg-neutral-950 p-3 rounded-xl border border-neutral-800 leading-relaxed font-mono">
            <span className="text-violet-400 font-semibold block mb-1">EffectErase Details:</span>
            • Model: Wan2.1-Fun-1.3B-InP base<br />
            • Task: Joint object & effect removal<br />
            • Audio: Stream muxed from source<br />
            • Resolution: {videoWidth}×{videoHeight}<br />
            • Noncommercial: CC BY-NC 4.0
          </div>
        </div>
      </div>
    </div>
  );
};
