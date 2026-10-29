import React from 'react';
import { Play, Pause, ChevronLeft, ChevronRight, Bookmark } from 'lucide-react';

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
  const currentTimeSec = fps > 0 ? (currentFrame / fps).toFixed(2) : '0.00';
  const totalTimeSec = fps > 0 ? (totalFrames / fps).toFixed(2) : '0.00';

  // Union of keyframe indices and annotated frame
  const allKeyframes = Array.from(new Set([
    ...(annotatedFrameIdx !== null ? [annotatedFrameIdx] : []),
    ...keyframeIndices
  ])).sort((a, b) => a - b);

  const handleSliderChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    onSeekFrame(parseInt(e.target.value, 10));
  };

  return (
    <div className="w-full bg-neutral-900 border border-neutral-800 rounded-xl p-3 flex flex-col gap-2.5 select-none">
      {/* Scrubber track and keyframe indicators */}
      <div className="relative w-full flex items-center">
        <input
          type="range"
          min={0}
          max={Math.max(0, totalFrames - 1)}
          value={currentFrame}
          onChange={handleSliderChange}
          disabled={disabled}
          className="w-full h-1.5 bg-neutral-800 rounded-lg appearance-none cursor-pointer accent-neutral-100 focus:outline-none disabled:opacity-40"
        />

        {/* Pin markers for annotated keyframes */}
        {totalFrames > 0 && allKeyframes.map((kfIdx) => (
          <div
            key={kfIdx}
            title={`Keyframe: ${kfIdx}`}
            className="absolute top-1/2 -translate-y-1/2 w-2 h-2 bg-neutral-100 rounded-full border border-neutral-950 pointer-events-none transform -translate-x-1/2 cursor-pointer"
            style={{
              left: `${(kfIdx / Math.max(1, totalFrames - 1)) * 100}%`,
            }}
          />
        ))}
      </div>

      {/* Control buttons & Frame Readout */}
      <div className="flex items-center justify-between text-xs text-neutral-300">
        <div className="flex items-center gap-1.5">
          {/* Step Backward 1 Frame */}
          <button
            type="button"
            onClick={() => onStepFrame(-1)}
            disabled={disabled || currentFrame <= 0}
            title="Step Back 1 Frame"
            className="p-1.5 rounded-md bg-neutral-800 hover:bg-neutral-700 active:scale-95 disabled:opacity-30 disabled:hover:bg-neutral-800 transition"
          >
            <ChevronLeft className="w-4 h-4 text-neutral-300" />
          </button>

          {/* Play / Pause Toggle */}
          <button
            type="button"
            onClick={onTogglePlay}
            disabled={disabled}
            title={isPlaying ? 'Pause' : 'Play'}
            className="p-1.5 px-2.5 rounded-md bg-neutral-100 hover:bg-white text-neutral-950 font-medium active:scale-95 disabled:opacity-40 transition"
          >
            {isPlaying ? (
              <Pause className="w-4 h-4 fill-current" />
            ) : (
              <Play className="w-4 h-4 fill-current ml-0.5" />
            )}
          </button>

          {/* Step Forward 1 Frame */}
          <button
            type="button"
            onClick={() => onStepFrame(1)}
            disabled={disabled || currentFrame >= totalFrames - 1}
            title="Step Forward 1 Frame"
            className="p-1.5 rounded-md bg-neutral-800 hover:bg-neutral-700 active:scale-95 disabled:opacity-30 disabled:hover:bg-neutral-800 transition"
          >
            <ChevronRight className="w-4 h-4 text-neutral-300" />
          </button>

          {/* Jump to Annotated Frame button if set */}
          {annotatedFrameIdx !== null && (
            <button
              type="button"
              onClick={() => onSeekFrame(annotatedFrameIdx)}
              title={`Jump to annotated frame ${annotatedFrameIdx}`}
              className="ml-1.5 flex items-center gap-1 px-2 py-1 rounded-md bg-neutral-800 hover:bg-neutral-700 text-neutral-300 text-[11px] font-mono transition"
            >
              <Bookmark className="w-3 h-3 text-neutral-200" />
              <span>Frame {annotatedFrameIdx}</span>
            </button>
          )}
        </div>

        {/* Time and Frame Counter */}
        <div className="flex items-center gap-3 font-mono text-[11px] text-neutral-400">
          <div>
            Frame: <span className="text-neutral-100 font-semibold">{currentFrame}</span>
            <span className="text-neutral-600"> / {totalFrames > 0 ? totalFrames - 1 : 0}</span>
          </div>
          <div>
            Time: <span className="text-neutral-100 font-semibold">{currentTimeSec}s</span>
            <span className="text-neutral-600"> / {totalTimeSec}s</span>
          </div>
        </div>
      </div>
    </div>
  );
};
