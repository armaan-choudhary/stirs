import React, { useState, useRef } from 'react';
import {
  Play,
  Pause,
  ChevronLeft,
  ChevronRight,
  SkipBack,
  SkipForward,
  Bookmark,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';

interface TimelineControlsProps {
  currentFrame: number;
  totalFrames: number;
  fps: number;
  isPlaying: boolean;
  onTogglePlay: () => void;
  onSeekFrame: (frame: number) => void;
  onStepFrame: (delta: number) => void;
  annotatedFrameIdx?: number | null;
  keyframeIndices?: number[];
  disabled?: boolean;
}

export const TimelineControls: React.FC<TimelineControlsProps> = ({
  currentFrame,
  totalFrames,
  fps,
  isPlaying,
  onTogglePlay,
  onSeekFrame,
  onStepFrame,
  annotatedFrameIdx = null,
  keyframeIndices = [],
  disabled = false,
}) => {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [zoomLevel, setZoomLevel] = useState<number>(1);
  const [hoverFrame, setHoverFrame] = useState<number | null>(null);
  const [hoverPos, setHoverPos] = useState<number | null>(null);

  const formatTime = (frame: number): string => {
    if (fps <= 0) return '00:00.0';
    const totalSec = frame / fps;
    const mins = Math.floor(totalSec / 60);
    const secs = (totalSec % 60).toFixed(1);
    const paddedSecs = parseFloat(secs) < 10 ? `0${secs}` : secs;
    return `${String(mins).padStart(2, '0')}:${paddedSecs}`;
  };

  const currentTimeStr = formatTime(currentFrame);
  const totalTimeStr = formatTime(Math.max(0, totalFrames - 1));

  // Sorted list of unique keyframe indices
  const allKeyframes = Array.from(
    new Set([
      ...(annotatedFrameIdx !== null ? [annotatedFrameIdx] : []),
      ...keyframeIndices,
    ])
  ).sort((a, b) => a - b);

  // Jump to previous keyframe or start
  const handleJumpPrevKeyframe = () => {
    if (allKeyframes.length === 0) {
      onSeekFrame(0);
      return;
    }
    const prevs = allKeyframes.filter((k) => k < currentFrame);
    if (prevs.length > 0) {
      onSeekFrame(prevs[prevs.length - 1]);
    } else {
      onSeekFrame(0);
    }
  };

  // Jump to next keyframe or end
  const handleJumpNextKeyframe = () => {
    if (allKeyframes.length === 0) {
      onSeekFrame(Math.max(0, totalFrames - 1));
      return;
    }
    const nexts = allKeyframes.filter((k) => k > currentFrame);
    if (nexts.length > 0) {
      onSeekFrame(nexts[0]);
    } else {
      onSeekFrame(Math.max(0, totalFrames - 1));
    }
  };

  // Click on track to scrub
  const handleTrackClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (disabled || !trackRef.current || totalFrames <= 0) return;
    const rect = trackRef.current.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const targetFrame = Math.round(ratio * (totalFrames - 1));
    onSeekFrame(targetFrame);
  };

  // Mouse move on track for hover preview
  const handleTrackMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!trackRef.current || totalFrames <= 0) return;
    const rect = trackRef.current.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const targetFrame = Math.round(ratio * (totalFrames - 1));
    setHoverFrame(targetFrame);
    setHoverPos(e.clientX - rect.left);
  };

  const handleTrackMouseLeave = () => {
    setHoverFrame(null);
    setHoverPos(null);
  };

  // Generate ruler tick marks
  const totalSeconds = fps > 0 ? Math.ceil(totalFrames / fps) : 10;
  const tickInterval = totalSeconds > 60 ? 10 : totalSeconds > 20 ? 5 : totalSeconds > 10 ? 2 : 1;
  const rulerTicks: { sec: number; percent: number }[] = [];
  for (let s = 0; s <= totalSeconds; s += tickInterval) {
    const f = s * fps;
    if (f < totalFrames) {
      rulerTicks.push({
        sec: s,
        percent: (f / Math.max(1, totalFrames - 1)) * 100,
      });
    }
  }

  const currentPercent = totalFrames > 1 ? (currentFrame / (totalFrames - 1)) * 100 : 0;

  return (
    <div className="w-full bg-neutral-900 border border-neutral-800 rounded-xl p-3 flex flex-col gap-3 select-none shadow-sm">
      {/* 1. Header Row: Playback Controls & Frame Counter */}
      <div className="flex items-center justify-between text-xs text-neutral-300">
        {/* Left: Playhead transport controls */}
        <div className="flex items-center gap-1.5">
          {/* Jump Prev Keyframe */}
          <button
            type="button"
            onClick={handleJumpPrevKeyframe}
            disabled={disabled || currentFrame <= 0}
            title="Jump to Previous Keyframe ([)"
            className="p-1.5 rounded-md hover:bg-neutral-800 text-neutral-400 hover:text-white transition disabled:opacity-30"
          >
            <SkipBack className="w-3.5 h-3.5" />
          </button>

          {/* Step Back 1 Frame */}
          <button
            type="button"
            onClick={() => onStepFrame(-1)}
            disabled={disabled || currentFrame <= 0}
            title="Step Back 1 Frame (←)"
            className="p-1.5 rounded-md hover:bg-neutral-800 text-neutral-300 hover:text-white transition disabled:opacity-30"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>

          {/* Play / Pause Toggle (Lime green / dark accent) */}
          <button
            type="button"
            onClick={onTogglePlay}
            disabled={disabled}
            title={isPlaying ? 'Pause (Space)' : 'Play (Space)'}
            className="px-3 py-1.5 rounded-lg bg-lime-500 hover:bg-lime-400 text-neutral-950 font-bold active:scale-95 disabled:opacity-40 transition shadow-sm flex items-center justify-center"
          >
            {isPlaying ? (
              <Pause className="w-3.5 h-3.5 fill-current" />
            ) : (
              <Play className="w-3.5 h-3.5 fill-current ml-0.5" />
            )}
          </button>

          {/* Step Forward 1 Frame */}
          <button
            type="button"
            onClick={() => onStepFrame(1)}
            disabled={disabled || currentFrame >= totalFrames - 1}
            title="Step Forward 1 Frame (→)"
            className="p-1.5 rounded-md hover:bg-neutral-800 text-neutral-300 hover:text-white transition disabled:opacity-30"
          >
            <ChevronRight className="w-4 h-4" />
          </button>

          {/* Jump Next Keyframe */}
          <button
            type="button"
            onClick={handleJumpNextKeyframe}
            disabled={disabled || currentFrame >= totalFrames - 1}
            title="Jump to Next Keyframe (])"
            className="p-1.5 rounded-md hover:bg-neutral-800 text-neutral-400 hover:text-white transition disabled:opacity-30"
          >
            <SkipForward className="w-3.5 h-3.5" />
          </button>

          {/* Time Counter */}
          <div className="ml-3 font-mono text-xs flex items-center gap-1.5 text-neutral-400">
            <span className="text-neutral-100 font-semibold">{currentTimeStr}</span>
            <span className="text-neutral-600">/</span>
            <span>{totalTimeStr}</span>
          </div>
        </div>

        {/* Center: Frame details */}
        <div className="hidden sm:flex items-center gap-2 font-mono text-[11px] text-neutral-400">
          <span className="px-2 py-0.5 rounded bg-neutral-950 border border-neutral-800 text-neutral-300">
            Frame <strong className="text-neutral-100">{currentFrame}</strong> / {Math.max(0, totalFrames - 1)}
          </span>
          <span className="text-neutral-500">
            {fps > 0 ? fps.toFixed(1) : 30} FPS
          </span>
        </div>

        {/* Right: Keyframes count & Zoom slider */}
        <div className="flex items-center gap-3">
          {allKeyframes.length > 0 && (
            <div className="flex items-center gap-1 text-[11px] font-mono text-amber-400 bg-amber-950/40 border border-amber-900/60 px-2 py-0.5 rounded-md">
              <Bookmark className="w-3 h-3 fill-current" />
              <span>{allKeyframes.length} Keyframe{allKeyframes.length > 1 ? 's' : ''}</span>
            </div>
          )}

          {/* Zoom Level Indicator */}
          <div className="hidden md:flex items-center gap-1.5 text-neutral-500">
            <ZoomOut className="w-3 h-3" />
            <input
              type="range"
              min={1}
              max={3}
              step={0.5}
              value={zoomLevel}
              onChange={(e) => setZoomLevel(parseFloat(e.target.value))}
              className="w-16 h-1 bg-neutral-800 rounded appearance-none cursor-pointer accent-neutral-300"
            />
            <ZoomIn className="w-3 h-3" />
            <button
              type="button"
              onClick={() => setZoomLevel(1)}
              className="text-[10px] font-mono px-1 rounded hover:bg-neutral-800 text-neutral-400"
              title="Fit to window"
            >
              Fit
            </button>
          </div>
        </div>
      </div>

      {/* 2. Professional Timeline Track Area */}
      <div className="relative w-full flex flex-col gap-1">
        {/* Seconds Ruler */}
        <div className="relative w-full h-4 overflow-hidden text-[10px] font-mono text-neutral-500 border-b border-neutral-800">
          {rulerTicks.map((tick) => (
            <div
              key={tick.sec}
              className="absolute top-0 flex flex-col items-center -translate-x-1/2"
              style={{ left: `${tick.percent}%` }}
            >
              <div className="w-px h-1.5 bg-neutral-700" />
              <span className="text-[9px] text-neutral-400">{tick.sec}s</span>
            </div>
          ))}
        </div>

        {/* Interactive Track Area */}
        <div
          ref={trackRef}
          onClick={handleTrackClick}
          onMouseMove={handleTrackMouseMove}
          onMouseLeave={handleTrackMouseLeave}
          className="relative w-full h-8 bg-neutral-950 rounded-lg border border-neutral-800/80 cursor-pointer overflow-hidden group shadow-inner"
        >
          {/* Track background strip */}
          <div className="absolute inset-x-0 inset-y-1 bg-neutral-850/60 rounded border border-neutral-800 flex items-center px-3">
            <span className="text-[10px] font-mono text-neutral-400 select-none">
              Source Video Stream
            </span>
          </div>

          {/* Played progress fill */}
          <div
            className="absolute top-1 bottom-1 left-0 bg-lime-500/10 border-r border-lime-500/40 pointer-events-none"
            style={{ width: `${currentPercent}%` }}
          />

          {/* Keyframe Diamond Badges (Clickable pins) */}
          {allKeyframes.map((kfIdx) => {
            const isCur = kfIdx === currentFrame;
            const leftPct = (kfIdx / Math.max(1, totalFrames - 1)) * 100;
            return (
              <button
                key={kfIdx}
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onSeekFrame(kfIdx);
                }}
                title={`Keyframe ${kfIdx} - Click to jump`}
                className={`absolute top-1/2 -translate-y-1/2 -translate-x-1/2 z-20 w-3.5 h-3.5 rotate-45 transition transform hover:scale-125 focus:outline-none ${
                  isCur
                    ? 'bg-amber-400 border border-white shadow-[0_0_8px_rgba(251,191,36,0.8)]'
                    : 'bg-amber-500/80 border border-neutral-900 hover:bg-amber-400'
                }`}
                style={{ left: `${leftPct}%` }}
              />
            );
          })}

          {/* Hover preview marker */}
          {hoverPos !== null && hoverFrame !== null && (
            <div
              className="absolute top-0 bottom-0 w-px bg-white/40 pointer-events-none z-10"
              style={{ left: `${hoverPos}px` }}
            >
              <div className="absolute -top-6 left-1/2 -translate-x-1/2 bg-neutral-900 border border-neutral-700 px-1.5 py-0.5 rounded text-[10px] font-mono text-white shadow pointer-events-none whitespace-nowrap">
                F{hoverFrame} ({formatTime(hoverFrame)})
              </div>
            </div>
          )}

          {/* Red Needle Playhead */}
          <div
            className="absolute top-0 bottom-0 w-0.5 bg-red-500 z-30 pointer-events-none transform -translate-x-1/2"
            style={{ left: `${currentPercent}%` }}
          >
            {/* Scrubber thumb handle at top */}
            <div className="absolute -top-1 left-1/2 -translate-x-1/2 w-3 h-3 bg-red-500 rounded-full border-2 border-white shadow-md" />
          </div>
        </div>
      </div>
    </div>
  );
};
