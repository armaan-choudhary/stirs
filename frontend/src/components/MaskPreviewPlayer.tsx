import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  Play,
  Pause,
  Download,
  RotateCcw,
  Layers,
  Columns,
  Eye,
  Sliders,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  PlusCircle,
  Maximize2,
  Split,
  Gauge,
} from 'lucide-react';
import { getActiveRenderRect } from '../utils/coordinateMap';

interface MaskPreviewPlayerProps {
  jobId: string;
  revision?: string;
  videoSrc: string;
  outputZipUrl: string;
  totalFrames: number;
  fps: number;
  videoWidth: number;
  videoHeight: number;
  onReset: () => void;
  onAddAnotherSubject?: (currentFrame: number) => void;
}

type PreviewViewMode = 'overlay' | 'split' | 'wipe' | 'mask-only';

export const MaskPreviewPlayer: React.FC<MaskPreviewPlayerProps> = ({
  jobId,
  revision,
  videoSrc,
  outputZipUrl,
  totalFrames,
  fps,
  videoWidth,
  videoHeight,
  onReset,
  onAddAnotherSubject,
}) => {
  const [currentFrame, setCurrentFrame] = useState<number>(0);
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [viewMode, setViewMode] = useState<PreviewViewMode>('overlay');
  const [overlayOpacity, setOverlayOpacity] = useState<number>(0.65);
  const [overlayColor, setOverlayColor] = useState<'cyan' | 'red' | 'lime'>('cyan');
  const [playbackSpeed, setPlaybackSpeed] = useState<number>(1);
  const [wipeSplitRatio, setWipeSplitRatio] = useState<number>(0.5);
  const [isDraggingWipe, setIsDraggingWipe] = useState<boolean>(false);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const offscreenCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const [containerSize, setContainerSize] = useState<{ width: number; height: number }>({
    width: 0,
    height: 0,
  });

  const imageCacheRef = useRef<Map<number, HTMLImageElement>>(new Map());
  const currentFrameRef = useRef<number>(0);
  currentFrameRef.current = currentFrame;

  // Clear image cache when jobId or revision changes to prevent stale browser-cached images
  useEffect(() => {
    imageCacheRef.current.clear();
  }, [jobId, revision]);

  // Track container dimensions for coordinate scaling
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const updateSize = () => {
      const rect = el.getBoundingClientRect();
      setContainerSize({ width: rect.width, height: rect.height });
    };

    const observer = new ResizeObserver(updateSize);
    observer.observe(el);
    updateSize();

    return () => observer.disconnect();
  }, [viewMode]);

  // Pre-fetch images around current playback position
  const getOrPreloadMask = useCallback(
    (frameIdx: number): HTMLImageElement => {
      const clamped = Math.max(0, Math.min(totalFrames - 1, frameIdx));
      const cache = imageCacheRef.current;
      if (cache.has(clamped)) {
        return cache.get(clamped)!;
      }

      const img = new Image();
      const padded = String(clamped).padStart(5, '0');
      img.src = `/workspace/${jobId}/masks/${padded}.png${revision ? `?v=${revision}` : ''}`;
      cache.set(clamped, img);

      // Preload next 10 frames
      for (let i = 1; i <= 10; i++) {
        const nextIdx = clamped + i;
        if (nextIdx < totalFrames && !cache.has(nextIdx)) {
          const preImg = new Image();
          const prePadded = String(nextIdx).padStart(5, '0');
          preImg.src = `/workspace/${jobId}/masks/${prePadded}.png${revision ? `?v=${revision}` : ''}`;
          cache.set(nextIdx, preImg);
        }
      }

      return img;
    },
    [jobId, revision, totalFrames]
  );

  // Synchronize playback speed
  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.playbackRate = playbackSpeed;
    }
  }, [playbackSpeed]);

  // High-precision frame sync using requestVideoFrameCallback or requestAnimationFrame
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    let callbackId: number | null = null;
    let animFrameId: number | null = null;

    const onFrame = () => {
      if (!video) return;
      const computedFrame = Math.min(
        totalFrames - 1,
        Math.max(0, Math.round(video.currentTime * fps))
      );
      if (computedFrame !== currentFrameRef.current) {
        setCurrentFrame(computedFrame);
      }

      if ('requestVideoFrameCallback' in video) {
        callbackId = (video as any).requestVideoFrameCallback(onFrame);
      } else {
        animFrameId = requestAnimationFrame(onFrame);
      }
    };

    if ('requestVideoFrameCallback' in video) {
      callbackId = (video as any).requestVideoFrameCallback(onFrame);
    } else {
      animFrameId = requestAnimationFrame(onFrame);
    }

    return () => {
      if (callbackId !== null && 'cancelVideoFrameCallback' in video) {
        (video as any).cancelVideoFrameCallback(callbackId);
      }
      if (animFrameId !== null) {
        cancelAnimationFrame(animFrameId);
      }
    };
  }, [fps, totalFrames, isPlaying]);

  const togglePlay = () => {
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

  const seekToFrame = (frame: number) => {
    const v = videoRef.current;
    if (!v) return;
    const clamped = Math.max(0, Math.min(totalFrames - 1, frame));
    v.currentTime = clamped / fps;
    setCurrentFrame(clamped);
  };

  const stepFrame = (delta: number) => {
    seekToFrame(currentFrame + delta);
  };

  const toggleFullscreen = () => {
    if (!containerRef.current) return;
    if (!document.fullscreenElement) {
      containerRef.current.requestFullscreen().catch(() => {});
    } else {
      document.exitFullscreen().catch(() => {});
    }
  };

  useEffect(() => {
    getOrPreloadMask(currentFrame);
  }, [currentFrame, getOrPreloadMask]);

  // Letterbox sizing for the overlay
  const renderRect = getActiveRenderRect(
    containerSize.width,
    containerSize.height,
    videoWidth,
    videoHeight
  );

  // Fast direct canvas rendering: turns 8-bit black/white mask into a tinted transparent overlay
  useEffect(() => {
    if (viewMode !== 'overlay' && viewMode !== 'wipe') return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const w = Math.round(renderRect.renderWidth);
    const h = Math.round(renderRect.renderHeight);
    if (w <= 0 || h <= 0) return;

    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    ctx.clearRect(0, 0, w, h);

    if (!offscreenCanvasRef.current) {
      offscreenCanvasRef.current = document.createElement('canvas');
    }
    const offCanvas = offscreenCanvasRef.current;
    if (offCanvas.width !== w || offCanvas.height !== h) {
      offCanvas.width = w;
      offCanvas.height = h;
    }
    const offCtx = offCanvas.getContext('2d', { willReadFrequently: true });
    if (!offCtx) return;

    const img = getOrPreloadMask(currentFrame);
    const draw = () => {
      if (img.complete && img.naturalWidth > 0) {
        offCtx.clearRect(0, 0, w, h);
        offCtx.drawImage(img, 0, 0, w, h);

        const imgData = offCtx.getImageData(0, 0, w, h);
        const data = imgData.data;
        const [rTint, gTint, bTint] =
          overlayColor === 'red'
            ? [239, 68, 68]
            : overlayColor === 'lime'
            ? [132, 204, 22] // Lime accent
            : [6, 182, 212];
        const alphaTarget = Math.round(overlayOpacity * 255);

        for (let i = 0; i < data.length; i += 4) {
          if (data[i] > 120) {
            data[i] = rTint;
            data[i + 1] = gTint;
            data[i + 2] = bTint;
            data[i + 3] = alphaTarget;
          } else {
            data[i + 3] = 0;
          }
        }

        ctx.putImageData(imgData, 0, 0);

        // If in wipe mode, clip overlay to the right side of split ratio
        if (viewMode === 'wipe') {
          const splitX = Math.round(w * wipeSplitRatio);
          ctx.save();
          ctx.globalCompositeOperation = 'destination-out';
          ctx.fillRect(0, 0, splitX, h);
          ctx.restore();
        }
      } else {
        img.onload = draw;
      }
    };

    draw();
  }, [currentFrame, renderRect, overlayOpacity, overlayColor, viewMode, wipeSplitRatio, getOrPreloadMask]);

  // Handle wipe slider dragging
  const handleWipePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    setIsDraggingWipe(true);
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const handleWipePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isDraggingWipe || !containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const ratio = Math.max(0.05, Math.min(0.95, (e.clientX - rect.left) / rect.width));
    setWipeSplitRatio(ratio);
  };

  const handleWipePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    setIsDraggingWipe(false);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  };

  const paddedIndex = String(Math.max(0, Math.min(totalFrames - 1, currentFrame))).padStart(5, '0');
  const maskUrl = `/workspace/${jobId}/masks/${paddedIndex}.png${revision ? `?v=${revision}` : ''}`;

  return (
    <div className="flex flex-col gap-4 w-full">
      {/* Top Banner (VEED.IO style) */}
      <div className="flex flex-wrap items-center justify-between gap-3 bg-neutral-900 border border-neutral-800 rounded-2xl p-4 shadow-sm">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-lime-500/10 border border-lime-500/30 flex items-center justify-center text-lime-400">
            <CheckCircle2 className="w-5 h-5" />
          </div>
          <div>
            <h2 className="text-sm font-semibold text-neutral-100 flex items-center gap-2">
              <span>Masks Generated Successfully</span>
              <span className="text-[10px] font-mono font-normal px-2 py-0.5 rounded bg-lime-500/10 text-lime-400 border border-lime-500/20">
                SAM 2 Output Ready
              </span>
            </h2>
            <p className="text-xs text-neutral-400 font-mono">
              {totalFrames} frames ({videoWidth}×{videoHeight} @ {fps.toFixed(1)}fps) • 8-bit Grayscale PNGs
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2.5">
          {onAddAnotherSubject && (
            <button
              type="button"
              onClick={() => onAddAnotherSubject(currentFrame)}
              className="flex items-center gap-1.5 px-3 py-2 rounded-xl border border-neutral-700 bg-neutral-900 hover:bg-neutral-800 text-neutral-200 text-xs font-medium transition active:scale-95 shadow-sm"
              title="Add another subject or mask to merge with these generated masks"
            >
              <PlusCircle className="w-3.5 h-3.5 text-lime-400" />
              <span>Add / Refine Mask</span>
            </button>
          )}

          {/* Download Button in Veed signature lime */}
          <a
            href={outputZipUrl}
            download="output_masks.zip"
            className="flex items-center gap-2 px-4 py-2 rounded-xl bg-lime-500 hover:bg-lime-400 text-neutral-950 text-xs font-bold transition active:scale-95 shadow-md"
          >
            <Download className="w-4 h-4 stroke-[2.5]" />
            <span>Download ZIP ({totalFrames} PNGs)</span>
          </a>

          <button
            type="button"
            onClick={onReset}
            className="flex items-center gap-1.5 px-3 py-2 rounded-xl border border-neutral-800 hover:bg-neutral-800 text-neutral-400 hover:text-neutral-200 text-xs font-medium transition"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span>New Video</span>
          </button>
        </div>
      </div>

      {/* Main Preview Container */}
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-4 items-start">
        {/* Visualizer Player Viewport */}
        <div className="lg:col-span-3 flex flex-col gap-3">
          <div
            ref={containerRef}
            className={`relative w-full bg-neutral-950 rounded-2xl overflow-hidden border border-neutral-800 select-none ${
              viewMode === 'split' ? 'grid grid-cols-2 gap-1 p-1' : 'aspect-video'
            }`}
          >
            {/* Split View Mode */}
            {viewMode === 'split' ? (
              <>
                {/* Left: Original Video */}
                <div className="relative aspect-video bg-neutral-900/60 rounded-xl overflow-hidden border border-neutral-800/80 flex flex-col items-center justify-center">
                  <span className="absolute top-2 left-2 z-10 px-2 py-0.5 rounded bg-neutral-950/80 text-[10px] font-mono text-neutral-300 border border-neutral-800">
                    Source Video
                  </span>
                  <video
                    ref={videoRef}
                    src={videoSrc}
                    playsInline
                    onPlay={() => setIsPlaying(true)}
                    onPause={() => setIsPlaying(false)}
                    className="w-full h-full object-contain pointer-events-none"
                  />
                </div>

                {/* Right: Propagated Mask Frame */}
                <div className="relative aspect-video bg-neutral-900/60 rounded-xl overflow-hidden border border-neutral-800/80 flex flex-col items-center justify-center">
                  <span className="absolute top-2 left-2 z-10 px-2 py-0.5 rounded bg-neutral-950/80 text-[10px] font-mono text-neutral-300 border border-neutral-800">
                    Propagated Mask
                  </span>
                  <img
                    src={maskUrl}
                    alt={`Frame ${currentFrame} Mask`}
                    className="w-full h-full object-contain pointer-events-none"
                  />
                </div>
              </>
            ) : viewMode === 'mask-only' ? (
              /* Binary Mask Only Mode */
              <div className="relative w-full h-full flex items-center justify-center bg-black">
                <video
                  ref={videoRef}
                  src={videoSrc}
                  playsInline
                  onPlay={() => setIsPlaying(true)}
                  onPause={() => setIsPlaying(false)}
                  className="hidden"
                />
                <img
                  src={maskUrl}
                  alt={`Frame ${currentFrame} Mask`}
                  className="w-full h-full object-contain pointer-events-none"
                />
                <span className="absolute top-2 left-2 z-10 px-2 py-0.5 rounded bg-neutral-950/80 text-[10px] font-mono text-neutral-300 border border-neutral-800">
                  Binary Mask
                </span>
              </div>
            ) : (
              /* Synchronous Canvas Overlay / Wipe Mode */
              <>
                <video
                  ref={videoRef}
                  src={videoSrc}
                  playsInline
                  onPlay={() => setIsPlaying(true)}
                  onPause={() => setIsPlaying(false)}
                  className="absolute inset-0 w-full h-full object-contain pointer-events-none"
                />
                {/* Synchronized Mask Canvas */}
                <canvas
                  ref={canvasRef}
                  className="absolute pointer-events-none select-none"
                  style={{
                    left: `${renderRect.offsetX}px`,
                    top: `${renderRect.offsetY}px`,
                    width: `${renderRect.renderWidth}px`,
                    height: `${renderRect.renderHeight}px`,
                  }}
                />

                {/* Interactive Wipe Split Divider Handle */}
                {viewMode === 'wipe' && (
                  <div
                    onPointerDown={handleWipePointerDown}
                    onPointerMove={handleWipePointerMove}
                    onPointerUp={handleWipePointerUp}
                    className="absolute top-0 bottom-0 z-30 flex flex-col items-center cursor-ew-resize group"
                    style={{ left: `${wipeSplitRatio * 100}%` }}
                  >
                    <div className="w-0.5 h-full bg-white shadow-[0_0_8px_rgba(255,255,255,0.8)]" />
                    <div className="absolute top-1/2 -translate-y-1/2 w-7 h-7 rounded-full bg-white text-neutral-950 flex items-center justify-center shadow-lg border border-neutral-300 transform -translate-x-1/2 hover:scale-110 active:scale-95 transition">
                      <Split className="w-3.5 h-3.5" />
                    </div>
                  </div>
                )}

                <div className="absolute top-3 left-3 z-10 flex items-center gap-1.5">
                  <span className="px-2 py-0.5 rounded-md bg-neutral-950/80 backdrop-blur text-[10px] font-mono text-neutral-300 border border-neutral-800 shadow">
                    {viewMode === 'wipe' ? 'Split Curtain Wipe' : 'Synced Overlay'}
                  </span>
                </div>

                <button
                  type="button"
                  onClick={toggleFullscreen}
                  title="Toggle Fullscreen"
                  className="absolute top-3 right-3 z-10 p-1.5 rounded-lg bg-neutral-950/80 hover:bg-neutral-800 text-neutral-300 hover:text-white border border-neutral-800 transition"
                >
                  <Maximize2 className="w-3.5 h-3.5" />
                </button>
              </>
            )}
          </div>

          {/* Timeline and Scrubber */}
          <div className="bg-neutral-900 border border-neutral-800 rounded-2xl p-3.5 flex flex-col gap-2.5">
            <div className="flex items-center justify-between text-xs font-mono text-neutral-400">
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={togglePlay}
                  className="p-2 rounded-lg bg-lime-500 hover:bg-lime-400 text-neutral-950 font-bold transition shadow-sm"
                  title={isPlaying ? 'Pause' : 'Play'}
                >
                  {isPlaying ? <Pause className="w-3.5 h-3.5 fill-current" /> : <Play className="w-3.5 h-3.5 fill-current ml-0.5" />}
                </button>
                <button
                  type="button"
                  onClick={() => stepFrame(-1)}
                  className="p-1.5 rounded-lg hover:bg-neutral-800 text-neutral-400 hover:text-neutral-200 transition"
                  title="Previous frame (←)"
                >
                  <ChevronLeft className="w-4 h-4" />
                </button>
                <button
                  type="button"
                  onClick={() => stepFrame(1)}
                  className="p-1.5 rounded-lg hover:bg-neutral-800 text-neutral-400 hover:text-neutral-200 transition"
                  title="Next frame (→)"
                >
                  <ChevronRight className="w-4 h-4" />
                </button>
              </div>

              {/* Playback Speed selector */}
              <div className="flex items-center gap-1 bg-neutral-950 p-1 rounded-lg border border-neutral-800 text-[10px]">
                <Gauge className="w-3 h-3 text-neutral-400 ml-1" />
                {[0.25, 0.5, 1, 2].map((speed) => (
                  <button
                    key={speed}
                    type="button"
                    onClick={() => setPlaybackSpeed(speed)}
                    className={`px-1.5 py-0.5 rounded transition ${
                      playbackSpeed === speed
                        ? 'bg-neutral-800 text-lime-400 font-bold'
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
                  {(currentFrame / fps).toFixed(2)}s
                </span>
              </div>
            </div>

            {/* Slider track */}
            <input
              type="range"
              min={0}
              max={Math.max(0, totalFrames - 1)}
              value={currentFrame}
              onChange={(e) => seekToFrame(parseInt(e.target.value, 10))}
              className="w-full h-1.5 bg-neutral-800 rounded-lg appearance-none cursor-pointer accent-lime-400"
            />
          </div>
        </div>

        {/* Sidebar Preview Controls */}
        <div className="flex flex-col gap-4 bg-neutral-900 border border-neutral-800 rounded-2xl p-4">
          <div className="flex items-center gap-1.5 border-b border-neutral-800 pb-2.5">
            <Sliders className="w-3.5 h-3.5 text-lime-400" />
            <span className="text-xs font-semibold text-neutral-200">Display Modes</span>
          </div>

          {/* Mode Selector */}
          <div className="flex flex-col gap-1.5">
            <label className="text-[10px] font-mono text-neutral-400 uppercase tracking-wider">
              Layout Mode
            </label>
            <div className="grid grid-cols-2 gap-1.5 bg-neutral-950 p-1 rounded-xl border border-neutral-800">
              <button
                type="button"
                onClick={() => setViewMode('overlay')}
                className={`flex items-center gap-1.5 p-2 rounded-lg text-xs font-medium transition ${
                  viewMode === 'overlay'
                    ? 'bg-neutral-800 text-white shadow-sm'
                    : 'text-neutral-400 hover:text-neutral-200'
                }`}
              >
                <Layers className="w-3.5 h-3.5" />
                <span>Overlay</span>
              </button>
              <button
                type="button"
                onClick={() => setViewMode('wipe')}
                className={`flex items-center gap-1.5 p-2 rounded-lg text-xs font-medium transition ${
                  viewMode === 'wipe'
                    ? 'bg-neutral-800 text-lime-400 shadow-sm font-semibold'
                    : 'text-neutral-400 hover:text-neutral-200'
                }`}
              >
                <Split className="w-3.5 h-3.5" />
                <span>Curtain Wipe</span>
              </button>
              <button
                type="button"
                onClick={() => setViewMode('split')}
                className={`flex items-center gap-1.5 p-2 rounded-lg text-xs font-medium transition ${
                  viewMode === 'split'
                    ? 'bg-neutral-800 text-white shadow-sm'
                    : 'text-neutral-400 hover:text-neutral-200'
                }`}
              >
                <Columns className="w-3.5 h-3.5" />
                <span>Side-by-Side</span>
              </button>
              <button
                type="button"
                onClick={() => setViewMode('mask-only')}
                className={`flex items-center gap-1.5 p-2 rounded-lg text-xs font-medium transition ${
                  viewMode === 'mask-only'
                    ? 'bg-neutral-800 text-white shadow-sm'
                    : 'text-neutral-400 hover:text-neutral-200'
                }`}
              >
                <Eye className="w-3.5 h-3.5" />
                <span>Mask Only</span>
              </button>
            </div>
          </div>

          {/* Color Tint Selector (for overlay / wipe) */}
          {(viewMode === 'overlay' || viewMode === 'wipe') && (
            <div className="flex flex-col gap-1.5">
              <label className="text-[10px] font-mono text-neutral-400 uppercase tracking-wider">
                Overlay Tint
              </label>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setOverlayColor('cyan')}
                  className={`flex-1 py-1.5 rounded-lg text-xs font-medium border transition ${
                    overlayColor === 'cyan'
                      ? 'border-cyan-500 bg-cyan-950/40 text-cyan-300 font-bold'
                      : 'border-neutral-800 bg-neutral-950 text-neutral-400 hover:border-neutral-700'
                  }`}
                >
                  Cyan
                </button>
                <button
                  type="button"
                  onClick={() => setOverlayColor('lime')}
                  className={`flex-1 py-1.5 rounded-lg text-xs font-medium border transition ${
                    overlayColor === 'lime'
                      ? 'border-lime-500 bg-lime-950/40 text-lime-300 font-bold'
                      : 'border-neutral-800 bg-neutral-950 text-neutral-400 hover:border-neutral-700'
                  }`}
                >
                  Lime
                </button>
                <button
                  type="button"
                  onClick={() => setOverlayColor('red')}
                  className={`flex-1 py-1.5 rounded-lg text-xs font-medium border transition ${
                    overlayColor === 'red'
                      ? 'border-red-500 bg-red-950/40 text-red-300 font-bold'
                      : 'border-neutral-800 bg-neutral-950 text-neutral-400 hover:border-neutral-700'
                  }`}
                >
                  Red
                </button>
              </div>
            </div>
          )}

          {/* Opacity Slider */}
          {(viewMode === 'overlay' || viewMode === 'wipe') && (
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between text-xs">
                <span className="text-neutral-400">Opacity</span>
                <span className="font-mono text-neutral-200">{Math.round(overlayOpacity * 100)}%</span>
              </div>
              <input
                type="range"
                min={0.1}
                max={1.0}
                step={0.05}
                value={overlayOpacity}
                onChange={(e) => setOverlayOpacity(parseFloat(e.target.value))}
                className="w-full h-1.5 bg-neutral-800 rounded-lg appearance-none cursor-pointer accent-lime-400"
              />
            </div>
          )}

          {/* Mask format info */}
          <div className="text-[11px] text-neutral-400 bg-neutral-950 p-3 rounded-xl border border-neutral-800 leading-relaxed font-mono">
            <span className="text-lime-400 font-semibold block mb-1">Export Specifications:</span>
            • 8-bit single-channel grayscale PNGs<br />
            • Sequential names: <code className="text-white">00000.png</code> ...<br />
            • Dimensions: {videoWidth}×{videoHeight} (1:1 native)<br />
            • Ready for VFX & inpainting pipelines
          </div>
        </div>
      </div>
    </div>
  );
};
