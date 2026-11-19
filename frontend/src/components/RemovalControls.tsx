import React from 'react';
import { Sparkles, Loader2, Play, RotateCcw, Wand2 } from 'lucide-react';
import { RemovalStage } from '../types/api';

export interface RemovalControlsProps {
  jobId: string;
  hasMasks: boolean;
  isRemovalActive: boolean;
  isRemovalCompleted: boolean;
  eraseRunId?: string | null;
  currentStage?: RemovalStage | null;
  removalProgress?: number | null;
  onStartRemoval: () => void;
  onViewCleanedVideo?: () => void;
  className?: string;
  variant?: 'compact' | 'full';
}

export const RemovalControls: React.FC<RemovalControlsProps> = ({
  jobId: _jobId,
  hasMasks,
  isRemovalActive,
  isRemovalCompleted,
  eraseRunId: _eraseRunId,
  currentStage,
  removalProgress,
  onStartRemoval,
  onViewCleanedVideo,
  className = '',
  variant = 'compact',
}) => {
  if (!hasMasks) {
    return null;
  }

  if (variant === 'compact') {
    return (
      <div className={`flex items-center gap-2 ${className}`}>
        {isRemovalCompleted && onViewCleanedVideo && (
          <button
            type="button"
            onClick={onViewCleanedVideo}
            className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-violet-600 hover:bg-violet-500 text-white text-xs font-bold transition active:scale-95 shadow-md"
            title="View the generated cleaned video"
          >
            <Play className="w-3.5 h-3.5 fill-current" />
            <span>View Cleaned Video</span>
          </button>
        )}

        <button
          type="button"
          onClick={onStartRemoval}
          disabled={isRemovalActive || !hasMasks}
          className={`flex items-center gap-2 px-3.5 py-2 rounded-xl text-xs font-bold transition active:scale-95 shadow-md ${
            isRemovalActive
              ? 'bg-neutral-800 text-neutral-400 border border-neutral-700 cursor-not-allowed'
              : isRemovalCompleted
              ? 'bg-neutral-800 hover:bg-neutral-700 text-neutral-200 border border-neutral-700'
              : 'bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-500 hover:to-indigo-500 text-white shadow-violet-900/30'
          }`}
          title={
            !hasMasks
              ? 'Complete mask generation first'
              : isRemovalActive
              ? 'Removal currently processing'
              : isRemovalCompleted
              ? 'Re-run object removal with current masks'
              : 'Remove selected object and its shadows/reflections with EffectErase'
          }
        >
          {isRemovalActive ? (
            <>
              <Loader2 className="w-3.5 h-3.5 animate-spin text-violet-400" />
              <span>
                Removing... {removalProgress !== null && removalProgress !== undefined ? `${removalProgress}%` : ''}
              </span>
            </>
          ) : isRemovalCompleted ? (
            <>
              <RotateCcw className="w-3.5 h-3.5" />
              <span>Re-run Removal</span>
            </>
          ) : (
            <>
              <Sparkles className="w-3.5 h-3.5 text-violet-200" />
              <span>Remove Object</span>
            </>
          )}
        </button>
      </div>
    );
  }

  // Full banner / card variant
  return (
    <div
      className={`bg-gradient-to-r from-violet-950/40 via-neutral-900 to-indigo-950/30 border border-violet-800/50 rounded-2xl p-4 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 shadow-lg ${className}`}
    >
      <div className="flex items-start gap-3">
        <div className="w-10 h-10 rounded-xl bg-violet-500/10 border border-violet-500/30 flex items-center justify-center text-violet-400 flex-shrink-0 mt-0.5 sm:mt-0">
          <Wand2 className="w-5 h-5" />
        </div>
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-sm font-semibold text-neutral-100">
              EffectErase Video Object Removal
            </h3>
            <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-violet-500/20 text-violet-300 border border-violet-500/30">
              CVPR 2026 Inpainting
            </span>
            {isRemovalCompleted && (
              <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
                Cleaned Video Ready
              </span>
            )}
          </div>
          <p className="text-xs text-neutral-400 mt-0.5">
            Erase selected object along with its shadows, reflections, and lighting effects from the raw video.
          </p>
        </div>
      </div>

      <div className="flex items-center gap-2.5 w-full sm:w-auto justify-end flex-shrink-0">
        {isRemovalCompleted && onViewCleanedVideo && (
          <button
            type="button"
            onClick={onViewCleanedVideo}
            className="flex items-center gap-1.5 px-4 py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-neutral-950 text-xs font-bold transition active:scale-95 shadow-md"
          >
            <Play className="w-4 h-4 fill-current" />
            <span>View Cleaned Video</span>
          </button>
        )}

        <button
          type="button"
          onClick={onStartRemoval}
          disabled={isRemovalActive || !hasMasks}
          className={`flex items-center gap-2 px-5 py-2.5 rounded-xl text-xs font-bold transition active:scale-95 shadow-md ${
            isRemovalActive
              ? 'bg-neutral-800 text-neutral-400 border border-neutral-700 cursor-not-allowed'
              : 'bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-500 hover:to-indigo-500 text-white shadow-violet-900/40'
          }`}
        >
          {isRemovalActive ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin text-violet-400" />
              <span>
                Removing...{' '}
                {currentStage === 'inference'
                  ? 'Inference'
                  : currentStage === 'loading_model'
                  ? 'Loading Model'
                  : currentStage === 'preparing_input'
                  ? 'Preparing Input'
                  : currentStage || ''}
              </span>
            </>
          ) : isRemovalCompleted ? (
            <>
              <RotateCcw className="w-4 h-4" />
              <span>Re-run Removal</span>
            </>
          ) : (
            <>
              <Sparkles className="w-4 h-4 fill-violet-300" />
              <span>Remove Object</span>
            </>
          )}
        </button>
      </div>
    </div>
  );
};
