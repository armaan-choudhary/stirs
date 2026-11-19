import { RemovalStage } from '../types/api';

export interface ActionableError {
  title: string;
  hint: string;
  type: 'weights' | 'gpu' | 'runtime' | 'mask_alignment' | 'generic';
}

export function parseActionableError(errorMsg?: string): ActionableError {
  if (!errorMsg) {
    return {
      title: 'Removal Pipeline Error',
      hint: 'The removal job encountered an unexpected error. Check backend logs or try again.',
      type: 'generic',
    };
  }

  const lower = errorMsg.toLowerCase();
  if (
    lower.includes('weights') ||
    lower.includes('checkpoint') ||
    lower.includes('model not found') ||
    lower.includes('wan2.1')
  ) {
    return {
      title: 'Missing Model Weights',
      hint: 'EffectErase or Wan2.1-Fun-1.3B-InP checkpoints are not found. Verify EFFECT_ERASE_CHECKPOINT_PATH and base model weights.',
      type: 'weights',
    };
  }
  if (
    lower.includes('cuda') ||
    lower.includes('gpu') ||
    lower.includes('out of memory') ||
    lower.includes('oom')
  ) {
    return {
      title: 'GPU / CUDA Resource Limit',
      hint: 'Insufficient GPU VRAM or CUDA device error during diffusion inference. Check NVIDIA driver and memory availability.',
      type: 'gpu',
    };
  }
  if (
    lower.includes('runtime') ||
    lower.includes('python') ||
    lower.includes('no such file') ||
    lower.includes('executable') ||
    lower.includes('command not found')
  ) {
    return {
      title: 'Missing Runtime Environment',
      hint: 'The external EffectErase Python environment or inference script was not found. Check EFFECT_ERASE_PYTHON_BIN and repository path.',
      type: 'runtime',
    };
  }
  if (
    lower.includes('mask') ||
    lower.includes('dimension') ||
    lower.includes('frame count') ||
    lower.includes('mismatch')
  ) {
    return {
      title: 'Mask Alignment Mismatch',
      hint: 'Source video and mask sequence frame count or dimension alignment failed. Verify SAM 2 masks completed cleanly.',
      type: 'mask_alignment',
    };
  }

  return {
    title: 'Removal Execution Error',
    hint: errorMsg,
    type: 'generic',
  };
}

export function getVersionedResultUrl(
  jobId: string,
  eraseRunId: string,
  baseUrl?: string
): string {
  if (baseUrl) {
    if (baseUrl.includes(`v=${eraseRunId}`)) return baseUrl;
    const separator = baseUrl.includes('?') ? '&' : '?';
    return `${baseUrl}${separator}v=${eraseRunId}`;
  }
  return `/api/v1/jobs/${jobId}/removal/${eraseRunId}/result?v=${eraseRunId}`;
}

export function getRemovalStageLabel(stage: RemovalStage): string {
  switch (stage) {
    case 'queued':
      return 'Queued for Removal';
    case 'preparing_input':
      return 'Preparing Input & Mask Video';
    case 'loading_model':
      return 'Loading EffectErase Model';
    case 'inference':
      return 'Running Removal Diffusion';
    case 'validating_output':
      return 'Validating Cleaned Video';
    case 'publishing':
      return 'Publishing Cleaned Video';
    case 'completed':
      return 'Object Removal Complete';
    case 'failed':
      return 'Removal Failed';
    case 'cancelled':
      return 'Removal Cancelled';
    default:
      return stage;
  }
}

export function isRemovalActive(stage: RemovalStage): boolean {
  return (
    stage !== 'completed' &&
    stage !== 'failed' &&
    stage !== 'cancelled'
  );
}
