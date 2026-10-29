import React from 'react';
import {
  Check,
  Clock,
  Layers,
  PackageCheck,
  AlertCircle,
  Loader2,
} from 'lucide-react';
import { JobProgressEvent, PipelineStage } from '../types/api';

interface LiveProgressTrackerProps {
  progress: JobProgressEvent;
  elapsedSeconds?: number;
  totalFrames?: number;
  annotatedFrameIdx?: number | null;
  onCancel?: () => void;
  isCancelling?: boolean;
}

interface StageStep {
  stage: PipelineStage;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}

const PIPELINE_STEPS: StageStep[] = [
  { stage: 'sam2_forward', label: 'SAM 2 Forward', icon: Layers },
  { stage: 'sam2_backward', label: 'SAM 2 Backward', icon: Layers },
  { stage: 'packaging', label: 'Packaging PNG masks', icon: PackageCheck },
];

const STAGE_ORDER: Record<PipelineStage, number> = {
  queued: 0,
  sam2_forward: 0,
  sam2_backward: 1,
  packaging: 2,
  completed: 3,
  failed: -1,
  cancelled: -1,
};

export const LiveProgressTracker: React.FC<LiveProgressTrackerProps> = ({
  progress,
  elapsedSeconds = 0,
  totalFrames,
  annotatedFrameIdx,
  onCancel,
  isCancelling = false,
}) => {
  const currentStepIdx = STAGE_ORDER[progress.stage] ?? 0;
  const isFailed = progress.stage === 'failed';
  const isCompleted = progress.stage === 'completed';
  const isCancelled = progress.stage === 'cancelled';

  const formatTime = (secs: number) => {
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  return (
    <div className="flex flex-col gap-4 bg-neutral-900 border border-neutral-800 rounded-xl p-5 select-none">
      {/* Top telemetry bar */}
      <div className="flex items-center justify-between flex-wrap gap-2 text-xs">
        <div className="flex items-center gap-2">
          {!isFailed && !isCancelled && !isCompleted ? (
            <Loader2 className="w-4 h-4 animate-spin text-neutral-100" />
          ) : isCompleted ? (
            <Check className="w-4 h-4 text-emerald-400" />
          ) : (
            <AlertCircle className="w-4 h-4 text-neutral-400" />
          )}
          <span className="font-medium text-neutral-200">
            {progress.message ||
              (isCancelled
                ? 'Generation cancelled'
                : isFailed
                ? 'Pipeline failed'
                : 'Generating video masks...')}
          </span>
        </div>

        <div className="flex items-center gap-2 font-mono text-[11px] text-neutral-400">
          <div className="flex items-center gap-1 bg-neutral-950 px-2 py-1 rounded border border-neutral-800">
            <Clock className="w-3 h-3 text-neutral-400" />
            <span>{formatTime(elapsedSeconds)}</span>
          </div>
          {totalFrames && (
            <div className="bg-neutral-950 px-2 py-1 rounded border border-neutral-800">
              <span>{totalFrames} frames</span>
            </div>
          )}
          {annotatedFrameIdx !== null && annotatedFrameIdx !== undefined && (
            <div className="bg-neutral-950 px-2 py-1 rounded border border-neutral-800">
              <span>Frame #{annotatedFrameIdx}</span>
            </div>
          )}
          {onCancel && !isFailed && !isCompleted && progress.stage !== 'cancelled' && (
            <button
              type="button"
              onClick={onCancel}
              disabled={isCancelling}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded border border-neutral-700 bg-neutral-950 hover:bg-neutral-800 text-neutral-300 hover:text-neutral-100 text-[11px] font-sans font-medium transition active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed disabled:active:scale-100"
              title="Cancel mask generation"
            >
              {isCancelling && <Loader2 className="w-3 h-3 animate-spin text-neutral-400" />}
              <span>{isCancelling ? 'Cancelling...' : 'Cancel'}</span>
            </button>
          )}
        </div>
      </div>

      {/* Sleek monochromatic progress line */}
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between font-mono text-[11px]">
          <span className="text-neutral-400 uppercase tracking-wider text-[10px]">Progress</span>
          <span className="text-neutral-100 font-semibold">{progress.progress}%</span>
        </div>
        <div className="w-full h-1 bg-neutral-950 rounded-full overflow-hidden border border-neutral-800">
          <div
            className={`h-full transition-all duration-300 ${
              isFailed || isCancelled ? 'bg-neutral-500' : 'bg-neutral-100'
            }`}
            style={{ width: `${Math.max(2, progress.progress)}%` }}
          />
        </div>
      </div>

      {/* 5-step stages list */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 pt-1">
        {PIPELINE_STEPS.map((step, idx) => {
          const StepIcon = step.icon;
          const isCurrent = currentStepIdx === idx;
          const isDone = currentStepIdx > idx || isCompleted;

          return (
            <div
              key={step.stage}
              className={`flex items-center gap-2 p-2.5 rounded-lg border text-xs transition-all ${
                isCurrent
                  ? 'bg-neutral-950 border-neutral-600 text-neutral-100'
                  : isDone
                  ? 'bg-neutral-950/60 border-neutral-800 text-neutral-400'
                  : 'bg-neutral-950/30 border-neutral-900 text-neutral-600'
              }`}
            >
              <div
                className={`w-5 h-5 rounded flex items-center justify-center flex-shrink-0 ${
                  isCurrent
                    ? 'bg-neutral-100 text-neutral-950'
                    : isDone
                    ? 'bg-neutral-800 text-neutral-200'
                    : 'bg-neutral-900 text-neutral-600'
                }`}
              >
                {isDone ? <Check className="w-3 h-3" /> : <StepIcon className="w-3 h-3" />}
              </div>
              <span className="truncate font-mono text-[11px]">{step.label}</span>
            </div>
          );
        })}
      </div>

      {isFailed && (
        <div className="flex items-center gap-2 bg-neutral-950 border border-neutral-700 p-3 rounded-lg text-xs text-neutral-300">
          <AlertCircle className="w-4 h-4 text-neutral-100" />
          <span>{progress.message || 'Pipeline failed'}</span>
        </div>
      )}

      {isCancelled && (
        <div className="flex items-center gap-2 bg-neutral-950 border border-neutral-700 p-3 rounded-lg text-xs text-neutral-300">
          <AlertCircle className="w-4 h-4 text-neutral-400" />
          <span>{progress.message || 'Generation cancelled'}</span>
        </div>
      )}
    </div>
  );
};
