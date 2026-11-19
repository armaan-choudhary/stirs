import React from 'react';
import {
  Check,
  Clock,
  Layers,
  Sparkles,
  PackageCheck,
  AlertCircle,
  Loader2,
  Cpu,
  ShieldCheck,
  RotateCcw,
  Play,
  X,
  FileQuestion,
} from 'lucide-react';
import { RemovalProgressEvent, RemovalStage } from '../types/api';
import { parseActionableError } from '../utils/removalUtils';

export interface RemovalProgressTrackerProps {
  progress: RemovalProgressEvent;
  elapsedSeconds?: number;
  onCancel?: () => void;
  isCancelling?: boolean;
  onRetry?: () => void;
  onViewResult?: () => void;
  onDismiss?: () => void;
}

interface RemovalStep {
  stage: RemovalStage;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}

const REMOVAL_STEPS: RemovalStep[] = [
  { stage: 'preparing_input', label: 'Preparing Input', icon: Layers },
  { stage: 'loading_model', label: 'Loading Model', icon: Cpu },
  { stage: 'inference', label: 'EffectErase Inference', icon: Sparkles },
  { stage: 'validating_output', label: 'Validating Video', icon: ShieldCheck },
  { stage: 'publishing', label: 'Publishing', icon: PackageCheck },
];

const STAGE_ORDER: Record<RemovalStage, number> = {
  queued: 0,
  preparing_input: 0,
  loading_model: 1,
  inference: 2,
  validating_output: 3,
  publishing: 4,
  completed: 5,
  failed: -1,
  cancelled: -1,
};

function formatTime(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export const RemovalProgressTracker: React.FC<RemovalProgressTrackerProps> = ({
  progress,
  elapsedSeconds = 0,
  onCancel,
  isCancelling = false,
  onRetry,
  onViewResult,
  onDismiss,
}) => {
  const currentStepIdx = STAGE_ORDER[progress.stage] ?? 0;
  const isFailed = progress.stage === 'failed';
  const isCompleted = progress.stage === 'completed';
  const isCancelled = progress.stage === 'cancelled';
  const isActive = !isFailed && !isCancelled && !isCompleted;

  const actionable = isFailed ? parseActionableError(progress.error || progress.message) : null;

  return (
    <div className="flex flex-col gap-4 bg-neutral-900/95 backdrop-blur-md border border-violet-800/60 rounded-2xl p-5 shadow-2xl select-none text-neutral-100">
      {/* Top telemetry bar */}
      <div className="flex items-center justify-between flex-wrap gap-2 text-xs">
        <div className="flex items-center gap-2.5">
          {isActive ? (
            <div className="w-6 h-6 rounded-lg bg-violet-950/80 border border-violet-700/60 flex items-center justify-center text-violet-400">
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            </div>
          ) : isCompleted ? (
            <div className="w-6 h-6 rounded-lg bg-emerald-950/80 border border-emerald-600/60 flex items-center justify-center text-emerald-400">
              <Check className="w-3.5 h-3.5 stroke-[3]" />
            </div>
          ) : (
            <div className="w-6 h-6 rounded-lg bg-rose-950/80 border border-rose-800/60 flex items-center justify-center text-rose-400">
              <AlertCircle className="w-3.5 h-3.5" />
            </div>
          )}

          <div>
            <div className="flex items-center gap-2">
              <span className="font-semibold text-neutral-100">
                {isCompleted
                  ? 'Object Removal Complete'
                  : isFailed
                  ? 'Removal Failed'
                  : isCancelled
                  ? 'Removal Cancelled'
                  : 'Removing Object with EffectErase'}
              </span>
              <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-violet-950 text-violet-300 border border-violet-800/80">
                Run: {progress.erase_run_id ? progress.erase_run_id.slice(0, 8) : 'init'}
              </span>
            </div>
            <p className="text-[11px] text-neutral-400">
              {progress.message ||
                (isCompleted
                  ? 'Video successfully in专题ed and cleaned.'
                  : isCancelled
                  ? 'Run was cancelled by user.'
                  : isFailed
                  ? progress.error || 'Execution stopped with error.'
                  : 'Running Wan2.1 diffusion inpainting...')}
            </p>
          </div>
        </div>

        {/* Right telemetry & action controls */}
        <div className="flex items-center gap-2 font-mono text-[11px] text-neutral-400">
          <div className="flex items-center gap-1 bg-neutral-950 px-2.5 py-1 rounded-lg border border-neutral-800">
            <Clock className="w-3 h-3 text-violet-400" />
            <span>{formatTime(elapsedSeconds)}</span>
          </div>

          {onCancel && isActive && (
            <button
              type="button"
              onClick={onCancel}
              disabled={isCancelling}
              className="flex items-center gap-1.5 px-3 py-1 rounded-lg border border-neutral-700 bg-neutral-950 hover:bg-neutral-800 text-neutral-300 hover:text-white text-xs font-sans font-medium transition active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed"
              title="Cancel removal job"
            >
              {isCancelling && <Loader2 className="w-3 h-3 animate-spin text-neutral-400" />}
              <span>{isCancelling ? 'Cancelling...' : 'Cancel'}</span>
            </button>
          )}

          {(isFailed || isCancelled) && onRetry && (
            <button
              type="button"
              onClick={onRetry}
              className="flex items-center gap-1.5 px-3 py-1 rounded-lg bg-violet-600 hover:bg-violet-500 text-white text-xs font-sans font-bold shadow-md transition active:scale-95"
            >
              <RotateCcw className="w-3 h-3" />
              <span>Retry</span>
            </button>
          )}

          {isCompleted && onViewResult && (
            <button
              type="button"
              onClick={onViewResult}
              className="flex items-center gap-1.5 px-3 py-1 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-neutral-950 text-xs font-sans font-bold shadow-md transition active:scale-95"
            >
              <Play className="w-3 h-3 fill-current" />
              <span>View Cleaned Video</span>
            </button>
          )}

          {onDismiss && (
            <button
              type="button"
              onClick={onDismiss}
              className="p-1 rounded-lg hover:bg-neutral-800 text-neutral-400 hover:text-white transition"
              title="Dismiss tracker"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Progress Line */}
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between font-mono text-[11px]">
          <span className="text-neutral-400 uppercase tracking-wider text-[10px]">
            {progress.stage.replace('_', ' ')}
          </span>
          <span className="text-violet-300 font-semibold">{progress.progress}%</span>
        </div>
        <div className="w-full h-1.5 bg-neutral-950 rounded-full overflow-hidden border border-neutral-800">
          <div
            className={`h-full transition-all duration-300 ${
              isFailed
                ? 'bg-rose-500'
                : isCancelled
                ? 'bg-neutral-500'
                : isCompleted
                ? 'bg-emerald-400'
                : 'bg-gradient-to-r from-violet-500 to-indigo-500'
            }`}
            style={{ width: `${Math.max(2, progress.progress)}%` }}
          />
        </div>
      </div>

      {/* 5-step Pipeline Stages Visualizer */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 pt-1">
        {REMOVAL_STEPS.map((step, idx) => {
          const StepIcon = step.icon;
          const isCurrent = currentStepIdx === idx && isActive;
          const isDone = currentStepIdx > idx || isCompleted;

          return (
            <div
              key={step.stage}
              className={`flex items-center gap-2 p-2 rounded-xl border text-xs transition-all ${
                isCurrent
                  ? 'bg-violet-950/60 border-violet-500 text-violet-100 shadow-sm'
                  : isDone
                  ? 'bg-neutral-950/70 border-neutral-800 text-neutral-300'
                  : 'bg-neutral-950/30 border-neutral-900 text-neutral-600'
              }`}
            >
              <div
                className={`w-5 h-5 rounded-lg flex items-center justify-center flex-shrink-0 ${
                  isCurrent
                    ? 'bg-violet-500 text-white animate-pulse'
                    : isDone
                    ? 'bg-violet-900/60 text-violet-300 border border-violet-700/50'
                    : 'bg-neutral-900 text-neutral-600'
                }`}
              >
                {isDone ? <Check className="w-3 h-3 stroke-[2.5]" /> : <StepIcon className="w-3 h-3" />}
              </div>
              <span className="truncate font-mono text-[10px]">{step.label}</span>
            </div>
          );
        })}
      </div>

      {/* Actionable Error Card */}
      {isFailed && actionable && (
        <div className="bg-rose-950/30 border border-rose-800/60 rounded-xl p-3.5 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 text-xs">
          <div className="flex items-start gap-2.5">
            <FileQuestion className="w-4 h-4 text-rose-400 flex-shrink-0 mt-0.5" />
            <div>
              <span className="font-semibold text-rose-200 block">{actionable.title}</span>
              <span className="text-neutral-300 text-[11px] leading-relaxed block mt-0.5">
                {actionable.hint}
              </span>
            </div>
          </div>
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              className="flex-shrink-0 px-3 py-1.5 rounded-lg bg-rose-600 hover:bg-rose-500 text-white font-bold text-xs transition active:scale-95 shadow"
            >
              Retry Removal
            </button>
          )}
        </div>
      )}
    </div>
  );
};
